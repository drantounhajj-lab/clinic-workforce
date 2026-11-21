import { useCallback, useEffect, useState } from "react";
import { formatDate } from "../i18n";
import { personName, useSession } from "../session";
import { type AvailabilityRule, must, type PunchCorrection, supabase, type TimeOffRequest } from "../supabase";

export function Requests({ onChange }: { onChange?: () => void }) {
  const { t, lang, data, can, locationsWith } = useSession();
  const [timeOff, setTimeOff] = useState<TimeOffRequest[]>([]);
  const [othersAway, setOthersAway] = useState<TimeOffRequest[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRule[]>([]);
  const [corrections, setCorrections] = useState<PunchCorrection[]>([]);
  const [paid, setPaid] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const punchLocs = locationsWith("punches").map((l) => l.id);
      const [off, recent, av, cor] = await Promise.all([
        supabase.from("time_off_requests").select("*").eq("status", "pending").order("start_date"),
        supabase
          .from("time_off_requests")
          .select("*")
          .in("status", ["approved", "pending"])
          .gte("end_date", new Date(Date.now() - 86_400_000).toISOString().slice(0, 10))
          .order("start_date")
          .limit(500),
        supabase.from("availability_rules").select("*").order("weekday"),
        punchLocs.length
          ? supabase.from("punch_corrections").select("*").in("location_id", punchLocs).eq("status", "pending").order("occurred_at")
          : Promise.resolve({ data: [], error: null }),
      ]);
      setTimeOff(must(off) as TimeOffRequest[]);
      setOthersAway(must(recent) as TimeOffRequest[]);
      setAvailability(must(av) as AvailabilityRule[]);
      setCorrections(must(cor) as PunchCorrection[]);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [locationsWith]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!data) return null;
  const name = (personId: string) => personName(data.persons.find((p) => p.id === personId));
  const clinicsOf = (personId: string) =>
    new Set(data.employments.filter((e) => e.person_id === personId).flatMap((e) => e.employment_locations.map((x) => x.location_id)));
  const say = (id: string, ok: boolean, text: string) => setMsg((m) => ({ ...m, [id]: { ok, text } }));
  const day = (d: string) => formatDate(d, lang, { weekday: "short", day: "numeric", month: "short" });
  const range = (r: TimeOffRequest) =>
    `${day(r.start_date)}${r.end_date !== r.start_date ? ` → ${day(r.end_date)}` : ""}${r.start_time ? ` · ${r.start_time.slice(0, 5)}–${r.end_time?.slice(0, 5)}` : ""}`;
  const businessDays = (r: TimeOffRequest) => {
    let n = 0;
    for (let d = new Date(`${r.start_date}T12:00:00Z`); d <= new Date(`${r.end_date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      const w = d.getUTCDay();
      if (w !== 0 && w !== 6) n++;
    }
    return n;
  };

  async function decideTimeOff(r: TimeOffRequest, approve: boolean) {
    const hours = paid[r.id] === undefined || paid[r.id] === "" ? null : Number(paid[r.id].replace(",", "."));
    const { data: res, error: err } = await supabase.rpc("decide_time_off", {
      p_id: r.id,
      p_approve: approve,
      p_paid_hours: approve ? hours : null,
      p_note: notes[r.id] ?? null,
    });
    if (err || !res?.ok) say(r.id, false, err?.message ?? t.requestErrors[res?.reason] ?? t.error);
    else {
      await load();
      onChange?.();
    }
  }

  async function decideAvailability(personId: string, approve: boolean) {
    const { data: res, error: err } = await supabase.rpc("decide_availability", { p_person_id: personId, p_approve: approve });
    if (err || !res?.ok) say(personId, false, err?.message ?? t.requestErrors[res?.reason] ?? t.error);
    else {
      await load();
      onChange?.();
    }
  }

  async function decideCorrection(c: PunchCorrection, approve: boolean) {
    const { data: res, error: err } = await supabase.rpc("decide_punch_correction", { p_id: c.id, p_approve: approve, p_note: notes[c.id] ?? null });
    if (err || !res?.ok) say(c.id, false, err?.message ?? t.requestErrors[res?.reason] ?? t.error);
    else {
      await load();
      onChange?.();
    }
  }

  const pendingAvailability = [...new Set(availability.filter((a) => a.status === "pending").map((a) => a.person_id))];
  const windows = (personId: string, status: "approved" | "pending") =>
    [0, 1, 2, 3, 4, 5, 6].map((w) => {
      const list = availability.filter((a) => a.person_id === personId && a.status === status && a.weekday === w);
      return list.length ? list.map((a) => `${a.start_time.slice(0, 5)}–${a.end_time.slice(0, 5)}`).join(", ") : "—";
    });
  const time = (iso: string, locId: string) =>
    new Intl.DateTimeFormat(lang === "fr" ? "fr-CA" : "en-CA", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: data.locations.find((l) => l.id === locId)?.timezone ?? "America/Toronto",
    }).format(new Date(iso));

  return (
    <div className="stack-lg">
      {error && <p className="error">{error}</p>}

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
          return (
            <article key={r.id} className="card stack">
              <div className="row spread">
                <strong>
                  {name(r.person_id)} · {t.timeOffTypes[r.type]}
                </strong>
                <span className="small muted">{range(r)}</span>
              </div>
              {r.note && <p className="muted small">« {r.note} »</p>}
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
                    placeholder={r.type === "unpaid" ? "0" : String(businessDays(r) * 8)}
                    value={paid[r.id] ?? ""}
                    onChange={(e) => setPaid({ ...paid, [r.id]: e.target.value })}
                  />
                </label>
                <label className="field" htmlFor={`n-${r.id}`}>
                  <span>{t.managerNote}</span>
                  <input id={`n-${r.id}`} value={notes[r.id] ?? ""} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} maxLength={500} />
                </label>
              </div>
              <p className="muted small">{t.paidHoursHint}</p>
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
        {pendingAvailability.length === 0 && <p className="muted">{t.noRequests}</p>}
        {pendingAvailability.map((personId) => {
          const before = windows(personId, "approved");
          const after = windows(personId, "pending");
          return (
            <article key={personId} className="card stack">
              <strong>{name(personId)}</strong>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th />
                      {t.days.map((d) => (
                        <th key={d}>{d}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row" className="small">
                        {t.currentAvailability}
                      </th>
                      {before.map((x, i) => (
                        <td key={i} className="small">
                          {x}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th scope="row" className="small">
                        {t.requestedAvailability}
                      </th>
                      {after.map((x, i) => (
                        <td key={i} className={`small ${x !== before[i] ? "changed" : ""}`}>
                          {x}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
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
                {time(c.occurred_at, c.location_id)} · {data.locations.find((l) => l.id === c.location_id)?.name}
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
    </div>
  );
}
