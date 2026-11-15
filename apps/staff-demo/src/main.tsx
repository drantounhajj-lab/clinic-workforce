import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { addDays, localDate, weekdayOf, zonedToUtc } from "@clinic-workforce/rules";
import {
  evaluatePunch,
  parsePunchFix,
  type PunchDecision,
  type PunchLocation,
  rotatingCode,
  QR_PERIOD_SECONDS,
} from "@clinic-workforce/timeclock";
import {
  availabilityRules,
  type Clinic,
  clinics,
  type DemoShift,
  employments,
  type Person,
  persons,
  seedShifts,
  TZ,
} from "@clinic-workforce/sample-data";
import { decisionMessage, type Lang, strings, type Strings } from "./i18n";

// ---------- Demo setup ----------

const GEO: Record<string, { latitude: number; longitude: number }> = {
  gatineau: { latitude: 45.4765, longitude: -75.7013 },
  aylmer: { latitude: 45.396, longitude: -75.844 },
  ottawa: { latitude: 45.4215, longitude: -75.6972 },
  orleans: { latitude: 45.48, longitude: -75.51 },
};

const punchLocation = (c: Clinic, i = clinics.indexOf(c)): PunchLocation => ({
  id: c.id,
  ...GEO[c.id],
  geofenceRadiusM: 150,
  earlyPunchLimitMin: 15,
  wifiBssids: [`aa:bb:cc:00:00:0${i}`],
  qrSecret: `demo-secret-${c.id}`,
});

const PINS: Record<string, string> = {
  marie: "1234", julie: "2345", karim: "3456", sophie: "4567", emilie: "5678", nadia: "6789",
  luc: "1111", sarah: "2222", kevin: "3333", ana: "4444", chloe: "5555",
};

const clinicById = (id: string) => clinics.find((c) => c.id === id)!;
const toStart = (s: DemoShift) => zonedToUtc(s.date, s.start, TZ);
const toEnd = (s: DemoShift) => zonedToUtc(s.date, s.end, TZ);
const weekOf = (date: string) => addDays(date, -weekdayOf(date));

function upcomingMonday(): string {
  const today = localDate(new Date(), TZ);
  return addDays(today, 7 - weekdayOf(today));
}

function fmtTime(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TZ }).format(d);
}

function fmtDay(date: string, lang: Lang, t: Strings, withMonth = true): string {
  const [y, m, d] = date.split("-").map(Number);
  const label = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-CA", {
    timeZone: "UTC",
    day: "numeric",
    ...(withMonth ? { month: "short" } : {}),
  });
  return `${t.daysLong[weekdayOf(date)]} ${label}`;
}

