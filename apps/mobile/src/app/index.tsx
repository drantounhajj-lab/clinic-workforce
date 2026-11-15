import NetInfo, { NetInfoStateType } from "@react-native-community/netinfo";
import { parseQrPayload } from "@clinic-workforce/timeclock";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Card, Label, Muted, Result, Segmented, Tag } from "../components/ui";
import { fmtDay, fmtDistance, fmtTime } from "../format";
import { reasonText } from "../i18n";
import { useMyClinics, useSession } from "../session";
import { type Punch, type PunchResult, type Shift, supabase } from "../supabase";
import { colors, space } from "../theme";

NetInfo.configure({ shouldFetchWiFiSSID: true });

export default function ClockScreen() {
  const { t, lang, me, employments } = useSession();
  const clinics = useMyClinics();
  const [clinicId, setClinicId] = useState<string | null>(null);
  const clinic = clinics.find((c) => c.id === clinicId) ?? clinics[0];
  const [punches, setPunches] = useState<Punch[]>([]);
  const [nextShift, setNextShift] = useState<Shift | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; title: string; lines: string[] } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const handled = useRef(false);

  const load = useCallback(async () => {
    if (!me) return;
    const empIds = employments.map((e) => e.id);
    const [p, s] = await Promise.all([
      supabase.from("punches").select("id, location_id, kind, method, occurred_at, flags").eq("person_id", me.id).order("occurred_at", { ascending: false }).limit(12),
      empIds.length
        ? supabase.from("shifts").select("*").in("employment_id", empIds).gt("ends_at", new Date().toISOString()).neq("response", "declined").order("starts_at").limit(1)
        : Promise.resolve({ data: [] }),
    ]);
    setPunches((p.data as Punch[]) ?? []);
    setNextShift(((s.data as Shift[]) ?? [])[0] ?? null);
  }, [me, employments]);

  useEffect(() => {
    load();
  }, [load]);

  const clockedIn = punches[0]?.kind === "in";

  function report(r: PunchResult | null, error: string | null, punchClinicName: string, extra: string[] = []) {
    if (error || !r) {
      setOutcome({ ok: false, title: error ?? t.error, lines: [] });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      return;
    }
    if (r.accepted) {
      const lines = [...extra];
      if (r.distance_m != null && !(r.flags ?? []).includes("outside_geofence_wifi_ok")) lines.unshift(t.distanceOk(r.distance_m, r.radius_m ?? 0));
      lines.push(...(r.flags ?? []).map((f) => t.flags[f]).filter(Boolean));
      setOutcome({ ok: true, title: t.accepted(r.kind ?? "in", fmtTime(r.occurred_at ?? new Date(), clinic?.timezone), punchClinicName), lines });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      load();
    } else {
      setOutcome({
        ok: false,
        title: reasonText(t, r.reason, { distance: r.distance_m != null ? fmtDistance(r.distance_m, lang) : undefined, radius: r.radius_m, opensIn: r.opens_in_min }),
        lines: extra,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    }
  }

  async function punchByLocation() {
    if (!clinic) return;
    setBusy(true);
    setOutcome(null);
    try {
      const net = await NetInfo.fetch();
      if (net.isConnected === false) {
        setOutcome({ ok: false, title: t.offline, lines: [] });
        return;
      }
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        setOutcome({ ok: false, title: t.locationDenied, lines: [] });
        return;
      }
      const [position, net2] = await Promise.all([Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }), NetInfo.fetch()]);
      const wifi = net2.type === NetInfoStateType.wifi ? net2.details : null;
      const { data, error } = await supabase.rpc("punch_with_location", {
        p_location_id: clinic.id,
        p_latitude: position.coords.latitude,
        p_longitude: position.coords.longitude,
        p_accuracy_m: position.coords.accuracy ?? null,
        p_wifi_bssid: wifi?.bssid ?? null,
        p_mocked: position.mocked === true,
      });
      report(data as PunchResult | null, error?.message ?? null, clinic.name, wifi?.ssid ? [`Wi-Fi : ${wifi.ssid}`] : []);
    } catch {
      setOutcome({ ok: false, title: t.reasons.no_position as string, lines: [] });
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

  async function onScanned(text: string) {
    if (handled.current) return;
    handled.current = true;
    setScanning(false);
    const payload = parseQrPayload(text);
    if (!payload) {
      setOutcome({ ok: false, title: t.notClinicCode, lines: [] });
      return;
    }
    const target = clinics.find((c) => c.id === payload.locationId);
    if (!target) {
      setOutcome({ ok: false, title: t.notYourClinic, lines: [] });
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.rpc("punch_with_qr", { p_location_id: payload.locationId, p_code: payload.code });
    setBusy(false);
    report(data as PunchResult | null, error?.message ?? null, target.name, (data as PunchResult | null)?.accepted ? [t.qrOk] : []);
  }

  const nameOf = (id: string) => clinics.find((c) => c.id === id)?.name ?? "";

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
    >
      {clinics.length > 1 && (
        <Card>
          <Label>{t.clinic}</Label>
          <Segmented options={clinics.map((c) => ({ value: c.id, label: c.name }))} value={clinic?.id ?? ""} onChange={setClinicId} />
        </Card>
      )}

      <Card style={styles.shiftCard}>
        <Label>{t.nextShift}</Label>
        {nextShift ? (
          <>
            <Text style={styles.big}>
              {fmtTime(nextShift.starts_at)}–{fmtTime(nextShift.ends_at)}
            </Text>
            <Text style={styles.body}>
              {fmtDay(nextShift.starts_at, lang)} · {nameOf(nextShift.location_id)}
            </Text>
          </>
        ) : (
          <Text style={styles.body}>{t.noShift}</Text>
        )}
      </Card>

      <Card>
        <Text style={styles.action}>
          {clockedIn ? t.clockOut : t.clockIn}
          {clinic ? ` · ${clinic.name}` : ""}
        </Text>
        <Button big variant={clockedIn ? "dark" : "primary"} title={busy ? t.checking : t.byLocation} busy={busy} onPress={punchByLocation} />
        <Button title={t.byQr} onPress={startScan} />
        {outcome && <Result ok={outcome.ok} title={outcome.title} lines={outcome.lines} />}
      </Card>

      <Card>
        <Label>{t.punches}</Label>
        {punches.length === 0 ? (
          <Muted>{t.noPunches}</Muted>
        ) : (
          punches.map((p) => (
            <View key={p.id} style={styles.punchRow}>
              <Tag text={p.kind === "in" ? t.in : t.out} tone={p.kind === "in" ? "accent" : "ink"} />
              <Text style={styles.body}>{fmtTime(p.occurred_at)}</Text>
              <Text style={styles.small}>
                {fmtDay(p.occurred_at, lang, undefined, false)} · {nameOf(p.location_id)} · {t.methodNames[p.method]}
              </Text>
            </View>
          ))
        )}
      </Card>

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <SafeAreaView style={styles.scanPage}>
          <Text style={styles.scanTitle}>{t.scanTitle}</Text>
          <View style={styles.cameraBox}>
            <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={(r) => onScanned(r.data)} />
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
  body: { fontSize: 15, color: colors.ink, fontVariant: ["tabular-nums"] },
  small: { fontSize: 12, color: colors.muted, flexShrink: 1 },
  action: { fontSize: 18, fontWeight: "700", color: colors.ink },
  punchRow: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap", paddingVertical: 4 },
  scanPage: { flex: 1, backgroundColor: colors.ink, padding: space.lg, gap: space.lg },
  scanTitle: { color: colors.surface, fontSize: 18, fontWeight: "600", textAlign: "center" },
  cameraBox: { flex: 1, borderRadius: 20, overflow: "hidden", backgroundColor: "#000" },
});
