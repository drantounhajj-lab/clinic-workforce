import { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SwapSheet } from "../components/SwapSheet";
import { Button, Card, Label, Muted, Result, Tag } from "../components/ui";
import { fmtDay, fmtTime, weekStartOf } from "../format";
import { useMyClinics, useSession } from "../session";
import { fetchUpcomingShifts, loadPrefs, savePrefs, syncShifts } from "../shiftSync";
import { type MyOffer, type MySwap, type Shift, type SwapShift, supabase } from "../supabase";
import { colors, space } from "../theme";

export default function ScheduleScreen() {
  const { t, lang, employments, locations, jobRoles } = useSession();
  const clinics = useMyClinics();
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [swaps, setSwaps] = useState<MySwap[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [swapFor, setSwapFor] = useState<Shift | null>(null);
  const [calendarOn, setCalendarOn] = useState(true);
  const [calendarMsg, setCalendarMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openShifts, setOpenShifts] = useState<Shift[]>([]);
  const [myClaims, setMyClaims] = useState<{ shift_id: string; status: string }[]>([]);
  const [offers, setOffers] = useState<MyOffer[]>([]);
  const [offerMsg, setOfferMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const locIds = [...new Set(employments.flatMap((e) => e.employment_locations.map((x) => x.location_id)))];
      const none = Promise.resolve({ data: [] as unknown[] });
      const [list, mine, prefs, open, weeks, claims, offered] = await Promise.all([
        fetchUpcomingShifts(employments),
        supabase.rpc("my_swaps"),
        loadPrefs(),
        locIds.length
          ? supabase.from("shifts").select("*").is("employment_id", null).in("location_id", locIds).gt("starts_at", new Date().toISOString()).order("starts_at").limit(30)
          : none,
        locIds.length ? supabase.from("schedule_weeks").select("location_id, week_start").eq("status", "published").in("location_id", locIds) : none,
        supabase.from("shift_claims").select("shift_id, status"),
        supabase.rpc("my_offers"),
      ]);
      setOffers(((offered.data as MyOffer[]) ?? []).filter((o) => o.status === "invited" && o.offer_status === "open"));
      setShifts(list);
      setSwaps((mine.data as MySwap[]) ?? []);
      setCalendarOn(prefs.calendar);
      const published = new Set(((weeks.data as { location_id: string; week_start: string }[]) ?? []).map((w) => `${w.location_id}|${w.week_start}`));
      // Only shifts this person could take: published, and for no particular position or one they hold there.
      const fits = (x: Shift & { week_start: string }) =>
        !x.job_role_id ||
        employments.some((e) => e.employment_locations.some((l) => l.location_id === x.location_id) && (!e.job_role_id || e.job_role_id === x.job_role_id));
      setOpenShifts(((open.data as (Shift & { week_start: string })[]) ?? []).filter((x) => published.has(`${x.location_id}|${x.week_start}`) && fits(x)));
      setMyClaims((claims.data as { shift_id: string; status: string }[]) ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [employments]);

  useEffect(() => {
    load();
  }, [load]);

  async function answerOffer(offerId: string, accept: boolean) {
    setBusy(offerId);
    setOfferMsg(null);
    const { data, error: err } = await supabase.rpc("respond_to_offer", { p_offer_id: offerId, p_accept: accept });
    setBusy(null);
    if (err) setOfferMsg({ ok: false, text: err.message });
    else if (!data?.ok) setOfferMsg({ ok: false, text: t.offerErrors[data?.reason] ?? t.error });
    else {
      setOfferMsg({ ok: true, text: accept ? t.offerAccepted : t.offerDeclined });
      if (accept) syncShifts({ employments, locations, t, lang }).catch(() => undefined);
    }
    await load();
  }

  async function acknowledge(id: string) {
    setBusy(id);
    const { data, error: err } = await supabase.rpc("respond_to_shift", { p_shift_id: id, p_response: "confirmed" });
    setBusy(null);
    if (err || !data?.ok) setError(err?.message ?? t.error);
    else load();
  }

  async function claim(id: string, take: boolean) {
    setBusy(id);
    const { data, error: err } = await supabase.rpc(take ? "claim_open_shift" : "withdraw_claim", { p_shift_id: id });
    setBusy(null);
    if (err || !data?.ok) setError(err?.message ?? t.claimErrors[data?.reason] ?? t.error);
    load();
  }

  async function answer(id: string, accept: boolean) {
    setBusy(id);
    const { data, error: err } = await supabase.rpc("respond_to_swap", { p_swap_id: id, p_accept: accept });
    setBusy(null);
    if (err || !data?.ok) setError(err?.message ?? t.error);
    load();
  }

  async function cancel(id: string) {
    setBusy(id);
    const { data, error: err } = await supabase.rpc("cancel_swap", { p_swap_id: id });
    setBusy(null);
    if (err || !data?.ok) setError(err?.message ?? t.error);
    load();
  }

  async function addToCalendar() {
    setBusy("calendar");
    const prefs = await loadPrefs();
    await savePrefs({ ...prefs, calendar: true });
    const out = await syncShifts({ employments, locations, t, lang });
    setBusy(null);
    const cal = out[0];
    if (cal && !cal.ok) {
      await savePrefs({ ...prefs, calendar: false });
      setCalendarMsg({ ok: false, text: cal.reason === "calendar_denied" ? t.calendarDenied : (cal.message ?? t.error) });
    } else {
      setCalendarOn(true);
      setCalendarMsg({ ok: true, text: t.calendarAdded(cal && cal.ok ? cal.count : 0) });
    }
  }

  const loc = (id: string) => locations.find((l) => l.id === id);
  const when = (s: SwapShift) => {
    const tz = loc(s.location_id)?.timezone;
    return `${fmtDay(s.starts_at, lang, tz)} · ${fmtTime(s.starts_at, tz)}–${fmtTime(s.ends_at, tz)} · ${loc(s.location_id)?.name ?? ""}`;
  };
  const positionOf = (s: Shift) => {
    const id = s.job_role_id ?? employments.find((e) => e.id === s.employment_id)?.job_role_id;
    const j = jobRoles.find((x) => x.id === id);
    return j ? (lang === "fr" ? j.name_fr : j.name_en) : "";
  };

  const openRequestFor = new Map(
    swaps.filter((w) => !w.incoming && (w.status === "pending_colleague" || w.status === "pending_manager")).map((w) => [w.shift.id, w]),
  );
  const incoming = swaps.filter((w) => w.incoming && w.status === "pending_colleague");
  const others = swaps.filter((w) => !(w.incoming && w.status === "pending_colleague")).slice(0, 8);

  const weeks = new Map<string, Shift[]>();
  for (const s of shifts) {
    const w = weekStartOf(s.starts_at, loc(s.location_id)?.timezone);
    weeks.set(w, [...(weeks.get(w) ?? []), s]);
  }

  return (
    <ScrollView
      contentContainerStyle={styles.page}
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
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {!calendarOn && shifts.length > 0 && (
        <Card>
          <Button title={t.addToCalendar} busy={busy === "calendar"} onPress={addToCalendar} />
          {calendarMsg && <Result ok={calendarMsg.ok} title={calendarMsg.text} />}
        </Card>
      )}
      {calendarOn && calendarMsg?.ok && <Muted small>{calendarMsg.text}</Muted>}

      {(offers.length > 0 || offerMsg) && (
        <Card style={styles.incoming}>
          <Label>{t.offeredShifts}</Label>
          <Muted small>{t.offeredShiftsHint}</Muted>
          {offers.map((o) => (
            <View key={o.offer_id} style={styles.request}>
              <Text style={styles.requestTitle}>{when(o.shift)}</Text>
              <View style={styles.actions}>
                <Button variant="primary" title={t.takeShift} busy={busy === o.offer_id} onPress={() => answerOffer(o.offer_id, true)} />
                <Button title={t.notAvailable} onPress={() => answerOffer(o.offer_id, false)} />
              </View>
            </View>
          ))}
          {offerMsg && <Result ok={offerMsg.ok} title={offerMsg.text} />}
        </Card>
      )}

      {incoming.length > 0 && (
        <Card style={styles.incoming}>
          <Label>{t.requests}</Label>
          {incoming.map((w) => (
            <View key={w.id} style={styles.request}>
              <Text style={styles.requestTitle}>{w.target_shift ? t.wantsToExchange(w.requester_name) : t.wantsToGive(w.requester_name)}</Text>
              <Text style={styles.body}>{when(w.shift)}</Text>
              {(w.reset_count ?? 0) > 0 && <Muted small>{t.swapHoursChanged}</Muted>}
              {w.target_shift && (
                <Text style={styles.small}>
                  {t.inExchange} {when(w.target_shift)}
                </Text>
              )}
              {w.note ? <Muted small>« {w.note} »</Muted> : null}
              <View style={styles.actions}>
                <Button variant="primary" title={t.accept} busy={busy === w.id} onPress={() => answer(w.id, true)} />
                <Button title={t.refuse} onPress={() => answer(w.id, false)} />
              </View>
            </View>
          ))}
        </Card>
      )}

      {openShifts.length > 0 && (
        <Card>
          <Label>{t.openShiftsTitle}</Label>
          <Muted small>{t.openShiftsHint}</Muted>
          {openShifts.map((o) => {
            const c = myClaims.find((x) => x.shift_id === o.id && x.status === "pending");
            return (
              <View key={o.id} style={styles.request}>
                <Text style={styles.body}>{when(o)}</Text>
                <View style={styles.actions}>
                  {c ? (
                    <>
                      <Tag text={t.claimSent} tone="warn" />
                      <Button variant="ghost" title={t.withdraw} busy={busy === o.id} onPress={() => claim(o.id, false)} />
                    </>
                  ) : (
                    <Button variant="primary" title={t.iCanTakeIt} busy={busy === o.id} onPress={() => claim(o.id, true)} />
                  )}
                </View>
              </View>
            );
          })}
        </Card>
      )}

      {weeks.size === 0 && <Muted>{t.noSchedule}</Muted>}
      {[...weeks.entries()].map(([week, list]) => (
        <Card key={week}>
          <Label>{t.weekOf(fmtDay(`${week}T12:00:00Z`, lang).replace(/^\S+\s/, ""))}</Label>
          {list.map((s) => {
            const l = loc(s.location_id);
            const tz = l?.timezone;
            const request = openRequestFor.get(s.id);
            const position = positionOf(s);
            return (
              <View key={s.id} style={styles.row}>
                <View style={styles.info}>
                  <Text style={styles.day}>{fmtDay(s.starts_at, lang, tz, false)}</Text>
                  <Text style={styles.time}>
                    {fmtTime(s.starts_at, tz)}–{fmtTime(s.ends_at, tz)}
                    {s.unpaid_break_minutes ? ` · ${s.unpaid_break_minutes} min` : ""}
                    {position ? ` · ${position}` : ""}
                  </Text>
                  <Text style={styles.small}>{[l?.name, l?.address].filter(Boolean).join(" · ")}</Text>
                </View>
                <View style={styles.actions}>
                  {s.response === "confirmed" ? (
                    <Tag text={t.confirmed} tone="ok" />
                  ) : (
                    <Button variant="primary" title={t.iSawIt} busy={busy === s.id} onPress={() => acknowledge(s.id)} />
                  )}
                  {request ? (
                    <Tag text={t.swapStatus[request.status]} tone="warn" />
                  ) : (
                    <Button title={t.exchange} onPress={() => setSwapFor(s)} />
                  )}
                </View>
              </View>
            );
          })}
        </Card>
      ))}

      {others.length > 0 && (
        <Card>
          <Label>{t.requests}</Label>
          {others.map((w) => (
            <View key={w.id} style={styles.request}>
              <Text style={styles.requestTitle}>
                {w.incoming
                  ? w.target_shift
                    ? t.wantsToExchange(w.requester_name)
                    : t.wantsToGive(w.requester_name)
                  : w.target_shift
                    ? t.youExchange(w.target_name)
                    : t.youOffer(w.target_name)}
              </Text>
              <Text style={styles.small}>{when(w.shift)}</Text>
              {w.target_shift && (
                <Text style={styles.small}>
                  {t.inExchange} {when(w.target_shift)}
                </Text>
              )}
              <View style={styles.actions}>
                <Tag text={t.swapStatus[w.status]} tone={w.status === "approved" ? "ok" : w.status.startsWith("pending") ? "warn" : "ink"} />
                {!w.incoming && w.status.startsWith("pending") && (
                  <Button variant="ghost" title={t.cancelRequest} busy={busy === w.id} onPress={() => cancel(w.id)} />
                )}
              </View>
              {w.manager_note ? <Muted small>« {w.manager_note} »</Muted> : null}
            </View>
          ))}
        </Card>
      )}

      {clinics.length === 0 && <Muted>{t.noSchedule}</Muted>}

      <SwapSheet
        shift={swapFor}
        onClose={(sent) => {
          setSwapFor(null);
          if (sent) load();
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: space.md, gap: space.md },
  row: { borderTopWidth: 1, borderTopColor: colors.line, paddingVertical: space.sm, gap: space.sm },
  info: { gap: 2 },
  day: { fontSize: 15, fontWeight: "600", color: colors.ink, textTransform: "capitalize" },
  time: { fontSize: 15, color: colors.ink, fontVariant: ["tabular-nums"] },
  body: { fontSize: 15, color: colors.ink, textTransform: "capitalize" },
  small: { fontSize: 12, color: colors.muted },
  actions: { flexDirection: "row", gap: space.sm, alignItems: "center", flexWrap: "wrap" },
  error: { color: colors.error },
  incoming: { borderColor: colors.accent, borderWidth: 1 },
  request: { borderTopWidth: 1, borderTopColor: colors.line, paddingVertical: space.sm, gap: 4 },
  requestTitle: { fontSize: 15, fontWeight: "600", color: colors.ink },
});
