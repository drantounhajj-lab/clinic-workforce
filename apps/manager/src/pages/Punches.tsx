import { addDays, localDate, zonedToUtc } from "@clinic-workforce/rules";
import { useEffect, useState } from "react";
import { hours } from "../i18n";
import { personName, useSession } from "../session";
import { must, type Punch, supabase } from "../supabase";

export function Punches() {
  const { t, lang, data, managedLocations } = useSession();
  const [locationId, setLocationId] = useState(managedLocations[0]?.id ?? "");
  const location = managedLocations.find((l) => l.id === locationId) ?? managedLocations[0];
  const tz = location?.timezone ?? "America/Toronto";
  const [date, setDate] = useState(() => localDate(new Date(), tz));
  const [punches, setPunches] = useState<Punch[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!location) return;
    const from = zonedToUtc(date, "00:00", tz).toISOString();
    const to = zonedToUtc(addDays(date, 1), "00:00", tz).toISOString();
    supabase
      .from("punches")
      .select("*")
      .eq("location_id", location.id)
      .gte("occurred_at", from)
      .lt("occurred_at", to)
      .order("occurred_at")
      .then((res) => {
        try {
          setPunches(must(res) as Punch[]);
          setError("");
        } catch (e) {
          setError((e as Error).message);
        }
      });
  }, [location, date, tz]);

  if (!data || !location) return <p className="card">{t.noClinics}</p>;

  const time = (iso: string) => new Intl.DateTimeFormat("en-CA", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(new Date(iso));

  // Worked minutes per person: pair each "in" with the next "out"
  const worked = new Map<string, number>();
  const openIn = new Map<string, string>();
  for (const p of punches) {
    if (p.kind === "in") openIn.set(p.person_id, p.occurred_at);
    else if (openIn.has(p.person_id)) {
      worked.set(p.person_id, (worked.get(p.person_id) ?? 0) + (Date.parse(p.occurred_at) - Date.parse(openIn.get(p.person_id)!)) / 60000);
      openIn.delete(p.person_id);
    }
  }

  return (
    <div className="stack-lg">
      <section className="controls card">
        <label className="field" htmlFor="p-clinic">
          <span>{t.clinic}</span>
          <select id="p-clinic" value={location.id} onChange={(e) => setLocationId(e.target.value)}>
            {managedLocations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="p-date">
          <span>{t.date}</span>
          <input id="p-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </section>
      {error && <p className="error">{error}</p>}

      {worked.size > 0 && (
        <section className="card">
          <h2>{t.hoursWorked}</h2>
          <ul className="plain">
            {[...worked.entries()].map(([personId, minutes]) => (
              <li key={personId} className="row spread">
                <span>{personName(data.persons.find((p) => p.id === personId))}</span>
                <span className="mono">{hours(minutes, lang)} h</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="card table-wrap">
        {punches.length === 0 ? (
          <p className="muted">{t.noPunches}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t.time}</th>
                <th>{t.employee}</th>
                <th />
                <th>{t.method}</th>
                <th>{t.distance}</th>
                <th>{t.flags}</th>
              </tr>
            </thead>
            <tbody>
              {punches.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{time(p.occurred_at)}</td>
                  <td>{personName(data.persons.find((x) => x.id === p.person_id))}</td>
                  <td>
                    <span className={`pill ${p.kind === "in" ? "ok" : "muted-pill"}`}>{p.kind === "in" ? t.in : t.out}</span>
                  </td>
                  <td className="small">{t.methods[p.method] ?? p.method}</td>
                  <td className="small mono">{p.distance_m != null ? `${p.distance_m} m` : "—"}</td>
                  <td className="small">
                    {p.flags.map((f) => (
                      <span key={f} className="pill warn">
                        {t.flagNames[f] ?? f}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
