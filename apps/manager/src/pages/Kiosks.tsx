import { friendly } from "../i18n";
import { useCallback, useEffect, useState } from "react";
import { useSession } from "../session";
import { type KioskDevice, must, supabase } from "../supabase";

export function Kiosks() {
  const { t, lang, locationsWith } = useSession();
  const managedLocations = locationsWith("kiosks");
  const [devices, setDevices] = useState<KioskDevice[]>([]);
  const [code, setCode] = useState("");
  const [locationId, setLocationId] = useState(managedLocations[0]?.id ?? "");
  const [name, setName] = useState("iPad");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      setDevices(must(await supabase.from("kiosk_devices").select("*").order("created_at")) as KioskDevice[]);
    } catch (e) {
      setError(friendly(e, t));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function pair(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    if (!/^\d{6}$/.test(code)) {
      setError(t.pairErrors.invalid_code);
      return;
    }
    const { data, error: err } = await supabase.rpc("kiosk_approve_pairing", { p_code: code, p_location_id: locationId, p_name: name.trim() || "iPad" });
    if (err) setError(friendly(err, t));
    else if (!data?.ok) setError(t.pairErrors[data?.reason] ?? String(data?.reason));
    else {
      setNotice(t.paired);
      setCode("");
      await load();
    }
  }

  async function remove(id: string) {
    try {
      must(await supabase.from("kiosk_devices").delete().eq("id", id));
      await load();
    } catch (e) {
      setError(friendly(e, t));
    }
  }

  if (managedLocations.length === 0) return <p className="card">{t.noClinics}</p>;

  return (
    <div className="stack-lg">
      {(error || notice) && <p className={error ? "error" : "notice"}>{error || notice}</p>}
      <form className="card stack" onSubmit={pair}>
        <h2>{t.pairTitle}</h2>
        <p className="muted">{t.pairHint}</p>
        <div className="grid3">
          <label className="field" htmlFor="k-code">
            <span>{t.pairCode}</span>
            <input id="k-code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required />
          </label>
          <label className="field" htmlFor="k-clinic">
            <span>{t.clinic}</span>
            <select id="k-clinic" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {managedLocations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor="k-name">
            <span>{t.deviceName}</span>
            <input id="k-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </label>
        </div>
        <div>
          <button type="submit" className="primary">
            {t.pair}
          </button>
        </div>
      </form>

      <section className="card stack">
        <h2>{t.nav.kiosks}</h2>
        {devices.length === 0 ? (
          <p className="muted">{t.none}</p>
        ) : (
          <ul className="plain">
            {devices.map((d) => (
              <li key={d.id} className="row spread">
                <span>
                  <strong>{d.name}</strong> · {managedLocations.find((l) => l.id === d.location_id)?.name}
                  <span className="muted small"> · {new Date(d.created_at).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-CA")}</span>
                </span>
                <button type="button" className="link danger" onClick={() => remove(d.id)}>
                  {t.remove}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
