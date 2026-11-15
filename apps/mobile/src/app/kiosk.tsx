import { clinics, employments, persons } from "@clinic-workforce/sample-data";
import { QR_PERIOD_SECONDS, qrPayload, rotatingCode } from "@clinic-workforce/timeclock";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { SafeAreaView } from "react-native-safe-area-context";
import { clinicById, DEMO_PINS, fmtTime, punchLocationFor } from "../clinics";
import { Muted, Result, Segmented } from "../components/ui";
import { useSettings } from "../settings";
import { colors, space } from "../theme";

export default function KioskScreen() {
  const { settings, t, addPunch } = useSettings();
  const [clinicId, setClinicId] = useState(clinics[0].id);
  const [now, setNow] = useState(new Date());
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const { width } = useWindowDimensions();
  const wide = width >= 700;

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const clinic = clinicById(clinicId);
  const loc = punchLocationFor(clinicId, settings.clinicOverrides);
  const code = rotatingCode(loc, now);
  const secondsLeft = QR_PERIOD_SECONDS - (Math.floor(now.getTime() / 1000) % QR_PERIOD_SECONDS);

  function press(d: string) {
    setMessage(null);
    const next = (pin + d).slice(0, 4);
    setPin(next);
    if (next.length === 4) submit(next);
  }

  function submit(value: string) {
    setPin("");
    const personId = Object.keys(DEMO_PINS).find((k) => DEMO_PINS[k] === value);
    if (!personId) {
      setMessage({ ok: false, lines: [t.kioskWrongPin] });
      return;
    }
    const person = persons.find((p) => p.id === personId)!;
    if (!employments.some((e) => e.personId === personId && e.locationIds.includes(clinicId))) {
      setMessage({ ok: false, lines: [t.kioskWrongClinic(person.name)] });
      return;
    }
    const mine = settings.punches.filter((p) => p.personId === personId);
    const kind = mine[mine.length - 1]?.kind === "in" ? "out" : "in";
    const at = new Date();
    addPunch({ personId, kind, at: at.toISOString(), clinicId, method: "kiosk", flags: [] });
    const first = person.name.startsWith("Dr ") ? person.name.split(" ").slice(0, 2).join(" ") : person.name.split(" ")[0];
    setMessage({ ok: true, lines: [kind === "in" ? t.kioskWelcomeIn(first, fmtTime(at)) : t.kioskWelcomeOut(first, fmtTime(at))] });
  }

  const qrSize = Math.min(wide ? 300 : width - 120, 320);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.page}>
        <Pressable delayLongPress={2000} onLongPress={() => router.replace("/setup")} accessibilityHint={t.kioskExit}>
          <View style={styles.head}>
            <Text style={styles.title}>{clinic.name}</Text>
            <Text style={styles.clock}>{fmtTime(now)}</Text>
          </View>
        </Pressable>
        <Segmented options={clinics.map((c) => ({ value: c.id, label: c.name }))} value={clinicId} onChange={(v) => { setClinicId(v); setMessage(null); }} />

        <View style={[styles.body, wide && { flexDirection: "row" }]}>
          <View style={styles.panel}>
            <View style={styles.qrBox}>
              <QRCode value={qrPayload(clinicId, code)} size={qrSize} color={colors.ink} backgroundColor="#FFFFFF" />
            </View>
            <Text style={styles.code}>{code}</Text>
            <Muted>{t.kioskScan}</Muted>
            <View style={styles.countdown}>
              <View style={[styles.countdownFill, { width: `${(secondsLeft / QR_PERIOD_SECONDS) * 100}%` }]} />
            </View>
            <Muted small>{t.kioskChanges(secondsLeft)}</Muted>
          </View>

          <View style={styles.panel}>
            <Text style={styles.pinLabel}>{t.kioskPin}</Text>
            <View style={styles.dots} accessibilityLabel={`${pin.length} / 4`}>
              {[0, 1, 2, 3].map((i) => (
                <View key={i} style={[styles.dot, i < pin.length && styles.dotOn]} />
              ))}
            </View>
            <View style={styles.pad}>
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0"].map((d) => (
                <Pressable
                  key={d}
                  accessibilityRole="button"
                  accessibilityLabel={d === "C" ? t.clear : d}
                  onPress={() => (d === "C" ? (setPin(""), setMessage(null)) : press(d))}
                  style={({ pressed }) => [styles.key, pressed && { backgroundColor: colors.accentSoft }]}
                >
                  <Text style={[styles.keyText, d === "C" && { fontSize: 16 }]}>{d === "C" ? t.clear : d}</Text>
                </Pressable>
              ))}
            </View>
            {message && <Result ok={message.ok} title={message.lines[0]} />}
            <Muted small>
              {t.demoPins}:{" "}
              {persons
                .filter((p) => employments.some((e) => e.personId === p.id && e.locationIds.includes(clinicId)))
                .map((p) => `${p.name.replace("Dr ", "")} ${DEMO_PINS[p.id]}`)
                .join(" · ")}
            </Muted>
          </View>
        </View>
        <Muted small>{t.kioskExit}</Muted>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  page: { padding: space.xl, gap: space.lg },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  title: { fontSize: 28, fontWeight: "700", color: colors.ink },
  clock: { fontSize: 34, color: colors.ink, fontVariant: ["tabular-nums"] },
  body: { gap: space.xl },
  panel: { flex: 1, alignItems: "center", gap: space.md },
  qrBox: { padding: space.md, backgroundColor: "#FFFFFF", borderRadius: 16, borderWidth: 1, borderColor: colors.line },
  code: { fontSize: 24, letterSpacing: 4, color: colors.ink, fontVariant: ["tabular-nums"] },
  countdown: { width: 260, height: 6, borderRadius: 3, backgroundColor: colors.line, overflow: "hidden" },
  countdownFill: { height: "100%", backgroundColor: colors.accent },
  pinLabel: { fontSize: 13, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.6 },
  dots: { flexDirection: "row", gap: space.md },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: colors.muted },
  dotOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  pad: { flexDirection: "row", flexWrap: "wrap", width: 3 * 84 + 2 * 12, gap: 12 },
  key: { width: 84, height: 70, borderRadius: 16, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  keyText: { fontSize: 26, fontWeight: "500", color: colors.ink },
});
