/**
 * Excel workbook for payroll: one summary line per employee and employer, every work period in detail,
 * and what to check before paying. Built in the browser; loaded only when someone exports.
 */
import type { TimesheetRow } from "@clinic-workforce/timesheet";
import { toHours } from "@clinic-workforce/timesheet";
import type { Lang } from "./i18n";

export interface ExportRow {
  companyName: string;
  employeeName: string;
  payrollNumber: string;
  row: TimesheetRow;
  approved: "approved" | "changed" | "no";
  clinicName: (locationId: string) => string;
  timezoneOf: (locationId: string) => string;
}

export interface ExportInput {
  lang: Lang;
  periodStart: string;
  periodEnd: string; // exclusive
  rows: ExportRow[];
  pendingCorrections: number;
}

const L = {
  fr: {
    summary: "Résumé",
    detail: "Détail",
    check: "À vérifier",
    title: "Feuilles de temps",
    period: "Période",
    generated: "Généré le",
    company: "Société",
    employee: "Employé",
    payroll: "No de paie",
    regular: "Heures régulières",
    overtime: "Heures supplémentaires",
    vacation: "Vacances",
    sick: "Maladie",
    personal: "Personnel",
    otherPaid: "Autre congé payé",
    total: "Total payé (h)",
    approved: "Approuvé",
    problems: "Problèmes",
    date: "Date",
    clinic: "Clinique",
    in: "Entrée",
    out: "Sortie",
    break: "Pause (min)",
    hours: "Heures",
    notes: "Notes",
    problem: "Problème",
    totals: "Total",
    yes: "Oui",
    no: "Non",
    changed: "Modifié depuis l'approbation",
    what: "À vérifier",
    nothing: "Rien à vérifier.",
    issue: {
      missing_out: "Sortie manquante",
      missing_in: "Entrée manquante",
      too_long: "Plus de 16 h",
      in_progress: "En cours",
    } as Record<string, string>,
    note: {
      manual: "Ajouté à la main",
      correction: "Correction approuvée",
      corrected: "Heure corrigée",
      added_by_manager: "Ajouté par un gestionnaire",
      no_shift: "Sans quart prévu",
      outside_geofence_wifi_ok: "Hors zone, Wi-Fi de la clinique",
    } as Record<string, string>,
    notApproved: "Feuille non approuvée",
    corrections: (n: number) => `${n} demande(s) de correction de pointage en attente`,
    hoursNote: "Heures en décimales (7,50 = 7 h 30). Pause non payée déduite selon l'horaire.",
  },
  en: {
    summary: "Summary",
    detail: "Detail",
    check: "To check",
    title: "Timesheets",
    period: "Period",
    generated: "Generated on",
    company: "Company",
    employee: "Employee",
    payroll: "Payroll #",
    regular: "Regular hours",
    overtime: "Overtime hours",
    vacation: "Vacation",
    sick: "Sick",
    personal: "Personal",
    otherPaid: "Other paid leave",
    total: "Total paid (h)",
    approved: "Approved",
    problems: "Problems",
    date: "Date",
    clinic: "Clinic",
    in: "In",
    out: "Out",
    break: "Break (min)",
    hours: "Hours",
    notes: "Notes",
    problem: "Problem",
    totals: "Total",
    yes: "Yes",
    no: "No",
    changed: "Changed since approval",
    what: "To check",
    nothing: "Nothing to check.",
    issue: {
      missing_out: "Missing out",
      missing_in: "Missing in",
      too_long: "Over 16 h",
      in_progress: "In progress",
    } as Record<string, string>,
    note: {
      manual: "Added by hand",
      correction: "Approved correction",
      corrected: "Time corrected",
      added_by_manager: "Added by a manager",
      no_shift: "No scheduled shift",
      outside_geofence_wifi_ok: "Outside zone, clinic Wi-Fi",
    } as Record<string, string>,
    notApproved: "Timesheet not approved",
    corrections: (n: number) => `${n} punch correction request(s) pending`,
    hoursNote: "Hours in decimals (7.50 = 7 h 30). Unpaid break deducted from the schedule.",
  },
};

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B6E7F" } } as const;
const TOTAL_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE3F1F3" } } as const;
const WARN_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3D6" } } as const;

