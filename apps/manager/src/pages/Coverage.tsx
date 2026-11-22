import { friendly } from "../i18n";
import { useCallback, useEffect, useState } from "react";
import { useSession } from "../session";
import { type CoverageRule, must, type StaffingRatioRule, supabase } from "../supabase";

/** Minimum number of people per position at a clinic, by day and time. */
export function CoverageRules({ locationId }: { locationId: string }) {
  const { t, lang, data, can } = useSession();
  const [rules, setRules] = useState<CoverageRule[]>([]);
  const [form, setForm] = useState({ job_role_id: "", weekdays: [0, 1, 2, 3, 4], start_time: "08:00", end_time: "17:00", min_count: 1 });
  const [error, setError] = useState("");
  const editable = can(locationId, "schedule");

  const load = useCallback(async () => {
    const { data: rows, error: err } = await supabase.from("coverage_rules").select("*").eq("location_id", locationId).order("start_time");
    if (err) setError(friendly(err, t));
    else setRules((rows as CoverageRule[]) ?? []);
  }, [locationId]);
  useEffect(() => {
    load();
  }, [load]);

  if (!data) return null;
  const positions = data.jobRoles;
  const posName = (id: string) => {
    const j = positions.find((x) => x.id === id);
    return j ? (lang === "fr" ? j.name_fr : j.name_en) : "?";
  };
  const days = (w: number[]) => (w.length === 7 ? t.everyDay : w.length === 5 && [0, 1, 2, 3, 4].every((d) => w.includes(d)) ? t.weekdays : w.map((d) => t.days[d]).join(", "));

  async function add() {
    if (!form.job_role_id || form.weekdays.length === 0 || form.end_time <= form.start_time) return;
    setError("");
    try {
      must(await supabase.from("coverage_rules").insert({ ...form, location_id: locationId }));
      await load();
    } catch (e) {
      setError(friendly(e, t));
    }
  }

  async function remove(id: string) {
    const { error: err } = await supabase.from("coverage_rules").delete().eq("id", id);
    if (err) setError(friendly(err, t));
    else load();
  }

  return (
    <div className="stack">
      <strong>{t.coverageTitle}</strong>
      <p className="muted small">{t.coverageHint}</p>
      {error && <p className="error">{error}</p>}
      {rules.length === 0 && <p className="muted small">{t.none}</p>}
      <ul className="plain">
        {rules.map((r) => (
          <li key={r.id} className="row spread small">
            <span>
              <strong>
                {r.min_count} × {posName(r.job_role_id)}
              </strong>{" "}
              · {days(r.weekdays)} · {r.start_time.slice(0, 5)}–{r.end_time.slice(0, 5)}
            </span>
            {editable && (
              <button type="button" className="link danger" onClick={() => remove(r.id)}>
                {t.remove}
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && positions.length === 0 && <p className="muted small">{t.coverageNeedsPositions}</p>}
      {editable && positions.length > 0 && (
        <div className="subcard stack">
          <div className="grid2">
            <label className="field" htmlFor={`cov-pos-${locationId}`}>
              <span>{t.position}</span>
              <select id={`cov-pos-${locationId}`} value={form.job_role_id} onChange={(e) => setForm({ ...form, job_role_id: e.target.value })}>
                <option value="">—</option>
                {positions.map((j) => (
                  <option key={j.id} value={j.id}>
                    {lang === "fr" ? j.name_fr : j.name_en}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" htmlFor={`cov-min-${locationId}`}>
              <span>{t.minPeople}</span>
              <input id={`cov-min-${locationId}`} type="number" min={1} max={20} value={form.min_count} onChange={(e) => setForm({ ...form, min_count: Math.max(1, Number(e.target.value) || 1) })} />
            </label>
            <label className="field" htmlFor={`cov-from-${locationId}`}>
              <span>{t.start}</span>
              <input id={`cov-from-${locationId}`} type="time" step={900} value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} />
            </label>
            <label className="field" htmlFor={`cov-to-${locationId}`}>
              <span>{t.end}</span>
              <input id={`cov-to-${locationId}`} type="time" step={900} value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} />
            </label>
          </div>
          <fieldset className="checks-group">
            <legend className="sr-only">{t.daysLabel}</legend>
            {t.days.map((d, i) => (
              <label key={d} className="check" htmlFor={`cov-d${i}-${locationId}`}>
                <input
                  id={`cov-d${i}-${locationId}`}
                  type="checkbox"
                  checked={form.weekdays.includes(i)}
                  onChange={(e) => setForm({ ...form, weekdays: e.target.checked ? [...form.weekdays, i].sort() : form.weekdays.filter((x) => x !== i) })}
                />
                {d}
              </label>
            ))}
          </fieldset>
          <div>
            <button type="button" onClick={add} disabled={!form.job_role_id || form.end_time <= form.start_time || form.weekdays.length === 0}>
              {t.addCoverage}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Pay period settings of a company (owner and company admins). */
export function PaySettings({ companyId }: { companyId: string }) {
  const { t, data, reload, managesCompany } = useSession();
  const company = data?.companies.find((c) => c.id === companyId);
  const [freq, setFreq] = useState(company?.pay_frequency ?? "biweekly");
  const [anchor, setAnchor] = useState(company?.pay_period_anchor ?? "2026-01-04");
  const [msg, setMsg] = useState("");
  if (!company) return null;
  const editable = managesCompany(companyId);
  const changed = freq !== company.pay_frequency || anchor !== company.pay_period_anchor;
  return (
    <div className="row wrap small">
      <label className="field" htmlFor={`pf-${companyId}`}>
        <span>{t.payFrequency}</span>
        <select id={`pf-${companyId}`} value={freq} disabled={!editable} onChange={(e) => setFreq(e.target.value as "weekly" | "biweekly")}>
          <option value="weekly">{t.weekly}</option>
          <option value="biweekly">{t.biweekly}</option>
        </select>
      </label>
      <label className="field" htmlFor={`pa-${companyId}`}>
        <span>{t.periodStartsOn}</span>
        <input id={`pa-${companyId}`} type="date" value={anchor} disabled={!editable} onChange={(e) => setAnchor(e.target.value)} />
      </label>
      {editable && changed && (
        <button
          type="button"
          onClick={async () => {
            const { error } = await supabase.from("companies").update({ pay_frequency: freq, pay_period_anchor: anchor }).eq("id", companyId);
            setMsg(error ? friendly(error, t) : t.saved);
            if (!error) await reload();
          }}
        >
          {t.save}
        </button>
      )}
      {msg && <span className="muted">{msg}</span>}
    </div>
  );
}

/** "Whenever N of position A are on shift, at least M of position B" for a clinic. */
export function StaffingRatios({ locationId }: { locationId: string }) {
  const { t, lang, data, can } = useSession();
  const [rules, setRules] = useState<StaffingRatioRule[]>([]);
  const [form, setForm] = useState({ trigger_job_role_id: "", trigger_count: 2, required_job_role_id: "", required_count: 1 });
  const [error, setError] = useState("");
  const editable = can(locationId, "schedule");
  const load = useCallback(async () => {
    const { data: rows, error: err } = await supabase.from("staffing_ratio_rules").select("*").eq("location_id", locationId).order("created_at");
    if (err) setError(friendly(err, t));
    else setRules((rows as StaffingRatioRule[]) ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);
  useEffect(() => {
    load();
  }, [load]);
  if (!data) return null;
  const positions = data.jobRoles;
  const pos = (id: string) => {
    const j = positions.find((x) => x.id === id);
    return j ? (lang === "fr" ? j.name_fr : j.name_en).toLowerCase() : "?";
  };
  if (positions.length < 2 && rules.length === 0) return null;
  const run = async (fn: () => Promise<void>) => {
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(friendly(e, t));
    }
  };
  return (
    <div className="stack-sm">
      <strong className="small">{t.staffingRatios}</strong>
      <p className="muted small">{t.staffingRatiosHint}</p>
      <ul className="plain small">
        {rules.map((r) => (
          <li key={r.id} className="row spread">
            <span>{t.ratioText(r.trigger_count, pos(r.trigger_job_role_id), r.required_count, pos(r.required_job_role_id))}</span>
            {editable && (
              <button type="button" className="link small" onClick={() => run(async () => void must(await supabase.from("staffing_ratio_rules").delete().eq("id", r.id)))}>
                {t.remove}
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form
          className="row wrap small"
          onSubmit={(e) => {
            e.preventDefault();
            if (!form.trigger_job_role_id || !form.required_job_role_id || form.trigger_job_role_id === form.required_job_role_id) return;
            run(async () => void must(await supabase.from("staffing_ratio_rules").insert({ location_id: locationId, ...form })));
          }}
        >
          <span>{t.whenever}</span>
          <input
            aria-label={t.whenever}
            type="number"
            min={1}
            max={50}
            className="num"
            value={form.trigger_count}
            onChange={(e) => setForm({ ...form, trigger_count: Math.max(1, Number(e.target.value) || 1) })}
          />
          <select aria-label={t.filterPosition} value={form.trigger_job_role_id} onChange={(e) => setForm({ ...form, trigger_job_role_id: e.target.value })}>
            <option value="">—</option>
            {positions.map((j) => (
              <option key={j.id} value={j.id}>
                {lang === "fr" ? j.name_fr : j.name_en}
              </option>
            ))}
          </select>
          <span>{t.areOnShift}</span>
          <input
            aria-label={t.areOnShift}
            type="number"
            min={1}
            max={50}
            className="num"
            value={form.required_count}
            onChange={(e) => setForm({ ...form, required_count: Math.max(1, Number(e.target.value) || 1) })}
          />
          <select aria-label={t.filterPosition} value={form.required_job_role_id} onChange={(e) => setForm({ ...form, required_job_role_id: e.target.value })}>
            <option value="">—</option>
            {positions.map((j) => (
              <option key={j.id} value={j.id}>
                {lang === "fr" ? j.name_fr : j.name_en}
              </option>
            ))}
          </select>
          <button type="submit">{t.addRatio}</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
