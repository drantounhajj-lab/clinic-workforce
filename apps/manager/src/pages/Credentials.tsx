import { useCallback, useEffect, useState } from "react";
import { formatDate, friendly } from "../i18n";
import { personName, useSession } from "../session";
import { type Credential, must, supabase } from "../supabase";

const soon = (date: string | null, days: number) => !!date && date <= new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const past = (date: string | null) => !!date && date < new Date().toISOString().slice(0, 10);

/** Licences and certifications of one person, with expiry. */
export function CredentialsPanel({ personId }: { personId: string }) {
  const { t, lang } = useSession();
  const [list, setList] = useState<Credential[]>([]);
  const [form, setForm] = useState({ name: "", number: "", issuer: "", expires_on: "", blocks_scheduling: true });
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.from("credentials").select("*").eq("person_id", personId).order("expires_on");
    if (err) setError(friendly(err, t));
    else setList((data as Credential[]) ?? []);
  }, [personId]);

  useEffect(() => {
    load();
  }, [load]);

  async function add() {
    if (!form.name.trim()) return;
    setError("");
    try {
      must(
        await supabase.from("credentials").insert({
          person_id: personId,
          name: form.name.trim(),
          number: form.number.trim() || null,
          issuer: form.issuer.trim() || null,
          expires_on: form.expires_on || null,
          blocks_scheduling: form.blocks_scheduling,
        }),
      );
      setForm({ name: "", number: "", issuer: "", expires_on: "", blocks_scheduling: true });
      await load();
    } catch (e) {
      setError(friendly(e, t));
    }
  }

  async function remove(id: string) {
    if (!window.confirm(t.confirmDeleteCredential)) return;
    const { error: err } = await supabase.from("credentials").delete().eq("id", id);
    if (err) setError(friendly(err, t));
    else load();
  }

  return (
    <section className="subcard stack">
      <h3>{t.credentialsTitle}</h3>
      <p className="muted small">{t.credentialsHint}</p>
      {error && <p className="error">{error}</p>}
      {list.length === 0 && <p className="muted small">{t.none}</p>}
      <ul className="plain">
        {list.map((c) => (
          <li key={c.id} className="row spread">
            <span>
              <strong>{c.name}</strong>
              {c.number && <span className="muted small"> · {c.number}</span>}
              {c.issuer && <span className="muted small"> · {c.issuer}</span>}
              <span className={`small ${past(c.expires_on) ? "error-text" : soon(c.expires_on, 60) ? "warn-text" : "muted"}`}>
                {" "}
                · {c.expires_on ? t.expiresOn(formatDate(c.expires_on, lang, { day: "numeric", month: "short", year: "numeric" })) : t.noExpiry}
              </span>
              {c.blocks_scheduling && <span className="pill muted-pill small-pill">{t.blocksScheduling}</span>}
            </span>
            <button type="button" className="link danger" onClick={() => remove(c.id)}>
              {t.remove}
            </button>
          </li>
        ))}
      </ul>
      <div className="grid2">
        <label className="field" htmlFor="cr-name">
          <span>{t.credentialName}</span>
          <input id="cr-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Permis OPPQ" maxLength={120} />
        </label>
        <label className="field" htmlFor="cr-exp">
          <span>{t.expiryDate}</span>
          <input id="cr-exp" type="date" value={form.expires_on} onChange={(e) => setForm({ ...form, expires_on: e.target.value })} />
        </label>
        <label className="field" htmlFor="cr-num">
          <span>{t.credentialNumber}</span>
          <input id="cr-num" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} maxLength={60} />
        </label>
        <label className="field" htmlFor="cr-iss">
          <span>{t.issuer}</span>
          <input id="cr-iss" value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} placeholder="OPPQ, CPSO…" maxLength={120} />
        </label>
      </div>
      <label className="check" htmlFor="cr-block">
        <input id="cr-block" type="checkbox" checked={form.blocks_scheduling} onChange={(e) => setForm({ ...form, blocks_scheduling: e.target.checked })} />
        {t.blocksSchedulingHint}
      </label>
      <div>
        <button type="button" onClick={add} disabled={!form.name.trim()}>
          {t.addCredential}
        </button>
      </div>
    </section>
  );
}

/** Credentials that have expired or expire within 60 days, for people the manager can see. */
export function ExpiringCredentials() {
  const { t, lang, data } = useSession();
  const [list, setList] = useState<Credential[]>([]);
  useEffect(() => {
    const until = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    supabase
      .from("credentials")
      .select("*")
      .lte("expires_on", until)
      .order("expires_on")
      .then(({ data: rows }) => setList((rows as Credential[]) ?? []));
  }, []);
  if (!data || list.length === 0) return null;
  return (
    <section className="card stack warn-card">
      <h3>{t.expiringTitle}</h3>
      <ul className="plain">
        {list.map((c) => (
          <li key={c.id} className="small">
            <strong>{personName(data.persons.find((p) => p.id === c.person_id))}</strong> · {c.name} ·{" "}
            <span className={past(c.expires_on) ? "error-text" : "warn-text"}>
              {past(c.expires_on) ? t.expiredOn : t.expiresOnShort} {formatDate(c.expires_on!, lang, { day: "numeric", month: "short", year: "numeric" })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
