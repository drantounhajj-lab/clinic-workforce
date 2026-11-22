import {
  addDays,
  type EmploymentInput,
  type Issue,
  localDate,
  localWeekStart,
  type ValidationInput,
  validateSchedule,
  weekdayOf,
  zonedToUtc,
} from "@clinic-workforce/rules";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDate, hours, type Lang, type Strings, friendly } from "../i18n";
import { personName, useSession } from "../session";
import {
  type AvailabilityException,
  type AvailabilityRule,
  type BusyShifts,
  type CoverageRule,
  type Credential,
  type Employment,
  type JobRole,
  type Location,
  must,
  type Person,
  type ScheduleWeek,
  type Shift,
  type ScheduleTemplate,
  type ShiftClaim,
  type StaffingRatioRule,
  supabase,
  type TimeOffRequest,
} from "../supabase";

/** A replacement candidate for a shift, after checking the rules as if they had it. */
interface Candidate {
  employmentId: string;
  name: string;
  claimed: boolean;
  blocking: string[];
  warnings: string[];
  /** Scheduled minutes that week (same employer, or all when hours are combined) if they take it. */
  weekMinutes: number;
  overtimeMinutes: number;
}

/** An open offer on a shift: who was invited and who declined. */
interface OfferInfo {
  id: string;
  invited: number;
  declined: number;
}

interface Draft {
  id: string | null;
  employmentId: string | null;
  date: string;
  start: string;
  end: string;
  breakMin: number;
  jobRoleId: string | null;
  /** New shifts only: 0 = once, 1 = every week, 2 = every 2 weeks, until this date. */
  repeat?: 0 | 1 | 2;
  until?: string;
}

