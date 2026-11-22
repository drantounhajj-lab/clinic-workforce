import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { DateTimeField } from "../components/DateTimeField";
import { Button, Card, Label, Muted, Result, Segmented, Tag } from "../components/ui";
import { fmtDay, fmtTime } from "../format";
import { useMyClinics, useSession } from "../session";
import { supabase } from "../supabase";
import { colors, radius, space } from "../theme";

interface LeaveType {
  id: string;
  name_fr: string;
  name_en: string;
  category: string;
}
interface MyTimeOff {
  id: string;
  type: string;
  leave_type_id: string | null;
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
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  status: "pending" | "approved" | "rejected";
  kind: "available" | "unavailable";
  effective_from: string;
  effective_to: string | null;
  every_weeks: number;
  anchor_week: string | null;
  location_ids: string[] | null;
}
interface OneOff {
  id: string;
  date: string;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  kind: "available" | "unavailable";
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
/** Monday of the week of a date, as YYYY-MM-DD. */
const mondayOf = (d: Date) => {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return ymd(x);
};
const plusDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
};
const emptyWeek = (on: boolean): DayAvail[] => [0, 1, 2, 3, 4, 5, 6].map((i) => ({ on: on && i < 5, start: atTime(8), end: atTime(17) }));

type Section = "available" | "unavailable" | "timeoff" | "punch";

