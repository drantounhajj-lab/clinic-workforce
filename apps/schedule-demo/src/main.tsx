import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  addDays,
  type Issue,
  localDate,
  type ShiftInput,
  validateSchedule,
  weekdayOf,
  zonedToUtc,
} from "@clinic-workforce/rules";
import {
  availabilityExceptions,
  availabilityRules,
  type Clinic,
  clinics,
  credentials,
  type DemoShift,
  employments,
  persons,
  seedShifts,
  TZ,
} from "./data";
import { formatDate, hours, issueMessage, type Lang, strings, type Strings } from "./i18n";

// ---------- State ----------

interface DemoState {
  seedWeek: string;
  shifts: DemoShift[];
  /** "clinicId|week" → ISO date published */
  published: Record<string, string>;
  /** Shifts added or changed after their week was published (Quebec 5-day notice). */
  changed: string[];
  combine: boolean;
  counter: number;
}

const STORAGE_KEY = "clinic-workforce-schedule-demo-v1";

function upcomingMonday(): string {
  const today = localDate(new Date(), TZ);
  return addDays(today, 7 - weekdayOf(today));
}

function initialState(w0: string): DemoState {
  return {
    seedWeek: w0,
    shifts: seedShifts(w0),
    published: { [`gatineau|${w0}`]: new Date().toISOString() },
    changed: [],
    combine: false,
    counter: 1,
  };
}

function loadState(w0: string): DemoState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DemoState;
    return parsed.seedWeek === w0 ? parsed : null;
  } catch {
    return null;
  }
}

function saveState(state: DemoState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable: the demo still works for this visit */
  }
}