const hhmm = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(new Date(iso));
const paidMinutes = (s: Shift) => Math.max(0, (Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 60000 - s.unpaid_break_minutes);

export function Schedule() {
  const { t, lang, data, locationsWith } = useSession();
  const managedLocations = locationsWith("schedule");
  const [locationId, setLocationId] = useState<string>(managedLocations[0]?.id ?? "");
  const location = managedLocations.find((l) => l.id === locationId) ?? managedLocations[0];
  const tz = location?.timezone ?? "America/Toronto";
  const [week, setWeek] = useState(() => localWeekStart(new Date(), tz));
  const [weekRow, setWeekRow] = useState<ScheduleWeek | null>(null);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [rules, setRules] = useState<AvailabilityRule[]>([]);
  const [exceptions, setExceptions] = useState<AvailabilityException[]>([]);
  const [busy, setBusy] = useState<BusyShifts>({ shifts: [], employments: [] });
  const [timeOff, setTimeOff] = useState<TimeOffRequest[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [coverage, setCoverage] = useState<CoverageRule[]>([]);
  const [claims, setClaims] = useState<ShiftClaim[]>([]);
  const [ratios, setRatios] = useState<StaffingRatioRule[]>([]);
  const [offers, setOffers] = useState<Record<string, OfferInfo>>({});
  const [showTemplates, setShowTemplates] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const rows: Employment[] = useMemo(
    () => (data && location ? data.employments.filter((e) => e.employment_locations.some((x) => x.location_id === location.id) && (!e.end_date || e.end_date >= week)) : []),
    [data, location, week],
  );

  const load = useCallback(async () => {
    if (!location) return;
    setLoading(true);
    setError("");
    try {
      const from = zonedToUtc(addDays(week, -7), "00:00", tz).toISOString();
      const to = zonedToUtc(addDays(week, 14), "00:00", tz).toISOString();
      const empIds = rows.map((e) => e.id);
      const personIds = [...new Set(rows.map((e) => e.person_id))];
      const none = Promise.resolve({ data: [], error: null });
      const [w, atClinic, ofStaff, r, x, b, off, creds, cov, cl] = await Promise.all([
        supabase.from("schedule_weeks").select("*").eq("location_id", location.id).eq("week_start", week).maybeSingle(),
        supabase.from("shifts").select("*").eq("location_id", location.id).gte("starts_at", from).lt("starts_at", to),
        empIds.length
          ? supabase.from("shifts").select("*").in("employment_id", empIds).gte("starts_at", from).lt("starts_at", to)
          : Promise.resolve({ data: [], error: null }),
        personIds.length ? supabase.from("availability_rules").select("*").in("person_id", personIds).eq("status", "approved") : Promise.resolve({ data: [], error: null }),
        personIds.length
          ? supabase
              .from("availability_exceptions")
              .select("*")
              .in("person_id", personIds)
              .eq("status", "approved")
              .lte("date", addDays(week, 7))
              .or(`end_date.gte.${week},date.gte.${week}`)
          : Promise.resolve({ data: [], error: null }),
        personIds.length ? supabase.rpc("busy_shifts", { p_person_ids: personIds, p_from: from, p_to: to }) : Promise.resolve({ data: { shifts: [], employments: [] }, error: null }),
        personIds.length
          ? supabase.from("time_off_requests").select("*").in("person_id", personIds).eq("status", "approved").lte("start_date", addDays(week, 14)).gte("end_date", addDays(week, -7))
          : none,
        personIds.length ? supabase.from("credentials").select("*").in("person_id", personIds) : none,
        supabase.from("coverage_rules").select("*").eq("location_id", location.id),
        supabase.from("shift_claims").select("*").eq("location_id", location.id).eq("status", "pending"),
      ]);
      const [rat, offerRes] = await Promise.all([
        supabase.from("staffing_ratio_rules").select("*").eq("location_id", location.id),
        supabase.from("coverage_offers").select("id, shift_id, coverage_invites(status)").eq("location_id", location.id).eq("status", "open"),
      ]);
      setRatios(must(rat) as StaffingRatioRule[]);
      const offerRows = (must(offerRes) as { id: string; shift_id: string; coverage_invites: { status: string }[] }[]) ?? [];
      setOffers(
        Object.fromEntries(
          offerRows.map((o) => [
            o.shift_id,
            { id: o.id, invited: o.coverage_invites.length, declined: o.coverage_invites.filter((i) => i.status === "declined").length },
          ]),
        ),
      );
      setWeekRow(must(w) as ScheduleWeek | null);
      const merged = new Map<string, Shift>();
      for (const s of [...(must(atClinic) as Shift[]), ...(must(ofStaff) as Shift[])]) merged.set(s.id, s);
      setShifts([...merged.values()]);
      setRules(must(r) as AvailabilityRule[]);
      setExceptions(must(x) as AvailabilityException[]);
      setBusy((must(b) as BusyShifts) ?? { shifts: [], employments: [] });
      setTimeOff(must(off) as TimeOffRequest[]);
      setCredentials(must(creds) as Credential[]);
      setCoverage(must(cov) as CoverageRule[]);
      setClaims(must(cl) as ShiftClaim[]);
    } catch (e) {
      setError(friendly(e, t));
    } finally {
      setLoading(false);
    }
  }, [location, week, tz, rows]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(id);
  }, [toast]);

  // Shifts and employments the rules need: this clinic's, plus the same people's at other clinics and companies.
  const allShifts: Shift[] = useMemo(() => {
    const merged = new Map<string, Shift>(shifts.map((s) => [s.id, s]));
    for (const b of busy.shifts) {
      if (!merged.has(b.id)) {
        merged.set(b.id, { ...b, location_id: b.location_id, job_role_id: null, response: "pending", notes: null, updated_at: b.starts_at } as unknown as Shift);
      }
    }
    return [...merged.values()];
  }, [shifts, busy]);

  const baseInput: ValidationInput | null = useMemo(() => {
    if (!data || !location) return null;
    const employments = new Map<string, EmploymentInput>();
    for (const e of data.employments) {
      employments.set(e.id, {
        id: e.id,
        personId: e.person_id,
        companyId: e.company_id,
        locationIds: e.employment_locations.map((x) => x.location_id),
        desiredWeeklyMinutes: e.desired_weekly_minutes,
        minWeeklyMinutes: e.min_weekly_minutes,
        maxWeeklyMinutes: e.max_weekly_minutes,
        jobRoleId: e.job_role_id,
      });
    }
    for (const e of busy.employments) {
      if (!employments.has(e.id)) {
        employments.set(e.id, { id: e.id, personId: e.person_id, companyId: e.company_id, locationIds: e.location_ids });
      }
    }
    const changed = weekRow?.status === "published" && weekRow.published_at
      ? shifts.filter((s) => s.location_id === location.id && s.week_start === week && s.updated_at > weekRow.published_at!).map((s) => s.id)
      : [];
    return {
      locations: data.locations.map((l) => ({ id: l.id, companyId: l.company_id, province: l.province, timezone: l.timezone, latitude: l.latitude, longitude: l.longitude })),
      employments: [...employments.values()],
      shifts: allShifts
        .filter((s) => s.employment_id === null || employments.has(s.employment_id))
        .map((s) => ({
          id: s.id,
          employmentId: s.employment_id,
          locationId: s.location_id,
          startsAt: new Date(s.starts_at),
          endsAt: new Date(s.ends_at),
          unpaidBreakMinutes: s.unpaid_break_minutes,
          jobRoleId: s.job_role_id,
        })),
      availabilityRules: rules.map((r) => ({
        personId: r.person_id,
        weekday: r.weekday,
        start: r.start_time.slice(0, 5),
        end: r.end_time.slice(0, 5),
        status: r.status,
        kind: r.kind,
        effectiveFrom: r.effective_from,
        effectiveTo: r.effective_to,
        everyWeeks: r.every_weeks,
        anchorWeek: r.anchor_week,
        locationIds: r.location_ids,
      })),
      availabilityExceptions: exceptions.map((x) => ({
        personId: x.person_id,
        date: x.date,
        endDate: x.end_date,
        start: x.start_time?.slice(0, 5),
        end: x.end_time?.slice(0, 5),
        status: x.status,
        kind: x.kind,
        locationIds: x.location_ids,
      })),
      timeOff: timeOff.map((o) => ({ personId: o.person_id, startDate: o.start_date, endDate: o.end_date, start: o.start_time?.slice(0, 5), end: o.end_time?.slice(0, 5), type: o.type })),
      credentials: credentials.map((c) => ({ personId: c.person_id, name: c.name, expiresOn: c.expires_on, blocksSchedulingWhenExpired: c.blocks_scheduling })),
      coverageRules: coverage.map((c) => ({
        id: c.id,
        locationId: c.location_id,
        jobRoleId: c.job_role_id,
        weekdays: c.weekdays,
        start: c.start_time.slice(0, 5),
        end: c.end_time.slice(0, 5),
        minCount: c.min_count,
      })),
      staffingRatios: ratios.map((x) => ({
        id: x.id,
        locationId: x.location_id,
        weekdays: x.weekdays,
        start: x.start_time.slice(0, 5),
        end: x.end_time.startsWith("24") ? "24:00" : x.end_time.slice(0, 5),
        triggerJobRoleId: x.trigger_job_role_id,
        triggerCount: x.trigger_count,
        requiredJobRoleId: x.required_job_role_id,
        requiredCount: x.required_count,
      })),
      changedShiftIds: changed,
      combineRelatedCompanyHours: data.account.combine_related_company_hours,
      weeks: [week],
      now: new Date(),
    };
  }, [data, location, allShifts, shifts, rules, exceptions, timeOff, credentials, coverage, ratios, week, weekRow, busy]);

  const result = useMemo(() => (baseInput ? validateSchedule(baseInput) : null), [baseInput]);

  /** Everyone at this clinic who could take the shift, checked against the rules as if they had it. */
  const candidatesFor = (shiftId: string): Candidate[] => {
    if (!baseInput || !data) return [];
    const target = baseInput.shifts.find((x) => x.id === shiftId);
    if (!target) return [];
    // The position being covered: the shift's own, else the current employee's
    const position = target.jobRoleId ?? baseInput.employments.find((x) => x.id === target.employmentId)?.jobRoleId ?? null;
    return rows
      .filter((e) => e.id !== target.employmentId)
      .map((e) => {
        const trial = validateSchedule({
          ...baseInput,
          shifts: baseInput.shifts.map((x) => (x.id === shiftId ? { ...x, employmentId: e.id, jobRoleId: position } : x)),
          changedShiftIds: [],
        });
        const mine = trial.issues.filter((i) => i.shiftIds.includes(shiftId) && i.code !== "coverage_gap" && i.code !== "overtime");
        const ot = trial.issues.find((i) => i.code === "overtime" && i.shiftIds.includes(shiftId));
        const target2 = trial.hours.find((h) => h.employmentId === e.id && h.week === week);
        const text = (i: Issue) => describe(i, allShifts, data.persons, data.employments, data.locations, data.jobRoles, t, lang, e.id);
        return {
          employmentId: e.id,
          name: personName(data.persons.find((p) => p.id === e.person_id)),
          claimed: claims.some((c) => c.shift_id === shiftId && c.employment_id === e.id),
          blocking: mine.filter((i) => i.severity === "error").map(text),
          warnings: mine.filter((i) => i.severity === "warning").map(text),
          weekMinutes: ot ? Number(ot.details.scheduledMinutes) : (target2?.scheduledMinutes ?? 0),
          overtimeMinutes: ot ? Number(ot.details.overtimeMinutes) : 0,
        };
      })
      .sort((a, b) => Number(b.claimed) - Number(a.claimed) || a.blocking.length - b.blocking.length || a.warnings.length - b.warnings.length || a.name.localeCompare(b.name));
  };

  if (!data) return null;
  if (!location) return <p className="card">{t.noClinics}</p>;

  const weekShifts = shifts.filter((s) => s.location_id === location.id && s.week_start === week);
  const viewIssues = (result?.issues ?? []).filter(
    (i) => i.shiftIds.some((id) => weekShifts.some((s) => s.id === id)) || ((i.code === "coverage_gap" || i.code === "staffing_ratio") && i.details.locationId === location.id),
  );
  const errors = viewIssues.filter((i) => i.severity === "error");
  const warnings = viewIssues.filter((i) => i.severity === "warning");
  const severity = new Map<string, "error" | "warning">();
  for (const i of result?.issues ?? []) for (const id of i.shiftIds) if (i.severity === "error" || !severity.has(id)) severity.set(id, i.severity);
  const dates = [0, 1, 2, 3, 4, 5, 6].map((d) => addDays(week, d));

  async function ensureWeek() {
    if (weekRow) return;
    must(await supabase.from("schedule_weeks").upsert({ location_id: location!.id, week_start: week }, { onConflict: "location_id,week_start", ignoreDuplicates: true }));
  }

  async function saveShift(d: Draft) {
    setError("");
    try {
      await ensureWeek();
      const row = {
        location_id: location!.id,
        week_start: week,
        employment_id: d.employmentId,
        starts_at: zonedToUtc(d.date, d.start, tz).toISOString(),
        // At or before the start: ends the next day (overnight)
        ends_at: zonedToUtc(d.end <= d.start ? addDays(d.date, 1) : d.date, d.end, tz).toISOString(),
        unpaid_break_minutes: d.breakMin,
        job_role_id: d.jobRoleId,
      };
      if (!d.id && (d.repeat ?? 0) > 0 && d.until) {
        const { data: res, error: err } = await supabase.rpc("create_recurring_shifts", {
          p_location_id: location!.id,
          p_employment_id: d.employmentId,
          p_job_role_id: d.jobRoleId,
          p_first_date: d.date,
          p_start: d.start,
          p_end: d.end,
          p_break: d.breakMin,
          p_every_weeks: d.repeat,
          p_until: d.until,
        });
        if (err) throw err;
        if (!res?.ok) throw new Error(t.error);
        setToast(t.recurringAdded(res.added));
        setDraft(null);
        await load();
        return;
      }
      const before = d.id ? shifts.find((x) => x.id === d.id) : undefined;
      if (before && before.employment_id === null && d.employmentId) {
        // Filling an open shift: save the hours first, then assign, so volunteers are answered
        // and a volunteer who gets it doesn't have to acknowledge it again.
        must(await supabase.from("shifts").update({ ...row, employment_id: null }).eq("id", before.id));
        const { data: res, error: err } = await supabase.rpc("assign_open_shift", { p_shift_id: before.id, p_employment_id: d.employmentId });
        if (err) throw err;
        if (!res?.ok) throw new Error(t.assignErrors[res?.reason] ?? t.error);
      } else if (d.id) must(await supabase.from("shifts").update(row).eq("id", d.id));
      else must(await supabase.from("shifts").insert(row));
      setDraft(null);
      await load();
    } catch (e) {
      setError(friendly(e, t));
    }
  }

  async function offerShift(id: string, employmentIds: string[] | null) {
    const { data: res, error: err } = await supabase.rpc("offer_shift", { p_shift_id: id, p_employment_ids: employmentIds });
    if (err) setError(friendly(err, t));
    else if (!res?.ok) setToast(t.offerErrors[res?.reason] ?? t.error);
    else {
      setToast(t.offeredTo(res.invited));
      await load();
    }
  }

  async function cancelOffer(offerId: string) {
    const { data: res, error: err } = await supabase.rpc("cancel_offer", { p_offer_id: offerId });
    if (err || !res?.ok) setError(err ? friendly(err, t) : t.error);
    else await load();
  }

  async function deleteShift(id: string) {
    try {
      must(await supabase.from("shifts").delete().eq("id", id));
      setDraft(null);
      await load();
    } catch (e) {
      setError(friendly(e, t));
    }
  }

  async function copyPrevious() {
    const prev = shifts.filter((s) => s.location_id === location!.id && s.week_start === addDays(week, -7));
    if (prev.length === 0) {
      setToast(t.nothingToCopy);
      return;
    }
    try {
      // Done on the server, one copy at a time: a double click, a retry or a second manager copies nothing more.
      const { data: res, error: err } = await supabase.rpc("copy_week", { p_location_id: location!.id, p_from_week: addDays(week, -7), p_to_week: week });
      if (err) throw err;
      if (!res?.ok) throw new Error(t.error);
      setToast(t.copied(res.copied));
      await load();
    } catch (e) {
      setError(friendly(e, t));
    }
  }

  async function publish() {
    if (errors.length) {
      setToast(t.publishBlocked(errors.length));
      return;
    }
    try {
      await ensureWeek();
      must(
        await supabase
          .from("schedule_weeks")
          .update({ status: "published", published_at: new Date().toISOString(), published_by: data!.me.id })
          .eq("location_id", location!.id)
          .eq("week_start", week),
      );
      setToast(t.publishedToast);
      await load();
    } catch (e) {
      setError(friendly(e, t));
    }
  }

  const availabilityHint = (personId: string, date: string): string | null => {
    if (exceptions.some((x) => x.person_id === personId && x.date === date && !x.start_time)) return t.dayOff;
    const mine = rules.filter((r) => r.person_id === personId);
    if (mine.length === 0) return null;
    const today = mine.filter((r) => r.weekday === weekdayOf(date));
    if (today.length === 0) return t.unavailable;
    return t.avail(today[0].start_time.slice(0, 5), today[0].end_time.slice(0, 5));
  };

  const weekLabel = `${formatDate(week, lang, { month: "short", day: "numeric" })} – ${formatDate(addDays(week, 6), lang, { month: "short", day: "numeric", year: "numeric" })}`;

  const chip = (s: Shift) => (
    <button
      type="button"
      key={s.id}
      className={`chip ${severity.get(s.id) ?? ""}`}
      onClick={() => setDraft({ id: s.id, employmentId: s.employment_id, date: localDate(new Date(s.starts_at), tz), start: hhmm(s.starts_at, tz), end: hhmm(s.ends_at, tz), breakMin: s.unpaid_break_minutes, jobRoleId: s.job_role_id })}
    >
      <span className="chip-time">
        {hhmm(s.starts_at, tz)}–{hhmm(s.ends_at, tz)}
      </span>
      {s.unpaid_break_minutes > 0 && <span className="chip-sub">{s.unpaid_break_minutes} min</span>}
      {s.job_role_id && (!s.employment_id || s.job_role_id !== data.employments.find((e) => e.id === s.employment_id)?.job_role_id) && (
        <span className="chip-sub">{(() => {
          const j = data.jobRoles.find((x) => x.id === s.job_role_id);
          return j ? (lang === "fr" ? j.name_fr : j.name_en) : "";
        })()}</span>
      )}
      {s.employment_id && weekRow?.status === "published" && (
        <span className={`chip-sub ${s.response === "confirmed" ? "confirmed" : "pending"}`}>{s.response === "confirmed" ? t.acknowledged : t.notAcknowledged}</span>
      )}
      {!s.employment_id && claims.some((c) => c.shift_id === s.id) && (
        <span className="chip-sub claims">{t.volunteers(claims.filter((c) => c.shift_id === s.id).length)}</span>
      )}
    </button>
  );

  const otherChips = (personId: string, date: string) =>
    allShifts
      .filter(
        (s) =>
          s.location_id !== location.id &&
          s.employment_id &&
          (data.employments.find((x) => x.id === s.employment_id)?.person_id ?? busy.employments.find((x) => x.id === s.employment_id)?.person_id) === personId &&
          localDate(new Date(s.starts_at), tz) === date,
      )
      .map((s) => (
        <span key={s.id} className="chip other" title={t.otherClinicShift}>
          <span className="chip-time">
            {hhmm(s.starts_at, tz)}–{hhmm(s.ends_at, tz)}
          </span>
          <span className="chip-sub">{data.locations.find((l) => l.id === s.location_id)?.name}</span>
        </span>
      ));

  const timeOffLabel = (personId: string, date: string) => {
    const o = timeOff.find((x) => x.person_id === personId && x.start_date <= date && x.end_date >= date);
    if (!o) return null;
    return `${t.timeOffTypes[o.type]}${o.start_time ? ` ${o.start_time.slice(0, 5)}–${o.end_time?.slice(0, 5)}` : ""}`;
  };

  return (
    <div className="stack-lg">
      <section className="controls card">
        <label className="field" htmlFor="sched-clinic">
          <span>{t.clinic}</span>
          <select id="sched-clinic" value={location.id} onChange={(e) => setLocationId(e.target.value)}>
            {managedLocations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} · {l.province}
              </option>
            ))}
          </select>
        </label>
        <div className="weeknav">
          <button type="button" className="icon" onClick={() => setWeek(addDays(week, -7))} aria-label={t.previousWeek}>
            ‹
          </button>
          <strong className="weeklabel">{weekLabel}</strong>
          <button type="button" className="icon" onClick={() => setWeek(addDays(week, 7))} aria-label={t.nextWeek}>
            ›
          </button>
        </div>
        <span className={`pill ${weekRow?.status === "published" ? "ok" : "muted-pill"}`}>{weekRow?.status === "published" ? t.published : t.draft}</span>
        <div className="actions">
          <button type="button" onClick={copyPrevious}>
            {t.copyPrevious}
          </button>
          <button type="button" onClick={() => setShowTemplates(true)}>
            {t.templates}
          </button>
          <button type="button" className="primary" onClick={publish}>
            {t.publish}
          </button>
        </div>
      </section>

      {error && <p className="error">{error}</p>}

      <div className="layout">
        <section className="card grid-card">
          {loading && <p className="muted small pad">{t.loading}</p>}
          {rows.length === 0 && <p className="muted pad">{t.noStaff}</p>}
          <div className="grid-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th className="sticky" />
                  {dates.map((d, i) => (
                    <th key={d}>
                      <span className="dow">{t.days[i]}</span>
                      <span className="dom">{formatDate(d, lang, { day: "numeric" })}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const p = data.persons.find((x) => x.id === e.person_id) as Person;
                  const mine = weekShifts.filter((s) => s.employment_id === e.id);
                  const scheduled = (result?.hours.find((h) => h.employmentId === e.id && h.week === week)?.scheduledMinutes) ?? mine.reduce((a, s) => a + paidMinutes(s), 0);
                  const target = e.desired_weekly_minutes ?? 0;
                  const over = e.max_weekly_minutes != null && scheduled > e.max_weekly_minutes;
                  return (
                    <tr key={e.id}>
                      <th scope="row" className="sticky person">
                        <span className="name">{personName(p)}</span>
                        {e.job_role_id && (
                          <span className="muted small">
                            {(() => {
                              const j = data.jobRoles.find((x) => x.id === e.job_role_id);
                              return j ? (lang === "fr" ? j.name_fr : j.name_en) : "";
                            })()}
                          </span>
                        )}
                        <span className={`meter ${over ? "over" : ""}`} aria-hidden="true">
                          <span style={{ width: `${target ? Math.min(100, (scheduled / target) * 100) : 0}%` }} />
                        </span>
                        <span className="hrs">
                          {hours(scheduled, lang)} {target ? `${t.of} ${hours(target, lang)} h` : "h"}
                        </span>
                      </th>
                      {dates.map((d) => {
                        const hint = availabilityHint(p.id, d);
                        return (
                          <td key={d}>
                            <div className="cell">
                              {hint && <span className={`avail ${hint === t.unavailable || hint === t.dayOff ? "no" : ""}`}>{hint}</span>}
                              {timeOffLabel(p.id, d) && <span className="avail no">{timeOffLabel(p.id, d)}</span>}
                              {mine.filter((s) => localDate(new Date(s.starts_at), tz) === d).map(chip)}
                              {otherChips(p.id, d)}
                              <button type="button" className="add" aria-label={`${t.addShift} · ${personName(p)} · ${d}`} onClick={() => setDraft({ id: null, employmentId: e.id, date: d, start: "08:00", end: "16:00", breakMin: 30, jobRoleId: null })}>
                                +
                              </button>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                <tr>
                  <th scope="row" className="sticky person">
                    <span className="name muted">{t.openShifts}</span>
                  </th>
                  {dates.map((d) => (
                    <td key={d}>
                      <div className="cell">
                        {weekShifts.filter((s) => s.employment_id === null && localDate(new Date(s.starts_at), tz) === d).map(chip)}
                        <button type="button" className="add" aria-label={`${t.addShift} · ${t.openShift} · ${d}`} onClick={() => setDraft({ id: null, employmentId: null, date: d, start: "08:00", end: "16:00", breakMin: 30, jobRoleId: null })}>
                          +
                        </button>
                      </div>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <aside className="card checks">
          <h2>{t.checksTitle}</h2>
          <p className="muted small">{t.checksHint}</p>
          {viewIssues.length === 0 ? (
            <p className="ok-text">{t.noIssues}</p>
          ) : (
            <ul className="issues">
              {[...errors, ...warnings].map((i, idx) => (
                <li key={idx} className={`issue ${i.severity}`}>
                  <span className="sev">{i.severity === "error" ? t.errorLabel : t.warningLabel}</span>
                  <span>{describe(i, allShifts, data.persons, data.employments, data.locations, data.jobRoles, t, lang)}</span>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      {draft && (
        <ShiftDialog
          t={t}
          lang={lang}
          draft={draft}
          dates={dates}
          staff={rows.map((e) => ({ id: e.id, name: personName(data.persons.find((p) => p.id === e.person_id)) }))}
          positions={data.jobRoles.map((j) => ({ id: j.id, name: lang === "fr" ? j.name_fr : j.name_en }))}
          candidates={draft.id ? candidatesFor(draft.id) : []}
          published={weekRow?.status === "published"}
          offer={draft.id ? offers[draft.id] : undefined}
          onOffer={draft.id ? (ids) => offerShift(draft.id!, ids) : undefined}
          onCancelOffer={cancelOffer}
          onCancel={() => setDraft(null)}
          onSave={saveShift}
          onDelete={deleteShift}
        />
      )}

      {showTemplates && (
        <TemplatesDialog
          locationId={location.id}
          week={week}
          onClose={() => setShowTemplates(false)}
          onDone={async (text) => {
            setToast(text);
            await load();
          }}
        />
      )}

      <div className={`toast ${toast ? "show" : ""}`} role="status" aria-live="polite">
        {toast}
      </div>
    </div>
  );
}

function describe(
  issue: Issue,
  shifts: Shift[],
  persons: Person[],
  employments: Employment[],
  locations: Location[],
  jobRoles: JobRole[],
  t: Strings,
  lang: Lang,
  asEmploymentId?: string,
): string {
  const s = shifts.find((x) => x.id === issue.shiftIds[0]);
  const other = shifts.find((x) => x.id === issue.shiftIds[1]);
  const loc = locations.find((l) => l.id === s?.location_id);
  const tz = loc?.timezone ?? "America/Toronto";
  const person =
    persons.find((p) => p.id === issue.personId) ??
    persons.find((p) => p.id === employments.find((e) => e.id === (asEmploymentId ?? s?.employment_id))?.person_id);
  const who = person ? personName(person) : t.openShift;
  const when = s ? `${t.daysLong[weekdayOf(localDate(new Date(s.starts_at), tz))]} ${hhmm(s.starts_at, tz)}–${hhmm(s.ends_at, tz)}` : "";
  const h = (m: unknown) => hours(Number(m), lang);
  const d = issue.details;
  const fr = lang === "fr";
  switch (issue.code) {
    case "shift_overlap":
      return fr
        ? `${who} : quarts qui se chevauchent (${loc?.name} et ${locations.find((l) => l.id === other?.location_id)?.name}).`
        : `${who}: overlapping shifts (${loc?.name} and ${locations.find((l) => l.id === other?.location_id)?.name}).`;
    case "location_not_allowed":
      return fr ? `${who} n'est pas affecté·e à cette clinique.` : `${who} isn't assigned to this clinic.`;
    case "credential_expired":
      return fr ? `${who} : ${d.credential} expiré (${when}).` : `${who}: ${d.credential} expired (${when}).`;
    case "outside_availability":
      return fr ? `${who} est à l'horaire hors de ses disponibilités (${when}).` : `${who} is scheduled outside their availability (${when}).`;
    case "overtime":
      return fr
        ? `${who} : ${h(d.scheduledMinutes)} h cette semaine, ${h(d.overtimeMinutes)} h au-delà du seuil de ${h(d.thresholdMinutes)} h.`
        : `${who}: ${h(d.scheduledMinutes)} h this week, ${h(d.overtimeMinutes)} h over the ${h(d.thresholdMinutes)} h overtime threshold.`;
    case "above_max_hours":
      return fr ? `${who} : ${h(d.scheduledMinutes)} h, au-dessus du maximum de ${h(d.maxWeeklyMinutes)} h.` : `${who}: ${h(d.scheduledMinutes)} h, above their ${h(d.maxWeeklyMinutes)} h maximum.`;
    case "below_min_hours":
      return fr ? `${who} : ${h(d.scheduledMinutes)} h, sous le minimum de ${h(d.minWeeklyMinutes)} h.` : `${who}: ${h(d.scheduledMinutes)} h, below their ${h(d.minWeeklyMinutes)} h minimum.`;
    case "weekly_rest":
      return fr
        ? `${who} : plus long repos ${h(d.longestRestMinutes)} h; ${d.province === "QC" ? "le Québec" : "l'Ontario"} exige ${h(d.requiredMinutes)} h consécutives.`
        : `${who}: longest rest ${h(d.longestRestMinutes)} h; ${d.province === "QC" ? "Quebec" : "Ontario"} requires ${h(d.requiredMinutes)} h in a row.`;
    case "meal_break_missing":
      return fr ? `${who} (${when}) : un quart de plus de 5 h exige une pause-repas de ${d.requiredMinutes} min.` : `${who} (${when}): a shift over 5 h needs a ${d.requiredMinutes}-minute meal break.`;
    case "short_notice_refusable":
      return fr
        ? `${who} (${when}) : modifié moins de 5 jours à l'avance. Au Québec, l'employé peut refuser.`
        : `${who} (${when}): changed less than 5 days ahead. In Quebec, the employee may refuse.`;
    case "province_rules_missing":
      return fr ? `${loc?.name} : aucune règle définie pour cette province.` : `${loc?.name}: no labour rules for this province yet.`;
    case "time_off":
      return fr ? `${who} est en congé approuvé (${when}).` : `${who} has approved time off (${when}).`;
    case "travel_time": {
      const a = locations.find((l) => l.id === d.fromLocationId)?.name;
      const b = locations.find((l) => l.id === d.toLocationId)?.name;
      return fr
        ? `${who} : ${d.gapMinutes} min entre ${a} et ${b}, il en faut environ ${d.requiredMinutes} pour se déplacer.`
        : `${who}: ${d.gapMinutes} min between ${a} and ${b}; about ${d.requiredMinutes} min needed to travel.`;
    }
    case "coverage_gap": {
      const j = jobRoles.find((x) => x.id === d.jobRoleId);
      const pos = j ? (fr ? j.name_fr : j.name_en) : "";
      const day = t.daysLong[weekdayOf(String(d.date))];
      return fr
        ? `${locations.find((l) => l.id === d.locationId)?.name} : ${pos} manquant ${day} de ${d.from} à ${d.to} (${d.scheduled}/${d.needed}).`
        : `${locations.find((l) => l.id === d.locationId)?.name}: ${pos} missing ${day} from ${d.from} to ${d.to} (${d.scheduled}/${d.needed}).`;
    }
    case "staffing_ratio": {
      const name = (id: unknown) => {
        const j = jobRoles.find((x) => x.id === id);
        return j ? (fr ? j.name_fr : j.name_en) : "";
      };
      const day = t.daysLong[weekdayOf(String(d.date))];
      const clinic = locations.find((l) => l.id === d.locationId)?.name;
      return fr
        ? `${clinic} : ${d.triggerScheduled} ${name(d.triggerJobRoleId)} en poste ${day} de ${d.from} à ${d.to}, il faut au moins ${d.needed} ${name(d.requiredJobRoleId)} (${d.scheduled} prévu${Number(d.scheduled) > 1 ? "s" : ""}).`
        : `${clinic}: ${d.triggerScheduled} ${name(d.triggerJobRoleId)} on shift ${day} from ${d.from} to ${d.to}, need at least ${d.needed} ${name(d.requiredJobRoleId)} (${d.scheduled} scheduled).`;
    }
    case "credential_expiring": {
      const on = formatDate(String(d.expiresOn), lang, { day: "numeric", month: "long", year: "numeric" });
      return fr ? `${who} : ${d.credential} expire le ${on}.` : `${who}: ${d.credential} expires on ${on}.`;
    }
    case "position_mismatch": {
      const name = (id: unknown) => {
        const j = jobRoles.find((x) => x.id === id);
        return j ? (fr ? j.name_fr : j.name_en) : "";
      };
      return fr
        ? `${who} (${when}) : quart de ${name(d.shiftJobRoleId)}, son poste est ${name(d.employeeJobRoleId)}.`
        : `${who} (${when}): ${name(d.shiftJobRoleId)} shift, their position is ${name(d.employeeJobRoleId)}.`;
    }
  }
}

function ShiftDialog({
  t,
  lang,
  draft,
  dates,
  staff,
  positions,
  candidates,
  published,
  offer,
  onOffer,
  onCancelOffer,
  onCancel,
  onSave,
  onDelete,
}: {
  t: Strings;
  lang: Lang;
  draft: Draft;
  dates: string[];
  staff: { id: string; name: string }[];
  positions: { id: string; name: string }[];
  candidates: Candidate[];
  published: boolean;
  offer?: OfferInfo;
  onOffer?: (employmentIds: string[] | null) => void;
  onCancelOffer: (offerId: string) => void;
  onCancel: () => void;
  onSave: (d: Draft) => void;
  onDelete: (id: string) => void;
}) {
  const [d, setD] = useState<Draft>({ repeat: 0, until: addDays(draft.date, 28), ...draft });
  const [invite, setInvite] = useState<Set<string>>(new Set());
  const overnight = d.end <= d.start;
  const valid = d.end !== d.start;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="overlay" onClick={onCancel}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shift-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSave(d);
        }}
      >
        <h2 id="shift-title">{d.id ? t.editShift : t.addShift}</h2>
        <label className="field" htmlFor="s-emp">
          <span>{t.employee}</span>
          <select id="s-emp" value={d.employmentId ?? ""} onChange={(e) => setD({ ...d, employmentId: e.target.value || null })}>
            <option value="">{t.openShift}</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {positions.length > 0 && (
          <label className="field" htmlFor="s-pos">
            <span>{t.shiftPosition}</span>
            <select id="s-pos" value={d.jobRoleId ?? ""} onChange={(e) => setD({ ...d, jobRoleId: e.target.value || null })}>
              <option value="">{d.employmentId ? t.employeesPosition : t.anyPosition}</option>
              {positions.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field" htmlFor="s-day">
          <span>{t.day}</span>
          <select id="s-day" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })}>
            {dates.map((x, i) => (
              <option key={x} value={x}>
                {t.daysLong[i]} {formatDate(x, lang, { day: "numeric", month: "short" })}
              </option>
            ))}
          </select>
        </label>
        <div className="grid3">
          <label className="field" htmlFor="s-start">
            <span>{t.start}</span>
            <input id="s-start" type="time" step={900} value={d.start} onChange={(e) => setD({ ...d, start: e.target.value })} required />
          </label>
          <label className="field" htmlFor="s-end">
            <span>{t.end}</span>
            <input id="s-end" type="time" step={900} value={d.end} onChange={(e) => setD({ ...d, end: e.target.value })} required />
          </label>
          <label className="field" htmlFor="s-break">
            <span>{t.breakMin}</span>
            <input id="s-break" type="number" min={0} max={240} step={15} value={d.breakMin} onChange={(e) => setD({ ...d, breakMin: Math.max(0, Number(e.target.value) || 0) })} />
          </label>
        </div>
        {!valid && <p className="error">{t.endAfterStart}</p>}
        {valid && overnight && <p className="muted small">{t.endsNextDay}</p>}
        {!d.id && (
          <div className="grid2">
            <label className="field" htmlFor="s-repeat">
              <span>{t.repeat}</span>
              <select id="s-repeat" value={d.repeat ?? 0} onChange={(e) => setD({ ...d, repeat: Number(e.target.value) as 0 | 1 | 2 })}>
                <option value={0}>{t.repeatNone}</option>
                <option value={1}>{t.repeatWeekly}</option>
                <option value={2}>{t.repeatBiweekly}</option>
              </select>
            </label>
            {(d.repeat ?? 0) > 0 && (
              <label className="field" htmlFor="s-until">
                <span>{t.repeatUntil}</span>
                <input id="s-until" type="date" value={d.until} min={d.date} max={addDays(d.date, 366)} onChange={(e) => setD({ ...d, until: e.target.value })} />
              </label>
            )}
          </div>
        )}
        {d.id && candidates.length > 0 && (
          <details className="cover" open={draft.employmentId === null}>
            <summary>{draft.employmentId === null ? t.findCoverage : t.findReplacement}</summary>
            <p className="muted small">{t.findReplacementHint}</p>
            <ul className="plain candidates">
              {candidates.map((c) => (
                <li key={c.employmentId} className={c.blocking.length ? "blocked" : c.warnings.length ? "warn" : "ok"}>
                  <div className="row spread">
                    <span>
                      <strong>{c.name}</strong>
                      {c.claimed && <span className="pill ok small-pill">{t.volunteered}</span>}
                    </span>
                    <span className="row">
                      {draft.employmentId === null && published && onOffer && c.blocking.length === 0 && (
                        <label className="check small" htmlFor={`inv-${c.employmentId}`}>
                          <input
                            id={`inv-${c.employmentId}`}
                            type="checkbox"
                            checked={invite.has(c.employmentId)}
                            onChange={(e) => {
                              const next = new Set(invite);
                              if (e.target.checked) next.add(c.employmentId);
                              else next.delete(c.employmentId);
                              setInvite(next);
                            }}
                          />
                          <span>{t.inviteSelected(1).replace(/\s*\(1\)/, "")}</span>
                        </label>
                      )}
                      <button type="button" className="link" disabled={c.blocking.length > 0} onClick={() => setD({ ...d, employmentId: c.employmentId })}>
                        {d.employmentId === c.employmentId ? t.chosen : t.choose}
                      </button>
                    </span>
                  </div>
                  {c.weekMinutes > 0 && (
                    <span className={`small block ${c.overtimeMinutes > 0 ? "warn" : "muted"}`}>
                      {t.weekHoursWith(hours(c.weekMinutes, lang))}
                      {c.overtimeMinutes > 0 ? ` · ${t.overtimeBy(hours(c.overtimeMinutes, lang))}` : ""}
                    </span>
                  )}
                  {c.blocking.length === 0 && c.warnings.length === 0 && <span className="ok-text small">{t.available}</span>}
                  {[...c.blocking, ...c.warnings].map((m, i) => (
                    <span key={i} className="small muted block">
                      {m}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
            {draft.employmentId === null && published && onOffer && (
              <div className="stack-sm">
                <p className="muted small">{t.findCoverageHint}</p>
                {offer && (
                  <p className="small">
                    {t.offerState(offer.invited, offer.declined)}{" "}
                    <button type="button" className="link small" onClick={() => onCancelOffer(offer.id)}>
                      {t.cancelOffer}
                    </button>
                  </p>
                )}
                <div className="row">
                  <button type="button" className="primary" disabled={invite.size === 0} onClick={() => onOffer([...invite])}>
                    {t.inviteSelected(invite.size)}
                  </button>
                  <button type="button" onClick={() => onOffer(null)}>
                    {t.inviteAllEligible}
                  </button>
                </div>
              </div>
            )}
          </details>
        )}
        <div className="row">
          {d.id && (
            <button type="button" className="danger" onClick={() => onDelete(d.id!)}>
              {t.deleteShift}
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={onCancel}>
            {t.cancel}
          </button>
          <button type="submit" className="primary">
            {t.save}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Save this week (or several as a rotation) as a template, or put a template on coming weeks. */
function TemplatesDialog({ locationId, week, onClose, onDone }: { locationId: string; week: string; onClose: () => void; onDone: (text: string) => Promise<void> }) {
  const { t, lang } = useSession();
  const [list, setList] = useState<ScheduleTemplate[]>([]);
  const [name, setName] = useState("");
  const [weeks, setWeeks] = useState(1);
  const [chosen, setChosen] = useState("");
  const [count, setCount] = useState(4);
  const [rotationStart, setRotationStart] = useState(week);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    const { data, error: err } = await supabase.from("schedule_templates").select("*").eq("location_id", locationId).order("name");
    if (err) setError(friendly(err, t));
    else {
      setList(data as ScheduleTemplate[]);
      if (!chosen && data?.length) setChosen((data as ScheduleTemplate[])[0].id);
    }
  }, [locationId, t, chosen]);
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const call = async (fn: string, args: Record<string, unknown>, ok: (r: Record<string, number>) => string) => {
    setError("");
    const { data, error: err } = await supabase.rpc(fn, args);
    if (err || !data?.ok) setError(err ? friendly(err, t) : t.error);
    else {
      await onDone(ok(data));
      await reload();
    }
  };
  const selected = list.find((x) => x.id === chosen);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog stack" role="dialog" aria-modal="true" aria-labelledby="tpl-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="tpl-title">{t.templates}</h2>
        <section className="stack-sm">
          <strong>{t.applyTemplate}</strong>
          {list.length === 0 ? (
            <p className="muted small">{t.noTemplates}</p>
          ) : (
            <>
              <label className="field" htmlFor="tpl-pick">
                <span>{t.templateName}</span>
                <select id="tpl-pick" value={chosen} onChange={(e) => setChosen(e.target.value)}>
                  {list.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name} ({x.weeks})
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid2">
                <label className="field" htmlFor="tpl-count">
                  <span>{t.applyFor}</span>
                  <input id="tpl-count" type="number" min={1} max={26} value={count} onChange={(e) => setCount(Math.min(26, Math.max(1, Number(e.target.value) || 1)))} />
                </label>
                {selected && selected.weeks > 1 && (
                  <label className="field" htmlFor="tpl-rot">
                    <span>{t.rotationStart}</span>
                    <input id="tpl-rot" type="date" step={7} value={rotationStart} onChange={(e) => setRotationStart(e.target.value)} />
                  </label>
                )}
              </div>
              <div className="row">
                <button
                  type="button"
                  className="primary"
                  onClick={() =>
                    call("apply_template", { p_template_id: chosen, p_from_week: week, p_weeks: count, p_rotation_start: selected && selected.weeks > 1 ? localWeekStartOf(rotationStart) : null }, (r) =>
                      t.templateApplied(r.added),
                    )
                  }
                >
                  {t.applyTemplate} · {formatDate(week, lang, { day: "numeric", month: "short" })}
                </button>
                <button
                  type="button"
                  className="danger link"
                  onClick={async () => {
                    const { error: err } = await supabase.from("schedule_templates").delete().eq("id", chosen);
                    if (err) setError(friendly(err, t));
                    else {
                      setChosen("");
                      await reload();
                    }
                  }}
                >
                  {t.deleteTemplate}
                </button>
              </div>
            </>
          )}
        </section>
        <section className="stack-sm">
          <strong>{t.saveAsTemplate}</strong>
          <div className="grid2">
            <label className="field" htmlFor="tpl-name">
              <span>{t.templateName}</span>
              <input id="tpl-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field" htmlFor="tpl-weeks">
              <span>{t.templateWeeks}</span>
              <input id="tpl-weeks" type="number" min={1} max={8} value={weeks} onChange={(e) => setWeeks(Math.min(8, Math.max(1, Number(e.target.value) || 1)))} />
            </label>
          </div>
          <p className="muted small">{t.templateWeeksHint}</p>
          <button
            type="button"
            disabled={!name.trim()}
            onClick={() => call("save_template", { p_location_id: locationId, p_name: name.trim(), p_first_week: week, p_weeks: weeks }, (r) => t.templateSaved(r.shifts))}
          >
            {t.saveAsTemplate}
          </button>
        </section>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {t.close}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Monday of the week containing a date (YYYY-MM-DD). */
function localWeekStartOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}
