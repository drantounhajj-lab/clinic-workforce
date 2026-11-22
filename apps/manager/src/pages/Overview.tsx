import { addDays, localWeekStart } from "@clinic-workforce/rules";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDate, friendly } from "../i18n";
import { personName, useSession } from "../session";
import { must, type ScheduleWeek, type Shift, supabase } from "../supabase";

interface Unacknowledged {
  id: string;
  location_id: string;
  person_id: string;
  starts_at: string;
  ends_at: string;
  changed_after_publish: boolean;
  reminded_at: string | null;
}

/** Every clinic the manager schedules, one week at a time, with filters; and shifts not yet seen by employees. */
export function Overview() {
  const { t, lang, data, locationsWith } = useSession();
  const clinics = locationsWith("schedule");
  const [week, setWeek] = useState(() => localWeekStart(new Date(), "America/Toronto"));
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [weeks, setWeeks] = useState<ScheduleWeek[]>([]);
  const [pending, setPending] = useState<Unacknowledged[]>([]);
  const [filter, setFilter] = useState({ clinic: "", person: "", position: "", employer: "" });
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const ids = clinics.map((c) => c.id);
      if (!ids.length) return;
      const from = `${addDays(week, -1)}T00:00:00Z`;
      const to = `${addDays(week, 8)}T00:00:00Z`;
      const [sh, wk, un] = await Promise.all([
        supabase.from("shifts").select("*").in("location_id", ids).gte("starts_at", from).lt("starts_at", to).order("starts_at"),
        supabase.from("schedule_weeks").select("*").in("location_id", ids).eq("week_start", week),
        supabase.rpc("unacknowledged_shifts"),
      ]);
      setShifts((must(sh) as Shift[]).filter((s) => s.week_start === week));
      setWeeks(must(wk) as ScheduleWeek[]);
      if (un.error) throw un.error;
      setPending((un.data as Unacknowledged[]) ?? []);
    } catch (e) {
      setError(friendly(e, t));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week, clinics.map((c) => c.id).join()]);

  useEffect(() => {
    load();
  }, [load]);

  const view = useMemo(() => {
    if (!data) return { rows: [] as { key: string; label: string; sub: string; byDay: Shift[][] }[], open: [] as Shift[], openByDay: [] as Shift[][] };
    const emp = (id: string | null) => data.employments.find((e) => e.id === id);
    const positionOf = (s: Shift) => s.job_role_id ?? emp(s.employment_id)?.job_role_id ?? null;
    const visible = shifts.filter((s) => {
      const e = emp(s.employment_id);
      if (filter.clinic && s.location_id !== filter.clinic) return false;
      if (filter.position && positionOf(s) !== filter.position) return false;
      if (filter.person && e?.person_id !== filter.person) return false;
      if (filter.employer && (e ? e.company_id : data.locations.find((l) => l.id === s.location_id)?.company_id) !== filter.employer) return false;
      return true;
    });
    const tz = (s: Shift) => data.locations.find((l) => l.id === s.location_id)?.timezone ?? "America/Toronto";
    const dayIndex = (s: Shift) => {
      const local = new Intl.DateTimeFormat("en-CA", { timeZone: tz(s), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(s.starts_at));
      return Math.round((Date.parse(`${local}T12:00:00Z`) - Date.parse(`${week}T12:00:00Z`)) / 86_400_000);
    };
    const people = new Map<string, Shift[]>();
    for (const s of visible.filter((x) => x.employment_id)) {
      const pid = emp(s.employment_id)?.person_id ?? "?";
      people.set(pid, [...(people.get(pid) ?? []), s]);
    }
    const rows = [...people.entries()]
      .map(([pid, list]) => {
        const p = data.persons.find((x) => x.id === pid);
        const byDay: Shift[][] = [0, 1, 2, 3, 4, 5, 6].map((d) => list.filter((s) => dayIndex(s) === d));
        const positions = [...new Set(list.map(positionOf).filter(Boolean))].map((id) => {
          const j = data.jobRoles.find((x) => x.id === id);
          return j ? (lang === "fr" ? j.name_fr : j.name_en) : "";
        });
        return { key: pid, label: personName(p), sub: positions.join(", "), byDay };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    const open = visible.filter((s) => !s.employment_id);
    return { rows, open, openByDay: [0, 1, 2, 3, 4, 5, 6].map((d) => open.filter((s) => dayIndex(s) === d)) };
  }, [data, shifts, filter, week, lang]);

  if (!data) return null;
  const clinicName = (id: string) => data.locations.find((l) => l.id === id)?.name ?? "";
  const hm = (iso: string, locId: string) =>
    new Intl.DateTimeFormat("en-CA", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: data.locations.find((l) => l.id === locId)?.timezone ?? "America/Toronto" }).format(new Date(iso));
  const when = (s: { starts_at: string; ends_at: string; location_id: string }) =>
    `${new Intl.DateTimeFormat(lang === "fr" ? "fr-CA" : "en-CA", { weekday: "short", day: "numeric", month: "short", timeZone: data.locations.find((l) => l.id === s.location_id)?.timezone }).format(new Date(s.starts_at))} ${hm(s.starts_at, s.location_id)}–${hm(s.ends_at, s.location_id)}`;
  const draftAt = new Set(clinics.filter((c) => weeks.find((w) => w.location_id === c.id)?.status !== "published").map((c) => c.id));
  const people = [...new Set(data.employments.filter((e) => e.employment_locations.some((x) => clinics.some((c) => c.id === x.location_id))).map((e) => e.person_id))]
    .map((id) => data.persons.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .sort((a, b) => personName(a).localeCompare(personName(b)));

  async function remind(ids: string[]) {
    setNotice("");
    const { data: res, error: err } = await supabase.rpc("remind_unacknowledged", { p_shift_ids: ids });
    if (err || !res?.ok) setError(err ? friendly(err, t) : t.error);
    else {
      setNotice(t.reminded(res.reminded));
      await load();
    }
  }

  return (
    <div className="stack-lg">
      <section className="card toolbar">
        <div className="weeknav">
          <button type="button" className="icon" onClick={() => setWeek(addDays(week, -7))} aria-label={t.previousWeek}>
            ‹
          </button>
          <strong className="weeklabel">
            {formatDate(week, lang, { day: "numeric", month: "short" })} – {formatDate(addDays(week, 6), lang, { day: "numeric", month: "short", year: "numeric" })}
          </strong>
          <button type="button" className="icon" onClick={() => setWeek(addDays(week, 7))} aria-label={t.nextWeek}>
            ›
          </button>
        </div>
        <label className="field" htmlFor="ov-clinic">
          <span>{t.filterClinic}</span>
          <select id="ov-clinic" value={filter.clinic} onChange={(e) => setFilter({ ...filter, clinic: e.target.value })}>
            <option value="">{t.allOption}</option>
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="ov-person">
          <span>{t.filterEmployee}</span>
          <select id="ov-person" value={filter.person} onChange={(e) => setFilter({ ...filter, person: e.target.value })}>
            <option value="">{t.allOption}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {personName(p)}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="ov-pos">
          <span>{t.filterPosition}</span>
          <select id="ov-pos" value={filter.position} onChange={(e) => setFilter({ ...filter, position: e.target.value })}>
            <option value="">{t.allOption}</option>
            {data.jobRoles.map((j) => (
              <option key={j.id} value={j.id}>
                {lang === "fr" ? j.name_fr : j.name_en}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="ov-employer">
          <span>{t.filterEmployer}</span>
          <select id="ov-employer" value={filter.employer} onChange={(e) => setFilter({ ...filter, employer: e.target.value })}>
            <option value="">{t.allOption}</option>
            {data.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.legal_name}
              </option>
            ))}
          </select>
        </label>
      </section>

      {error && <p className="error">{error}</p>}

      <section className="card grid-card">
        <div className="grid-wrap">
          <table className="table overview">
            <thead>
              <tr>
                <th scope="col">{t.employee}</th>
                {t.days.map((d, i) => (
                  <th key={d} scope="col">
                    {d} {formatDate(addDays(week, i), lang, { day: "numeric" })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.rows.length === 0 && view.open.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    {t.noShiftsFound}
                  </td>
                </tr>
              )}
              {view.rows.map((r) => (
                <tr key={r.key}>
                  <th scope="row">
                    {r.label}
                    {r.sub && <span className="small muted block">{r.sub}</span>}
                  </th>
                  {r.byDay.map((list, i) => (
                    <td key={i} className="small">
                      {list.map((s) => (
                        <span key={s.id} className={`block ${s.response === "pending" && !draftAt.has(s.location_id) ? "warn" : ""}`}>
                          {hm(s.starts_at, s.location_id)}–{hm(s.ends_at, s.location_id)} · {clinicName(s.location_id)}
                          {draftAt.has(s.location_id) ? ` (${t.draft.toLowerCase()})` : ""}
                        </span>
                      ))}
                    </td>
                  ))}
                </tr>
              ))}
              {view.open.length > 0 && (
                <tr>
                  <th scope="row">{t.openShiftLabel}</th>
                  {view.openByDay.map((list, d) => (
                    <td key={d} className="small">
                      {list
                        .map((s) => (
                          <span key={s.id} className="block warn">
                            {hm(s.starts_at, s.location_id)}–{hm(s.ends_at, s.location_id)} · {clinicName(s.location_id)}
                          </span>
                        ))}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card stack">
        <div className="row spread">
          <h2>{t.notAcknowledgedList}</h2>
          {pending.length > 0 && (
            <button type="button" onClick={() => remind(pending.map((p) => p.id))}>
              {t.remindAll}
            </button>
          )}
        </div>
        <p className="muted small">{t.notAcknowledgedHint}</p>
        {notice && <p className="notice">{notice}</p>}
        {pending.length === 0 ? (
          <p className="muted small">{t.none}</p>
        ) : (
          <ul className="plain stack-sm">
            {pending.map((p) => (
              <li key={p.id} className="row spread">
                <span className="small">
                  <strong>{personName(data.persons.find((x) => x.id === p.person_id))}</strong> · {when(p)} · {clinicName(p.location_id)}
                  {p.changed_after_publish && <span className="tag">{t.changedAfterPublish}</span>}
                  {p.reminded_at && (
                    <span className="muted">
                      {" "}
                      · {t.remindedAt(new Intl.DateTimeFormat(lang === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" }).format(new Date(p.reminded_at)))}
                    </span>
                  )}
                </span>
                <button type="button" className="link small" onClick={() => remind([p.id])}>
                  {t.remind}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
