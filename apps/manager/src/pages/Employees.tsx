import { CredentialsPanel, ExpiringCredentials } from "./Credentials";
import { useState } from "react";
import { friendly, type Strings } from "../i18n";
import { personName, useSession } from "../session";
import { type Company, type CustomRole, type Employment, type JobRole, type Location, must, type Person, supabase } from "../supabase";

/** "employee", "clinic_manager", "company_admin", or "custom:<role id>" */
type RoleChoice = string;

interface EmployeeDraft {
  personId: string | null;
  employmentId: string | null;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company_id: string;
  locationIds: string[];
  role: RoleChoice;
  jobRoleId: string;
  payrollNumber: string;
  desired: string;
  min: string;
  max: string;
}

const toMinutes = (h: string) => (h.trim() === "" ? null : Math.round(Number(h.replace(",", ".")) * 60));
const toHours = (m: number | null) => (m === null ? "" : String(m / 60));

export function Employees() {
  const { t, lang, data, reload, isOwner, managesCompany, managesLocation: fullyManages, can, locationsWith, isFullManager } = useSession();
  const managesLocation = (id: string) => can(id, "employees");
  const managedLocations = locationsWith("employees");
  const [draft, setDraft] = useState<EmployeeDraft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  if (!data) return null;

  const hireableCompanies = data.companies.filter((c) => managesCompany(c.id) || managedLocations.some((l) => l.company_id === c.id));

  const clinicName = (id: string | null) => data!.locations.find((l) => l.id === id)?.name ?? "";
  function roleOf(p: Person): string[] {
    const builtIn = data!.roles
      .filter((r) => r.person_id === p.id)
      .map((r) =>
        r.role === "clinic_manager"
          ? `${t.roles.clinic_manager} · ${clinicName(r.location_id)}`
          : r.role === "company_admin"
            ? `${t.roles.company_admin} · ${data!.companies.find((c) => c.id === r.company_id)?.legal_name ?? ""}`
            : t.roles.owner,
      );
    const custom = data!.customAssignments
      .filter((a) => a.person_id === p.id)
      .map((a) => `${data!.customRoles.find((r) => r.id === a.custom_role_id)?.name ?? ""} · ${clinicName(a.location_id)}`);
    return [...builtIn, ...custom];
  }
  const positionName = (id: string | null | undefined) => {
    const j = data!.jobRoles.find((x) => x.id === id);
    return j ? (lang === "fr" ? j.name_fr : j.name_en) : "";
  };

  function startNew() {
    const company = hireableCompanies[0];
    setDraft({
      personId: null,
      employmentId: null,
      first_name: "",
      last_name: "",
      email: "",
      phone: "",
      company_id: company?.id ?? "",
      locationIds: [],
      role: "employee",
      jobRoleId: "",
      payrollNumber: "",
      desired: "",
      min: "",
      max: "",
    });
    setError("");
    setNotice("");
  }

  function startEdit(p: Person, e: Employment | undefined) {
    const roles = data!.roles.filter((r) => r.person_id === p.id);
    setDraft({
      personId: p.id,
      employmentId: e?.id ?? null,
      first_name: p.first_name,
      last_name: p.last_name,
      email: p.email ?? "",
      phone: p.phone ?? "",
      company_id: e?.company_id ?? hireableCompanies[0]?.id ?? "",
      locationIds: e?.employment_locations.map((x) => x.location_id) ?? [],
      role: roles.some((r) => r.role === "company_admin")
        ? "company_admin"
        : roles.some((r) => r.role === "clinic_manager")
          ? "clinic_manager"
          : (() => {
              const a = data!.customAssignments.find((x) => x.person_id === p.id);
              return a ? `custom:${a.custom_role_id}` : "employee";
            })(),
      jobRoleId: e?.job_role_id ?? "",
      payrollNumber: e?.payroll_number ?? "",
      desired: toHours(e?.desired_weekly_minutes ?? null),
      min: toHours(e?.min_weekly_minutes ?? null),
      max: toHours(e?.max_weekly_minutes ?? null),
    });
    setError("");
    setNotice("");
  }

  async function save(d: EmployeeDraft) {
    setError("");
    if (d.locationIds.length === 0) {
      setError(t.pickClinic);
      return;
    }
    try {
      let personId = d.personId;
      const personRow = { first_name: d.first_name.trim(), last_name: d.last_name.trim(), email: d.email.trim() || null, phone: d.phone.trim() || null };
      if (personId) must(await supabase.from("persons").update(personRow).eq("id", personId));
      else personId = (must(await supabase.from("persons").insert(personRow).select("id").single()) as { id: string }).id;

      const hoursRow = {
        desired_weekly_minutes: toMinutes(d.desired),
        min_weekly_minutes: toMinutes(d.min),
        max_weekly_minutes: toMinutes(d.max),
        job_role_id: d.jobRoleId || null,
        payroll_number: d.payrollNumber.trim() || null,
      };
      let employmentId = d.employmentId;
      if (employmentId) must(await supabase.from("employments").update(hoursRow).eq("id", employmentId));
      else employmentId = (must(await supabase.from("employments").insert({ person_id: personId, company_id: d.company_id, ...hoursRow }).select("id").single()) as { id: string }).id;

      const current = data!.employments.find((e) => e.id === employmentId)?.employment_locations.map((x) => x.location_id) ?? [];
      const toAdd = d.locationIds.filter((id) => !current.includes(id));
      const toRemove = current.filter((id) => !d.locationIds.includes(id) && managesLocation(id));
      if (toAdd.length) must(await supabase.from("employment_locations").insert(toAdd.map((location_id) => ({ employment_id: employmentId, location_id }))));
      for (const id of toRemove) must(await supabase.from("employment_locations").delete().eq("employment_id", employmentId).eq("location_id", id));

      // Roles: only owners, company admins and clinic managers change them
      if (isFullManager) await saveRoles(d, personId!);

      setDraft(null);
      await reload();
      setNotice(t.saved);
    } catch (e) {
      setError(friendly(e, t));
      await reload();
    }
  }

  async function saveRoles(d: EmployeeDraft, personId: string) {
    const companyClinics = data!.locations.filter((l) => l.company_id === d.company_id).map((l) => l.id);
    // Custom roles at this company's clinics
    const customId = d.role.startsWith("custom:") ? d.role.slice(7) : null;
    const existingCustom = data!.customAssignments.filter((a) => a.person_id === personId && companyClinics.includes(a.location_id));
    const wantedCustom = customId ? d.locationIds.filter((id) => fullyManages(id)) : [];
    for (const a of existingCustom) {
      const keep = a.custom_role_id === customId && wantedCustom.includes(a.location_id);
      if (!keep && fullyManages(a.location_id)) must(await supabase.from("custom_role_assignments").delete().eq("id", a.id));
    }
    const customToAdd = wantedCustom.filter((loc) => !existingCustom.some((a) => a.custom_role_id === customId && a.location_id === loc));
    if (customId && customToAdd.length) {
      must(await supabase.from("custom_role_assignments").insert(customToAdd.map((location_id) => ({ person_id: personId, custom_role_id: customId, location_id }))));
    }
    {
      const existing = data!.roles.filter((r) => r.person_id === personId && r.role !== "owner");
      const wanted =
        d.role === "company_admin"
          ? [{ role: "company_admin", company_id: d.company_id, location_id: null }]
          : d.role === "clinic_manager"
            ? d.locationIds.map((location_id) => ({ role: "clinic_manager", company_id: null, location_id }))
            : [];
      for (const r of existing) {
        const keep = wanted.some((w) => w.role === r.role && w.company_id === r.company_id && w.location_id === r.location_id);
        const mayChange = isOwner || (r.role === "clinic_manager" && managesCompany(d.company_id));
        if (!keep && mayChange) must(await supabase.from("role_assignments").delete().eq("id", r.id));
      }
      const toInsert = wanted.filter((w) => !existing.some((r) => r.role === w.role && r.company_id === w.company_id && r.location_id === w.location_id));
      if (toInsert.length) must(await supabase.from("role_assignments").insert(toInsert.map((w) => ({ ...w, person_id: personId }))));
    }
  }

  async function removePerson(p: Person) {
    setError("");
    try {
      must(await supabase.from("persons").delete().eq("id", p.id));
      await reload();
    } catch (e) {
      setError(friendly(e, t));
    }
  }

  if (hireableCompanies.length === 0 || data.locations.length === 0) {
    return <p className="card">{t.needCompanyFirst}</p>;
  }

  return (
    <div className="stack-lg">
      {(error || notice) && <p className={error ? "error" : "notice"}>{error || notice}</p>}
      {!draft && <ExpiringCredentials />}
      <div className="row spread">
        <h2>{t.nav.employees}</h2>
        {!draft && (
          <button type="button" className="primary" onClick={startNew}>
            {t.addEmployee}
          </button>
        )}
      </div>

      {draft && (
        <EmployeeForm
          t={t}
          draft={draft}
          setDraft={setDraft}
          companies={hireableCompanies}
          locations={data.locations}
          canEditClinic={managesLocation}
          canMakeAdmin={isOwner}
          canMakeManager={managesCompany(draft.company_id)}
          canChangeRole={isFullManager}
          customRoles={data.customRoles.filter((r) => r.company_id === draft.company_id)}
          jobRoles={data.jobRoles}
          lang={lang}
          onSave={() => save(draft)}
          onCancel={() => setDraft(null)}
        />
      )}

      <div className="table-wrap card">
        <table className="table">
          <thead>
            <tr>
              <th>{t.lastName}</th>
              <th>{t.email}</th>
              <th>{t.role}</th>
              <th>{t.position}</th>
              <th>{t.clinicsWorked}</th>
              <th>{t.hoursDesired}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.persons.map((p) => {
              const emps = data.employments.filter((e) => e.person_id === p.id);
              const clinicNames = emps.flatMap((e) => e.employment_locations.map((x) => data.locations.find((l) => l.id === x.location_id)?.name ?? "")).join(", ");
              const roles = roleOf(p);
              const editable = (p.id !== data.me.id || isOwner) && (isOwner || emps.some((e) => e.employment_locations.some((x) => managesLocation(x.location_id))) || emps.length === 0);
              return (
                <tr key={p.id}>
                  <td>
                    <strong>{personName(p)}</strong>
                    <span className={`pill ${p.user_id ? "ok" : "muted-pill"}`}>{p.user_id ? t.active : t.invited}</span>
                  </td>
                  <td className="small">
                    {p.email}
                    {p.phone && <div className="muted">{p.phone}</div>}
                  </td>
                  <td className="small">{roles.length ? roles.join(" · ") : t.roles.employee}</td>
                  <td className="small">{positionName(emps[0]?.job_role_id) || "—"}</td>
                  <td className="small">{clinicNames || "—"}</td>
                  <td className="small mono">{emps[0]?.desired_weekly_minutes != null ? `${emps[0].desired_weekly_minutes / 60} h` : "—"}</td>
                  <td className="actions">
                    {editable && emps.length <= 1 && (
                      <button type="button" className="link" onClick={() => startEdit(p, emps[0])}>
                        {t.edit}
                      </button>
                    )}
                    {isOwner && p.id !== data.me.id && (
                      <button type="button" className="link danger" onClick={() => removePerson(p)}>
                        {t.remove}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">{t.inviteHint}</p>
    </div>
  );
}

function EmployeeForm({
  t,
  draft: d,
  setDraft,
  companies,
  locations,
  canEditClinic,
  canMakeAdmin,
  canMakeManager,
  canChangeRole,
  customRoles,
  jobRoles,
  lang,
  onSave,
  onCancel,
}: {
  t: Strings;
  draft: EmployeeDraft;
  setDraft: (d: EmployeeDraft) => void;
  companies: Company[];
  locations: Location[];
  canEditClinic: (id: string) => boolean;
  canMakeAdmin: boolean;
  canMakeManager: boolean;
  canChangeRole: boolean;
  customRoles: CustomRole[];
  jobRoles: JobRole[];
  lang: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<EmployeeDraft>) => setDraft({ ...d, ...patch });
  const companyClinics = locations.filter((l) => l.company_id === d.company_id);
  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <h3>{d.personId ? `${t.edit} · ${d.first_name} ${d.last_name}` : t.addEmployee}</h3>
      <div className="grid2">
        <label className="field" htmlFor="e-first">
          <span>{t.firstName}</span>
          <input id="e-first" value={d.first_name} onChange={(e) => set({ first_name: e.target.value })} required maxLength={100} />
        </label>
        <label className="field" htmlFor="e-last">
          <span>{t.lastName}</span>
          <input id="e-last" value={d.last_name} onChange={(e) => set({ last_name: e.target.value })} required maxLength={100} />
        </label>
        <label className="field" htmlFor="e-email">
          <span>{t.email}</span>
          <input id="e-email" type="email" value={d.email} onChange={(e) => set({ email: e.target.value })} required />
        </label>
        <label className="field" htmlFor="e-phone">
          <span>{t.phone}</span>
          <input id="e-phone" type="tel" value={d.phone} onChange={(e) => set({ phone: e.target.value })} />
        </label>
        <label className="field" htmlFor="e-company">
          <span>{t.company}</span>
          <select id="e-company" value={d.company_id} disabled={!!d.employmentId} onChange={(e) => set({ company_id: e.target.value, locationIds: [] })}>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.legal_name}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="e-role">
          <span>{t.role}</span>
          <select id="e-role" value={d.role} disabled={!canChangeRole} onChange={(e) => set({ role: e.target.value })}>
            <option value="employee">{t.roles.employee}</option>
            {(canMakeManager || d.role === "clinic_manager") && <option value="clinic_manager">{t.roles.clinic_manager}</option>}
            {(canMakeAdmin || d.role === "company_admin") && <option value="company_admin">{t.roles.company_admin}</option>}
            {customRoles.map((r) => (
              <option key={r.id} value={`custom:${r.id}`}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="e-position">
          <span>{t.position}</span>
          <select id="e-position" value={d.jobRoleId} onChange={(e) => set({ jobRoleId: e.target.value })}>
            <option value="">{t.noPosition}</option>
            {jobRoles.map((j) => (
              <option key={j.id} value={j.id}>
                {lang === "fr" ? j.name_fr : j.name_en}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="checks-group">
        <legend>{t.clinicsWorked}</legend>
        {companyClinics.map((l) => (
          <label key={l.id} className="check" htmlFor={`e-loc-${l.id}`}>
            <input
              id={`e-loc-${l.id}`}
              type="checkbox"
              disabled={!canEditClinic(l.id)}
              checked={d.locationIds.includes(l.id)}
              onChange={(e) => set({ locationIds: e.target.checked ? [...d.locationIds, l.id] : d.locationIds.filter((x) => x !== l.id) })}
            />
            {l.name} ({l.province})
          </label>
        ))}
      </fieldset>
      <div className="grid3">
        <label className="field" htmlFor="e-payroll">
          <span>{t.payrollNumber}</span>
          <input id="e-payroll" value={d.payrollNumber} onChange={(e) => set({ payrollNumber: e.target.value })} maxLength={40} />
        </label>
        <label className="field" htmlFor="e-desired">
          <span>{t.hoursDesired}</span>
          <input id="e-desired" inputMode="decimal" value={d.desired} onChange={(e) => set({ desired: e.target.value })} />
        </label>
        <label className="field" htmlFor="e-min">
          <span>{t.hoursMin}</span>
          <input id="e-min" inputMode="decimal" value={d.min} onChange={(e) => set({ min: e.target.value })} />
        </label>
        <label className="field" htmlFor="e-max">
          <span>{t.hoursMax}</span>
          <input id="e-max" inputMode="decimal" value={d.max} onChange={(e) => set({ max: e.target.value })} />
        </label>
      </div>
      {!d.personId && <p className="muted small">{t.inviteHint}</p>}
      {d.personId && <CredentialsPanel personId={d.personId} />}
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