export async function exportTimesheetWorkbook(input: ExportInput): Promise<Blob> {
  const mod = (await import("exceljs")) as unknown as { default?: typeof import("exceljs") } & typeof import("exceljs");
  const ExcelJS = mod.default ?? mod;
  const t = L[input.lang];
  const wb = new ExcelJS.Workbook();
  wb.creator = "Clinic Workforce";
  wb.created = new Date();
  const lastDay = new Date(Date.parse(`${input.periodEnd}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const periodText = `${input.periodStart} → ${lastDay}`;
  const sorted = [...input.rows].sort((a, b) => a.companyName.localeCompare(b.companyName) || a.employeeName.localeCompare(b.employeeName));

  type Sheet = ReturnType<typeof wb.addWorksheet>;
  const header = (ws: Sheet, rowNumber: number) => {
    const r = ws.getRow(rowNumber);
    r.font = { bold: true, color: { argb: "FFFFFFFF" } };
    r.alignment = { vertical: "middle", wrapText: true };
    r.height = 44;
    r.eachCell((c) => (c.fill = HEADER_FILL));
  };
  const titleRows = (ws: Sheet, cols: number) => {
    ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
    ws.pageSetup.printTitlesRow = "4:4";
    ws.mergeCells(1, 1, 1, cols);
    ws.getCell(1, 1).value = `${t.title} — ${periodText}`;
    ws.getCell(1, 1).font = { bold: true, size: 14 };
    ws.mergeCells(2, 1, 2, cols);
    ws.getCell(2, 1).value = `${t.generated} ${new Date().toLocaleString(input.lang === "fr" ? "fr-CA" : "en-CA")} · ${t.hoursNote}`;
    ws.getCell(2, 1).font = { italic: true, color: { argb: "FF5A6A77" } };
  };

  // ---- Summary
  const sum = wb.addWorksheet(t.summary, { views: [{ state: "frozen", ySplit: 4 }] });
  const sumCols = [
    { key: "company", header: t.company, width: 28 },
    { key: "employee", header: t.employee, width: 26 },
    { key: "payroll", header: t.payroll, width: 12 },
    { key: "regular", header: t.regular, width: 12 },
    { key: "overtime", header: t.overtime, width: 15 },
    { key: "vacation", header: t.vacation, width: 11 },
    { key: "sick", header: t.sick, width: 10 },
    { key: "personal", header: t.personal, width: 11 },
    { key: "otherPaid", header: t.otherPaid, width: 12 },
    { key: "total", header: t.total, width: 12 },
    { key: "approved", header: t.approved, width: 16 },
    { key: "problems", header: t.problems, width: 30 },
  ];
  titleRows(sum, sumCols.length);
  sum.columns = sumCols.map((c) => ({ key: c.key, width: c.width }));
  sum.getRow(4).values = sumCols.map((c) => c.header);
  header(sum, 4);
  let r = 5;
  const firstData = r;
  for (const x of sorted) {
    const off = x.row.timeOffMinutes;
    const other = Object.entries(off)
      .filter(([k]) => !["vacation", "sick", "personal"].includes(k))
      .reduce((a, [, v]) => a + v, 0);
    const problems = [...new Set(x.row.issues)].map((i) => `${t.issue[i]} ×${x.row.issues.filter((y) => y === i).length}`).join(", ");
    const row = sum.getRow(r);
    row.values = {
      company: x.companyName,
      employee: x.employeeName,
      payroll: x.payrollNumber,
      regular: toHours(x.row.regularMinutes),
      overtime: toHours(x.row.overtimeMinutes),
      vacation: toHours(off.vacation ?? 0),
      sick: toHours(off.sick ?? 0),
      personal: toHours(off.personal ?? 0),
      otherPaid: toHours(other),
      approved: x.approved === "approved" ? t.yes : x.approved === "changed" ? t.changed : t.no,
      problems,
    };
    row.getCell("total").value = { formula: `SUM(D${r}:I${r})` };
    if (problems || x.approved !== "approved") row.eachCell((c) => (c.fill = WARN_FILL));
    r++;
  }
  const lastData = r - 1;
  const tot = sum.getRow(r);
  tot.getCell("employee").value = t.totals;
  for (const col of ["D", "E", "F", "G", "H", "I", "J"]) {
    sum.getCell(`${col}${r}`).value = lastData >= firstData ? { formula: `SUM(${col}${firstData}:${col}${lastData})` } : 0;
  }
  tot.font = { bold: true };
  tot.eachCell((c) => (c.fill = TOTAL_FILL));
  for (let i = firstData; i <= r; i++) for (const col of ["D", "E", "F", "G", "H", "I", "J"]) sum.getCell(`${col}${i}`).numFmt = "0.00";
  sum.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, lastData), column: sumCols.length } };

  // ---- Detail
  const det = wb.addWorksheet(t.detail, { views: [{ state: "frozen", ySplit: 4 }] });
  const detCols = [
    { key: "company", header: t.company, width: 26 },
    { key: "employee", header: t.employee, width: 24 },
    { key: "payroll", header: t.payroll, width: 11 },
    { key: "date", header: t.date, width: 12 },
    { key: "clinic", header: t.clinic, width: 16 },
    { key: "in", header: t.in, width: 8 },
    { key: "out", header: t.out, width: 8 },
    { key: "break", header: t.break, width: 10 },
    { key: "hours", header: t.hours, width: 9 },
    { key: "notes", header: t.notes, width: 30 },
    { key: "problem", header: t.problem, width: 18 },
  ];
  titleRows(det, detCols.length);
  det.columns = detCols.map((c) => ({ key: c.key, width: c.width }));
  det.getRow(4).values = detCols.map((c) => c.header);
  header(det, 4);
  r = 5;
  const time = (d: Date | null, tz: string) =>
    d ? new Intl.DateTimeFormat("en-CA", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(d) : "";
  for (const x of sorted) {
    for (const e of x.row.entries) {
      const tz = x.timezoneOf(e.locationId);
      const row = det.getRow(r);
      row.values = {
        company: x.companyName,
        employee: x.employeeName,
        payroll: x.payrollNumber,
        date: e.date,
        clinic: x.clinicName(e.locationId),
        in: time(e.inAt, tz),
        out: time(e.outAt, tz),
        break: e.breakMinutes || "",
        hours: toHours(e.paidMinutes),
        notes: e.notes.map((n) => t.note[n] ?? n).join(", "),
        problem: e.issue ? t.issue[e.issue] : "",
      };
      row.getCell("hours").numFmt = "0.00";
      if (e.issue && e.issue !== "in_progress") row.eachCell((c) => (c.fill = WARN_FILL));
      r++;
    }
  }
  det.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, r - 1), column: detCols.length } };

  // ---- To check
  const chk = wb.addWorksheet(t.check);
  chk.columns = [{ width: 28 }, { width: 26 }, { width: 50 }];
  chk.getCell("A1").value = t.what;
  chk.getCell("A1").font = { bold: true, size: 14 };
  r = 3;
  if (input.pendingCorrections > 0) {
    chk.getCell(`A${r}`).value = t.corrections(input.pendingCorrections);
    r++;
  }
  for (const x of sorted) {
    const lines: string[] = [];
    if (x.approved === "no") lines.push(t.notApproved);
    if (x.approved === "changed") lines.push(t.changed);
    for (const e of x.row.entries.filter((y) => y.issue && y.issue !== "in_progress")) lines.push(`${e.date} · ${x.clinicName(e.locationId)} · ${t.issue[e.issue!]}`);
    for (const line of lines) {
      chk.getRow(r).values = [x.companyName, x.employeeName, line];
      r++;
    }
  }
  if (r === 3) chk.getCell("A3").value = t.nothing;

  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