export default function RequestsScreen() {
  const { t, lang, me } = useSession();
  const clinics = useMyClinics();
  const [section, setSection] = useState<Section>("available");
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Lists
  const [rules, setRules] = useState<Rule[]>([]);
  const [oneOffs, setOneOffs] = useState<OneOff[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([]);
  const [timeOff, setTimeOff] = useState<MyTimeOff[]>([]);
  const [corrections, setCorrections] = useState<MyCorrection[]>([]);

  // Shared date fields (available / unavailable one-off, time off)
  const [weekly, setWeekly] = useState(true);
  const [from, setFrom] = useState(() => new Date());
  const [to, setTo] = useState(() => new Date());
  const [partial, setPartial] = useState(false);
  const [fromTime, setFromTime] = useState(() => atTime(9));
  const [toTime, setToTime] = useState(() => atTime(12));
  // Weekly availability
  const [weekA, setWeekA] = useState<DayAvail[]>(() => emptyWeek(true));
  const [weekB, setWeekB] = useState<DayAvail[]>(() => emptyWeek(true));
  const [alternate, setAlternate] = useState(false);
  const [startsOn, setStartsOn] = useState(() => new Date());
  const [hasEnd, setHasEnd] = useState(false);
  const [endsOn, setEndsOn] = useState(() => new Date(Date.now() + 90 * 86_400_000));
  const [onlyAt, setOnlyAt] = useState<string[]>([]);
  // Weekly unavailability
  const [unDay, setUnDay] = useState(0);
  const [unAllDay, setUnAllDay] = useState(true);
  // Time off
  const [leaveTypeId, setLeaveTypeId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  // Missed punch
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [kind, setKind] = useState<"in" | "out">("in");
  const [punchDate, setPunchDate] = useState(() => new Date());
  const [punchTime, setPunchTime] = useState(() => atTime(9));
  const [reason, setReason] = useState("");
  const clinic = clinics.find((c) => c.id === clinicId) ?? clinics[0];

  const load = useCallback(async () => {
    if (!me) return;
    const [off, ru, ex, lt, cor] = await Promise.all([
      supabase.from("time_off_requests").select("*").eq("person_id", me.id).order("start_date", { ascending: false }).limit(20),
      supabase.from("availability_rules").select("*").eq("person_id", me.id).order("weekday"),
      supabase.from("availability_exceptions").select("*").eq("person_id", me.id).gte("date", plusDays(ymd(new Date()), -30)).order("date"),
      supabase.from("leave_types").select("id, name_fr, name_en, category").eq("active", true).order("sort"),
      supabase.from("punch_corrections").select("id, location_id, kind, occurred_at, status, manager_note").eq("person_id", me.id).order("created_at", { ascending: false }).limit(10),
    ]);
    setTimeOff((off.data as MyTimeOff[]) ?? []);
    setOneOffs((ex.data as OneOff[]) ?? []);
    setCorrections((cor.data as MyCorrection[]) ?? []);
    const types = (lt.data as LeaveType[]) ?? [];
    setLeaveTypes(types);
    setLeaveTypeId((cur) => cur ?? types[0]?.id ?? null);
    const list = (ru.data as Rule[]) ?? [];
    setRules(list);
    // Show the pending pattern if there is one, otherwise the one in effect.
    const today = ymd(new Date());
    const pending = list.filter((r) => r.status === "pending" && r.kind === "available");
    const current = list.filter((r) => r.status === "approved" && r.kind === "available" && (!r.effective_to || r.effective_to >= today));
    const shown = pending.length ? pending : current;
    if (shown.length) {
      const alt = shown.some((r) => r.every_weeks === 2);
      const anchors = [...new Set(shown.filter((r) => r.every_weeks === 2).map((r) => r.anchor_week ?? ""))].sort();
      const fill = (pick: (r: Rule) => boolean) =>
        [0, 1, 2, 3, 4, 5, 6].map((i) => {
          const r = shown.find((x) => x.weekday === i && pick(x));
          return r ? { on: true, start: fromHm(r.start_time), end: fromHm(r.end_time) } : { on: false, start: atTime(8), end: atTime(17) };
        });
      setAlternate(alt);
      setWeekA(fill((r) => !alt || r.anchor_week === anchors[0]));
      if (alt) setWeekB(fill((r) => r.anchor_week === anchors[1]));
      setOnlyAt(shown[0].location_ids ?? []);
    }
  }, [me]);

  useEffect(() => {
    load();
  }, [load]);

  const fail = (text: string) => setResult({ ok: false, text });
  const done = async () => {
    setResult({ ok: true, text: t.requestSentManager });
    await load();
  };

  /** Send a new weekly pattern: the rules of this kind, plus the current rules of the other kind kept as they are. */
  async function submitWeekly(kindNow: "available" | "unavailable", newRules: Omit<Rule, "id" | "status" | "effective_from" | "effective_to">[]) {
    if (!me) return;
    const effectiveFrom = ymd(startsOn);
    const effectiveTo = hasEnd ? ymd(endsOn) : null;
    if (effectiveTo && effectiveTo < effectiveFrom) return fail(t.requestErrors.invalid_dates);
    const today = ymd(new Date());
    const keep = rules
      .filter((r) => r.status === "approved" && r.kind !== kindNow && (!r.effective_to || r.effective_to >= effectiveFrom) && (r.effective_from <= today || r.effective_from <= effectiveFrom))
      .map((r) => ({ weekday: r.weekday, start_time: r.start_time, end_time: r.end_time, kind: r.kind, every_weeks: r.every_weeks, anchor_week: r.anchor_week, location_ids: r.location_ids }));
    setBusy(true);
    const del = await supabase.from("availability_rules").delete().eq("person_id", me.id).eq("status", "pending");
    const ins = del.error
      ? del
      : await supabase
          .from("availability_rules")
          .insert(
            [...newRules, ...keep].map((r) => ({ person_id: me.id, effective_from: effectiveFrom, effective_to: effectiveTo, ...r })),
            { defaultToNull: false },
          );
    setBusy(false);
    if (ins.error) fail(ins.error.message);
    else await done();
  }

  async function submitAvailablePattern() {
    const anchor = mondayOf(startsOn);
    const toRules = (days: DayAvail[], everyWeeks: number, anchorWeek: string | null) =>
      days
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => d.on)
        .map(({ d, i }) => ({
          weekday: i,
          start_time: hm(d.start),
          end_time: hm(d.end),
          kind: "available" as const,
          every_weeks: everyWeeks,
          anchor_week: anchorWeek,
          location_ids: onlyAt.length && onlyAt.length < clinics.length ? onlyAt : null,
        }));
    const list = alternate ? [...toRules(weekA, 2, anchor), ...toRules(weekB, 2, plusDays(anchor, 7))] : toRules(weekA, 1, null);
    if (list.length === 0) return fail(t.availabilityNeedOneDay);
    if (list.some((r) => r.end_time <= r.start_time)) return fail(t.endAfterStart);
    await submitWeekly("available", list);
  }

  async function submitWeeklyUnavailable() {
    const start = unAllDay ? "00:00" : hm(fromTime);
    const end = unAllDay ? "23:59" : hm(toTime);
    if (end <= start) return fail(t.endAfterStart);
    const existing = rules
      .filter((r) => r.status === "approved" && r.kind === "unavailable" && (!r.effective_to || r.effective_to >= ymd(startsOn)))
      .map((r) => ({ weekday: r.weekday, start_time: r.start_time, end_time: r.end_time, kind: r.kind, every_weeks: r.every_weeks, anchor_week: r.anchor_week, location_ids: r.location_ids }));
    await submitWeekly("unavailable", [...existing, { weekday: unDay, start_time: start, end_time: end, kind: "unavailable", every_weeks: 1, anchor_week: null, location_ids: null }]);
  }

  async function submitOneOff(k: "available" | "unavailable") {
    if (!me) return;
    if (ymd(to) < ymd(from)) return fail(t.requestErrors.invalid_dates);
    const sameDay = ymd(from) === ymd(to);
    const withTimes = partial && (k === "available" || sameDay);
    if (withTimes && hm(toTime) <= hm(fromTime)) return fail(t.endAfterStart);
    setBusy(true);
    const { error } = await supabase.from("availability_exceptions").insert({
      person_id: me.id,
      date: ymd(from),
      end_date: sameDay ? null : ymd(to),
      start_time: withTimes ? hm(fromTime) : null,
      end_time: withTimes ? hm(toTime) : null,
      kind: k,
    });
    setBusy(false);
    if (error) fail(error.message);
    else await done();
  }

  async function withdrawOneOff(id: string) {
    await supabase.from("availability_exceptions").delete().eq("id", id).eq("status", "pending");
    await load();
  }

  async function withdrawPattern() {
    if (!me) return;
    await supabase.from("availability_rules").delete().eq("person_id", me.id).eq("status", "pending");
    await load();
  }

  async function submitTimeOff() {
    setResult(null);
    if (!leaveTypeId) return fail(t.error);
    const sameDay = ymd(from) === ymd(to);
    if (ymd(to) < ymd(from)) return fail(t.requestErrors.invalid_dates);
    setBusy(true);
    const { data, error } = await supabase.rpc("request_leave", {
      p_leave_type_id: leaveTypeId,
      p_start: ymd(from),
      p_end: ymd(to),
      p_start_time: partial && sameDay ? hm(fromTime) : null,
      p_end_time: partial && sameDay ? hm(toTime) : null,
      p_reason: note.trim() || null,
    });
    setBusy(false);
    if (error || !data?.ok) fail(error?.message ?? t.requestErrors[data?.reason] ?? t.error);
    else {
      setNote("");
      await done();
    }
  }

  async function cancelTimeOff(id: string) {
    await supabase.rpc("cancel_time_off", { p_id: id });
    await load();
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
    if (error || !data?.ok) fail(error?.message ?? t.requestErrors[data?.reason] ?? t.error);
    else {
      setReason("");
      await done();
    }
  }

  const statusTag = (s: string) => <Tag text={t.requestStatus[s]} tone={s === "approved" ? "ok" : s === "pending" ? "warn" : s === "refused" || s === "rejected" ? "error" : "ink"} />;
  const dayLabel = (d: string) => fmtDay(`${d}T12:00:00Z`, lang);
  const range = (r: { start_date: string; end_date: string | null; start_time: string | null; end_time: string | null }) =>
    `${dayLabel(r.start_date)}${r.end_date && r.end_date !== r.start_date ? ` → ${dayLabel(r.end_date)}` : ""}${r.start_time ? ` · ${r.start_time.slice(0, 5)}–${r.end_time?.slice(0, 5)}` : ""}`;
  const today = ymd(new Date());
  const leaveName = (r: MyTimeOff) => {
    const lt = leaveTypes.find((x) => x.id === r.leave_type_id);
    return lt ? (lang === "fr" ? lt.name_fr : lt.name_en) : t.timeOffTypes[r.type] ?? r.type;
  };
  const pendingPattern = rules.filter((r) => r.status === "pending");
  const weeklyUnavailable = rules.filter((r) => r.kind === "unavailable" && r.status !== "rejected" && (!r.effective_to || r.effective_to >= today));

  const dateFields = (allowPartialRange: boolean) => (
    <>
      <DateTimeField label={t.fromDate} mode="date" value={from} lang={lang} onChange={(d) => { setFrom(d); if (ymd(d) > ymd(to)) setTo(d); }} />
      <DateTimeField label={t.toDate} mode="date" value={to} lang={lang} minimumDate={from} onChange={setTo} />
      {(allowPartialRange || ymd(from) === ymd(to)) && (
        <View style={styles.switchRow}>
          <Text style={styles.option}>{t.partOfDay}</Text>
          <Switch value={partial} onValueChange={setPartial} accessibilityLabel={t.partOfDay} />
        </View>
      )}
      {partial && (allowPartialRange || ymd(from) === ymd(to)) && (
        <>
          <DateTimeField label={t.fromTime} mode="time" value={fromTime} lang={lang} onChange={setFromTime} />
          <DateTimeField label={t.toTime} mode="time" value={toTime} lang={lang} onChange={setToTime} />
        </>
      )}
    </>
  );

  const weekEditor = (days: DayAvail[], set: (d: DayAvail[]) => void) =>
    days.map((d, i) => (
      <View key={i} style={styles.dayBlock}>
        <View style={styles.switchRow}>
          <Text style={styles.option}>{t.daysLong[i]}</Text>
          <Switch value={d.on} onValueChange={(v) => set(days.map((x, j) => (j === i ? { ...x, on: v } : x)))} accessibilityLabel={t.daysLong[i]} />
        </View>
        {d.on && (
          <>
            <DateTimeField label={t.fromTime} mode="time" value={d.start} lang={lang} onChange={(v) => set(days.map((x, j) => (j === i ? { ...x, start: v } : x)))} />
            <DateTimeField label={t.toTime} mode="time" value={d.end} lang={lang} onChange={(v) => set(days.map((x, j) => (j === i ? { ...x, end: v } : x)))} />
          </>
        )}
      </View>
    ));

  const effectiveFields = (
    <>
      <DateTimeField label={t.startsOn} mode="date" value={startsOn} lang={lang} onChange={setStartsOn} />
      <View style={styles.switchRow}>
        <Text style={styles.option}>{t.hasEndDate}</Text>
        <Switch value={hasEnd} onValueChange={setHasEnd} accessibilityLabel={t.hasEndDate} />
      </View>
      {hasEnd && <DateTimeField label={t.endsOn} mode="date" value={endsOn} lang={lang} minimumDate={startsOn} onChange={setEndsOn} />}
    </>
  );

  const oneOffList = (k: "available" | "unavailable") => {
    const list = oneOffs.filter((x) => x.kind === k);
    if (!list.length) return null;
    return (
      <Card>
        <Label>{t.myRequests}</Label>
        {list.map((x) => (
          <View key={x.id} style={styles.item}>
            <Text style={styles.itemTitle}>{range({ start_date: x.date, end_date: x.end_date, start_time: x.start_time, end_time: x.end_time })}</Text>
            <View style={styles.actions}>
              {statusTag(x.status)}
              {x.status === "pending" && <Button variant="ghost" title={t.withdraw} onPress={() => withdrawOneOff(x.id)} />}
            </View>
          </View>
        ))}
      </Card>
    );
  };

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
          { value: "available", label: t.availableTab },
          { value: "unavailable", label: t.unavailableTab },
          { value: "timeoff", label: t.timeOffTab },
          { value: "punch", label: t.punchTab },
        ]}
        value={section}
        onChange={(v) => {
          setSection(v);
          setResult(null);
          setPartial(false);
        }}
      />

      {section === "available" && (
        <>
          <Card>
            <Label>{t.imAvailable}</Label>
            <Segmented
              options={[
                { value: "weekly", label: t.everyWeek },
                { value: "once", label: t.specificDates },
              ]}
              value={weekly ? "weekly" : "once"}
              onChange={(v) => setWeekly(v === "weekly")}
            />
            {weekly ? (
              <>
                <Muted small>{t.availabilityHint}</Muted>
                {pendingPattern.length > 0 && (
                  <View style={styles.actions}>
                    <Tag text={t.availabilityPending} tone="warn" />
                    <Button variant="ghost" title={t.withdraw} onPress={withdrawPattern} />
                  </View>
                )}
                {effectiveFields}
                <View style={styles.switchRow}>
                  <Text style={styles.option}>{t.alternateWeeks}</Text>
                  <Switch value={alternate} onValueChange={setAlternate} accessibilityLabel={t.alternateWeeks} />
                </View>
                {alternate && <Text style={styles.weekTitle}>{t.weekA(dayLabel(mondayOf(startsOn)))}</Text>}
                {weekEditor(weekA, setWeekA)}
                {alternate && (
                  <>
                    <Text style={styles.weekTitle}>{t.weekB(dayLabel(plusDays(mondayOf(startsOn), 7)))}</Text>
                    {weekEditor(weekB, setWeekB)}
                  </>
                )}
                {clinics.length > 1 && (
                  <>
                    <Text style={styles.option}>{t.atClinics}</Text>
                    <View style={styles.chips}>
                      {clinics.map((c) => {
                        const on = onlyAt.length === 0 || onlyAt.includes(c.id);
                        return (
                          <Pressable
                            key={c.id}
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: on }}
                            onPress={() => {
                              const all = onlyAt.length === 0 ? clinics.map((x) => x.id) : onlyAt;
                              const next = on ? all.filter((x) => x !== c.id) : [...all, c.id];
                              setOnlyAt(next.length === clinics.length ? [] : next.length === 0 ? all : next);
                            }}
                            style={[styles.chip, on && styles.chipOn]}
                          >
                            <Text style={[styles.chipText, on && styles.chipTextOn]}>{c.name}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </>
                )}
                <Button variant="primary" title={t.sendRequest} busy={busy} onPress={submitAvailablePattern} />
              </>
            ) : (
              <>
                <Muted small>{t.extraAvailabilityHint}</Muted>
                {dateFields(true)}
                <Button variant="primary" title={t.sendRequest} busy={busy} onPress={() => submitOneOff("available")} />
              </>
            )}
            {result && <Result ok={result.ok} title={result.text} />}
          </Card>
          {!weekly && oneOffList("available")}
        </>
      )}

      {section === "unavailable" && (
        <>
          <Card>
            <Label>{t.imUnavailable}</Label>
            <Segmented
              options={[
                { value: "once", label: t.specificDates },
                { value: "weekly", label: t.everyWeek },
              ]}
              value={weekly ? "weekly" : "once"}
              onChange={(v) => setWeekly(v === "weekly")}
            />
            {weekly ? (
              <>
                <Muted small>{t.weeklyUnavailableHint}</Muted>
                <View style={styles.chips}>
                  {t.daysShort.map((d, i) => (
                    <Pressable
                      key={d}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: unDay === i }}
                      onPress={() => setUnDay(i)}
                      style={[styles.chip, unDay === i && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, unDay === i && styles.chipTextOn]}>{d}</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.switchRow}>
                  <Text style={styles.option}>{t.allDay}</Text>
                  <Switch value={unAllDay} onValueChange={setUnAllDay} accessibilityLabel={t.allDay} />
                </View>
                {!unAllDay && (
                  <>
                    <DateTimeField label={t.fromTime} mode="time" value={fromTime} lang={lang} onChange={setFromTime} />
                    <DateTimeField label={t.toTime} mode="time" value={toTime} lang={lang} onChange={setToTime} />
                  </>
                )}
                {effectiveFields}
                <Button variant="primary" title={t.sendRequest} busy={busy} onPress={submitWeeklyUnavailable} />
                {weeklyUnavailable.length > 0 && (
                  <View style={styles.item}>
                    {weeklyUnavailable.map((r) => (
                      <View key={r.id} style={styles.actions}>
                        <Text style={styles.small}>
                          {t.daysLong[r.weekday]} {r.start_time.slice(0, 5) === "00:00" && r.end_time.slice(0, 5) === "23:59" ? t.allDay.toLowerCase() : `${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}`}
                        </Text>
                        {statusTag(r.status)}
                      </View>
                    ))}
                  </View>
                )}
              </>
            ) : (
              <>
                <Muted small>{t.unavailableHint}</Muted>
                {dateFields(false)}
                <Button variant="primary" title={t.sendRequest} busy={busy} onPress={() => submitOneOff("unavailable")} />
              </>
            )}
            {result && <Result ok={result.ok} title={result.text} />}
          </Card>
          {!weekly && oneOffList("unavailable")}
        </>
      )}

      {section === "timeoff" && (
        <>
          <Card>
            <Label>{t.timeOffTitle}</Label>
            <View style={styles.chips}>
              {leaveTypes.map((x) => (
                <Pressable
                  key={x.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: leaveTypeId === x.id }}
                  onPress={() => setLeaveTypeId(x.id)}
                  style={[styles.chip, leaveTypeId === x.id && styles.chipOn]}
                >
                  <Text style={[styles.chipText, leaveTypeId === x.id && styles.chipTextOn]}>{lang === "fr" ? x.name_fr : x.name_en}</Text>
                </Pressable>
              ))}
            </View>
            {dateFields(false)}
            <TextInput style={styles.input} value={note} onChangeText={setNote} placeholder={t.reasonOptional} maxLength={500} multiline accessibilityLabel={t.reasonOptional} />
            <Muted small>{t.reasonPrivateHint}</Muted>
            <Button variant="primary" title={t.sendRequest} busy={busy} onPress={submitTimeOff} />
            {result && <Result ok={result.ok} title={result.text} />}
          </Card>
          <Card>
            <Label>{t.myRequests}</Label>
            {timeOff.length === 0 && <Muted>{t.noRequests}</Muted>}
            {timeOff.map((r) => (
              <View key={r.id} style={styles.item}>
                <Text style={styles.itemTitle}>{leaveName(r)}</Text>
                <Text style={styles.small}>{range(r)}</Text>
                <View style={styles.actions}>
                  {statusTag(r.status)}
                  {(r.status === "pending" || (r.status === "approved" && r.start_date > today)) && (
                    <Button variant="ghost" title={r.status === "pending" ? t.withdraw : t.cancelRequest} onPress={() => cancelTimeOff(r.id)} />
                  )}
                </View>
                {r.manager_note ? <Muted small>« {r.manager_note} »</Muted> : null}
              </View>
            ))}
          </Card>
        </>
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
  chip: { borderWidth: 1, borderColor: colors.line, borderRadius: 20, paddingHorizontal: space.md, paddingVertical: 8, backgroundColor: colors.surface, minHeight: 40, justifyContent: "center" },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 14, color: colors.ink },
  chipTextOn: { color: colors.surface },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  option: { fontSize: 15, fontWeight: "600", color: colors.ink },
  weekTitle: { fontSize: 14, fontWeight: "700", color: colors.ink, marginTop: space.sm },
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
  small: { fontSize: 12, color: colors.muted },
  actions: { flexDirection: "row", gap: space.sm, alignItems: "center", flexWrap: "wrap" },
});
