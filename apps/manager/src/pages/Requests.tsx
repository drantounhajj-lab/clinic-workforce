import { type CoverageRuleInput, type StaffingRatioInput, validateSchedule } from "@clinic-workforce/rules";
import { useCallback, useEffect, useState } from "react";
import { formatDate, friendly, hours } from "../i18n";
import { personName, useSession } from "../session";
import {
  type AvailabilityException,
  type AvailabilityRule,
  type CoverageRule,
  type ImpactShift,
  type LeaveType,
  must,
  type PunchCorrection,
  type Shift,
  type StaffingRatioRule,
  supabase,
  type TimeOffRequest,
} from "../supabase";

/** What would be missing at a clinic if this shift were removed (coverage and staffing-ratio rules). */
interface Impact extends ImpactShift {
  gaps: string[];
}

export function Requests({ onChange }: { onChange?: () => void }) {
  const { t, lang, data, can, locationsWith, isOwner } = useSession();
  const [timeOff, setTimeOff] = useState<TimeOffRequest[]>([]);
  const [othersAway, setOthersAway] = useState<TimeOffRequest[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRule[]>([]);
  const [exceptions, setExceptions] = useState<AvailabilityException[]>([]);
  const [corrections, setCorrections] = useState<PunchCorrection[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [impacts, setImpacts] = useState<Record<string, Impact[]>>({});
  const [release, setRelease] = useState<Record<string, boolean>>({});
  const [released, setReleased] = useState<{ requestId: string; personId: string; shifts: Impact[] } | null>(null);
  const [paid, setPaid] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const punchLocs = locationsWith("punches").map((l) => l.id);
      const [off, recent, av, ex, cor, lt] = await Promise.all([
        supabase.from("time_off_requests").select("*").eq("status", "pending").order("start_date"),
        supabase
          .from("time_off_requests")
          .select("*")
          .in("status", ["approved", "pending"])
          .gte("end_date", new Date(Date.now() - 86_400_000).toISOString().slice(0, 10))
          .order("start_date")
          .limit(500),
        supabase.from("availability_rules").select("*").order("weekday"),
        supabase.from("availability_exceptions").select("*").eq("status", "pending").order("date"),
        punchLocs.length
          ? supabase.from("punch_corrections").select("*").in("location_id", punchLocs).eq("status", "pending").order("occurred_at")
          : Promise.resolve({ data: [], error: null }),
        supabase.from("leave_types").select("*").order("sort"),
      ]);
      const pending = must(off) as TimeOffRequest[];
      setTimeOff(pending);
      setOthersAway(must(recent) as TimeOffRequest[]);
      setAvailability(must(av) as AvailabilityRule[]);
      setExceptions(must(ex) as AvailabilityException[]);
      setCorrections(must(cor) as PunchCorrection[]);
      setLeaveTypes(must(lt) as LeaveType[]);
      // Reasons: the database only returns those this manager may see.
      const ids = pending.map((r) => r.id);
      if (ids.length) {
        const rs = must(await supabase.from("time_off_reasons").select("request_id, reason").in("request_id", ids)) as { request_id: string; reason: string }[];
        setReasons(Object.fromEntries(rs.map((x) => [x.request_id, x.reason])));
      } else setReasons({});
      setImpacts(Object.fromEntries(await Promise.all(pending.map(async (r) => [r.id, await impactOf(r)] as const))));
    } catch (e) {
      setError(friendly(e, t));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationsWith]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The person's shifts during the leave, and what each clinic would be missing without them. */
  async function impactOf(r: TimeOffRequest): Promise<Impact[]> {
    if (!data) return [];
    const { data: res } = await supabase.rpc("time_off_impact", { p_id: r.id });
    const list = ((res?.shifts as ImpactShift[]) ?? []).map((s) => ({ ...s, gaps: [] as string[] }));
    const mine = list.filter((s) => s.can_schedule);
    if (!mine.length) return list;
    const locIds = [...new Set(mine.map((s) => s.location_id))];
    const weeks = [...new Set(mine.map((s) => s.week_start))];
    const [sh, cov, rat] = await Promise.all([
      supabase.from("shifts").select("*").in("location_id", locIds).in("week_start", weeks),
      supabase.from("coverage_rules").select("*").in("location_id", locIds),
      supabase.from("staffing_ratio_rules").select("*").in("location_id", locIds),
    ]);
    const shifts = (sh.data as Shift[]) ?? [];
    const coverageRules: CoverageRuleInput[] = ((cov.data as CoverageRule[]) ?? []).map((c) => ({
      id: c.id, locationId: c.location_id, jobRoleId: c.job_role_id, weekdays: c.weekdays, start: c.start_time.slice(0, 5), end: c.end_time.slice(0, 5), minCount: c.min_count,
    }));
    const staffingRatios: StaffingRatioInput[] = ((rat.data as StaffingRatioRule[]) ?? []).map((x) => ({
      id: x.id, locationId: x.location_id, weekdays: x.weekdays, start: x.start_time.slice(0, 5), end: x.end_time.slice(0, 5) === "24:00" ? "24:00" : x.end_time.slice(0, 5),
      triggerJobRoleId: x.trigger_job_role_id, triggerCount: x.trigger_count, requiredJobRoleId: x.required_job_role_id, requiredCount: x.required_count,
    }));
    const base = {
      locations: data.locations.map((l) => ({ id: l.id, companyId: l.company_id, province: l.province, timezone: l.timezone })),
      employments: data.employments.map((e) => ({ id: e.id, personId: e.person_id, companyId: e.company_id, locationIds: e.employment_locations.map((x) => x.location_id), jobRoleId: e.job_role_id })),
      coverageRules,
      staffingRatios,
      weeks,
      now: new Date(),
    };
    const toInput = (list: Shift[]) =>
      list.map((s) => ({ id: s.id, employmentId: s.employment_id, locationId: s.location_id, startsAt: new Date(s.starts_at), endsAt: new Date(s.ends_at), unpaidBreakMinutes: s.unpaid_break_minutes, jobRoleId: s.job_role_id }));
    const key = (i: { code: string; details: Record<string, unknown> }) => `${i.code}|${i.details.locationId}|${i.details.date}|${i.details.jobRoleId ?? i.details.requiredJobRoleId}|${i.details.from}`;
    const before = new Set(validateSchedule({ ...base, shifts: toInput(shifts) }).issues.filter((i) => i.code === "coverage_gap" || i.code === "staffing_ratio").map(key));
    const without = validateSchedule({ ...base, shifts: toInput(shifts.filter((s) => !mine.some((m) => m.id === s.id))) }).issues.filter(
      (i) => (i.code === "coverage_gap" || i.code === "staffing_ratio") && !before.has(key(i)),
    );
    const role = (id: unknown) => {
      const j = data.jobRoles.find((x) => x.id === id);
      return j ? (lang === "fr" ? j.name_fr : j.name_en) : "";
    };
    for (const s of mine) {
      s.gaps = without
        .filter((i) => i.details.locationId === s.location_id)
        .map((i) => t.missingAfter(Number(i.details.needed) - Number(i.details.scheduled), role(i.details.jobRoleId ?? i.details.requiredJobRoleId), `${i.details.from}–${i.details.to}`));
    }
    return list;
  }

  if (!data) return null;
  const isAdmin = isOwner || data.myRoles.some((r) => r.role === "company_admin");
  const name = (personId: string) => personName(data.persons.find((p) => p.id === personId));
  const clinicsOf = (personId: string) =>
    new Set(data.employments.filter((e) => e.person_id === personId).flatMap((e) => e.employment_locations.map((x) => x.location_id)));
  const clinicName = (id: string) => data.locations.find((l) => l.id === id)?.name ?? "";
  const say = (id: string, ok: boolean, text: string) => setMsg((m) => ({ ...m, [id]: { ok, text } }));
  const day = (d: string) => formatDate(d, lang, { weekday: "short", day: "numeric", month: "short" });
  const range = (r: { start_date: string; end_date: string; start_time: string | null; end_time: string | null }) =>
    `${day(r.start_date)}${r.end_date !== r.start_date ? ` → ${day(r.end_date)}` : ""}${r.start_time ? ` · ${r.start_time.slice(0, 5)}–${r.end_time?.slice(0, 5)}` : ""}`;
  const leaveName = (r: TimeOffRequest) => {
    const lt = leaveTypes.find((x) => x.id === r.leave_type_id);
    return lt ? (lang === "fr" ? lt.name_fr : lt.name_en) : t.timeOffTypes[r.type];
  };
  const when = (s: ImpactShift) => {
    const tz = data.locations.find((l) => l.id === s.location_id)?.timezone ?? "America/Toronto";
    const f = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(lang === "fr" ? "fr-CA" : "en-CA", { ...o, timeZone: tz }).format(new Date(iso));
    return `${f(s.starts_at, { weekday: "short", day: "numeric", month: "short" })} ${f(s.starts_at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}–${f(s.ends_at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} · ${s.location_name}`;
  };
  const businessDays = (r: TimeOffRequest) => {
    let n = 0;
    for (let d = new Date(`${r.start_date}T12:00:00Z`); d <= new Date(`${r.end_date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      const w = d.getUTCDay();
      if (w !== 0 && w !== 6) n++;
    }
    return n;
  };

  // Unpaid: 0. Part of a day: its hours. Full days: 8 h per weekday.
  const suggestedHours = (r: TimeOffRequest) => {
    if (r.type === "unpaid") return 0;
    if (r.start_time && r.end_time) {
      const [sh, sm] = r.start_time.split(":").map(Number);
      const [eh, em] = r.end_time.split(":").map(Number);
      return Math.max(0, Math.round(((eh * 60 + em - sh * 60 - sm) / 60) * 100) / 100);
    }
    return businessDays(r) * 8;
  };

  async function decideTimeOff(r: TimeOffRequest, approve: boolean) {
    const paidHours = paid[r.id] === undefined || paid[r.id] === "" ? null : Number(paid[r.id].replace(",", "."));
    const mine = (impacts[r.id] ?? []).filter((s) => s.can_schedule && Date.parse(s.starts_at) > Date.now());
    const doRelease = approve && mine.length > 0 && (release[r.id] ?? true);
    const { data: res, error: err } = await supabase.rpc("decide_leave", {
      p_id: r.id,
      p_approve: approve,
      p_paid_hours: approve ? paidHours : null,
      p_note: notes[r.id] ?? null,
      p_release_shifts: doRelease,
    });
    if (err || !res?.ok) {
      say(r.id, false, err ? friendly(err, t) : t.requestErrors[res?.reason] ?? t.error);
      return;
    }
    const freed = (res.released as string[]) ?? [];
    if (freed.length) setReleased({ requestId: r.id, personId: r.person_id, shifts: mine.filter((s) => freed.includes(s.id)) });
    await load();
    onChange?.();
  }

  async function offerToAll(shiftId: string) {
    const { data: res, error: err } = await supabase.rpc("offer_shift", { p_shift_id: shiftId, p_employment_ids: null });
    if (err || !res?.ok) say(shiftId, false, err ? friendly(err, t) : t.offerErrors[res?.reason] ?? t.error);
    else say(shiftId, true, t.offeredTo(res.invited as number));
  }

  async function decideAvailability(personId: string, approve: boolean) {
    const { data: res, error: err } = await supabase.rpc("decide_availability", { p_person_id: personId, p_approve: approve });
    if (err || !res?.ok) say(personId, false, err ? friendly(err, t) : t.requestErrors[res?.reason] ?? t.error);
    else {
      await load();
      onChange?.();
    }
  }

  async function decideException(x: AvailabilityException, approve: boolean) {
    const { data: res, error: err } = await supabase.rpc("decide_availability_exception", { p_id: x.id, p_approve: approve });
    if (err || !res?.ok) say(x.id, false, err ? friendly(err, t) : t.requestErrors[res?.reason] ?? t.error);
    else {
      await load();
      onChange?.();
    }
  }

  async function decideCorrection(c: PunchCorrection, approve: boolean) {
    const { data: res, error: err } = await supabase.rpc("decide_punch_correction", { p_id: c.id, p_approve: approve, p_note: notes[c.id] ?? null });
    if (err || !res?.ok) say(c.id, false, err ? friendly(err, t) : t.requestErrors[res?.reason] ?? t.error);
    else {
      await load();
      onChange?.();
    }
  }

  const pendingAvailability = [...new Set(availability.filter((a) => a.status === "pending").map((a) => a.person_id))];
  const describeRule = (a: AvailabilityRule) =>
    [
      `${t.days[a.weekday]} ${a.start_time.slice(0, 5)}–${a.end_time.slice(0, 5)}`,
      a.kind === "unavailable" ? t.unavailableLower : "",
      a.every_weeks === 2 ? t.everyOtherWeek(a.anchor_week ? day(a.anchor_week) : "") : "",
      a.location_ids?.length ? a.location_ids.map(clinicName).join(", ") : "",
    ]
      .filter(Boolean)
      .join(" · ");
  const today = new Date().toISOString().slice(0, 10);
  const currentRules = (personId: string) =>
    availability.filter((a) => a.person_id === personId && a.status === "approved" && (!a.effective_to || a.effective_to >= today));
  const time = (iso: string, locId: string) =>
    new Intl.DateTimeFormat(lang === "fr" ? "fr-CA" : "en-CA", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: data.locations.find((l) => l.id === locId)?.timezone ?? "America/Toronto",
    }).format(new Date(iso));

  return (
    <div className="stack-lg">
      {error && <p className="error">{error}</p>}

      {released && (
        <section className="card stack notice-card">
          <strong>{t.shiftsFreed(name(released.personId), released.shifts.length)}</strong>
          <p className="small muted">{t.shiftsFreedHint}</p>
          {released.shifts.map((s) => (
            <div key={s.id} className="row spread">
              <span className="small">{when(s)}</span>
              <button type="button" className="primary" onClick={() => offerToAll(s.id)}>
                {t.offerToEligible}
              </button>
              {msg[s.id] && <span className={msg[s.id].ok ? "notice small" : "error small"}>{msg[s.id].text}</span>}
            </div>
          ))}
          <button type="button" className="link small" onClick={() => setReleased(null)}>
            {t.close}
          </button>
        </section>
      )}

      <section className="stack">
        <h2>{t.timeOffRequests}</h2>
        {timeOff.length === 0 && <p className="muted">{t.noRequests}</p>}
        {timeOff.map((r) => {
          const mine = clinicsOf(r.person_id);
          const overlap = othersAway.filter(
            (o) =>
              o.id !== r.id &&
              o.person_id !== r.person_id &&
              o.start_date <= r.end_date &&
              o.end_date >= r.start_date &&
              [...clinicsOf(o.person_id)].some((l) => mine.has(l)),
          );
          const affected = impacts[r.id] ?? [];
          const releasable = affected.filter((s) => s.can_schedule && Date.parse(s.starts_at) > Date.now());
          return (
            <article key={r.id} className="card stack">
              <div className="row spread">
                <strong>
                  {name(r.person_id)} · {leaveName(r)}
                </strong>
                <span className="small muted">{range(r)}</span>
              </div>
              {reasons[r.id] && (
                <p className="muted small" title={t.reasonPrivate}>
                  « {reasons[r.id]} » <span className="tag">{t.privateTag}</span>
                </p>
              )}
              <div className="stack-sm">
                <span className="small strong">{t.affectedShifts}</span>
                {affected.length === 0 ? (
                  <span className="small muted">{t.noAffectedShifts}</span>
                ) : (
                  <ul className="plain small">
                    {affected.map((s) => (
                      <li key={s.id}>
                        {when(s)}
                        {!s.can_schedule ? (
                          <span className="muted"> — {t.otherClinicNotified}</span>
                        ) : s.gaps.length ? (
                          <span className="warn"> — {s.gaps.join(" · ")}</span>
                        ) : (
                          <span className="muted"> — {t.coverageStillOk}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p className="small">
                {overlap.length === 0
                  ? t.nobodyElseAway
                  : `${t.alsoAway} : ${overlap.map((o) => `${name(o.person_id)} (${range(o)}${o.status === "pending" ? `, ${t.pendingLower}` : ""})`).join(" · ")}`}
              </p>
              <div className="grid2">
                <label className="field" htmlFor={`paid-${r.id}`}>
                  <span>{t.paidHours}</span>
                  <input
                    id={`paid-${r.id}`}
                    inputMode="decimal"
                    placeholder="0"
                    value={paid[r.id] ?? ""}
                    onChange={(e) => setPaid({ ...paid, [r.id]: e.target.value })}
                  />
                  {suggestedHours(r) > 0 && (paid[r.id] ?? "") !== String(suggestedHours(r)) && (
                    <button type="button" className="link small" onClick={() => setPaid({ ...paid, [r.id]: String(suggestedHours(r)) })}>
                      {t.useSuggestion(hours(suggestedHours(r) * 60, lang))}
                    </button>
                  )}
                </label>
                <label className="field" htmlFor={`n-${r.id}`}>
                  <span>{t.managerComment}</span>
                  <input id={`n-${r.id}`} value={notes[r.id] ?? ""} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} maxLength={500} />
                </label>
              </div>
              <p className="muted small">{t.paidHoursHint}</p>
              {releasable.length > 0 && (
                <label className="check" htmlFor={`rel-${r.id}`}>
                  <input id={`rel-${r.id}`} type="checkbox" checked={release[r.id] ?? true} onChange={(e) => setRelease({ ...release, [r.id]: e.target.checked })} />
                  <span>{t.releaseShifts(releasable.length)}</span>
                </label>
              )}
              <div className="row">
                <button type="button" className="primary" onClick={() => decideTimeOff(r, true)}>
                  {t.approve}
                </button>
                <button type="button" onClick={() => decideTimeOff(r, false)}>
                  {t.refuse}
                </button>
              </div>
              {msg[r.id] && <p className={msg[r.id].ok ? "notice" : "error"}>{msg[r.id].text}</p>}
            </article>
          );
        })}
      </section>

      <section className="stack">
        <h2>{t.availabilityRequests}</h2>
        {pendingAvailability.length === 0 && exceptions.length === 0 && <p className="muted">{t.noRequests}</p>}
        {pendingAvailability.map((personId) => {
          const requested = availability.filter((a) => a.person_id === personId && a.status === "pending");
          const from = requested.map((a) => a.effective_from).sort()[0];
          return (
            <article key={personId} className="card stack">
              <strong>{name(personId)}</strong>
              <div className="grid2 small">
                <div>
                  <span className="strong">{t.currentAvailability}</span>
                  <ul className="plain">
                    {currentRules(personId).length === 0 ? <li className="muted">—</li> : currentRules(personId).map((a) => <li key={a.id}>{describeRule(a)}</li>)}
                  </ul>
                </div>
                <div>
                  <span className="strong">{t.requestedFrom(day(from))}</span>
                  <ul className="plain">
                    {requested.map((a) => (
                      <li key={a.id} className="changed">
                        {describeRule(a)}
                        {a.effective_to ? ` · ${t.until} ${day(a.effective_to)}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <div className="row">
                <button type="button" className="primary" onClick={() => decideAvailability(personId, true)}>
                  {t.approve}
                </button>
                <button type="button" onClick={() => decideAvailability(personId, false)}>
                  {t.refuse}
                </button>
              </div>
              {msg[personId] && <p className={msg[personId].ok ? "notice" : "error"}>{msg[personId].text}</p>}
            </article>
          );
        })}
        {exceptions.map((x) => (
          <article key={x.id} className="card stack">
            <div className="row spread">
              <strong>
                {name(x.person_id)} · {x.kind === "available" ? t.availableOn : t.unavailableOn}
              </strong>
              <span className="small muted">{range({ start_date: x.date, end_date: x.end_date ?? x.date, start_time: x.start_time, end_time: x.end_time })}</span>
            </div>
            {x.location_ids?.length ? <span className="small muted">{x.location_ids.map(clinicName).join(", ")}</span> : null}
            <div className="row">
              <button type="button" className="primary" onClick={() => decideException(x, true)}>
                {t.approve}
              </button>
              <button type="button" onClick={() => decideException(x, false)}>
                {t.refuse}
              </button>
            </div>
            {msg[x.id] && <p className={msg[x.id].ok ? "notice" : "error"}>{msg[x.id].text}</p>}
          </article>
        ))}
      </section>

      <section className="stack">
        <h2>{t.correctionRequests}</h2>
        {corrections.length === 0 && <p className="muted">{t.noRequests}</p>}
        {corrections.map((c) => (
          <article key={c.id} className="card stack">
            <div className="row spread">
              <strong>
                {name(c.person_id)} · {c.punch_id ? t.correctPunch : t.missedPunch} ({c.kind === "in" ? t.in : t.out})
              </strong>
              <span className="small muted">
                {time(c.occurred_at, c.location_id)} · {clinicName(c.location_id)}
              </span>
            </div>
            <p className="muted small">« {c.reason} »</p>
            {can(c.location_id, "punches") && (
              <>
                <label className="field" htmlFor={`cn-${c.id}`}>
                  <span>{t.managerNote}</span>
                  <input id={`cn-${c.id}`} value={notes[c.id] ?? ""} onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })} maxLength={500} />
                </label>
                <div className="row">
                  <button type="button" className="primary" onClick={() => decideCorrection(c, true)}>
                    {t.approve}
                  </button>
                  <button type="button" onClick={() => decideCorrection(c, false)}>
                    {t.refuse}
                  </button>
                </div>
              </>
            )}
            {msg[c.id] && <p className={msg[c.id].ok ? "notice" : "error"}>{msg[c.id].text}</p>}
          </article>
        ))}
      </section>

      {isAdmin && <LeaveTypes types={leaveTypes} onSaved={load} />}
    </div>
  );
}

