import { useState } from "react";
import { useSession } from "../session";
import { type CustomRole, type JobRole, must, type Permission, PERMISSIONS, supabase } from "../supabase";

export function Roles() {
  const { t, lang, data, reload, managesCompany, isFullManager } = useSession();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pos, setPos] = useState({ fr: "", en: "" });
  const [editingPos, setEditingPos] = useState<{ id: string; fr: string; en: string } | null>(null);
  const adminCompanies = (data?.companies ?? []).filter((c) => managesCompany(c.id));
  const [newRole, setNewRole] = useState<{ company_id: string; name: string; permissions: Permission[] }>({
    company_id: adminCompanies[0]?.id ?? "",
    name: "",
    permissions: ["schedule"],
  });
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

  const togglePerm = (list: Permission[], p: Permission, on: boolean) => (on ? [...list, p] : list.filter((x) => x !== p));
  const companyName = (id: string) => data.companies.find((c) => c.id === id)?.legal_name ?? "";
  const holders = (roleId: string) => new Set(data.customAssignments.filter((a) => a.custom_role_id === roleId).map((a) => a.person_id)).size;

  return (
    <div className="stack-lg">
      {(error || notice) && <p className={error ? "error" : "notice"}>{error || notice}</p>}

      <section className="card stack">
        <h2>{t.positionsTitle}</h2>
        <p className="muted">{t.positionsHint}</p>
        {data.jobRoles.length === 0 ? (
          <p className="muted">{t.none}</p>
        ) : (
          <ul className="plain">
            {data.jobRoles.map((j: JobRole) =>
              editingPos?.id === j.id ? (
                <li key={j.id}>
                  <form
                    className="row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      run(async () => {
                        must(await supabase.from("job_roles").update({ name_fr: editingPos.fr.trim(), name_en: editingPos.en.trim() || editingPos.fr.trim() }).eq("id", j.id));
                        setEditingPos(null);
                      });
                    }}
                  >
                    <input aria-label={t.positionFr} value={editingPos.fr} onChange={(e) => setEditingPos({ ...editingPos, fr: e.target.value })} required maxLength={80} />
                    <input aria-label={t.positionEn} value={editingPos.en} onChange={(e) => setEditingPos({ ...editingPos, en: e.target.value })} maxLength={80} />
                    <button type="submit" className="primary">
                      {t.save}
                    </button>
                    <button type="button" onClick={() => setEditingPos(null)}>
                      {t.cancel}
                    </button>
                  </form>
                </li>
              ) : (
                <li key={j.id} className="row spread">
                  <span>
                    <strong>{lang === "fr" ? j.name_fr : j.name_en}</strong>
                    <span className="muted small"> · {lang === "fr" ? j.name_en : j.name_fr}</span>
                  </span>
                  {isFullManager && (
                    <span className="row">
                      <button type="button" className="link" onClick={() => setEditingPos({ id: j.id, fr: j.name_fr, en: j.name_en })}>
                        {t.edit}
                      </button>
                      <button
                        type="button"
                        className="link danger"
                        onClick={() => {
                          if (window.confirm(t.confirmDeletePosition)) run(async () => { must(await supabase.from("job_roles").delete().eq("id", j.id)); });
                        }}
                      >
                        {t.remove}
                      </button>
                    </span>
                  )}
                </li>
              ),
            )}
          </ul>
        )}
        {isFullManager && (
          <form
            className="row wrap"
            onSubmit={(e) => {
              e.preventDefault();
              if (!pos.fr.trim()) return;
              run(async () => {
                must(await supabase.from("job_roles").insert({ name_fr: pos.fr.trim(), name_en: pos.en.trim() || pos.fr.trim() }));
                setPos({ fr: "", en: "" });
              });
            }}
          >
            <label className="field grow" htmlFor="pos-fr">
              <span>{t.positionFr}</span>
              <input id="pos-fr" value={pos.fr} onChange={(e) => setPos({ ...pos, fr: e.target.value })} placeholder="Réceptionniste" maxLength={80} />
            </label>
            <label className="field grow" htmlFor="pos-en">
              <span>{t.positionEn}</span>
              <input id="pos-en" value={pos.en} onChange={(e) => setPos({ ...pos, en: e.target.value })} placeholder="Receptionist" maxLength={80} />
            </label>
            <button type="submit">{t.addPosition}</button>
          </form>
        )}
      </section>

      <section className="card stack">
        <h2>{t.customRolesTitle}</h2>
        <p className="muted">{t.customRolesHint}</p>
        {adminCompanies.length === 0 && <p className="muted small">{t.customRolesAdminOnly}</p>}
        {data.customRoles.length === 0 ? (
          <p className="muted">{t.none}</p>
        ) : (
          data.customRoles.map((r: CustomRole) => {
            const editable = managesCompany(r.company_id);
            return (
              <article key={r.id} className="subcard stack">
                <div className="row spread">
                  <div>
                    <strong>{r.name}</strong>
                    <span className="muted small">
                      {" "}
                      · {companyName(r.company_id)} · {t.holders(holders(r.id))}
                    </span>
                  </div>
                  {editable && (
                    <button
                      type="button"
                      className="link danger"
                      onClick={() => {
                        if (window.confirm(t.confirmDeleteRole)) run(async () => { must(await supabase.from("custom_roles").delete().eq("id", r.id)); });
                      }}
                    >
                      {t.remove}
                    </button>
                  )}
                </div>
                <fieldset className="checks-group">
                  <legend className="sr-only">{t.permissionsLabel}</legend>
                  {PERMISSIONS.map((p) => (
                    <label key={p} className="check" htmlFor={`perm-${r.id}-${p}`}>
                      <input
                        id={`perm-${r.id}-${p}`}
                        type="checkbox"
                        disabled={!editable}
                        checked={r.permissions.includes(p)}
                        onChange={(e) =>
                          run(async () => {
                            must(await supabase.from("custom_roles").update({ permissions: togglePerm(r.permissions, p, e.target.checked) }).eq("id", r.id));
                          })
                        }
                      />
                      {t.perms[p]}
                    </label>
                  ))}
                </fieldset>
              </article>
            );
          })
        )}

        {adminCompanies.length > 0 && (
          <form
            className="subcard stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newRole.name.trim() || !newRole.company_id) return;
              run(async () => {
                must(await supabase.from("custom_roles").insert({ company_id: newRole.company_id, name: newRole.name.trim(), permissions: newRole.permissions }));
                setNewRole({ ...newRole, name: "" });
              });
            }}
          >
            <div className="grid2">
              <label className="field" htmlFor="role-name">
                <span>{t.roleName}</span>
                <input id="role-name" value={newRole.name} onChange={(e) => setNewRole({ ...newRole, name: e.target.value })} placeholder="Coordonnatrice" maxLength={80} />
              </label>
              <label className="field" htmlFor="role-company">
                <span>{t.company}</span>
                <select id="role-company" value={newRole.company_id} onChange={(e) => setNewRole({ ...newRole, company_id: e.target.value })}>
                  {adminCompanies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.legal_name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <fieldset className="checks-group">
              <legend>{t.permissionsLabel}</legend>
              {PERMISSIONS.map((p) => (
                <label key={p} className="check" htmlFor={`new-perm-${p}`}>
                  <input
                    id={`new-perm-${p}`}
                    type="checkbox"
                    checked={newRole.permissions.includes(p)}
                    onChange={(e) => setNewRole({ ...newRole, permissions: togglePerm(newRole.permissions, p, e.target.checked) })}
                  />
                  {t.perms[p]}
                </label>
              ))}
            </fieldset>
            <div>
              <button type="submit" className="primary">
                {t.addRole}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
