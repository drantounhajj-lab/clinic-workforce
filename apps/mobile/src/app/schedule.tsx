import { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Button, Card, Label, Muted, Tag } from "../components/ui";
import { fmtDay, fmtTime, weekStartOf } from "../format";
import { useMyClinics, useSession } from "../session";
import { type Shift, supabase } from "../supabase";
import { colors, space } from "../theme";

export default function ScheduleScreen() {
  const { t, lang, employments } = useSession();
  const clinics = useMyClinics();
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const empIds = employments.map((e) => e.id);
    if (!empIds.length) return;
    const since = new Date(Date.now() - 12 * 3600_000).toISOString();
    const { data, error: err } = await supabase.from("shifts").select("*").in("employment_id", empIds).gt("ends_at", since).order("starts_at").limit(60);
    if (err) setError(err.message);
    else setShifts((data as Shift[]) ?? []);
  }, [employments]);

  useEffect(() => {
    load();
  }, [load]);

  async function respond(id: string, response: "confirmed" | "declined") {
    const { data, error: err } = await supabase.rpc("respond_to_shift", { p_shift_id: id, p_response: response });
    if (err || !data?.ok) setError(err?.message ?? t.error);
    else load();
  }

  const weeks = new Map<string, Shift[]>();
  for (const s of shifts) {
    const w = weekStartOf(s.starts_at);
    weeks.set(w, [...(weeks.get(w) ?? []), s]);
  }
  const nameOf = (id: string) => clinics.find((c) => c.id === id)?.name ?? "";

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
    >
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {weeks.size === 0 && <Muted>{t.noSchedule}</Muted>}
      {[...weeks.entries()].map(([week, list]) => (
        <Card key={week}>
          <Label>{t.weekOf(fmtDay(`${week}T12:00:00Z`, lang).replace(/^\S+\s/, ""))}</Label>
          {list.map((s) => (
            <View key={s.id} style={styles.row}>
              <View style={styles.info}>
                <Text style={styles.day}>{fmtDay(s.starts_at, lang, undefined, false)}</Text>
                <Text style={styles.time}>
                  {fmtTime(s.starts_at)}–{fmtTime(s.ends_at)}
                  {s.unpaid_break_minutes ? ` · ${s.unpaid_break_minutes} min` : ""}
                </Text>
                <Text style={styles.small}>{nameOf(s.location_id)}</Text>
              </View>
              {s.response !== "pending" ? (
                <Tag text={s.response === "confirmed" ? t.confirmed : t.declined} tone={s.response === "confirmed" ? "ok" : "error"} />
              ) : Date.parse(s.starts_at) > Date.now() ? (
                <View style={styles.actions}>
                  <Button variant="primary" title={t.confirm} onPress={() => respond(s.id, "confirmed")} />
                  <Button title={t.decline} onPress={() => respond(s.id, "declined")} />
                </View>
              ) : null}
            </View>
          ))}
        </Card>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: space.md, gap: space.md },
  row: { borderTopWidth: 1, borderTopColor: colors.line, paddingVertical: space.sm, gap: space.sm },
  info: { gap: 2 },
  day: { fontSize: 15, fontWeight: "600", color: colors.ink, textTransform: "capitalize" },
  time: { fontSize: 15, color: colors.ink, fontVariant: ["tabular-nums"] },
  small: { fontSize: 12, color: colors.muted },
  actions: { flexDirection: "row", gap: space.sm },
  error: { color: colors.error },
});