function LeaveTypes({ types, onSaved }: { types: LeaveType[]; onSaved: () => Promise<void> }) {
  const { t } = useSession();
  const [fr, setFr] = useState("");
  const [en, setEn] = useState("");
  const [category, setCategory] = useState<LeaveType["category"]>("other");
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<void>) => {
    setError("");
    try {
      await fn();
      await onSaved();
    } catch (e) {
      setError(friendly(e, t));
    }
  };
  return (
    <section className="card stack">
      <h2>{t.leaveTypes}</h2>
      <p className="muted small">{t.leaveTypesHint}</p>
      <ul className="plain stack-sm">
        {types.map((x) => (
          <li key={x.id} className="row spread">
            <span className={x.active ? "" : "muted"}>
              {x.name_fr} / {x.name_en} <span className="small muted">({t.timeOffTypes[x.category]})</span>
            </span>
            <button type="button" className="link small" onClick={() => run(async () => void must(await supabase.from("leave_types").update({ active: !x.active }).eq("id", x.id)))}>
              {x.active ? t.deactivate : t.reactivate}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (!fr.trim() || !en.trim()) return;
          run(async () => {
            must(await supabase.from("leave_types").insert({ name_fr: fr.trim(), name_en: en.trim(), category, sort: types.length + 1 }));
            setFr("");
            setEn("");
          });
        }}
      >
        <label className="field" htmlFor="lt-fr">
          <span>{t.nameFr}</span>
          <input id="lt-fr" value={fr} onChange={(e) => setFr(e.target.value)} maxLength={60} />
        </label>
        <label className="field" htmlFor="lt-en">
          <span>{t.nameEn}</span>
          <input id="lt-en" value={en} onChange={(e) => setEn(e.target.value)} maxLength={60} />
        </label>
        <label className="field" htmlFor="lt-cat">
          <span>{t.payrollCategory}</span>
          <select id="lt-cat" value={category} onChange={(e) => setCategory(e.target.value as LeaveType["category"])}>
            {(["vacation", "sick", "personal", "unpaid", "other"] as const).map((c) => (
              <option key={c} value={c}>
                {t.timeOffTypes[c]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">{t.addLeaveType}</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
