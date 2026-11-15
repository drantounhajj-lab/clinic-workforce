import NetInfo, { NetInfoStateType } from "@react-native-community/netinfo";
import { clinics } from "@clinic-workforce/sample-data";
import * as Location from "expo-location";
import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { personById, punchLocationFor } from "../clinics";
import { PersonPicker } from "../components/PersonPicker";
import { Button, Card, Label, Muted, Segmented } from "../components/ui";
import { useSettings } from "../settings";
import { colors, space } from "../theme";

export default function SetupScreen() {
  const { settings, t, ready, update, setOverride } = useSettings();
  const [picking, setPicking] = useState(false);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  if (!ready) return null;
  const person = personById(settings.personId);
  const say = (clinicId: string, text: string) => setMessages((m) => ({ ...m, [clinicId]: text }));

  async function saveLocationHere(clinicId: string) {
    setBusy(`${clinicId}-loc`);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        say(clinicId, t.locationDenied);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
      setOverride(clinicId, { latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      say(clinicId, `${t.saved} ±${Math.round(pos.coords.accuracy ?? 0)} m`);
    } catch {
      say(clinicId, t.reasons.no_position);
    } finally {
      setBusy(null);
    }
  }

  async function addWifi(clinicId: string) {
    setBusy(`${clinicId}-wifi`);
    try {
      await Location.requestForegroundPermissionsAsync();
      const net = await NetInfo.fetch();
      if (net.type !== NetInfoStateType.wifi) {
        say(clinicId, t.notOnWifi);
        return;
      }
      const bssid = net.details.bssid?.toLowerCase();
      if (!bssid) {
        say(clinicId, t.wifiUnreadable);
        return;
      }
      const current = settings.clinicOverrides[clinicId] ?? {};
      const wifiBssids = [...new Set([...(current.wifiBssids ?? []), bssid])];
      const wifiNames = [...new Set([...(current.wifiNames ?? []), net.details.ssid ?? bssid])];
      setOverride(clinicId, { wifiBssids, wifiNames });
      say(clinicId, `${t.saved} ${net.details.ssid ?? ""}`.trim());
    } finally {
      setBusy(null);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Card>
        <Label>{t.language}</Label>
        <Segmented
          options={[
            { value: "fr", label: "Français" },
            { value: "en", label: "English" },
          ]}
          value={settings.lang}
          onChange={(lang) => update({ lang })}
        />
      </Card>

      {person && !picking ? (
        <Card>
          <Label>{t.me}</Label>
          <Text style={styles.name}>{person.name}</Text>
          <Muted>{t.roles[person.role]}</Muted>
          <Button title={t.change} onPress={() => setPicking(true)} />
        </Card>
      ) : (
        <PersonPicker onPicked={() => setPicking(false)} />
      )}

      <Card>
        <Label>{t.testing}</Label>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>{t.ignoreSchedule}</Text>
          <Switch
            value={settings.ignoreSchedule}
            onValueChange={(v) => update({ ignoreSchedule: v })}
            trackColor={{ true: colors.accent, false: colors.line }}
            accessibilityLabel={t.ignoreSchedule}
          />
        </View>
        <Muted small>{t.ignoreScheduleHint}</Muted>
      </Card>

      <Card>
        <Label>{t.clinicsTitle}</Label>
        <Muted small>{t.clinicsHint}</Muted>
        {clinics.map((c) => {
          const o = settings.clinicOverrides[c.id];
          const loc = punchLocationFor(c.id, settings.clinicOverrides);
          return (
            <View key={c.id} style={styles.clinic}>
              <Text style={styles.clinicName}>
                {c.name} · {c.province}
              </Text>
              <Muted small>
                {o?.latitude !== undefined ? t.savedLocation(loc.latitude.toFixed(5), loc.longitude.toFixed(5)) : t.sampleLocation}
              </Muted>
              <Muted small>
                {t.wifiList(o?.wifiBssids?.length ?? 0)}
                {o?.wifiNames?.length ? ` (${o.wifiNames.join(", ")})` : ""}
              </Muted>
              <View style={styles.radiusRow}>
                <Text style={styles.small}>{t.radius}</Text>
                <View style={{ flex: 1 }}>
                  <Segmented
                    options={[100, 150, 250].map((r) => ({ value: String(r), label: `${r} m` }))}
                    value={String(loc.geofenceRadiusM)}
                    onChange={(v) => setOverride(c.id, { radiusM: Number(v) })}
                  />
                </View>
              </View>
              <View style={styles.buttons}>
                <Button title={t.useHere} busy={busy === `${c.id}-loc`} onPress={() => saveLocationHere(c.id)} />
                <Button title={t.addWifi} busy={busy === `${c.id}-wifi`} onPress={() => addWifi(c.id)} />
                {o && <Button variant="ghost" title={t.resetClinic} onPress={() => setOverride(c.id, null)} />}
              </View>
              {messages[c.id] && <Muted small>{messages[c.id]}</Muted>}
            </View>
          );
        })}
      </Card>

      <Card>
        <Label>{t.kioskTitle}</Label>
        <Muted small>{t.kioskHint}</Muted>
        <Button variant="dark" title={t.openKiosk} onPress={() => router.push("/kiosk")} />
      </Card>

      {person && (
        <Button
          variant="ghost"
          title={t.clearPunches}
          onPress={() => update({ punches: settings.punches.filter((p) => p.personId !== person.id) })}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: space.md, gap: space.md, paddingBottom: space.xl * 2 },
  name: { fontSize: 18, fontWeight: "600", color: colors.ink },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  switchLabel: { flex: 1, fontSize: 15, color: colors.ink },
  clinic: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space.md, marginTop: space.sm, gap: space.xs },
  clinicName: { fontSize: 16, fontWeight: "600", color: colors.ink },
  radiusRow: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.xs },
  small: { fontSize: 13, color: colors.muted },
  buttons: { gap: space.sm, marginTop: space.xs },
});
