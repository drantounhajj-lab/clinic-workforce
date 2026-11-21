import {
  addDays,
  type EmploymentInput,
  type Issue,
  localDate,
  localWeekStart,
  validateSchedule,
  weekdayOf,
  zonedToUtc,
} from "@clinic-workforce/rules";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDate, hours, type Lang, type Strings } from "../i18n";
import { personName, useSession } from "../session";
import {
  type AvailabilityException,
  type AvailabilityRule,
  type Employment,
  type Location,
  must,
  type Person,
  type ScheduleWeek,
  type Shift,
  supabase,
} from "../supabase";

interface Draft {
  id: string | null;
  employmentId: string | null;
  date: string;
  start: string;
  end: string;
  breakMin: number;
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
      const [w, atClinic, ofStaff, r, x] = await Promise.all([
        supabase.from("schedule_weeks").select("*").eq("location_id", location.id).eq("week_start", week).maybeSingle(),
        supabase.from("shifts").select("*").eq("location_id", location.id).gte("starts_at", from).lt("starts_at", to),
        empIds.length
          ? supabase.from("shifts").select("*").in("employment_id", empIds).gte("starts_at", from).lt("starts_at", to)
          : Promise.resolve({ data: [], error: null }),
        personIds.length ? supabase.from("availability_rules").select("*").in("person_id", personIds).eq("status", "approved") : Promise.resolve({ data: [], error: null }),
        personIds.length
          ? supabase.from("availability_exceptions").select("*").in("person_id", personIds).eq("status", "approved").gte("date", week).lt("date", addDays(week, 7))
          : Promise.resolve({ data: [], error: null }),
      ]);
      setWeekRow(must(w) as ScheduleWeek | null);
      const merged = new Map<string, Shift>();
      for (const s of [...(must(atClinic) as Shift[]), ...(must(ofStaff) as Shift[])]) merged.set(s.id, s);
      setShifts([...merged.values()]);
      setRules(must(r) as AvailabilityRule[]);
      setExceptions(must(x) as AvailabilityException[]);
    } catch (e) {
      setError((e as Error).message);
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

  const result = useMemo(() => {
    if (!data || !location) return null;
    const employments: EmploymentInput[] = data.employments.map((e) => ({
      id: e.id,
      personId: e.person_id,
      companyId: e.company_id,
      locationIds: e.employment_locations.map((x) => x.location_id),
      desiredWeeklyMinutes: e.desired_weekly_minutes,
      minWeeklyMinutes: e.min_weekly_minutes,
      maxWeeklyMinutes: e.max_weekly_minutes,
    }));
    const changed = weekRow?.status === "published" && weekRow.published_at
      ? shifts.filter((s) => s.location_id === location.id && s.week_start === week && s.updated_at > weekRow.published_at!).map((s) => s.id)
      : [];
    return validateSchedule({
      locations: data.locations.map((l) => ({ id: l.id, companyId: l.company_id, province: l.province, timezone: l.timezone })),
      employments,
      shifts: shifts
        .filter((s) => employments.some((e) => e.id === s.employment_id) || s.employment_id === null)
        .map((s) => ({ id: s.id, employmentId: s.employment_id, locationId: s.location_id, startsAt: new Date(s.starts_at), endsAt: new Date(s.ends_at), unpaidBreakMinutes: s.unpaid_break_minutes })),
      availabilityRules: rules.map((r) => ({ personId: r.person_id, weekday: r.weekday, start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5), status: r.status })),
      availabilityExceptions: exceptions.map((x) => ({ personId: x.person_id, date: x.date, start: x.start_time?.slice(0, 5), end: x.end_time?.slice(0, 5), status: x.status })),
      changedShiftIds: changed,
      weeks: [week],
      now: new Date(),
    });
  }, [data, location, shifts, rules, exceptions, week, weekRow]);

  if (!data) return null;
  if (!location) return <p className="card">{t.noClinics}</p>;

  const weekShifts = shifts.filter((s) => s.location_id === location.id && s.week_start === week);
  const viewIssues = (result?.issues ?? []).filter((i) => i.shiftIds.some((id) => weekShifts.some((s) => s.id === id)));
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
        ends_at: zonedToUtc(d.date, d.end, tz).toISOString(),
        unpaid_break_minutes: d.breakMin,
      };
      if (d.id) must(await supabase.from("shifts").update(row).eq("id", d.id));
      else must(await supabase.from("shifts").insert(row));
      setDraft(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteShift(id: string) {
    try {
      must(await supabase.from("shifts").delete().eq("id", id));
      setDraft(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function copyPrevious() {
    const prev = shifts.filter((s) => s.location_id === location!.id && s.week_start === addDays(week, -7));
    if (prev.length === 0) {
      setToast(t.nothingToCopy);
      return;
    }
    try {
      await ensureWeek();
      const rowsToInsert = prev
        .map((s) => ({
          location_id: location!.id,
          week_start: week,
          employment_id: s.employment_id,
          starts_at: new Date(Date.parse(s.starts_at) + 7 * 86400000).toISOString(),
          ends_at: new Date(Date.parse(s.ends_at) + 7 * 86400000).toISOString(),
          unpaid_break_minutes: s.unpaid_break_minutes,
          job_role_id: s.job_role_id,
          notes: s.notes,
        }))
        // Keep local clock times across daylight-saving changes
        .map((r, i) => {
          const s = prev[i];
          const date = addDays(localDate(new Date(s.starts_at), tz), 7);
          return { ...r, starts_at: zonedToUtc(date, hhmm(s.starts_at, tz), tz).toISOString(), ends_at: zonedToUtc(date, hhmm(s.ends_at, tz), tz).toISOString() };
        })
        // Compare instants, not strings ("14:00:00+00:00" and "14:00:00.000Z" are the same time)
        .filter(
          (r) =>
            !weekShifts.some(
              (x) =>
                x.employment_id === r.employment_id &&
                Date.parse(x.starts_at) === Date.parse(r.starts_at) &&
                Date.parse(x.ends_at) === Date.parse(r.ends_at),
            ),
        );
      // The database also refuses duplicates (shifts_no_duplicate); skip any that slip through.
      if (rowsToInsert.length) {
        must(
          await supabase
            .from("shifts")
            .upsert(rowsToInsert, { onConflict: "employment_id,location_id,starts_at,ends_at", ignoreDuplicates: true }),
        );
      }
      setToast(t.copied(rowsToInsert.length));
      await load();
    } catch (e) {
      setError((e as Error).message);
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
      setError((e as Error).message);
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
      onClick={() => setDraft({ id: s.id, employmentId: s.employment_id, date: localDate(new Date(s.starts_at), tz), start: hhmm(s.starts_at, tz), end: hhmm(s.ends_at, tz), breakMin: s.unpaid_break_minutes })}
    >
      <span className="chip-time">
        {hhmm(s.starts_at, tz)}–{hhmm(s.ends_at, tz)}
      </span>
      {s.unpaid_break_minutes > 0 && <span className="chip-sub">{s.unpaid_break_minutes} min</span>}
      {s.response !== "pending" && <span className={`chip-sub ${s.response}`}>{s.response === "confirmed" ? t.confirmed : t.declined}</span>}
    </button>
  );

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
                              {mine.filter((s) => localDate(new Date(s.starts_at), tz) === d).map(chip)}
                              <button type="button" className="add" aria-label={`${t.addShift} · ${personName(p)} · ${d}`} onClick={() => setDraft({ id: null, employmentId: e.id, date: d, start: "08:00", end: "16:00", breakMin: 30 })}>
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
                        <button type="button" className="add" aria-label={`${t.addShift} · ${t.openShift} · ${d}`} onClick={() => setDraft({ id: null, employmentId: null, date: d, start: "08:00", end: "16:00", breakMin: 30 })}>
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
                  <span>{describe(i, shifts, data.persons, data.employments, data.locations, t, lang)}</span>
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
          onCancel={() => setDraft(null)}
          onSave={saveShift}
          onDelete={deleteShift}
        />
      )}

      <div className={`toast ${toast ? "show" : ""}`} role="status" aria-live="polite">
        {toast}
      </div>
    </div>
  );
}

function describe(issue: Issue, shifts: Shift[], persons: Person[], employments: Employment[], locations: Location[], t: Strings, lang: Lang): string {
  const s = shifts.find((x) => x.id === issue.shiftIds[0]);
  const other = shifts.find((x) => x.id === issue.shiftIds[1]);
  const loc = locations.find((l) => l.id === s?.location_id);
  const tz = loc?.timezone ?? "America/Toronto";
  const person =
    persons.find((p) => p.id === issue.personId) ?? persons.find((p) => p.id === employments.find((e) => e.id === s?.employment_id)?.person_id);
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
  }
}

function ShiftDialog({
  t,
  lang,
  draft,
  dates,
  staff,
  onCancel,
  onSave,
  onDelete,
}: {
  t: Strings;
  lang: Lang;
  draft: Draft;
  dates: string[];
  staff: { id: string; name: string }[];
  onCancel: () => void;
  onSave: (d: Draft) => void;
  onDelete: (id: string) => void;
}) {
  const [d, setD] = useState(draft);
  const valid = d.end > d.start;
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
