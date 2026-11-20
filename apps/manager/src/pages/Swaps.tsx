import { useCallback, useEffect, useState } from "react";
import { personName, useSession } from "../session";
import { type Shift, type ShiftSwap, supabase } from "../supabase";

export function Swaps({ onChange }: { onChange?: () => void }) {
  const { t, lang, data, can } = useSession();
  const [swaps, setSwaps] = useState<ShiftSwap[]>([]);
  const [shifts, setShifts] = useState<Record<string, Shift>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data: rows, error: err } = await supabase.from("shift_swaps").select("*").order("created_at", { ascending: false }).limit(150);
    if (err) {
      setError(err.message);
      return;
    }
    const list = (rows as ShiftSwap[]) ?? [];
    setSwaps(list);
    const ids = [...new Set(list.flatMap((s) => [s.shift_id, s.target_shift_id]).filter((x): x is string => !!x))];
    if (ids.length) {
      const { data: sh } = await supabase.from("shifts").select("*").in("id", ids);
      setShifts(Object.fromEntries(((sh as Shift[]) ?? []).map((x) => [x.id, x])));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) return null;

  const location = (id: string | null) => data.locations.find((l) => l.id === id);
  const nameOfEmployment = (id: string) => {
    const e = data.employments.find((x) => x.id === id);
    return personName(data.persons.find((p) => p.id === e?.person_id)) || "—";
  };
  const when = (shiftId: string | null) => {
    const s = shiftId ? shifts[shiftId] : undefined;
    if (!s) return "—";
    const tz = location(s.location_id)?.timezone ?? "America/Toronto";
    const locale = lang === "fr" ? "fr-CA" : "en-CA";
    const day = new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(s.starts_at));
    const time = (iso: string) => new Intl.DateTimeFormat(locale, { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
    return `${day} · ${time(s.starts_at)}–${time(s.ends_at)} · ${location(s.location_id)?.name ?? ""}`;
  };

  async function decide(s: ShiftSwap, approve: boolean) {
    setBusy(s.id);
    const { data: res, error: err } = await supabase.rpc("decide_swap", { p_swap_id: s.id, p_approve: approve, p_note: notes[s.id] ?? null });
    setBusy(null);
    if (err) setMessages((m) => ({ ...m, [s.id]: { ok: false, text: err.message } }));
    else if (!res?.ok) setMessages((m) => ({ ...m, [s.id]: { ok: false, text: t.swapReasons[res?.reason] ?? String(res?.reason) } }));
    else {
      setMessages((m) => ({ ...m, [s.id]: { ok: true, text: t.saved } }));
      await load();
      onChange?.();
    }
  }

  const mayDecide = (s: ShiftSwap) => can(s.location_id, "schedule") && (!s.target_location_id || can(s.target_location_id, "schedule"));

  const describe = (s: ShiftSwap) => (
    <>
      <p>
        <strong>{nameOfEmployment(s.requester_employment_id)}</strong> {s.target_shift_id ? t.exchangesWith : t.gives}{" "}
        <strong>{nameOfEmployment(s.target_employment_id)}</strong>
      </p>
      <p className="small">
        {when(s.shift_id)}
        {s.target_shift_id && (
          <>
            <br />⇄ {t.theirShift} : {when(s.target_shift_id)}
          </>
        )}
      </p>
      {s.note && <p className="muted small">« {s.note} »</p>}
    </>
  );

  const pendingManager = swaps.filter((s) => s.status === "pending_manager");
  const pendingColleague = swaps.filter((s) => s.status === "pending_colleague");
  const decided = swaps.filter((s) => !["pending_manager", "pending_colleague"].includes(s.status)).slice(0, 30);

  return (
    <div className="stack-lg">
      {error && <p className="error">{error}</p>}
      <p className="muted">{t.swapsHint}</p>

      <section className="stack">
        <h2>{t.toApprove}</h2>
        {pendingManager.length === 0 && <p className="muted">{t.noSwaps}</p>}
        {pendingManager.map((s) => (
          <article key={s.id} className="card stack">
            {describe(s)}
            {mayDecide(s) && (
              <>
                <label className="field" htmlFor={`note-${s.id}`}>
                  <span>{t.managerNote}</span>
                  <input id={`note-${s.id}`} value={notes[s.id] ?? ""} onChange={(e) => setNotes({ ...notes, [s.id]: e.target.value })} maxLength={500} />
                </label>
                <div className="row">
                  <button type="button" className="primary" disabled={busy === s.id} onClick={() => decide(s, true)}>
                    {t.approve}
                  </button>
                  <button type="button" disabled={busy === s.id} onClick={() => decide(s, false)}>
                    {t.refuse}
                  </button>
                </div>
              </>
            )}
            {messages[s.id] && <p className={messages[s.id].ok ? "notice" : "error"}>{messages[s.id].text}</p>}
          </article>
        ))}
      </section>

      {pendingColleague.length > 0 && (
        <section className="stack">
          <h2>{t.waitingColleague}</h2>
          {pendingColleague.map((s) => (
            <article key={s.id} className="card stack">
              {describe(s)}
            </article>
          ))}
        </section>
      )}

      <section className="stack">
        <h2>{t.recentSwaps}</h2>
        {decided.length === 0 ? (
          <p className="muted">{t.noSwaps}</p>
        ) : (
          <div className="table-wrap card">
            <table className="table">
              <tbody>
                {decided.map((s) => (
                  <tr key={s.id}>
                    <td className="small">
                      {nameOfEmployment(s.requester_employment_id)} → {nameOfEmployment(s.target_employment_id)}
                    </td>
                    <td className="small">{when(s.shift_id)}</td>
                    <td>
                      <span className={`pill ${s.status === "approved" ? "ok" : "muted-pill"}`}>{t.swapStatus[s.status]}</span>
                    </td>
                    <td className="small muted">{s.manager_note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
