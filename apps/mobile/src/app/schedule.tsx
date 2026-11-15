import { addDays, weekdayOf } from "@clinic-workforce/rules";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { clinicById, fmtDay, myShifts, personById, shiftEnd } from "../clinics";
import { PersonPicker } from "../components/PersonPicker";
import { Button, Card, Label, Muted, Tag } from "../components/ui";
import { useSettings } from "../settings";
import { colors, space } from "../theme";

export default function ScheduleScreen() {
  const { settings, t, ready } = useSettings();
  const [status, setStatus] = useState<Record<string, "confirmed" | "declined">>({});
  if (!ready) return null;
  const person = personById(settings.personId);
  if (!person) {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <PersonPicker />
      </ScrollView>
    );
  }

  const now = new Date();
  const upcoming = myShifts(person.id).filter((s) => shiftEnd(s) > now);
  const weeks = new Map<string, typeof upcoming>();
  for (const s of upcoming) {
    const w = addDays(s.date, -weekdayOf(s.date));
    weeks.set(w, [...(weeks.get(w) ?? []), s]);
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Muted small>{t.sampleSchedule}</Muted>
      {[...weeks.entries()].map(([week, list]) => (
        <Card key={week}>
          <Label>{t.weekOf(fmtDay(week, settings.lang, t.daysLong).replace(/^\S+ /, ""))}</Label>
          {list.map((s) => {
            const c = clinicById(s.locationId);
            const st = status[s.id];
            return (
              <View key={s.id} style={styles.row}>
                <View style={styles.info}>
                  <Text style={styles.day}>{fmtDay(s.date, settings.lang, t.daysLong, false)}</Text>
                  <Text style={styles.time}>
                    {s.start}–{s.end}
                  </Text>
                  <Text style={styles.small}>
                    {c.name} · {c.companyName}
                  </Text>
                </View>
                {st ? (
                  <Tag text={st === "confirmed" ? t.confirmed : t.declined} tone={st === "confirmed" ? "ok" : "error"} />
                ) : (
                  <View style={styles.actions}>
                    <Button variant="primary" title={t.confirm} onPress={() => setStatus({ ...status, [s.id]: "confirmed" })} />
                    <Button title={t.decline} onPress={() => setStatus({ ...status, [s.id]: "declined" })} />
                  </View>
                )}
              </View>
            );
          })}
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
});
