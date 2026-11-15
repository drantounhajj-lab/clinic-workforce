import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { SafeAreaView } from "react-native-safe-area-context";
import { fmtTime } from "../format";
import { useSession } from "../session";
import { type PunchResult, supabase } from "../supabase";
import { colors, space } from "../theme";
import { Button, Muted, Result } from "./ui";

/** Shown on a device signed in anonymously: pairing first, then the punch station. */
export function Kiosk() {
  const { kiosk } = useSession();
  return kiosk ? <Station /> : <Pairing />;
}

function Pairing() {
  const { t, reload } = useSession();
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState("");

  const request = useCallback(async () => {
    setError("");
    const { data, error: err } = await supabase.rpc("kiosk_request_pairing");
    if (err) setError(err.message);
    else if (data?.ok) setCode(data.code);
    else if (data?.reason === "already_paired") await reload();
    else setError(String(data?.reason ?? t.error));
  }, [reload, t.error]);

  useEffect(() => {
    request();
  }, [request]);

  // Check every 3 seconds whether a manager has paired this device.
  useEffect(() => {
    const id = setInterval(async () => {
      const { data } = await supabase.rpc("kiosk_me");
      if (data) await reload();
    }, 3000);
    return () => clearInterval(id);
  }, [reload]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.center}>
        <Text style={styles.title}>{t.pairTitle}</Text>
        <Text style={styles.pairCode} accessibilityLabel={code ?? ""}>
          {code ? `${code.slice(0, 3)} ${code.slice(3)}` : "—"}
        </Text>
        <Muted>{t.pairHint}</Muted>
        <Muted small>{t.pairWaiting}</Muted>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button title={t.newCode} onPress={request} />
        <Button variant="ghost" title={t.cancel} onPress={() => supabase.auth.signOut()} />
      </View>
    </SafeAreaView>
  );
}

function Station() {
  const { t, kiosk } = useSession();
  const [qr, setQr] = useState<{ payload: string; code: string; until: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { width } = useWindowDimensions();
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshCode = useCallback(async () => {
    if (!kiosk) return;
    const { data } = await supabase.rpc("kiosk_current_code", { p_location_id: kiosk.location_id });
    if (data?.ok) setQr({ payload: data.payload, code: data.code, until: Date.now() + data.seconds_left * 1000 });
  }, [kiosk]);

  useEffect(() => {
    refreshCode();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [refreshCode]);

  useEffect(() => {
    if (qr && now >= qr.until) refreshCode();
  }, [now, qr, refreshCode]);

  function show(m: { ok: boolean; text: string }) {
    setMessage(m);
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setMessage(null), 6000);
  }

  async function submit(value: string) {
    setBusy(true);
    const { data, error } = await supabase.rpc("kiosk_punch", { p_pin: value });
    setBusy(false);
    setPin("");
    const r = data as PunchResult | null;
    if (error || !r) show({ ok: false, text: error?.message ?? t.error });
    else if (r.accepted) {
      const time = fmtTime(r.occurred_at ?? new Date(), kiosk?.timezone);
      show({ ok: true, text: r.kind === "in" ? t.kioskWelcomeIn(r.first_name ?? "", time) : t.kioskWelcomeOut(r.first_name ?? "", time) });
    } else show({ ok: false, text: t.kioskErrors[r.reason ?? ""] ?? t.error });
  }

  function press(d: string) {
    if (busy) return;
    setMessage(null);
    const next = (pin + d).slice(0, 6);
    setPin(next);
    if (next.length === 6) submit(next);
  }

  const secondsLeft = qr ? Math.max(0, Math.ceil((qr.until - now) / 1000)) : 30;
  const wide = width >= 700;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.page}>
        <Pressable delayLongPress={3000} onLongPress={() => supabase.auth.signOut()} accessibilityHint={t.kioskExit}>
          <View style={styles.head}>
            <Text style={styles.title}>{kiosk?.location_name}</Text>
            <Text style={styles.clock}>{fmtTime(new Date(now), kiosk?.timezone)}</Text>
          </View>
        </Pressable>

        <View style={[styles.body, wide && { flexDirection: "row" }]}>
          <View style={styles.panel}>
            <View style={styles.qrBox}>{qr ? <QRCode value={qr.payload} size={Math.min(wide ? 300 : width - 120, 320)} /> : null}</View>
            <Text style={styles.code}>{qr?.code ?? "······"}</Text>
            <Muted>{t.kioskScan}</Muted>
            <Muted small>{t.kioskChanges(secondsLeft)}</Muted>
          </View>

          <View style={styles.panel}>
            <Text style={styles.pinLabel}>{t.kioskPin}</Text>
            <View style={styles.dots}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <View key={i} style={[styles.dot, i < pin.length && styles.dotOn]} />
              ))}
            </View>
            <View style={styles.pad}>
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "OK"].map((d) => (
                <Pressable
                  key={d}
                  accessibilityRole="button"
                  accessibilityLabel={d === "C" ? t.clear : d}
                  onPress={() => (d === "C" ? (setPin(""), setMessage(null)) : d === "OK" ? pin.length >= 4 && submit(pin) : press(d))}
                  style={({ pressed }) => [styles.key, pressed && { backgroundColor: colors.accentSoft }]}
                >
                  <Text style={[styles.keyText, (d === "C" || d === "OK") && { fontSize: 16 }]}>{d === "C" ? t.clear : d}</Text>
                </Pressable>
              ))}
            </View>
            {message && <Result ok={message.ok} title={message.text} />}
          </View>
        </View>
        <Muted small>{t.kioskExit}</Muted>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl, gap: space.lg },
  page: { padding: space.xl, gap: space.lg },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  title: { fontSize: 28, fontWeight: "700", color: colors.ink },
  clock: { fontSize: 34, color: colors.ink, fontVariant: ["tabular-nums"] },
  pairCode: { fontSize: 56, fontWeight: "700", letterSpacing: 6, color: colors.ink, fontVariant: ["tabular-nums"] },
  error: { color: colors.error },
  body: { gap: space.xl },
  panel: { flex: 1, alignItems: "center", gap: space.md },
  qrBox: { padding: space.md, backgroundColor: "#FFFFFF", borderRadius: 16, borderWidth: 1, borderColor: colors.line, minHeight: 200, minWidth: 200 },
  code: { fontSize: 24, letterSpacing: 4, color: colors.ink, fontVariant: ["tabular-nums"] },
  pinLabel: { fontSize: 13, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.6 },
  dots: { flexDirection: "row", gap: space.md },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: colors.muted },
  dotOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  pad: { flexDirection: "row", flexWrap: "wrap", width: 3 * 84 + 2 * 12, gap: 12 },
  key: { width: 84, height: 70, borderRadius: 16, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  keyText: { fontSize: 26, fontWeight: "500", color: colors.ink },
});
