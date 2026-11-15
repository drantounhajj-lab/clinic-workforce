import NetInfo, { NetInfoStateType } from "@react-native-community/netinfo";
import * as Location from "expo-location";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Button, Card, Label, Muted, Segmented } from "../components/ui";
import { useSession } from "../session";
import { supabase } from "../supabase";
import { colors, radius, space } from "../theme";

export default function SetupScreen() {
  const { t, lang, setLang, me, session, locations, managesLocation, reload } = useSession();
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [pin, setPin] = useState("");
  const [pinMsg, setPinMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const managed = locations.filter(managesLocation);

  useEffect(() => {
    supabase.rpc("has_pin").then(({ data }) => setHasPin(data === true));
  }, []);

  const say = (id: string, text: string) => setMessages((m) => ({ ...m, [id]: text }));

  async function savePin() {
    setPinMsg(null);
    const { data, error } = await supabase.rpc("set_my_pin", { p_pin: pin });
    if (error) setPinMsg({ ok: false, text: error.message });
    else if (!data?.ok) setPinMsg({ ok: false, text: t.pinErrors[data?.reason] ?? t.error });
    else {
      setPinMsg({ ok: true, text: t.pinSet });
      setHasPin(true);
      setPin("");
    }
  }

  async function saveLocationHere(locationId: string) {
    setBusy(`${locationId}-loc`);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        say(locationId, t.locationDenied);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
      const { error } = await supabase.from("locations").update({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }).eq("id", locationId);
      say(locationId, error ? error.message : `${t.saved} ±${Math.round(pos.coords.accuracy ?? 0)} m`);
      if (!error) await reload();
    } catch {
      say(locationId, t.error);
    } finally {
      setBusy(null);
    }
  }

  async function addWifi(locationId: string) {
    setBusy(`${locationId}-wifi`);
    try {
      await Location.requestForegroundPermissionsAsync();
      const net = await NetInfo.fetch();
      if (net.type !== NetInfoStateType.wifi) {
        say(locationId, t.notOnWifi);
        return;
      }
      const bssid = net.details.bssid?.toLowerCase();
      if (!bssid) {
        say(locationId, t.wifiUnreadable);
        return;
      }
      const { error } = await supabase
        .from("location_wifi")
        .upsert({ location_id: locationId, ssid: net.details.ssid ?? null, bssid }, { onConflict: "location_id,bssid", ignoreDuplicates: true });
      say(locationId, error ? error.message : `${t.saved} ${net.details.ssid ?? ""}`.trim());
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
          value={lang}
          onChange={setLang}
        />
      </Card>

      <Card>
        <Label>{t.account}</Label>
        <Text style={styles.name}>
          {me?.first_name} {me?.last_name}
        </Text>
        <Muted>{session?.user.email}</Muted>
        <Button title={t.signOut} onPress={() => supabase.auth.signOut()} />
      </Card>

      <Card>
        <Label>{t.pinTitle}</Label>
        <Muted small>{t.pinHint}</Muted>
        <Muted>{hasPin ? t.pinSet : t.pinMissing}</Muted>
        <TextInput
          style={styles.input}
          value={pin}
          onChangeText={(v) => setPin(v.replace(/\D/g, "").slice(0, 6))}
          keyboardType="number-pad"
          secureTextEntry
          placeholder={t.newPin}
          accessibilityLabel={t.newPin}
        />
        <Button variant="primary" title={t.savePin} onPress={savePin} />
        {pinMsg && <Text style={{ color: pinMsg.ok ? colors.ok : colors.error }}>{pinMsg.text}</Text>}
      </Card>

      {managed.length > 0 && (
        <Card>
          <Label>{t.managerTools}</Label>
          <Muted small>{t.managerHint}</Muted>
          {managed.map((l) => (
            <View key={l.id} style={styles.clinic}>
              <Text style={styles.clinicName}>
                {l.name} · {l.province}
              </Text>
              <Muted small>{l.latitude != null ? t.locationSet(l.latitude.toFixed(5), (l.longitude ?? 0).toFixed(5)) : t.locationUnset}</Muted>
              <Button title={t.saveLocationHere} busy={busy === `${l.id}-loc`} onPress={() => saveLocationHere(l.id)} />
              <Button title={t.addWifi} busy={busy === `${l.id}-wifi`} onPress={() => addWifi(l.id)} />
              {messages[l.id] ? <Muted small>{messages[l.id]}</Muted> : null}
            </View>
          ))}
        </Card>
      )}

      <Card>
        <Label>{t.kioskTitle}</Label>
        <Muted small>{t.kioskHint}</Muted>
        <Button
          variant="dark"
          title={t.setUpKiosk}
          onPress={async () => {
            await supabase.auth.signOut();
            await supabase.auth.signInAnonymously();
          }}
        />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: space.md, gap: space.md, paddingBottom: space.xl * 2 },
  name: { fontSize: 18, fontWeight: "600", color: colors.ink },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: space.md, minHeight: 46, fontSize: 18, color: colors.ink, letterSpacing: 4 },
  clinic: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space.md, marginTop: space.sm, gap: space.sm },
  clinicName: { fontSize: 16, fontWeight: "600", color: colors.ink },
});