function loadLang(): Lang {
  try {
    const saved = localStorage.getItem(`${STORAGE_KEY}-lang`);
    if (saved === "fr" || saved === "en") return saved;
  } catch {
    /* ignore */
  }
  return navigator.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

// ---------- Helpers ----------

const weekOf = (date: string) => addDays(date, -weekdayOf(date));
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const paidMinutes = (s: DemoShift) => Math.max(0, minutesOf(s.end) - minutesOf(s.start) - s.breakMin);
const personOf = (employmentId: string | null) =>
  employmentId ? persons.find((p) => p.id === employments.find((e) => e.id === employmentId)?.personId) : undefined;
const clinicById = (id: string) => clinics.find((c) => c.id === id)!;
const timeRange = (s: DemoShift) => `${s.start}–${s.end}`;

function toInput(s: DemoShift): ShiftInput {
  return {
    id: s.id,
    employmentId: s.employmentId,
    locationId: s.locationId,
    startsAt: zonedToUtc(s.date, s.start, TZ),
    endsAt: zonedToUtc(s.date, s.end, TZ),
    unpaidBreakMinutes: s.breakMin,
  };
}

function runChecks(state: DemoState, week: string, shifts: DemoShift[] = state.shifts, extraChanged: string[] = []) {
  const weeks = new Set([addDays(week, -7), week, addDays(week, 7)]);
  return validateSchedule({
    locations: clinics,
    employments,
    shifts: shifts.filter((s) => weeks.has(weekOf(s.date))).map(toInput),
    availabilityRules,
    availabilityExceptions: availabilityExceptions(state.seedWeek),
    credentials: credentials(state.seedWeek),
    combineRelatedCompanyHours: state.combine,
    changedShiftIds: [...state.changed, ...extraChanged],
    weeks: [week],
    now: new Date(),
  });
}

function describeIssue(issue: Issue, shifts: DemoShift[], lang: Lang, t: Strings): string {
  const byId = new Map(shifts.map((s) => [s.id, s]));
  const first = byId.get(issue.shiftIds[0]);
  const second = byId.get(issue.shiftIds[1]);
  const person = persons.find((p) => p.id === issue.personId) ?? personOf(first?.employmentId ?? null);
  return issueMessage(
    issue,
    {
      personName: person?.name ?? t.openShift,
      clinicName: first ? clinicById(first.locationId).name : "",
      dayLabel: first ? t.daysLong[weekdayOf(first.date)] : "",
      timeRange: first ? timeRange(first) : "",
      otherClinicName: second ? clinicById(second.locationId).name : undefined,
      otherTimeRange: second ? timeRange(second) : undefined,
    },
    lang,
  );
}

function availabilityHint(personId: string, date: string, w0: string, t: Strings): string | null {
  if (availabilityExceptions(w0).some((x) => x.personId === personId && x.date === date && x.status === "approved")) {
    return t.dayOff;
  }
  const rules = availabilityRules.filter((r) => r.personId === personId && r.status === "approved");
  if (rules.length === 0) return null;
  const today = rules.filter((r) => r.weekday === weekdayOf(date));
  if (today.length === 0) return t.unavailable;
  const r = today[0];
  return r.start <= "08:00" ? t.availableUntil(r.end) : t.availableRange(r.start, r.end);
}

// ---------- Components ----------

interface Draft {
  mode: "add" | "edit";
  shift: DemoShift;
}

function App() {
  const w0 = useMemo(upcomingMonday, []);
  const [lang, setLang] = useState<Lang>(loadLang);
  const [state, setState] = useState<DemoState>(() => loadState(w0) ?? initialState(w0));
  const [week, setWeek] = useState(w0);
  const [view, setView] = useState<string>("gatineau");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const t = strings[lang];

  useEffect(() => saveState(state), [state]);
  useEffect(() => {
    document.documentElement.lang = lang === "fr" ? "fr-CA" : "en-CA";
    try {
      localStorage.setItem(`${STORAGE_KEY}-lang`, lang);
    } catch {
      /* ignore */
    }
  }, [lang]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(id);
  }, [toast]);

  const viewClinics: Clinic[] = view === "all" ? clinics : [clinicById(view)];
  const viewIds = new Set(viewClinics.map((c) => c.id));
  const result = useMemo(() => runChecks(state, week), [state, week]);
  const weekShifts = state.shifts.filter((s) => weekOf(s.date) === week);
  const shiftById = new Map(state.shifts.map((s) => [s.id, s]));

  const viewIssues = result.issues.filter((i) =>
    i.shiftIds.some((id) => {
      const s = shiftById.get(id);
      return s && viewIds.has(s.locationId) && weekOf(s.date) === week;
    }),
  );
  const severityByShift = new Map<string, "error" | "warning">();
  for (const i of result.issues) {
    for (const id of i.shiftIds) {
      if (i.severity === "error" || !severityByShift.has(id)) severityByShift.set(id, i.severity);
    }
  }
  const errors = viewIssues.filter((i) => i.severity === "error");
  const warnings = viewIssues.filter((i) => i.severity === "warning");
  const viewWeekShifts = weekShifts.filter((s) => viewIds.has(s.locationId));
  const viewMinutes = viewWeekShifts.reduce((a, s) => a + paidMinutes(s), 0);

  const isPublished = (clinicId: string) => Boolean(state.published[`${clinicId}|${week}`]);

  function saveShift(shift: DemoShift) {
    setState((prev) => {
      const exists = prev.shifts.some((s) => s.id === shift.id);
      const shifts = exists ? prev.shifts.map((s) => (s.id === shift.id ? shift : s)) : [...prev.shifts, shift];
      const changed =
        prev.published[`${shift.locationId}|${weekOf(shift.date)}`] && !prev.changed.includes(shift.id)
          ? [...prev.changed, shift.id]
          : prev.changed;
      return { ...prev, shifts, changed, counter: exists ? prev.counter : prev.counter + 1 };
    });
    setDraft(null);
  }

  function deleteShift(id: string) {
    setState((prev) => ({
      ...prev,
      shifts: prev.shifts.filter((s) => s.id !== id),
      changed: prev.changed.filter((c) => c !== id),
    }));
    setDraft(null);
  }

  function copyPreviousWeek() {
    const source = state.shifts.filter((s) => weekOf(s.date) === addDays(week, -7) && viewIds.has(s.locationId));
    if (source.length === 0) {
      setToast(t.nothingToCopy);
      return;
    }
    const added: DemoShift[] = [];
    let counter = state.counter;
    let skipped = 0;
    for (const s of source) {
      const date = addDays(s.date, 7);
      const duplicate = state.shifts.some(
        (x) => x.employmentId === s.employmentId && x.locationId === s.locationId && x.date === date && x.start === s.start && x.end === s.end,
      );
      if (duplicate) skipped++;
      else added.push({ ...s, id: `copy-${counter++}`, date });
    }
    const newlyChanged = added.filter((s) => state.published[`${s.locationId}|${week}`]).map((s) => s.id);
    setState((prev) => ({
      ...prev,
      shifts: [...prev.shifts, ...added],
      changed: [...prev.changed, ...newlyChanged],
      counter,
    }));
    setToast(t.copiedToast(added.length, skipped));
  }

  function publishWeek() {
    if (errors.length > 0) {
      setToast(t.publishBlocked(errors.length));
      document.getElementById("checks")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    setState((prev) => {
      const published = { ...prev.published };
      for (const c of viewClinics) published[`${c.id}|${week}`] = new Date().toISOString();
      return { ...prev, published };
    });
    setToast(t.publishedToast);
  }

  function resetDemo() {
    setState(initialState(w0));
    setWeek(w0);
    setDraft(null);
  }

  function openAdd(clinic: Clinic, employmentId: string | null, date: string) {
    setDraft({
      mode: "add",
      shift: { id: `new-${state.counter}`, employmentId, locationId: clinic.id, date, start: "08:00", end: "16:00", breakMin: 30 },
    });
  }

  const weekLabel = `${formatDate(week, lang, { month: "short", day: "numeric" })} – ${formatDate(addDays(week, 6), lang, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <h1>{t.appName}</h1>
          <span className="badge">{t.demoBadge}</span>
        </div>
        <div className="lang" role="group" aria-label="Language">
          <button type="button" className={lang === "fr" ? "on" : ""} onClick={() => setLang("fr")} aria-pressed={lang === "fr"}>
            FR
          </button>
          <button type="button" className={lang === "en" ? "on" : ""} onClick={() => setLang("en")} aria-pressed={lang === "en"}>
            EN
          </button>
        </div>
      </header>

      <section className="controls">
        <label className="field" htmlFor="clinic-select">
          <span>{t.clinic}</span>
          <select id="clinic-select" value={view} onChange={(e) => setView(e.target.value)}>
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.province}
              </option>
            ))}
            <option value="all">{t.allClinics}</option>
          </select>
        </label>

        <div className="weeknav">
          <button type="button" className="icon" onClick={() => setWeek(addDays(week, -7))} aria-label={t.previousWeek}>
            ‹
          </button>
          <div className="weeklabel">
            <strong>{weekLabel}</strong>
            {week !== w0 && (
              <button type="button" className="link" onClick={() => setWeek(w0)}>
                {t.thisWeek}
              </button>
            )}
          </div>
          <button type="button" className="icon" onClick={() => setWeek(addDays(week, 7))} aria-label={t.nextWeek}>
            ›
          </button>
        </div>

        <div className="actions">
          <button type="button" onClick={copyPreviousWeek}>
            {t.copyPrevious}
          </button>
          <button type="button" className="primary" onClick={publishWeek}>
            {t.publish}
          </button>
        </div>
      </section>

      <section className="summary" aria-label="Summary">
        <div className="stat">
          <span>{t.shifts}</span>
          <strong>{viewWeekShifts.length}</strong>
        </div>
        <div className="stat">
          <span>{t.scheduled}</span>
          <strong>{hours(viewMinutes, lang)} h</strong>
        </div>
        <div className={`stat ${errors.length ? "is-error" : ""}`}>
          <span>{t.errors}</span>
          <strong>{errors.length}</strong>
        </div>
        <div className={`stat ${warnings.length ? "is-warning" : ""}`}>
          <span>{t.warnings}</span>
          <strong>{warnings.length}</strong>
        </div>
        <label className="toggle" htmlFor="combine">
          <input
            id="combine"
            type="checkbox"
            checked={state.combine}
            onChange={(e) => setState((prev) => ({ ...prev, combine: e.target.checked }))}
          />
          <span>{t.combine}</span>
        </label>
      </section>

      <main className="layout">
        <div className="grids">
          {viewClinics.map((clinic) => (
            <ClinicGrid
              key={clinic.id}
              clinic={clinic}
              week={week}
              w0={state.seedWeek}
              shifts={state.shifts}
              published={state.published[`${clinic.id}|${week}`]}
              severityByShift={severityByShift}
              lang={lang}
              t={t}
              onAdd={openAdd}
              onEdit={(s) => setDraft({ mode: "edit", shift: s })}
            />
          ))}
        </div>

        <aside className="checks" id="checks" aria-labelledby="checks-title">
          <h2 id="checks-title">{t.checksTitle}</h2>
          <p className="hint">{t.checksHint}</p>
          {viewIssues.length === 0 ? (
            <p className="ok">{t.noIssues}</p>
          ) : (
            <ul className="issues">
              {[...errors, ...warnings].map((issue, idx) => (
                <li key={`${issue.code}-${idx}`} className={`issue ${issue.severity}`}>
                  <span className="sev">{issue.severity === "error" ? t.errorLabel : t.warningLabel}</span>
                  <span>{describeIssue(issue, state.shifts, lang, t)}</span>
                  {issue.shiftIds[0] && shiftById.get(issue.shiftIds[0]) && issue.shiftIds.length <= 2 && (
                    <button type="button" className="link" onClick={() => setDraft({ mode: "edit", shift: shiftById.get(issue.shiftIds[0])! })}>
                      {t.editShift}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="ghost reset" onClick={resetDemo}>
            {t.reset}
          </button>
        </aside>
      </main>

      <footer className="foot">{t.footer}</footer>

      {draft && (
        <ShiftDialog
          draft={draft}
          state={state}
          week={week}
          lang={lang}
          t={t}
          isPublished={isPublished(draft.shift.locationId)}
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

interface GridProps {
  clinic: Clinic;
  week: string;
  w0: string;
  shifts: DemoShift[];
  published?: string;
  severityByShift: Map<string, "error" | "warning">;
  lang: Lang;
  t: Strings;
  onAdd: (clinic: Clinic, employmentId: string | null, date: string) => void;
  onEdit: (shift: DemoShift) => void;
}

function ClinicGrid({ clinic, week, w0, shifts, published, severityByShift, lang, t, onAdd, onEdit }: GridProps) {
  const dates = [0, 1, 2, 3, 4, 5, 6].map((d) => addDays(week, d));
  const rows = employments.filter((e) => e.locationIds.includes(clinic.id));
  const weekShifts = shifts.filter((s) => weekOf(s.date) === week);
  const clinicShifts = weekShifts.filter((s) => s.locationId === clinic.id);

  const renderChips = (list: DemoShift[]) =>
    list.map((s) => {
      const sev = severityByShift.get(s.id);
      return (
        <button
          type="button"
          key={s.id}
          className={`chip ${sev ?? ""}`}
          onClick={() => onEdit(s)}
          aria-label={`${t.editShift} ${timeRange(s)}`}
        >
          <span className="chip-time">{timeRange(s)}</span>
          {s.breakMin > 0 && <span className="chip-break">{s.breakMin} min</span>}
        </button>
      );
    });

  return (
    <section className="clinic" aria-label={clinic.name}>
      <header className="clinic-head">
        <div>
          <h2>
            {clinic.name} <span className="prov">{clinic.province}</span>
          </h2>
          <p className="company">
            {t.companyLabel}
            {lang === "fr" ? " : " : ": "}
            {clinic.companyName}
          </p>
        </div>
        <span className={`pill ${published ? "published" : "draft"}`}>
          {published ? t.publishedOn(formatDate(localDate(new Date(published), TZ), lang, { month: "short", day: "numeric" })) : t.draft}
        </span>
      </header>

      <div className="grid-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th scope="col" className="sticky" />
              {dates.map((d, i) => (
                <th scope="col" key={d}>
                  <span className="dow">{t.days[i]}</span>
                  <span className="dom">{formatDate(d, lang, { day: "numeric" })}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const person = persons.find((p) => p.id === e.personId)!;
              const mine = weekShifts.filter((s) => s.employmentId === e.id);
              const scheduled = mine.reduce((a, s) => a + paidMinutes(s), 0);
              const other = weekShifts
                .filter((s) => s.employmentId !== e.id && personOf(s.employmentId)?.id === person.id)
                .reduce((a, s) => a + paidMinutes(s), 0);
              const target = e.desiredWeeklyMinutes ?? 0;
              const pct = target ? Math.min(100, (scheduled / target) * 100) : 0;
              const over = e.maxWeeklyMinutes != null && scheduled > e.maxWeeklyMinutes;
              return (
                <tr key={e.id}>
                  <th scope="row" className="sticky person">
                    <span className="name">{person.name}</span>
                    <span className="role">{t.roles[person.role]}</span>
                    <span className={`meter ${over ? "over" : ""}`} aria-hidden="true">
                      <span style={{ width: `${pct}%` }} />
                    </span>
                    <span className="hrs">
                      {hours(scheduled, lang)} {target ? `${t.of} ${hours(target, lang)} h` : "h"}
                    </span>
                    {other > 0 && <span className="other">{t.otherCompanies(hours(other, lang))}</span>}
                  </th>
                  {dates.map((d) => {
                    const cell = clinicShifts.filter((s) => s.employmentId === e.id && s.date === d);
                    const hint = availabilityHint(person.id, d, w0, t);
                    return (
                      <td key={d}>
                        <div className="cell">
                          {hint && <span className={`avail ${hint === t.unavailable || hint === t.dayOff ? "no" : ""}`}>{hint}</span>}
                          {renderChips(cell)}
                          <button type="button" className="add" onClick={() => onAdd(clinic, e.id, d)} aria-label={`${t.addShift} · ${person.name} · ${d}`}>
                            +
                          </button>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr className="open-row">
              <th scope="row" className="sticky person">
                <span className="name">{t.openShifts}</span>
              </th>
              {dates.map((d) => (
                <td key={d}>
                  <div className="cell">
                    {renderChips(clinicShifts.filter((s) => s.employmentId === null && s.date === d))}
                    <button type="button" className="add" onClick={() => onAdd(clinic, null, d)} aria-label={`${t.addShift} · ${t.openShift} · ${d}`}>
                      +
                    </button>
                  </div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {clinicShifts.length === 0 && <p className="empty">{t.noShiftsWeek}</p>}
    </section>
  );
}

interface DialogProps {
  draft: Draft;
  state: DemoState;
  week: string;
  lang: Lang;
  t: Strings;
  isPublished: boolean;
  onCancel: () => void;
  onSave: (s: DemoShift) => void;
  onDelete: (id: string) => void;
}

function ShiftDialog({ draft, state, week, lang, t, isPublished, onCancel, onSave, onDelete }: DialogProps) {
  const [shift, setShift] = useState<DemoShift>(draft.shift);
  const clinic = clinicById(shift.locationId);
  const eligible = employments.filter((e) => e.locationIds.includes(clinic.id));
  const valid = minutesOf(shift.end) > minutesOf(shift.start);
  const shiftWeek = weekOf(shift.date);
  const dates = [0, 1, 2, 3, 4, 5, 6].map((d) => addDays(shiftWeek, d));

  const preview = useMemo(() => {
    if (!valid) return [];
    const others = state.shifts.filter((s) => s.id !== shift.id);
    const r = runChecks(state, week, [...others, shift], isPublished ? [shift.id] : []);
    return r.issues.filter((i) => i.shiftIds.includes(shift.id));
  }, [shift, state, week, valid, isPublished]);

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
        aria-labelledby="dialog-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSave(shift);
        }}
      >
        <header>
          <h2 id="dialog-title">{draft.mode === "add" ? t.addShift : t.editShift}</h2>
          <p className="company">
            {clinic.name} · {clinic.province}
          </p>
        </header>

        <label className="field" htmlFor="f-employee">
          <span>{t.employee}</span>
          <select
            id="f-employee"
            value={shift.employmentId ?? ""}
            onChange={(e) => setShift({ ...shift, employmentId: e.target.value || null })}
          >
            <option value="">{t.openShift}</option>
            {eligible.map((e) => {
              const p = persons.find((x) => x.id === e.personId)!;
              return (
                <option key={e.id} value={e.id}>
                  {p.name} · {t.roles[p.role]}
                </option>
              );
            })}
          </select>
        </label>

        <label className="field" htmlFor="f-day">
          <span>{t.day}</span>
          <select id="f-day" value={shift.date} onChange={(e) => setShift({ ...shift, date: e.target.value })}>
            {dates.map((d, i) => (
              <option key={d} value={d}>
                {t.daysLong[i]} {formatDate(d, lang, { day: "numeric", month: "short" })}
              </option>
            ))}
          </select>
        </label>

        <div className="row">
          <label className="field" htmlFor="f-start">
            <span>{t.start}</span>
            <input id="f-start" type="time" step={900} value={shift.start} onChange={(e) => setShift({ ...shift, start: e.target.value })} />
          </label>
          <label className="field" htmlFor="f-end">
            <span>{t.end}</span>
            <input id="f-end" type="time" step={900} value={shift.end} onChange={(e) => setShift({ ...shift, end: e.target.value })} />
          </label>
          <label className="field" htmlFor="f-break">
            <span>{t.breakMin}</span>
            <input
              id="f-break"
              type="number"
              min={0}
              max={120}
              step={15}
              value={shift.breakMin}
              onChange={(e) => setShift({ ...shift, breakMin: Math.max(0, Number(e.target.value) || 0) })}
            />
          </label>
        </div>
        {!valid && <p className="field-error">{t.endAfterStart}</p>}

        <div className="preview" aria-live="polite">
          <h3>{t.previewTitle}</h3>
          {preview.length === 0 ? (
            <p className="ok">{t.previewOk}</p>
          ) : (
            <ul className="issues">
              {preview.map((issue, idx) => (
                <li key={idx} className={`issue ${issue.severity}`}>
                  <span>{describeIssue(issue, [...state.shifts.filter((s) => s.id !== shift.id), shift], lang, t)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer>
          {draft.mode === "edit" && (
            <button type="button" className="danger" onClick={() => onDelete(shift.id)}>
              {t.remove}
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={onCancel}>
            {t.cancel}
          </button>
          <button type="submit" className="primary">
            {t.save}
          </button>
        </footer>
      </form>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