function loadLang(): Lang {
  try {
    const saved = localStorage.getItem("clinic-workforce-staff-demo-lang");
    if (saved === "fr" || saved === "en") return saved;
  } catch {
    /* ignore */
  }
  return navigator.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

// ---------- App ----------

function App() {
  const w0 = useMemo(upcomingMonday, []);
  const shifts = useMemo(() => seedShifts(w0), [w0]);
  const [lang, setLang] = useState<Lang>(loadLang);
  const [mode, setMode] = useState<"phone" | "kiosk">("phone");
  const [personId, setPersonId] = useState("marie");
  const t = strings[lang];

  useEffect(() => {
    document.documentElement.lang = lang === "fr" ? "fr-CA" : "en-CA";
    try {
      localStorage.setItem("clinic-workforce-staff-demo-lang", lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  const person = persons.find((p) => p.id === personId)!;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <h1>{t.appName}</h1>
          <span className="badge">{t.demoBadge}</span>
        </div>
        <div className="lang" role="group" aria-label="Language">
          {(["fr", "en"] as const).map((l) => (
            <button key={l} type="button" className={lang === l ? "on" : ""} aria-pressed={lang === l} onClick={() => setLang(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      <div className="modebar">
        <div className="segmented" role="tablist" aria-label="Mode">
          <button type="button" role="tab" aria-selected={mode === "phone"} className={mode === "phone" ? "on" : ""} onClick={() => setMode("phone")}>
            {t.phoneMode}
          </button>
          <button type="button" role="tab" aria-selected={mode === "kiosk"} className={mode === "kiosk" ? "on" : ""} onClick={() => setMode("kiosk")}>
            {t.kioskMode}
          </button>
        </div>
        {mode === "phone" && (
          <label className="field inline" htmlFor="person">
            <span>{t.viewingAs}</span>
            <select id="person" value={personId} onChange={(e) => setPersonId(e.target.value)}>
              {persons.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {mode === "phone" ? (
        <PhoneApp key={personId} person={person} shifts={shifts} w0={w0} lang={lang} t={t} />
      ) : (
        <Kiosk lang={lang} t={t} />
      )}

      <footer className="foot">{t.footer}</footer>
    </div>
  );
}

// ---------- Phone app ----------

type Tab = "clock" | "schedule" | "availability" | "timeoff";

function PhoneApp({ person, shifts, w0, lang, t }: { person: Person; shifts: DemoShift[]; w0: string; lang: Lang; t: Strings }) {
  const [tab, setTab] = useState<Tab>("clock");
  const myEmployments = employments.filter((e) => e.personId === person.id);
  const myShifts = shifts
    .filter((s) => myEmployments.some((e) => e.id === s.employmentId))
    .sort((a, b) => toStart(a).getTime() - toStart(b).getTime());

  return (
    <div className="phone">
      <div className="phone-head">
        <div className="avatar" aria-hidden="true">
          {person.name.replace("Dr ", "").split(" ").map((w) => w[0]).join("")}
        </div>
        <div>
          <strong>{person.name}</strong>
          <span>{t.roles[person.role]}</span>
        </div>
      </div>
      <div className="phone-body">
        {tab === "clock" && <ClockTab person={person} myShifts={myShifts} lang={lang} t={t} />}
        {tab === "schedule" && <ScheduleTab person={person} myShifts={myShifts} shifts={shifts} w0={w0} lang={lang} t={t} />}
        {tab === "availability" && <AvailabilityTab person={person} lang={lang} t={t} />}
        {tab === "timeoff" && <TimeOffTab person={person} lang={lang} t={t} />}
      </div>
      <nav className="tabbar" aria-label="Sections">
        {(Object.keys(t.tabs) as Tab[]).map((k) => (
          <button key={k} type="button" className={tab === k ? "on" : ""} aria-current={tab === k ? "page" : undefined} onClick={() => setTab(k)}>
            <span className={`ico ico-${k}`} aria-hidden="true" />
            {t.tabs[k]}
          </button>
        ))}
      </nav>
    </div>
  );
}

interface Punch {
  kind: "in" | "out";
  at: Date;
  clinicId: string;
  method: "gps" | "qr";
  decision: PunchDecision;
}

function ClockTab({ person, myShifts, lang, t }: { person: Person; myShifts: DemoShift[]; lang: Lang; t: Strings }) {
  const now = new Date();
  const shift = myShifts.find((s) => toEnd(s) > now) ?? myShifts[0];
  const clinic = shift ? clinicById(shift.locationId) : clinics[0];
  const loc = punchLocation(clinic);

  const [preset, setPreset] = useState<"early" | "soon" | "end">("soon");
  const [method, setMethod] = useState<"gps" | "qr">("gps");
  const [where, setWhere] = useState<"clinic" | "home">("clinic");
  const [wifi, setWifi] = useState(false);
  const [fake, setFake] = useState(false);
  const [offline, setOffline] = useState(false);
  const [scan, setScan] = useState<"none" | "now" | "old">("none");
  const [punches, setPunches] = useState<Punch[]>([]);
  const [last, setLast] = useState<{ ok: boolean; title: string; lines: string[] } | null>(null);
  const [fixText, setFixText] = useState("");
  const [fixResult, setFixResult] = useState<{ ok: boolean; text: string } | null>(null);

  const start = shift ? toStart(shift) : now;
  const end = shift ? toEnd(shift) : now;
  const simNow = preset === "early" ? new Date(start.getTime() - 30 * 60_000) : preset === "soon" ? new Date(start.getTime() - 10 * 60_000) : end;
  const clockedIn = punches.length > 0 && punches[punches.length - 1].kind === "in";
  const scannedCode =
    scan === "now" ? rotatingCode(loc, simNow) : scan === "old" ? rotatingCode(loc, new Date(simNow.getTime() - 120_000)) : null;

  function punch() {
    const kind = clockedIn ? "out" : "in";
    const position =
      where === "clinic"
        ? { latitude: loc.latitude + 0.0003, longitude: loc.longitude + 0.0002, accuracyM: 12 }
        : { latitude: loc.latitude - 0.052, longitude: loc.longitude + 0.02, accuracyM: 12 };
    const decision = evaluatePunch({
      kind,
      method: method === "gps" ? "phone_geofence" : "rotating_qr",
      at: simNow,
      location: loc,
      scheduledStart: shift ? start : null,
      position: method === "gps" ? position : null,
      wifiBssid: wifi ? loc.wifiBssids[0] : null,
      mockLocationDetected: method === "gps" && fake,
      offline,
      qrToken: scannedCode,
    });
    if (decision.accepted) {
      setPunches((p) => [...p, { kind, at: simNow, clinicId: clinic.id, method, decision }]);
      const lines = [
        method === "gps"
          ? decision.distanceM !== undefined && !decision.flags.includes("outside_geofence_wifi_ok")
            ? t.gpsOk(decision.distanceM, loc.geofenceRadiusM)
            : ""
          : t.qrOk,
        ...decision.flags.map((f) => t.flags[f]).filter(Boolean),
      ].filter(Boolean);
      setLast({ ok: true, title: t.accepted(kind, fmtTime(simNow), clinic.name), lines });
      if (kind === "in") setPreset("end");
      setScan("none");
    } else {
      setLast({ ok: false, title: decisionMessage(decision, t, clinic.name, loc.geofenceRadiusM, loc.earlyPunchLimitMin, lang), lines: [] });
    }
  }

  function sendFix() {
    const today = localDate(new Date(), TZ);
    const fix = parsePunchFix(fixText || t.fixPlaceholder, today);
    if (!fix) {
      setFixResult({ ok: false, text: t.fixFail });
      return;
    }
    setFixResult({ ok: true, text: t.fixParsed(fix.kind, fmtDay(fix.date, lang, t), fix.time) });
  }

  return (
    <div className="stack">
      <section className="card shift-card">
        <span className="label">{t.nextShift}</span>
        {shift ? (
          <>
            <strong className="big">
              {shift.start}–{shift.end}
            </strong>
            <span>
              {fmtDay(shift.date, lang, t)} · {clinic.name} {clinic.province}
            </span>
          </>
        ) : (
          <span>{t.noShift}</span>
        )}
      </section>

      <section className="card">
        <span className="label">{t.demoTime}</span>
        <div className="chips">
          {(["early", "soon", "end"] as const).map((p) => (
            <button key={p} type="button" className={preset === p ? "on" : ""} aria-pressed={preset === p} onClick={() => setPreset(p)}>
              {t.presets[p]}
            </button>
          ))}
        </div>
        <span className="clock">{fmtTime(simNow)}</span>
      </section>

      <section className="card">
        <span className="label">{t.method}</span>
        <div className="segmented small">
          {(["gps", "qr"] as const).map((m) => (
            <button key={m} type="button" className={method === m ? "on" : ""} aria-pressed={method === m} onClick={() => setMethod(m)}>
              {t.methods[m]}
            </button>
          ))}
        </div>

        {method === "gps" ? (
          <div className="sim">
            <span className="label">{t.simulate}</span>
            <div className="chips">
              <button type="button" className={where === "clinic" ? "on" : ""} aria-pressed={where === "clinic"} onClick={() => setWhere("clinic")}>
                {t.atClinic}
              </button>
              <button type="button" className={where === "home" ? "on" : ""} aria-pressed={where === "home"} onClick={() => setWhere("home")}>
                {t.atHome}
              </button>
            </div>
            <Toggle id="wifi" label={t.onWifi} checked={wifi} onChange={setWifi} />
            <Toggle id="fake" label={t.fakeGps} checked={fake} onChange={setFake} />
            <Toggle id="offline" label={t.offline} checked={offline} onChange={setOffline} />
          </div>
        ) : (
          <div className="sim">
            <div className="chips">
              <button type="button" className={scan === "now" ? "on" : ""} aria-pressed={scan === "now"} onClick={() => setScan("now")}>
                {t.scanNow}
              </button>
              <button type="button" className={scan === "old" ? "on" : ""} aria-pressed={scan === "old"} onClick={() => setScan("old")}>
                {t.scanOld}
              </button>
            </div>
            {scannedCode && <span className="mono">{t.scanned(scannedCode)}</span>}
            <Toggle id="offline-qr" label={t.offline} checked={offline} onChange={setOffline} />
          </div>
        )}

        <button type="button" className={`punch ${clockedIn ? "out" : ""}`} onClick={punch}>
          {clockedIn ? t.clockOut : t.clockIn}
        </button>
        {clockedIn && <span className="muted center">{t.clockedInSince(fmtTime(punches[punches.length - 1].at))}</span>}

        {last && (
          <div className={`result ${last.ok ? "ok" : "bad"}`} role="status">
            <strong>{last.title}</strong>
            {last.lines.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <span className="label">{t.todayPunches}</span>
        {punches.length === 0 ? (
          <p className="muted">{t.noPunches}</p>
        ) : (
          <ul className="list">
            {punches.map((p, i) => (
              <li key={i}>
                <span className={`tag ${p.kind}`}>{p.kind === "in" ? t.in : t.out}</span>
                <span className="mono">{fmtTime(p.at)}</span>
                <span className="muted">
                  {clinicById(p.clinicId).name} · {p.method === "gps" ? t.methods.gps : t.methods.qr}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <span className="label">{t.fixTitle}</span>
        <p className="muted small">{t.fixHint}</p>
        <label className="sr-only" htmlFor="fix">
          {t.fixTitle}
        </label>
        <textarea id="fix" rows={2} placeholder={t.fixPlaceholder} value={fixText} onChange={(e) => setFixText(e.target.value)} />
        <button type="button" onClick={sendFix}>
          {t.fixButton}
        </button>
        {fixResult && (
          <div className={`result ${fixResult.ok ? "ok" : "bad"}`} role="status">
            <strong>{fixResult.text}</strong>
            {fixResult.ok && <span>{t.fixSent}</span>}
            <span className="muted small">{t.fixAi}</span>
          </div>
        )}
      </section>
    </div>
  );
}

function ScheduleTab({ person, myShifts, shifts, w0, lang, t }: { person: Person; myShifts: DemoShift[]; shifts: DemoShift[]; w0: string; lang: Lang; t: Strings }) {
  const [status, setStatus] = useState<Record<string, "confirmed" | "declined" | "swap">>({});
  const [requested, setRequested] = useState<string[]>([]);
  const myEmployments = employments.filter((e) => e.personId === person.id);
  const myClinicIds = new Set(myEmployments.flatMap((e) => e.locationIds));
  const now = new Date();
  const upcoming = myShifts.filter((s) => toEnd(s) > now && weekOf(s.date) <= addDays(w0, 7));
  const open = shifts.filter((s) => s.employmentId === null && myClinicIds.has(s.locationId) && toEnd(s) > now);
  const byWeek = new Map<string, DemoShift[]>();
  for (const s of upcoming) byWeek.set(weekOf(s.date), [...(byWeek.get(weekOf(s.date)) ?? []), s]);

  return (
    <div className="stack">
      {[...byWeek.entries()].map(([week, list]) => (
        <section className="card" key={week}>
          <span className="label">{t.weekOf(fmtDay(week, lang, t).replace(/^\S+ /, ""))}</span>
          <ul className="list shifts">
            {list.map((s) => {
              const c = clinicById(s.locationId);
              const st = status[s.id];
              return (
                <li key={s.id}>
                  <div className="shift-line">
                    <strong>{fmtDay(s.date, lang, t, false)}</strong>
                    <span className="mono">
                      {s.start}–{s.end}
                    </span>
                    <span className="muted">
                      {c.name} · {c.companyName}
                    </span>
                  </div>
                  <div className="shift-actions">
                    {st ? (
                      <span className={`tag ${st}`}>{st === "confirmed" ? t.confirmed : st === "declined" ? t.declined : t.swapOffered}</span>
                    ) : (
                      <>
                        <button type="button" className="mini primary" onClick={() => setStatus({ ...status, [s.id]: "confirmed" })}>
                          {t.confirm}
                        </button>
                        <button type="button" className="mini" onClick={() => setStatus({ ...status, [s.id]: "declined" })}>
                          {t.decline}
                        </button>
                        <button type="button" className="mini ghost" onClick={() => setStatus({ ...status, [s.id]: "swap" })}>
                          {t.offerSwap}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <section className="card">
        <span className="label">{t.openShifts}</span>
        {open.length === 0 ? (
          <p className="muted">{t.noOpen}</p>
        ) : (
          <ul className="list shifts">
            {open.map((s) => (
              <li key={s.id}>
                <div className="shift-line">
                  <strong>{fmtDay(s.date, lang, t)}</strong>
                  <span className="mono">
                    {s.start}–{s.end}
                  </span>
                  <span className="muted">{clinicById(s.locationId).name}</span>
                </div>
                {requested.includes(s.id) ? (
                  <span className="tag confirmed">{t.requested}</span>
                ) : (
                  <button type="button" className="mini primary" onClick={() => setRequested([...requested, s.id])}>
                    {t.pickUp}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

interface DayAvail {
  on: boolean;
  from: string;
  to: string;
}

function AvailabilityTab({ person, lang, t }: { person: Person; lang: Lang; t: Strings }) {
  const notice = 14;
  const initial: DayAvail[] = [0, 1, 2, 3, 4, 5, 6].map((wd) => {
    const mine = availabilityRules.filter((r) => r.personId === person.id);
    if (mine.length === 0) return { on: wd < 5, from: "08:00", to: "18:00" };
    const r = mine.find((x) => x.weekday === wd);
    return r ? { on: true, from: r.start, to: r.end } : { on: false, from: "08:00", to: "18:00" };
  });
  const [days, setDays] = useState<DayAvail[]>(initial);
  const [submitted, setSubmitted] = useState(false);
  const [exceptions, setExceptions] = useState<{ date: string; reason: string }[]>([]);
  const [exDate, setExDate] = useState("");
  const [exReason, setExReason] = useState("");
  const effective = addDays(localDate(new Date(), TZ), notice);

  const update = (i: number, patch: Partial<DayAvail>) => {
    setDays(days.map((d, j) => (j === i ? { ...d, ...patch } : d)));
    setSubmitted(false);
  };

  return (
    <div className="stack">
      <section className="card">
        <span className="label">{t.availTitle}</span>
        <p className="muted small">{t.availHint(notice)}</p>
        <ul className="list avail">
          {days.map((d, i) => (
            <li key={i}>
              <label className="check" htmlFor={`day-${i}`}>
                <input id={`day-${i}`} type="checkbox" checked={d.on} onChange={(e) => update(i, { on: e.target.checked })} />
                <span>{t.daysLong[i]}</span>
              </label>
              {d.on ? (
                <span className="times">
                  <label className="sr-only" htmlFor={`from-${i}`}>
                    {t.from}
                  </label>
                  <input id={`from-${i}`} type="time" step={900} value={d.from} onChange={(e) => update(i, { from: e.target.value })} />
                  <span aria-hidden="true">–</span>
                  <label className="sr-only" htmlFor={`to-${i}`}>
                    {t.to}
                  </label>
                  <input id={`to-${i}`} type="time" step={900} value={d.to} onChange={(e) => update(i, { to: e.target.value })} />
                </span>
              ) : (
                <span className="muted">{t.unavailable}</span>
              )}
            </li>
          ))}
        </ul>
        <button type="button" className="primary" onClick={() => setSubmitted(true)}>
          {t.submit}
        </button>
        {submitted && (
          <div className="result ok" role="status">
            <strong>{t.pendingFrom(fmtDay(effective, lang, t))}</strong>
          </div>
        )}
      </section>

      <section className="card">
        <span className="label">{t.exceptionsTitle}</span>
        <div className="row">
          <label className="field" htmlFor="ex-date">
            <span>{t.date}</span>
            <input id="ex-date" type="date" value={exDate} onChange={(e) => setExDate(e.target.value)} />
          </label>
          <label className="field grow" htmlFor="ex-reason">
            <span>{t.reason}</span>
            <input id="ex-reason" type="text" value={exReason} onChange={(e) => setExReason(e.target.value)} />
          </label>
        </div>
        <button
          type="button"
          onClick={() => {
            if (!exDate) return;
            setExceptions([...exceptions, { date: exDate, reason: exReason }]);
            setExDate("");
            setExReason("");
          }}
        >
          {t.addException}
        </button>
        {exceptions.length > 0 && (
          <ul className="list">
            {exceptions.map((x, i) => (
              <li key={i}>
                <span>{fmtDay(x.date, lang, t)}</span>
                <span className="muted">{x.reason}</span>
                <span className="tag swap">{t.pending}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TimeOffTab({ person, lang, t }: { person: Person; lang: Lang; t: Strings }) {
  const myEmployments = employments.filter((e) => e.personId === person.id);
  const [type, setType] = useState<"vacation" | "personal">("vacation");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [requests, setRequests] = useState<{ type: string; start: string; end: string; company: string }[]>([]);
  const [company, setCompany] = useState(myEmployments[0]?.companyId ?? "");
  const hrs = (h: number) => `${new Intl.NumberFormat(lang === "fr" ? "fr-CA" : "en-CA").format(h)} h`;

  return (
    <div className="stack">
      <section className="card">
        <span className="label">{t.balancesTitle}</span>
        <ul className="list">
          {myEmployments.map((e, i) => {
            const c = clinics.find((x) => x.companyId === e.companyId)!;
            return (
              <li key={e.id} className="balance">
                <span className="muted">{c.companyName}</span>
                <span>
                  {t.vacation} <strong>{hrs(i === 0 ? 72 : 24)}</strong>
                </span>
                <span>
                  {t.personal} <strong>{hrs(i === 0 ? 14 : 7)}</strong>
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!start || !end) return;
          if (end < start) {
            setError(t.endBeforeStart);
            return;
          }
          setRequests([...requests, { type, start, end, company }]);
          setStart("");
          setEnd("");
          setNote("");
          setError("");
        }}
      >
        <span className="label">{t.requestTitle}</span>
        {myEmployments.length > 1 && (
          <label className="field" htmlFor="to-company">
            <span>{t.company}</span>
            <select id="to-company" value={company} onChange={(e) => setCompany(e.target.value)}>
              {myEmployments.map((e) => (
                <option key={e.id} value={e.companyId}>
                  {clinics.find((c) => c.companyId === e.companyId)!.companyName}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field" htmlFor="to-type">
          <span>{t.type}</span>
          <select id="to-type" value={type} onChange={(e) => setType(e.target.value as "vacation" | "personal")}>
            <option value="vacation">{t.vacation}</option>
            <option value="personal">{t.personal}</option>
          </select>
        </label>
        <div className="row">
          <label className="field grow" htmlFor="to-start">
            <span>{t.start}</span>
            <input id="to-start" type="date" required value={start} onChange={(e) => { setStart(e.target.value); setError(""); }} />
          </label>
          <label className="field grow" htmlFor="to-end">
            <span>{t.end}</span>
            <input id="to-end" type="date" required value={end} onChange={(e) => { setEnd(e.target.value); setError(""); }} />
          </label>
        </div>
        {error && <p className="field-error">{error}</p>}
        <label className="field" htmlFor="to-note">
          <span>{t.note}</span>
          <input id="to-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button type="submit" className="primary">
          {t.sendRequest}
        </button>
      </form>

      <section className="card">
        <span className="label">{t.requestsTitle}</span>
        {requests.length === 0 ? (
          <p className="muted">{t.noRequests}</p>
        ) : (
          <ul className="list">
            {requests.map((r, i) => (
              <li key={i}>
                <span>{r.type === "vacation" ? t.vacation : t.personal}</span>
                <span className="muted">
                  {fmtDay(r.start, lang, t)} → {fmtDay(r.end, lang, t)}
                </span>
                <span className="tag swap">{t.pending}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Toggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch" htmlFor={id}>
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

// ---------- Clinic iPad kiosk ----------

function Kiosk({ lang, t }: { lang: Lang; t: Strings }) {
  const [clinicId, setClinicId] = useState("gatineau");
  const [now, setNow] = useState(new Date());
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [inside, setInside] = useState<Record<string, boolean>>({});
  const clinic = clinicById(clinicId);
  const loc = punchLocation(clinic);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const code = rotatingCode(loc, now);
  const secondsLeft = QR_PERIOD_SECONDS - (Math.floor(now.getTime() / 1000) % QR_PERIOD_SECONDS);

  function press(d: string) {
    setMessage(null);
    const next = (pin + d).slice(0, 4);
    setPin(next);
    if (next.length === 4) submit(next);
  }

  function submit(value: string) {
    const personId = Object.keys(PINS).find((k) => PINS[k] === value);
    setPin("");
    if (!personId) {
      setMessage({ ok: false, lines: [t.kioskWrongPin] });
      return;
    }
    const person = persons.find((p) => p.id === personId)!;
    const worksHere = employments.some((e) => e.personId === personId && e.locationIds.includes(clinicId));
    if (!worksHere) {
      setMessage({ ok: false, lines: [t.kioskWrongClinic(person.name)] });
      return;
    }
    const key = `${personId}|${clinicId}`;
    const wasIn = inside[key];
    setInside({ ...inside, [key]: !wasIn });
    const first = person.name.startsWith("Dr ") ? person.name.split(" ").slice(0, 2).join(" ") : person.name.split(" ")[0];
    setMessage({
      ok: true,
      lines: [wasIn ? t.kioskWelcomeOut(first, fmtTime(new Date())) : t.kioskWelcomeIn(first, fmtTime(new Date())), t.kioskPhoto],
    });
  }

  const staffHere = persons.filter((p) => employments.some((e) => e.personId === p.id && e.locationIds.includes(clinicId)));

  return (
    <div className="kiosk">
      <div className="kiosk-top">
        <label className="field inline" htmlFor="kiosk-clinic">
          <span>{t.kioskMode}</span>
          <select id="kiosk-clinic" value={clinicId} onChange={(e) => { setClinicId(e.target.value); setMessage(null); setPin(""); }}>
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.province}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="ipad">
        <div className="ipad-head">
          <h2>{t.kioskTitle(clinic.name)}</h2>
          <span className="kiosk-clock">{fmtTime(now)}</span>
        </div>
        <div className="ipad-body">
          <div className="qr-side">
            <PseudoQr value={`${clinic.id}:${code}`} />
            <span className="mono code">{code}</span>
            <span className="muted">{t.kioskScan}</span>
            <div className="countdown" aria-label={t.kioskChanges(secondsLeft)}>
              <span style={{ width: `${(secondsLeft / QR_PERIOD_SECONDS) * 100}%` }} />
            </div>
            <span className="muted small">{t.kioskChanges(secondsLeft)}</span>
          </div>
          <div className="pin-side">
            <span className="label">{t.kioskPin}</span>
            <div className="pin-dots" aria-label={`${pin.length} / 4`}>
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={i < pin.length ? "on" : ""} />
              ))}
            </div>
            <div className="pinpad">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                <button key={d} type="button" onClick={() => press(d)}>
                  {d}
                </button>
              ))}
              <button type="button" className="ghost" onClick={() => { setPin(""); setMessage(null); }}>
                {t.clear}
              </button>
              <button type="button" onClick={() => press("0")}>
                0
              </button>
              <span />
            </div>
            {message && (
              <div className={`result ${message.ok ? "ok" : "bad"}`} role="status">
                {message.lines.map((l, i) => (i === 0 ? <strong key={i}>{l}</strong> : <span key={i}>{l}</span>))}
              </div>
            )}
            <details className="pins">
              <summary>{t.kioskDemoPins}</summary>
              <ul>
                {staffHere.map((p) => (
                  <li key={p.id}>
                    {p.name}: <span className="mono">{PINS[p.id]}</span>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </div>
      </div>
      <p className="muted small center">{lang === "fr" ? "Mode kiosque : l'iPad reste verrouillé sur cette application." : "Kiosk mode: the iPad stays locked to this app."}</p>
    </div>
  );
}

/** QR-like pattern derived from the code (illustration only, not a scannable QR). */
function PseudoQr({ value }: { value: string }) {
  const n = 25;
  let h = 2166136261;
  for (const ch of value) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const cells: boolean[] = [];
  for (let i = 0; i < n * n; i++) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    cells.push((h & 7) < 3);
  }
  const finder = (x: number, y: number) => {
    const inBox = (ox: number, oy: number) => x >= ox && x < ox + 7 && y >= oy && y < oy + 7;
    for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      if (inBox(ox, oy)) {
        const dx = x - ox, dy = y - oy;
        const ring = Math.min(dx, dy, 6 - dx, 6 - dy);
        return ring !== 1;
      }
      if (x >= ox - 1 && x <= ox + 7 && y >= oy - 1 && y <= oy + 7) return false;
    }
    return null;
  };
  const rects = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const f = finder(x, y);
      if (f === true || (f === null && cells[y * n + x])) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} />);
    }
  }
  return (
    <svg className="qr" viewBox={`-2 -2 ${n + 4} ${n + 4}`} role="img" aria-label="Clinic code">
      <rect x={-2} y={-2} width={n + 4} height={n + 4} className="qr-bg" />
      <g className="qr-fg">{rects}</g>
    </svg>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
