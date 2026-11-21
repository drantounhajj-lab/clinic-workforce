import { CoverageRules, PaySettings } from "./Coverage";
import { useEffect, useState } from "react";
import { useSession } from "../session";
import { friendly, type Strings } from "../i18n";
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
  const { t, lang, data, reload, isOwner, managesCompany, can } = useSession();
  const managesLocation = (id: string) => can(id, "clinics");
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
      setError(friendly(e, t));
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
              <li key={c.id} className="stack">
                <strong>{c.legal_name}</strong>
                <PaySettings companyId={c.id} />
              </li>
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

        {form && !editing && <ClinicEditor t={t} lang={lang} companies={editableCompanies(form.company_id)} form={form} setForm={setForm} onSave={() => saveClinic(form, null)} onCancel={() => setForm(null)} />}

        {data.locations.length === 0 && !form && <p className="muted">{t.none}</p>}

        {data.locations.map((l) => {
          const company = data.companies.find((c) => c.id === l.company_id);
          const nets = wifi.filter((w) => w.location_id === l.id);
          if (editing === l.id && form) {
            return <ClinicEditor key={l.id} t={t} lang={lang} companies={editableCompanies(form.company_id)} form={form} setForm={setForm} onSave={() => saveClinic(form, l.id)} onCancel={() => { setEditing(null); setForm(null); }} />;
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
                  <dt>{t.mapPosition}</dt>
                  <dd>
                    {l.latitude !== null && l.longitude !== null ? (
                      <a href={googleMapsLink(l.latitude, l.longitude)} target="_blank" rel="noreferrer">
                        {t.openInMaps}
                      </a>
                    ) : (
                      <span className="warn-text">{t.positionMissing}</span>
                    )}
                  </dd>
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
              <CoverageRules locationId={l.id} />
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

export function googleMapsLink(lat: number, lon: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

interface Place {
  label: string;
  province: Province | null;
  lat: number;
  lon: number;
}

const PROVINCE_NAMES: Record<string, Province> = {
  quebec: "QC", "québec": "QC", ontario: "ON", alberta: "AB", "british columbia": "BC", "colombie-britannique": "BC",
  manitoba: "MB", "new brunswick": "NB", "nouveau-brunswick": "NB", "newfoundland and labrador": "NL", "terre-neuve-et-labrador": "NL",
  "nova scotia": "NS", "nouvelle-écosse": "NS", "northwest territories": "NT", "territoires du nord-ouest": "NT", nunavut: "NU",
  "prince edward island": "PE", "île-du-prince-édouard": "PE", saskatchewan: "SK", yukon: "YT",
};

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  address?: Record<string, string>;
}

// Address search: OpenStreetMap's free geocoder (one search per click, as its usage policy asks).
async function searchAddress(query: string, lang: string): Promise<Place[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.search = new URLSearchParams({ q: query, format: "jsonv2", addressdetails: "1", limit: "5", countrycodes: "ca", "accept-language": lang }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  const rows = (await res.json()) as NominatimResult[];
  return rows.map((r) => {
    const a = r.address ?? {};
    const street = [a.house_number, a.road].filter(Boolean).join(" ");
    const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.suburb ?? "";
    const province = PROVINCE_NAMES[(a.state ?? "").toLowerCase()] ?? null;
    const label = [street, city, [province, a.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ") || r.display_name;
    return { label, province, lat: Number(r.lat), lon: Number(r.lon) };
  });
}

function ClinicEditor({ form: f, setForm: set, onSave, onCancel, t, lang, companies }: {
form: ClinicForm;
setForm: (f: ClinicForm) => void;
onSave: () => void;
onCancel: () => void;
t: Strings;
lang: string;
companies: Company[];
}) {
  const [results, setResults] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const lat = f.latitude ? Number(f.latitude) : null;
  const lon = f.longitude ? Number(f.longitude) : null;

  async function find() {
    if (!f.address.trim()) return;
    setSearching(true);
    setSearchError("");
    setResults(null);
    try {
      const found = await searchAddress(f.address.trim(), lang);
      if (found.length === 0) setSearchError(t.noAddressResults);
      else if (found.length === 1) choose(found[0]);
      else setResults(found);
    } catch {
      setSearchError(t.addressSearchFailed);
    } finally {
      setSearching(false);
    }
  }

  function choose(p: Place) {
    set({ ...f, address: p.label, latitude: String(p.lat), longitude: String(p.lon), province: p.province ?? f.province });
    setResults(null);
  }

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
      <div className="stack">
        <label className="field" htmlFor="c-address">
          <span>{t.address}</span>
          <div className="row">
            <input
              id="c-address"
              className="grow"
              value={f.address}
              placeholder={t.addressPlaceholder}
              onChange={(e) => set({ ...f, address: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  find();
                }
              }}
            />
            <button type="button" onClick={find} disabled={searching || !f.address.trim()}>
              {searching ? t.searching : t.findOnMap}
            </button>
          </div>
        </label>
        {searchError && <p className="warn-text small">{searchError}</p>}
        {results && (
          <div className="stack">
            <span className="muted small">{t.pickAddress}</span>
            <ul className="plain results">
              {results.map((r) => (
                <li key={`${r.lat},${r.lon}`}>
                  <button type="button" className="link" onClick={() => choose(r)}>
                    {r.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {lat !== null && lon !== null ? (
          <div className="stack">
            <iframe
              className="map"
              title={t.mapPosition}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              src={`https://maps.google.com/maps?q=${lat},${lon}&z=17&output=embed`}
            />
            <p className="muted small">
              {t.mapCheckHint}{" "}
              <a href={googleMapsLink(lat, lon)} target="_blank" rel="noreferrer">
                {t.openInMaps}
              </a>
            </p>
          </div>
        ) : (
          <p className="warn-text small">{t.positionMissingHint}</p>
        )}
      </div>
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
