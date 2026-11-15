import NetInfo, { NetInfoStateType } from "@react-native-community/netinfo";
import { evaluatePunch, parseQrPayload, type PunchDecision } from "@clinic-workforce/timeclock";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import { useRef, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  clinicById,
  fmtDay,
  fmtDistance,
  fmtTime,
  myClinicIds,
  myShifts,
  personById,
  punchLocationFor,
  shiftEnd,
  shiftStart,
} from "../clinics";
import { PersonPicker } from "../components/PersonPicker";
import { Button, Card, Label, Muted, Result, Segmented, Tag } from "../components/ui";
import { useSettings } from "../settings";
import { colors, mono, space } from "../theme";

NetInfo.configure({ shouldFetchWiFiSSID: true });

interface Outcome {
  ok: boolean;
  title: string;
  lines: string[];
}

export default function ClockScreen() {
  const { settings, t, ready, addPunch } = useSettings();
  const person = personById(settings.personId);
  const clinicIds = person ? myClinicIds(person.id) : [];
  const [clinicId, setClinicId] = useState<string | null>(null);
  const activeClinicId = clinicId && clinicIds.includes(clinicId) ? clinicId : clinicIds[0];
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const handled = useRef(false);

  if (!ready) return null;
  if (!person || !activeClinicId) {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <PersonPicker />
      </ScrollView>
    );
  }

  const clinic = clinicById(activeClinicId);
  const now = new Date();
  const shift = myShifts(person.id).find((s) => s.locationId === activeClinicId && shiftEnd(s) > now);
  const mine = settings.punches.filter((p) => p.personId === person.id);
  const last = mine[mine.length - 1];
  const clockedIn = last?.kind === "in";
  const kind: "in" | "out" = clockedIn ? "out" : "in";

  function report(decision: PunchDecision, method: "gps" | "qr", punchClinicId: string, extra: string[] = []) {
    const c = clinicById(punchClinicId);
    const loc = punchLocationFor(punchClinicId, settings.clinicOverrides);
    if (decision.accepted) {
      const at = new Date();
      addPunch({ personId: person!.id, kind, at: at.toISOString(), clinicId: punchClinicId, method, flags: decision.flags, distanceM: decision.distanceM });
      setOutcome({ ok: true, title: t.accepted(kind, fmtTime(at), c.name), lines: [...extra, ...decision.flags.map((f) => t.flags[f]).filter(Boolean)] });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      return;
    }
    let title = "";
    switch (decision.reason) {
      case "too_early":
        title = t.reasons.too_early(loc.earlyPunchLimitMin, decision.opensInMin ?? 0);
        break;
      case "outside_geofence":
        title = t.reasons.outside_geofence(fmtDistance(decision.distanceM ?? 0, settings.lang), c.name, loc.geofenceRadiusM);
        break;
      case "no_position":
        title = t.reasons.no_position;
        break;
      case "invalid_qr":
        title = t.reasons.invalid_qr;
        break;
      case "mock_location":
        title = t.reasons.mock_location;
        break;
    }
    setOutcome({ ok: false, title, lines: extra });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
  }

  async function punchByLocation() {
    setBusy(true);
    setOutcome(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        setOutcome({ ok: false, title: t.locationDenied, lines: [] });
        return;
      }
      const [position, net] = await Promise.all([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
        NetInfo.fetch(),
      ]);
      const wifi = net.type === NetInfoStateType.wifi ? net.details : null;
      const loc = punchLocationFor(activeClinicId!, settings.clinicOverrides);
      const decision = evaluatePunch({
        kind,
        method: "phone_geofence",
        at: new Date(),
        location: loc,
        scheduledStart: settings.ignoreSchedule || !shift ? null : shiftStart(shift),
        position: { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracyM: position.coords.accuracy ?? undefined },
        wifiBssid: wifi?.bssid ?? null,
        mockLocationDetected: position.mocked === true,
        offline: net.isConnected === false,
      });
      const extra: string[] = [];
      if (decision.accepted && decision.distanceM !== undefined && !decision.flags.includes("outside_geofence_wifi_ok")) {
        extra.push(t.gpsOk(decision.distanceM, loc.geofenceRadiusM, position.coords.accuracy ?? null));
      }
      if (wifi?.ssid) extra.push(t.wifiSeen(wifi.ssid));
      report(decision, "gps", activeClinicId!, extra);
    } catch {
      setOutcome({ ok: false, title: t.reasons.no_position, lines: [] });
    } finally {
      setBusy(false);
    }
  }

  async function startScan() {
    setOutcome(null);
    if (!cameraPermission?.granted) {
      const res = await requestCameraPermission();
      if (!res.granted) {
        setOutcome({ ok: false, title: t.cameraDenied, lines: [] });
        return;
      }
    }
    handled.current = false;
    setScanning(true);
  }

  function onScanned(data: string) {
    if (handled.current) return;
    handled.current = true;
    setScanning(false);
    const payload = parseQrPayload(data);
    if (!payload) {
      setOutcome({ ok: false, title: t.notClinicCode, lines: [] });
      return;
    }
    if (!clinicIds.includes(payload.locationId)) {
      setOutcome({ ok: false, title: t.notYourClinic, lines: [] });
      return;
    }
    const scannedShift = myShifts(person!.id).find((s) => s.locationId === payload.locationId && shiftEnd(s) > new Date());
    const decision = evaluatePunch({
      kind,
      method: "rotating_qr",
      at: new Date(),
      location: punchLocationFor(payload.locationId, settings.clinicOverrides),
      scheduledStart: settings.ignoreSchedule || !scannedShift ? null : shiftStart(scannedShift),
      qrToken: payload.code,
    });
    report(decision, "qr", payload.locationId, decision.accepted ? [t.qrOk] : []);
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {clinicIds.length > 1 && (
        <Card>
          <Label>{t.clinic}</Label>
          <Segmented options={clinicIds.map((id) => ({ value: id, label: clinicById(id).name }))} value={activeClinicId} onChange={setClinicId} />
        </Card>
      )}

      <Card style={styles.shiftCard}>
        <Label>{t.nextShift}</Label>
        {shift ? (
          <>
            <Text style={styles.big}>
              {shift.start}–{shift.end}
            </Text>
            <Text style={styles.body}>
              {fmtDay(shift.date, settings.lang, t.daysLong)} · {clinic.name} {clinic.province}
            </Text>
          </>
        ) : (
          <Text style={styles.body}>{t.noShift}</Text>
        )}
        {settings.ignoreSchedule && <Muted small>{t.ignoringSchedule}</Muted>}
      </Card>

      <Card>
        <Text style={styles.action}>{clockedIn ? t.clockOut : t.clockIn}</Text>
        {clockedIn && last && <Muted>{t.clockedInSince(fmtTime(new Date(last.at)))}</Muted>}
        <Button big variant={clockedIn ? "dark" : "primary"} title={busy ? t.checking : t.byLocation} busy={busy} onPress={punchByLocation} />
        <Button title={t.byQr} onPress={startScan} />
        {outcome && <Result ok={outcome.ok} title={outcome.title} lines={outcome.lines} />}
      </Card>

      <Card>
        <Label>{t.punches}</Label>
        {mine.length === 0 ? (
          <Muted>{t.noPunches}</Muted>
        ) : (
          [...mine]
            .reverse()
            .slice(0, 12)
            .map((p) => (
              <View key={p.id} style={styles.punchRow}>
                <Tag text={p.kind === "in" ? t.in : t.out} tone={p.kind === "in" ? "accent" : "ink"} />
                <Text style={[styles.body, mono]}>{fmtTime(new Date(p.at))}</Text>
                <Text style={styles.small}>
                  {fmtDay(p.at.slice(0, 10), settings.lang, t.daysLong, false)} · {clinicById(p.clinicId).name} · {t.methodNames[p.method]}
                </Text>
              </View>
            ))
        )}
      </Card>

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <SafeAreaView style={styles.scanPage}>
          <Text style={styles.scanTitle}>{t.scanTitle}</Text>
          <View style={styles.cameraBox}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={(r) => onScanned(r.data)}
            />
          </View>
          <Button title={t.cancel} onPress={() => setScanning(false)} />
        </SafeAreaView>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: space.md, gap: space.md },
  shiftCard: { backgroundColor: colors.accentSoft },
  big: { fontSize: 30, fontWeight: "600", color: colors.ink, fontVariant: ["tabular-nums"] },
  body: { fontSize: 15, color: colors.ink },
  small: { fontSize: 12, color: colors.muted, flexShrink: 1 },
  action: { fontSize: 18, fontWeight: "700", color: colors.ink },
  punchRow: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap", paddingVertical: 4 },
  scanPage: { flex: 1, backgroundColor: colors.ink, padding: space.lg, gap: space.lg },
  scanTitle: { color: colors.surface, fontSize: 18, fontWeight: "600", textAlign: "center" },
  cameraBox: { flex: 1, borderRadius: 20, overflow: "hidden", backgroundColor: "#000" },
});
