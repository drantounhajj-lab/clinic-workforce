import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { DateTimeField } from "../components/DateTimeField";
import { Button, Card, Label, Muted, Result, Segmented, Tag } from "../components/ui";
import { fmtDay, fmtTime } from "../format";
import { useMyClinics, useSession } from "../session";
import { supabase } from "../supabase";
import { colors, radius, space } from "../theme";

type TimeOffType = "vacation" | "sick" | "personal" | "unpaid" | "other";
const TYPES: TimeOffType[] = ["vacation", "sick", "personal", "unpaid", "other"];

interface MyTimeOff {
  id: string;
  type: TimeOffType;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  status: "pending" | "approved" | "refused" | "cancelled";
  manager_note: string | null;
}
interface MyCorrection {
  id: string;
  location_id: string;
  kind: "in" | "out";
  occurred_at: string;
  status: "pending" | "approved" | "refused" | "cancelled";
  manager_note: string | null;
}
interface Rule {
  weekday: number;
  start_time: string;
  end_time: string;
  status: "pending" | "approved" | "rejected";
}
interface DayAvail {
  on: boolean;
  start: Date;
  end: Date;
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const atTime = (h: number, m = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
};
const fromHm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return atTime(h, m);
};

export default function RequestsScreen() {
  const { t, lang, me } = useSession();
  const clinics = useMyClinics();
  const [section, setSection] = useState<"timeoff" | "availability" | "punch">("timeoff");
  const [refreshing, setRefreshing] = useState(false);

  // Time off
  const [type, setType] = useState<TimeOffType>("vacation");
  const [from, setFrom] = useState(() => new Date());
  const [to, setTo] = useState(() => new Date());
  const [partial, setPartial] = useState(false);
  const [fromTime, setFromTime] = useState(() => atTime(9));
  const [toTime, setToTime] = useState(() => atTime(12));
  const [note, setNote] = useState("");
  const [timeOff, setTimeOff] = useState<MyTimeOff[]>([]);
  // Availability
  const [days, setDays] = useState<DayAvail[]>(() => [0, 1, 2, 3, 4, 5, 6].map((i) => ({ on: i < 5, start: atTime(8), end: atTime(17) })));
  const [availStatus, setAvailStatus] = useState<"none" | "approved" | "pending">("none");
  // Missed punch
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [kind, setKind] = useState<"in" | "out">("in");
  const [punchDate, setPunchDate] = useState(() => new Date());
  const [punchTime, setPunchTime] = useState(() => atTime(9));
  const [reason, setReason] = useState("");
  const [corrections, setCorrections] = useState<MyCorrection[]>([]);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const clinic = clinics.find((c) => c.id === clinicId) ?? clinics[0];

  const load = useCallback(async () => {
    if (!me) return;
    const [off, rules, cor] = await Promise.all([
      supabase.from("time_off_requests").select("*").eq("person_id", me.id).order("start_date", { ascending: false }).limit(20),
      supabase.from("availability_rules").select("weekday, start_time, end_time, status").eq("person_id", me.id),
      supabase.from("punch_corrections").select("id, location_id, kind, occurred_at, status, manager_note").eq("person_id", me.id).order("created_at", { ascending: false }).limit(10),
    ]);
    setTimeOff((off.data as MyTimeOff[]) ?? []);
    setCorrections((cor.data as MyCorrection[]) ?? []);
    const list = (rules.data as Rule[]) ?? [];
    const pending = list.filter((r) => r.status === "pending");
    const approved = list.filter((r) => r.status === "approved");
    const shown = pending.length ? pending : approved;
    setAvailStatus(pending.length ? "pending" : approved.length ? "approved" : "none");
    if (shown.length) {
      setDays(
        [0, 1, 2, 3, 4, 5, 6].map((i) => {
          const r = shown.find((x) => x.weekday === i);
          return r ? { on: true, start: fromHm(r.start_time), end: fromHm(r.end_time) } : { on: false, start: atTime(8), end: atTime(17) };
        }),
      );
    }
  }, [me]);

  useEffect(() => {
    load();
  }, [load]);

  async function submitTimeOff() {
    setResult(null);
    const sameDay = ymd(from) === ymd(to);
    if (ymd(to) < ymd(from)) {
      setResult({ ok: false, text: t.requestErrors.invalid_dates });
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.rpc("request_time_off", {
      p_type: type,
      p_start: ymd(from),
      p_end: ymd(to),
      p_start_time: partial && sameDay ? hm(fromTime) : null,
      p_end_time: partial && sameDay ? hm(toTime) : null,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error || !data?.ok) setResult({ ok: false, text: error?.message ?? t.requestErrors[data?.reason] ?? t.error });
    else {
      setResult({ ok: true, text: t.requestSentManager });
      setNote("");
      load();
    }
  }

  async function cancelTimeOff(id: string) {
    await supabase.rpc("cancel_time_off", { p_id: id });
    load();
  }

  async function submitAvailability() {
    if (!me) return;
    setResult(null);
    const chosen = days.map((d, i) => ({ ...d, i })).filter((d) => d.on);
    if (chosen.length === 0) {
      setResult({ ok: false, text: t.availabilityNeedOneDay });
      return;
    }
    if (chosen.some((d) => hm(d.end) <= hm(d.start))) {
      setResult({ ok: false, text: t.endAfterStart });
      return;
    }
    setBusy(true);
    const del = await supabase.from("availability_rules").delete().eq("person_id", me.id).eq("status", "pending");
    const ins = del.error
      ? del
      : await supabase.from("availability_rules").insert(chosen.map((d) => ({ person_id: me.id, weekday: d.i, start_time: hm(d.start), end_time: hm(d.end) })));
    setBusy(false);
    if (ins.error) setResult({ ok: false, text: ins.error.message });
    else {
      setResult({ ok: true, text: t.requestSentManager });
      load();
    }
  }

  async function submitPunch() {
    if (!clinic) return;
    setResult(null);
    const when = new Date(punchDate);
    when.setHours(punchTime.getHours(), punchTime.getMinutes(), 0, 0);
    setBusy(true);
    const { data, error } = await supabase.rpc("request_punch_correction", {
      p_location_id: clinic.id,
      p_kind: kind,
      p_occurred_at: when.toISOString(),
      p_reason: reason,
    });
    setBusy(false);
    if (error || !data?.ok) setResult({ ok: false, text: error?.message ?? t.requestErrors[data?.reason] ?? t.error });
    else {
      setResult({ ok: true, text: t.requestSentManager });
      setReason("");
      load();
    }
  }

  const statusTag = (s: string) => <Tag text={t.requestStatus[s]} tone={s === "approved" ? "ok" : s === "pending" ? "warn" : s === "refused" ? "error" : "ink"} />;
  const range = (r: MyTimeOff) =>
    `${fmtDay(`${r.start_date}T12:00:00Z`, lang)}${r.end_date !== r.start_date ? ` → ${fmtDay(`${r.end_date}T12:00:00Z`, lang)}` : ""}${r.start_time ? ` · ${r.start_time.slice(0, 5)}–${r.end_time?.slice(0, 5)}` : ""}`;
  const today = ymd(new Date());

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <Segmented
        options={[
          { value: "timeoff", label: t.timeOffTab },
          { value: "availability", label: t.availabilityTab },
          { value: "punch", label: t.punchTab },
        ]}
        value={section}
        onChange={(v) => {
          setSection(v);
          setResult(null);
        }}
      />

      {section === "timeoff" && (
        <>
          <Card>
            <Label>{t.timeOffTitle}</Label>
            <View style={styles.chips}>
              {TYPES.map((x) => (
                <Pressable
                  key={x}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: type === x }}
                  onPress={() => setType(x)}
                  style={[styles.chip, type === x && styles.chipOn]}
                >
                  <Text style={[styles.chipText, type === x && styles.chipTextOn]}>{t.timeOffTypes[x]}</Text>
                </Pressable>
              ))}
            </View>
            <DateTimeField label={t.fromDate} mode="date" value={from} lang={lang} onChange={(d) => { setFrom(d); if (ymd(d) > ymd(to)) setTo(d); }} />
            <DateTimeField label={t.toDate} mode="date" value={to} lang={lang} minimumDate={from} onChange={setTo} />
            {ymd(from) === ymd(to) && (
              <View style={styles.switchRow}>
                <Text style={styles.option}>{t.partOfDay}</Text>
                <Switch value={partial} onValueChange={setPartial} accessibilityLabel={t.partOfDay} />
              </View>
            )}
            {partial && ymd(from) === ymd(to) && (
              <>
                <DateTimeField label={t.fromTime} mode="time" value={fromTime} lang={lang} onChange={setFromTime} />
                <DateTimeField label={t.toTime} mode="time" value={toTime} lang={lang} onChange={setToTime} />
              </>
            )}
            <TextInput style={styles.input} value={note} onChangeText={setNote} placeholder={t.noteOptional} maxLength={500} multiline accessibilityLabel={t.noteOptional} />
            <Button variant="primary" title={t.sendRequest} busy={busy} onPress={submitTimeOff} />
            {result && <Result ok={result.ok} title={result.text} />}
          </Card>
          <Card>
            <Label>{t.myRequests}</Label>
            {timeOff.length === 0 && <Muted>{t.noRequests}</Muted>}
            {timeOff.map((r) => (
              <View key={r.id} style={styles.item}>
                <Text style={styles.itemTitle}>{t.timeOffTypes[r.type]}</Text>
                <Text style={styles.small}>{range(r)}</Text>
                <View style={styles.actions}>
                  {statusTag(r.status)}
                  {(r.status === "pending" || (r.status === "approved" && r.start_date > today)) && (
                    <Button variant="ghost" title={t.cancelRequest} onPress={() => cancelTimeOff(r.id)} />
                  )}
                </View>
                {r.manager_note ? <Muted small>« {r.manager_note} »</Muted> : null}
              </View>
            ))}
          </Card>
        </>
      )}

      {section === "availability" && (
        <Card>
          <Label>{t.availabilityTitle}</Label>
          <Muted small>{t.availabilityHint}</Muted>
          {availStatus === "pending" && <Tag text={t.availabilityPending} tone="warn" />}
          {availStatus === "approved" && <Tag text={t.availabilityApproved} tone="ok" />}
          {days.map((d, i) => (
            <View key={i} style={styles.dayBlock}>
              <View style={styles.switchRow}>
                <Text style={styles.option}>{t.daysLong[i]}</Text>
                <Switch
                  value={d.on}
                  onValueChange={(v) => setDays(days.map((x, j) => (j === i ? { ...x, on: v } : x)))}
                  accessibilityLabel={t.daysLong[i]}
                />
              </View>
              {d.on && (
                <>
                  <DateTimeField label={t.fromTime} mode="time" value={d.start} lang={lang} onChange={(v) => setDays(days.map((x, j) => (j === i ? { ...x, start: v } : x)))} />
                  <DateTimeField label={t.toTime} mode="time" value={d.end} lang={lang} onChange={(v) => setDays(days.map((x, j) => (j === i ? { ...x, end: v } : x)))} />
                </>
              )}
            </View>
          ))}
          <Button variant="primary" title={t.sendRequest} busy={busy} onPress={submitAvailability} />
          {result && <Result ok={result.ok} title={result.text} />}
        </Card>
      )}

      {section === "punch" && (
        <>
          <Card>
            <Label>{t.missedPunchTitle}</Label>
            <Muted small>{t.missedPunchHint}</Muted>
            {clinics.length > 1 && <Segmented options={clinics.map((c) => ({ value: c.id, label: c.name }))} value={clinic?.id ?? ""} onChange={setClinicId} />}
            <Segmented
              options={[
                { value: "in", label: t.in },
                { value: "out", label: t.out },
              ]}
              value={kind}
              onChange={setKind}
            />
            <DateTimeField label={t.date} mode="date" value={punchDate} lang={lang} maximumDate={new Date()} onChange={setPunchDate} />
            <DateTimeField label={t.time} mode="time" value={punchTime} lang={lang} onChange={setPunchTime} />
            <TextInput style={styles.input} value={reason} onChangeText={setReason} placeholder={t.reasonRequired} maxLength={500} multiline accessibilityLabel={t.reasonRequired} />
            <Button variant="primary" title={t.sendRequest} busy={busy} onPress={submitPunch} />
            {result && <Result ok={result.ok} title={result.text} />}
          </Card>
          <Card>
            <Label>{t.myRequests}</Label>
            {corrections.length === 0 && <Muted>{t.noRequests}</Muted>}
            {corrections.map((c) => (
              <View key={c.id} style={styles.item}>
                <Text style={styles.itemTitle}>
                  {c.kind === "in" ? t.in : t.out} · {fmtDay(c.occurred_at, lang)} {fmtTime(c.occurred_at)}
                </Text>
                <Text style={styles.small}>{clinics.find((x) => x.id === c.location_id)?.name ?? ""}</Text>
                <View style={styles.actions}>{statusTag(c.status)}</View>
                {c.manager_note ? <Muted small>« {c.manager_note} »</Muted> : null}
              </View>
            ))}
          </Card>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: space.md, gap: space.md, paddingBottom: space.xl * 2 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: { borderWidth: 1, borderColor: colors.line, borderRadius: 20, paddingHorizontal: space.md, paddingVertical: 8, backgroundColor: colors.surface },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 14, color: colors.ink },
  chipTextOn: { color: colors.surface },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  option: { fontSize: 15, fontWeight: "600", color: colors.ink, textTransform: "capitalize" },
  dayBlock: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: 60,
    fontSize: 15,
    color: colors.ink,
    backgroundColor: colors.surface,
    textAlignVertical: "top",
  },
  item: { borderTopWidth: 1, borderTopColor: colors.line, paddingVertical: space.sm, gap: 4 },
  itemTitle: { fontSize: 15, fontWeight: "600", color: colors.ink },
  small: { fontSize: 12, color: colors.muted, textTransform: "capitalize" },
  actions: { flexDirection: "row", gap: space.sm, alignItems: "center", flexWrap: "wrap" },
});
