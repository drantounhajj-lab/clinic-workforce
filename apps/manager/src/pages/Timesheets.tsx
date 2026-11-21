import { addDays, zonedToUtc } from "@clinic-workforce/rules";
import { buildTimesheets, recentPayPeriods, type TimesheetRow, toHours } from "@clinic-workforce/timesheet";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { downloadBlob, exportTimesheetWorkbook } from "../excel";
import { formatDate, friendly } from "../i18n";
import { personName, useSession } from "../session";
import { must, type Punch, type Shift, supabase, type TimeOffRequest, type TimesheetApproval } from "../supabase";

const ALL = "__all__";

export function Timesheets() {
  const { t, lang, data, locationsWith } = useSession();
  const payrollLocations = locationsWith("punches");
  const companies = (data?.companies ?? []).filter((c) => payrollLocations.some((l) => l.company_id === c.id));
  const [companyId, setCompanyId] = useState<string>(companies[0]?.id ?? ALL);
  const ref = companies.find((c) => c.id === companyId) ?? companies[0];
  const periods = useMemo(
    () => (ref ? recentPayPeriods(ref.pay_period_anchor, ref.pay_frequency, new Date().toISOString().slice(0, 10), 10) : []),
    [ref],
  );
  const [periodStart, setPeriodStart] = useState<string>("");
  const period = periods.find((p) => p.start === periodStart) ?? periods[1] ?? periods[0];
  const [punches, setPunches] = useState<Punch[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [timeOff, setTimeOff] = useState<TimeOffRequest[]>([]);
  const [approvals, setApprovals] = useState<TimesheetApproval[]>([]);
  const [pendingCorrections, setPendingCorrections] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<{ personId: string; locationId: string; kind: "in" | "out"; date: string; time: string; note: string } | null>(null);

  const scopeCompanies = companyId === ALL ? companies : companies.filter((c) => c.id === companyId);
  const scopeLocations = payrollLocations.filter((l) => scopeCompanies.some((c) => c.id === l.company_id));
  const tz = scopeLocations[0]?.timezone ?? "America/Toronto";

  const load = useCallback(async () => {
    if (!period || scopeLocations.length === 0) return;
    setError("");
    try {
      const locIds = scopeLocations.map((l) => l.id);
      const from = zonedToUtc(addDays(period.start, -1), "00:00", tz).toISOString();
      const to = zonedToUtc(addDays(period.end, 1), "00:00", tz).toISOString();
      const [p, s, a, c] = await Promise.all([
        supabase.from("punches").select("*").in("location_id", locIds).gte("occurred_at", from).lt("occurred_at", to).order("occurred_at").limit(10000),
        supabase.from("shifts").select("*").in("location_id", locIds).gte("starts_at", from).lt("starts_at", to).limit(10000),
        supabase.from("timesheet_approvals").select("*").eq("period_start", period.start).in("company_id", scopeCompanies.map((x) => x.id)),
        supabase.from("punch_corrections").select("id", { count: "exact", head: true }).in("location_id", locIds).eq("status", "pending"),
      ]);
      const pun = must(p) as Punch[];
      setPunches(pun);
      setShifts(must(s) as Shift[]);
      setApprovals(must(a) as TimesheetApproval[]);
      setPendingCorrections(c.count ?? 0);
      const people = [...new Set([...pun.map((x) => x.person_id), ...(data?.employments ?? []).filter((e) => scopeCompanies.some((co) => co.id === e.company_id)).map((e) => e.person_id)])];
      if (people.length) {
        const off = await supabase
          .from("time_off_requests")
          .select("*")
          .in("person_id", people)
          .eq("status", "approved")
          .lte("start_date", addDays(period.end, -1))
          .gte("end_date", period.start);
        setTimeOff(must(off) as TimeOffRequest[]);
      } else setTimeOff([]);
    } catch (e) {
      setError(friendly(e, t));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period?.start, companyId, data]);

  useEffect(() => {
    load();
  }, [load]);

  const rows: TimesheetRow[] = useMemo(() => {
    if (!data || !period) return [];
    return buildTimesheets({
      period,
      timezone: tz,
      locations: data.locations.map((l) => ({ id: l.id, companyId: l.company_id, province: l.province, timezone: l.timezone })),
      employments: data.employments.map((e) => ({ id: e.id, personId: e.person_id, companyId: e.company_id })),
      punches: punches.map((p) => ({
        id: p.id,
        personId: p.person_id,
        employmentId: p.employment_id,
        locationId: p.location_id,
        kind: p.kind,
        occurredAt: new Date(p.occurred_at),
        method: p.method,
        flags: p.flags,
      })),
      shifts: shifts.map((s) => ({
        id: s.id,
        employmentId: s.employment_id,
        locationId: s.location_id,
        startsAt: new Date(s.starts_at),
        endsAt: new Date(s.ends_at),
        unpaidBreakMinutes: s.unpaid_break_minutes,
      })),
      timeOff: timeOff.map((o) => ({ personId: o.person_id, type: o.type, startDate: o.start_date, endDate: o.end_date, paidHours: o.paid_hours })),
      now: new Date(),
    }).filter((r) => scopeCompanies.some((c) => c.id === r.companyId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, period?.start, punches, shifts, timeOff, companyId]);

  if (!data) return null;
  if (companies.length === 0 || !period) return <p className="card">{t.noClinics}</p>;

  const companyName = (id: string) => data.companies.find((c) => c.id === id)?.legal_name ?? "";
  const payrollNumber = (r: TimesheetRow) => data.employments.find((e) => e.person_id === r.personId && e.company_id === r.companyId)?.payroll_number ?? "";
  const approvalOf = (r: TimesheetRow) => approvals.find((a) => a.person_id === r.personId && a.company_id === r.companyId);
  const approvalState = (r: TimesheetRow): "approved" | "changed" | "no" => {
    const a = approvalOf(r);
    if (!a) return "no";
    return a.regular_minutes === r.regularMinutes && a.overtime_minutes === r.overtimeMinutes ? "approved" : "changed";
  };
  const clinicName = (id: string) => data.locations.find((l) => l.id === id)?.name ?? "";
  const timezoneOf = (id: string) => data.locations.find((l) => l.id === id)?.timezone ?? tz;
  const timeOffHours = (r: TimesheetRow) => toHours(Object.values(r.timeOffMinutes).reduce((a, b) => a + b, 0));
  const time = (d: Date | null, locId: string) =>
    d ? new Intl.DateTimeFormat("en-CA", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezoneOf(locId) }).format(d) : "—";
  const lastDay = addDays(period.end, -1);
  const label = (p: { start: string; end: string }) =>
    `${formatDate(p.start, lang, { month: "short", day: "numeric" })} – ${formatDate(addDays(p.end, -1), lang, { month: "short", day: "numeric", year: "numeric" })}`;

  async function approve(r: TimesheetRow, on: boolean) {
    setError("");
    try {
      const existing = approvalOf(r);
      if (existing) must(await supabase.from("timesheet_approvals").delete().eq("id", existing.id));
      if (on) {
        must(
          await supabase.from("timesheet_approvals").insert({
            company_id: r.companyId,
            person_id: r.personId,
            period_start: period!.start,
            period_end: period!.end,
            regular_minutes: r.regularMinutes,
            overtime_minutes: r.overtimeMinutes,
            approved_by: data!.me.id,
          }),
        );
      }
      await load();
    } catch (e) {
      setError(friendly(e, t));
    }
  }

  async function approveAll() {
    for (const r of rows.filter((x) => approvalState(x) !== "approved" && x.issues.length === 0)) await approve(r, true);
    setNotice(t.saved);
  }

  async function exportExcel() {
    const unapproved = rows.filter((r) => approvalState(r) !== "approved").length;
    const problems = rows.filter((r) => r.issues.length > 0).length;
    if ((unapproved || problems || pendingCorrections) && !window.confirm(t.exportWarning(unapproved, problems, pendingCorrections))) return;
    setBusy(true);
    try {
      const blob = await exportTimesheetWorkbook({
        lang,
        periodStart: period!.start,
        periodEnd: period!.end,
        pendingCorrections,
        rows: rows.map((r) => ({
          companyName: companyName(r.companyId),
          employeeName: personName(data!.persons.find((p) => p.id === r.personId)),
          payrollNumber: payrollNumber(r),
          row: r,
          approved: approvalState(r),
          clinicName,
          timezoneOf,
        })),
      });
      const scope = companyId === ALL ? "toutes" : companyName(companyId).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
      downloadBlob(blob, `${t.timesheetFile}-${scope}-${period!.start}_${lastDay}.xlsx`);
    } catch (e) {
      setError(friendly(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function addPunch() {
    if (!adding) return;
    const { data: res, error: err } = await supabase.rpc("manager_add_punch", {
      p_person_id: adding.personId,
      p_location_id: adding.locationId,
      p_kind: adding.kind,
      p_occurred_at: zonedToUtc(adding.date, adding.time, timezoneOf(adding.locationId)).toISOString(),
      p_note: adding.note,
    });
    if (err) setError(friendly(err, t));
    else if (!res?.ok) setError(t.punchErrors[res?.reason] ?? String(res?.reason));
    else {
      setAdding(null);
      await load();
    }
  }

  const totals = rows.reduce(
    (a, r) => ({ regular: a.regular + r.regularMinutes, overtime: a.overtime + r.overtimeMinutes }),
    { regular: 0, overtime: 0 },
  );
  const sorted = [...rows].sort((a, b) => companyName(a.companyId).localeCompare(companyName(b.companyId)) || personName(data.persons.find((p) => p.id === a.personId)).localeCompare(personName(data.persons.find((p) => p.id === b.personId))));

  return (
    <div className="stack-lg">
      <section className="controls card">
        <label className="field" htmlFor="ts-company">
          <span>{t.company}</span>
          <select id="ts-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.legal_name}
              </option>
            ))}
            {companies.length > 1 && <option value={ALL}>{t.allCompanies}</option>}
          </select>
        </label>
        <label className="field" htmlFor="ts-period">
          <span>{t.payPeriod}</span>
          <select id="ts-period" value={period.start} onChange={(e) => setPeriodStart(e.target.value)}>
            {periods.map((p, i) => (
              <option key={p.start} value={p.start}>
                {label(p)}
                {i === 0 ? ` (${t.current})` : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <button type="button" onClick={approveAll}>
            {t.approveAllClean}
          </button>
          <button type="button" className="primary" onClick={exportExcel} disabled={busy}>
            {busy ? t.loading : t.exportExcel}
          </button>
        </div>
      </section>

      {(error || notice) && <p className={error ? "error" : "notice"}>{error || notice}</p>}
      {pendingCorrections > 0 && (
        <p className="notice">
          {t.pendingCorrectionsBanner(pendingCorrections)} <a href="#requests">{t.nav.requests}</a>
        </p>
      )}

      <section className="card table-wrap">
        <table className="table">
          <thead>
            <tr>
              {companyId === ALL && <th>{t.company}</th>}
              <th>{t.employee}</th>
              <th>{t.payrollNumber}</th>
              <th className="num">{t.regularHours}</th>
              <th className="num">{t.overtimeHours}</th>
              <th className="num">{t.timeOffHours}</th>
              <th>{t.problems}</th>
              <th>{t.approval}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  {t.noPunchesPeriod}
                </td>
              </tr>
            )}
            {sorted.map((r) => {
              const key = `${r.personId}|${r.companyId}`;
              const state = approvalState(r);
              return (
                <Fragment key={key}>
                  <tr className={r.issues.length ? "warn-row" : ""}>
                    {companyId === ALL && <td className="small">{companyName(r.companyId)}</td>}
                    <td>
                      <button type="button" className="link" onClick={() => setOpen(open === key ? null : key)} aria-expanded={open === key}>
                        {personName(data.persons.find((p) => p.id === r.personId))}
                      </button>
                    </td>
                    <td className="small">{payrollNumber(r) || <span className="warn-text">{t.missingPayroll}</span>}</td>
                    <td className="num mono">{toHours(r.regularMinutes).toFixed(2)}</td>
                    <td className="num mono">{toHours(r.overtimeMinutes).toFixed(2)}</td>
                    <td className="num mono">{timeOffHours(r).toFixed(2)}</td>
                    <td className="small">
                      {r.issues.length === 0 ? <span className="ok-text">—</span> : <span className="warn-text">{t.issueCount(r.issues.length)}</span>}
                    </td>
                    <td>
                      {state === "approved" ? (
                        <button type="button" className="pill ok" onClick={() => approve(r, false)} title={t.withdrawApproval}>
                          {t.approvedLabel}
                        </button>
                      ) : (
                        <button type="button" onClick={() => approve(r, true)}>
                          {state === "changed" ? t.reapprove : t.approve}
                        </button>
                      )}
                    </td>
                  </tr>
                  {open === key && (
                    <tr>
                      <td colSpan={8}>
                        <table className="table inner">
                          <thead>
                            <tr>
                              <th>{t.day}</th>
                              <th>{t.clinic}</th>
                              <th>{t.in}</th>
                              <th>{t.out}</th>
                              <th className="num">{t.breakMin}</th>
                              <th className="num">{t.hoursLabel}</th>
                              <th>{t.notesLabel}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.entries.map((e, i) => (
                              <tr key={i} className={e.issue && e.issue !== "in_progress" ? "warn-row" : ""}>
                                <td>{formatDate(e.date, lang, { weekday: "short", day: "numeric", month: "short" })}</td>
                                <td>{clinicName(e.locationId)}</td>
                                <td className="mono">{time(e.inAt, e.locationId)}</td>
                                <td className="mono">{time(e.outAt, e.locationId)}</td>
                                <td className="num mono">{e.breakMinutes || ""}</td>
                                <td className="num mono">{toHours(e.paidMinutes).toFixed(2)}</td>
                                <td className="small">
                                  {e.issue && <strong className="warn-text">{t.entryIssues[e.issue]} </strong>}
                                  {e.notes.map((n) => t.entryNotes[n] ?? n).join(", ")}
                                  {(e.issue === "missing_out" || e.issue === "missing_in") && (
                                    <button
                                      type="button"
                                      className="link"
                                      onClick={() =>
                                        setAdding({
                                          personId: r.personId,
                                          locationId: e.locationId,
                                          kind: e.issue === "missing_out" ? "out" : "in",
                                          date: e.date,
                                          time: e.issue === "missing_out" ? "17:00" : "09:00",
                                          note: "",
                                        })
                                      }
                                    >
                                      {" "}
                                      {e.issue === "missing_out" ? t.addOut : t.addIn}
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {r.weeks.length > 1 && (
                          <p className="muted small">
                            {r.weeks.map((w) => `${t.weekOfShort(formatDate(w.start, lang, { day: "numeric", month: "short" }))} : ${toHours(w.paidMinutes).toFixed(2)} h`).join(" · ")}
                          </p>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          {sorted.length > 0 && (
            <tfoot>
              <tr>
                {companyId === ALL && <td />}
                <td>
                  <strong>{t.total}</strong>
                </td>
                <td />
                <td className="num mono">
                  <strong>{toHours(totals.regular).toFixed(2)}</strong>
                </td>
                <td className="num mono">
                  <strong>{toHours(totals.overtime).toFixed(2)}</strong>
                </td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          )}
        </table>
        <p className="muted small pad">{t.timesheetHint}</p>
      </section>

      {adding && (
        <div className="overlay" onClick={() => setAdding(null)}>
          <form
            className="dialog"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              addPunch();
            }}
          >
            <h2>{adding.kind === "out" ? t.addOut : t.addIn}</h2>
            <p className="muted">
              {personName(data.persons.find((p) => p.id === adding.personId))} · {clinicName(adding.locationId)}
            </p>
            <div className="grid2">
              <label className="field" htmlFor="ap-date">
                <span>{t.day}</span>
                <input id="ap-date" type="date" value={adding.date} onChange={(e) => setAdding({ ...adding, date: e.target.value })} required />
              </label>
              <label className="field" htmlFor="ap-time">
                <span>{t.timeLabel}</span>
                <input id="ap-time" type="time" value={adding.time} onChange={(e) => setAdding({ ...adding, time: e.target.value })} required />
              </label>
            </div>
            <label className="field" htmlFor="ap-note">
              <span>{t.reason}</span>
              <input id="ap-note" value={adding.note} onChange={(e) => setAdding({ ...adding, note: e.target.value })} required minLength={3} maxLength={500} />
            </label>
            <div className="row">
              <span className="spacer" />
              <button type="button" onClick={() => setAdding(null)}>
                {t.cancel}
              </button>
              <button type="submit" className="primary">
                {t.save}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
