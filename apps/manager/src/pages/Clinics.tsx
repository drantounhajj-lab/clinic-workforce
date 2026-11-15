import { useEffect, useState } from "react";
import { useSession } from "../session";
import type { Strings } from "../i18n";
import { type Company, type Location, type LocationWifi, must, type Province, supabase } from "../supabase";

const PROVINCES: Province[] = ["QC", "ON", "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "PE", "SK", "YT"];

interface ClinicForm {
  company_id: string;
  name: string;
  province: Province;
  address: string;
  latitude: string;
  longitude: string;
  geofence_radius_m: number;
  early_punch_limit_min: number;
}

const emptyForm = (companyId: string): ClinicForm => ({
  company_id: companyId,
  name: "",
  province: "QC",
  address: "",
  latitude: "",
  longitude: "",
  geofence_radius_m: 150,
  early_punch_limit_min: 15,
});

export function Clinics() {
  const { t, data, reload, isOwner, managesCompany, managesLocation } = useSession();
  const [companyName, setCompanyName] = useState("");
  const [form, setForm] = useState<ClinicForm | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [wifi, setWifi] = useState<LocationWifi[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    supabase
      .from("location_wifi")
      .select("*")
      .then(({ data: rows }) => setWifi((rows as LocationWifi[]) ?? []));
  }, [data]);

  if (!data) return null;

  async function run(fn: () => Promise<void>) {
    setError("");
    setNotice("");
    try {
      await fn();
      await reload();
      setNotice(t.saved);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const editableCompanies = (current: string) => data.companies.filter((c) => managesCompany(c.id) || c.id === current);
  const parseCoord = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));

  async function saveClinic(f: ClinicForm, id: string | null) {
    const row = {
      company_id: f.company_id,
      name: f.name.trim(),
      province: f.province,
      address: f.address.trim() || null,
      latitude: parseCoord(f.latitude),
      longitude: parseCoord(f.longitude),
      geofence_radius_m: f.geofence_radius_m,
      early_punch_limit_min: f.early_punch_limit_min,
    };
    await run(async () => {
      if (id) must(await supabase.from("locations").update(row).eq("id", id));
      else must(await supabase.from("locations").insert(row));
      setForm(null);
      setEditing(null);
    });
  }

  const toForm = (l: Location): ClinicForm => ({
    company_id: l.company_id,
    name: l.name,
    province: l.province,
    address: l.address ?? "",
    latitude: l.latitude?.toString() ?? "",
    longitude: l.longitude?.toString() ?? "",
    geofence_radius_m: l.geofence_radius_m,
    early_punch_limit_min: l.early_punch_limit_min,
  });

  return (
    <div className="stack-lg">
      {(error || notice) && <p className={error ? "error" : "notice"}>{error || notice}</p>}

      <section className="card stack">
        <h2>{t.companies}</h2>
        <p className="muted">{t.companyHint}</p>
        {data.companies.length === 0 ? (
          <p className="muted">{t.none}</p>
        ) : (
          <ul className="plain">
            {data.companies.map((c) => (
              <li key={c.id}>{c.legal_name}</li>
            ))}
          </ul>
        )}
        {isOwner && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!companyName.trim()) return;
              run(async () => {
                must(await supabase.from("companies").insert({ legal_name: companyName.trim() }));
                setCompanyName("");
              });
            }}
          >
            <label className="field grow" htmlFor="company-name">
              <span>{t.legalName}</span>
              <input id="company-name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} maxLength={200} />
            </label>
            <button type="submit">{t.addCompany}</button>
          </form>
        )}
      </section>

      <section className="stack">
        <div className="row spread">
          <h2>{t.clinics}</h2>
          {data.companies.some((c) => managesCompany(c.id)) && !form && (
            <button type="button" className="primary" onClick={() => setForm(emptyForm(data.companies.find((c) => managesCompany(c.id))!.id))}>
              {t.addClinic}
            </button>
          )}
        </div>

        {form && !editing && <ClinicEditor t={t} companies={editableCompanies(form.company_id)} form={form} setForm={setForm} onSave={() => saveClinic(form, null)} onCancel={() => setForm(null)} />}

        {data.locations.length === 0 && !form && <p className="muted">{t.none}</p>}

        {data.locations.map((l) => {
          const company = data.companies.find((c) => c.id === l.company_id);
          const nets = wifi.filter((w) => w.location_id === l.id);
          if (editing === l.id && form) {
            return <ClinicEditor key={l.id} t={t} companies={editableCompanies(form.company_id)} form={form} setForm={setForm} onSave={() => saveClinic(form, l.id)} onCancel={() => { setEditing(null); setForm(null); }} />;
          }
          return (
            <article className="card stack" key={l.id}>
              <div className="row spread">
                <div>
                  <h3>
                    {l.name} <span className="prov">{l.province}</span>
                  </h3>
                  <p className="muted small">{company?.legal_name}</p>
                </div>
                {managesLocation(l.id) && (
                  <button type="button" onClick={() => { setEditing(l.id); setForm(toForm(l)); }}>
                    {t.edit}
                  </button>
                )}
              </div>
              <dl className="facts">
                <div>
                  <dt>{t.address}</dt>
                  <dd>{l.address ?? "—"}</dd>
                </div>
                <div>
                  <dt>
                    {t.latitude}, {t.longitude}
                  </dt>
                  <dd>{l.latitude !== null ? `${l.latitude.toFixed(5)}, ${l.longitude?.toFixed(5)}` : <span className="warn-text">{t.noCoords}</span>}</dd>
                </div>
                <div>
                  <dt>{t.zone}</dt>
                  <dd>{l.geofence_radius_m} m</dd>
                </div>
                <div>
                  <dt>{t.earlyLimit}</dt>
                  <dd>{l.early_punch_limit_min} min</dd>
                </div>
              </dl>
              {managesLocation(l.id) && (
                <div className="stack">
                  <strong>{t.wifi}</strong>
                  {nets.length === 0 ? (
                    <p className="muted small">{t.wifiHint}</p>
                  ) : (
                    <ul className="plain">
                      {nets.map((w) => (
                        <li key={w.id} className="row spread">
                          <span>
                            {w.ssid ?? "—"} <span className="mono muted">{w.bssid}</span>
                          </span>
                          <button type="button" className="link danger" onClick={() => run(async () => { must(await supabase.from("location_wifi").delete().eq("id", w.id)); })}>
                            {t.remove}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}

function ClinicEditor({ form: f, setForm: set, onSave, onCancel, t, companies }: {
form: ClinicForm;
setForm: (f: ClinicForm) => void;
onSave: () => void;
onCancel: () => void;
t: Strings;
companies: Company[];
}) {
  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="grid2">
        <label className="field" htmlFor="c-company">
          <span>{t.company}</span>
          <select id="c-company" value={f.company_id} onChange={(e) => set({ ...f, company_id: e.target.value })}>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.legal_name}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="c-name">
          <span>{t.clinicName}</span>
          <input id="c-name" value={f.name} onChange={(e) => set({ ...f, name: e.target.value })} required maxLength={120} />
        </label>
        <label className="field" htmlFor="c-province">
          <span>{t.province}</span>
          <select id="c-province" value={f.province} onChange={(e) => set({ ...f, province: e.target.value as Province })}>
            {PROVINCES.map((p) => (
              <option key={p} value={p}>
                {t.provinces[p] ? `${t.provinces[p]} (${p})` : p}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="c-address">
          <span>{t.address}</span>
          <input id="c-address" value={f.address} onChange={(e) => set({ ...f, address: e.target.value })} />
        </label>
        <label className="field" htmlFor="c-lat">
          <span>{t.latitude}</span>
          <input id="c-lat" inputMode="decimal" placeholder="45.47650" value={f.latitude} onChange={(e) => set({ ...f, latitude: e.target.value })} />
        </label>
        <label className="field" htmlFor="c-lon">
          <span>{t.longitude}</span>
          <input id="c-lon" inputMode="decimal" placeholder="-75.70130" value={f.longitude} onChange={(e) => set({ ...f, longitude: e.target.value })} />
        </label>
        <label className="field" htmlFor="c-zone">
          <span>{t.zone}</span>
          <select id="c-zone" value={f.geofence_radius_m} onChange={(e) => set({ ...f, geofence_radius_m: Number(e.target.value) })}>
            {[75, 100, 150, 200, 250, 400].map((r) => (
              <option key={r} value={r}>
                {r} m
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="c-early">
          <span>{t.earlyLimit}</span>
          <input id="c-early" type="number" min={0} max={240} value={f.early_punch_limit_min} onChange={(e) => set({ ...f, early_punch_limit_min: Number(e.target.value) })} />
        </label>
      </div>
      <p className="muted small">{t.coordsHint}</p>
      <div className="row">
        <button type="submit" className="primary">
          {t.save}
        </button>
        <button type="button" onClick={onCancel}>
          {t.cancel}
        </button>
      </div>
    </form>
  );
}
