import type { Issue } from "@clinic-workforce/rules";
import type { RoleKey } from "@clinic-workforce/sample-data";

export type Lang = "fr" | "en";

export const strings = {
  en: {
    appName: "Schedules",
    demoBadge: "Demo · sample data",
    clinic: "Clinic",
    allClinics: "All clinics (head office)",
    previousWeek: "Previous week",
    nextWeek: "Next week",
    thisWeek: "Back to next week",
    copyPrevious: "Copy previous week",
    publish: "Publish week",
    published: "Published",
    draft: "Draft",
    reset: "Reset demo",
    combine: "Count hours across related companies",
    shifts: "Shifts",
    scheduled: "Hours scheduled",
    errors: "Errors",
    warnings: "Warnings",
    errorLabel: "Error",
    warningLabel: "Warning",
    checksTitle: "Rule checks",
    checksHint: "Updated live as you edit. Errors block publishing; warnings don't.",
    noIssues: "No issues. This week can be published.",
    openShifts: "Open shifts",
    openShift: "Open shift",
    addShift: "Add shift",
    editShift: "Edit shift",
    employee: "Employee",
    day: "Day",
    start: "Start",
    end: "End",
    breakMin: "Unpaid break (minutes)",
    save: "Save",
    remove: "Delete shift",
    cancel: "Cancel",
    close: "Close",
    endAfterStart: "End time must be after start time.",
    previewTitle: "Checks for this shift",
    previewOk: "No issues for this shift.",
    unavailable: "Unavailable",
    availableUntil: (t: string) => `Avail. until ${t}`,
    availableRange: (a: string, b: string) => `Avail. ${a}–${b}`,
    dayOff: "Day off",
    of: "of",
    otherCompanies: (hrs: string) => `+ ${hrs} h at other companies`,
    publishBlocked: (n: number) => `Fix ${n} error${n > 1 ? "s" : ""} before publishing.`,
    publishedToast: "Published. In the real app, staff get a notification.",
    copiedToast: (n: number, skipped: number) =>
      `${n} shift${n === 1 ? "" : "s"} copied${skipped ? `, ${skipped} already there` : ""}.`,
    nothingToCopy: "Nothing to copy from the previous week.",
    footer: "Demo with sample data. Your changes stay in this browser only.",
    companyLabel: "Company",
    days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    daysLong: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
    roles: { reception: "Receptionist", assistant: "Assistant", podiatrist: "Podiatrist" } as Record<RoleKey, string>,
    noShiftsWeek: "No shifts this week yet. Copy the previous week or add shifts.",
    publishedOn: (d: string) => `Published ${d}`,
  },
  fr: {
    appName: "Horaires",
    demoBadge: "Démo · données fictives",
    clinic: "Clinique",
    allClinics: "Toutes les cliniques (siège social)",
    previousWeek: "Semaine précédente",
    nextWeek: "Semaine suivante",
    thisWeek: "Revenir à la semaine prochaine",
    copyPrevious: "Copier la semaine précédente",
    publish: "Publier la semaine",
    published: "Publié",
    draft: "Brouillon",
    reset: "Réinitialiser la démo",
    combine: "Cumuler les heures entre sociétés liées",
    shifts: "Quarts",
    scheduled: "Heures planifiées",
    errors: "Erreurs",
    warnings: "Avertissements",
    errorLabel: "Erreur",
    warningLabel: "Avertissement",
    checksTitle: "Vérification des règles",
    checksHint: "Mise à jour en direct. Les erreurs bloquent la publication; les avertissements, non.",
    noIssues: "Aucun problème. Cette semaine peut être publiée.",
    openShifts: "Quarts ouverts",
    openShift: "Quart ouvert",
    addShift: "Ajouter un quart",
    editShift: "Modifier le quart",
    employee: "Employé",
    day: "Jour",
    start: "Début",
    end: "Fin",
    breakMin: "Pause non payée (minutes)",
    save: "Enregistrer",
    remove: "Supprimer le quart",
    cancel: "Annuler",
    close: "Fermer",
    endAfterStart: "L'heure de fin doit suivre l'heure de début.",
    previewTitle: "Vérifications pour ce quart",
    previewOk: "Aucun problème pour ce quart.",
    unavailable: "Indisponible",
    availableUntil: (t: string) => `Dispo jusqu'à ${t}`,
    availableRange: (a: string, b: string) => `Dispo ${a}–${b}`,
    dayOff: "Congé",
    of: "sur",
    otherCompanies: (hrs: string) => `+ ${hrs} h dans d'autres sociétés`,
    publishBlocked: (n: number) => `Corrigez ${n} erreur${n > 1 ? "s" : ""} avant de publier.`,
    publishedToast: "Publié. Dans la vraie application, le personnel reçoit une notification.",
    copiedToast: (n: number, skipped: number) =>
      `${n} quart${n > 1 ? "s" : ""} copié${n > 1 ? "s" : ""}${skipped ? `, ${skipped} déjà présent${skipped > 1 ? "s" : ""}` : ""}.`,
    nothingToCopy: "Rien à copier de la semaine précédente.",
    footer: "Démo avec données fictives. Vos modifications restent dans ce navigateur seulement.",
    companyLabel: "Société",
    days: ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."],
    daysLong: ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"],
    roles: { reception: "Réceptionniste", assistant: "Assistante", podiatrist: "Podiatre" } as Record<RoleKey, string>,
    noShiftsWeek: "Aucun quart cette semaine. Copiez la semaine précédente ou ajoutez des quarts.",
    publishedOn: (d: string) => `Publié le ${d}`,
  },
};

export type Strings = (typeof strings)["en"];

export function hours(minutes: number, lang: Lang): string {
  return new Intl.NumberFormat(lang === "fr" ? "fr-CA" : "en-CA", { maximumFractionDigits: 1 }).format(minutes / 60);
}

export function formatDate(date: string, lang: Lang, opts: Intl.DateTimeFormatOptions): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-CA", { timeZone: "UTC", ...opts });
}

export interface IssueContext {
  personName: string;
  clinicName: string;
  dayLabel: string;
  timeRange: string;
  otherClinicName?: string;
  otherTimeRange?: string;
}

/** Turn a rules-engine issue into a sentence. */
export function issueMessage(issue: Issue, ctx: IssueContext, lang: Lang): string {
  const d = issue.details;
  const hr = (m: unknown) => hours(Number(m), lang);
  const who = ctx.personName;
  const when = `${ctx.dayLabel} ${ctx.timeRange}`;
  if (lang === "fr") {
    switch (issue.code) {
      case "shift_overlap":
        return `${who} : quarts qui se chevauchent (${ctx.clinicName} ${ctx.timeRange} et ${ctx.otherClinicName} ${ctx.otherTimeRange}).`;
      case "location_not_allowed":
        return `${who} n'est pas autorisé·e à travailler à ${ctx.clinicName}.`;
      case "credential_expired":
        return `${who} : ${d.credential === "OPQ licence" ? "permis OPQ" : d.credential} expiré le ${formatDate(String(d.expiredOn), lang, { day: "numeric", month: "long" })}. Ne peut pas être à l'horaire (${when}).`;
      case "outside_availability":
        return `${who} est à l'horaire en dehors de ses disponibilités (${when}).`;
      case "overtime":
        return `${who} : ${hr(d.scheduledMinutes)} h cette semaine, soit ${hr(d.overtimeMinutes)} h au-delà du seuil de ${hr(d.thresholdMinutes)} h (heures supplémentaires).`;
      case "above_max_hours":
        return `${who} : ${hr(d.scheduledMinutes)} h planifiées, au-dessus de son maximum de ${hr(d.maxWeeklyMinutes)} h.`;
      case "below_min_hours":
        return `${who} : ${hr(d.scheduledMinutes)} h planifiées, sous son minimum de ${hr(d.minWeeklyMinutes)} h.`;
      case "weekly_rest":
        return `${who} : le plus long repos cette semaine est de ${hr(d.longestRestMinutes)} h; ${d.province === "QC" ? "le Québec" : "l'Ontario"} exige ${hr(d.requiredMinutes)} h consécutives.`;
      case "meal_break_missing":
        return `${who} (${when}) : un quart de plus de 5 h exige une pause-repas non payée de ${d.requiredMinutes} minutes.`;
      case "short_notice_refusable":
        return `${who} (${when}) : annoncé moins de 5 jours à l'avance. Au Québec, l'employé peut refuser ce quart.`;
      case "province_rules_missing":
        return `${ctx.clinicName} : aucune règle définie pour cette province.`;
      case "time_off":
        return `${who} est en congé (${when}).`;
      case "travel_time":
        return `${who} n'a pas assez de temps pour se rendre d'une clinique à l'autre.`;
      case "coverage_gap":
        return `${ctx.clinicName} : poste non couvert de ${d.from} à ${d.to}.`;
      case "credential_expiring":
        return `${who} : ${d.credential} expire le ${d.expiresOn}.`;
    }
  }
  switch (issue.code) {
    case "shift_overlap":
      return `${who}: overlapping shifts (${ctx.clinicName} ${ctx.timeRange} and ${ctx.otherClinicName} ${ctx.otherTimeRange}).`;
    case "location_not_allowed":
      return `${who} is not allowed to work at ${ctx.clinicName}.`;
    case "credential_expired":
      return `${who}: ${d.credential} expired on ${formatDate(String(d.expiredOn), lang, { month: "long", day: "numeric" })}. Can't be scheduled (${when}).`;
    case "outside_availability":
      return `${who} is scheduled outside their availability (${when}).`;
    case "overtime":
      return `${who}: ${hr(d.scheduledMinutes)} h this week, ${hr(d.overtimeMinutes)} h over the ${hr(d.thresholdMinutes)} h overtime threshold.`;
    case "above_max_hours":
      return `${who}: ${hr(d.scheduledMinutes)} h scheduled, above their maximum of ${hr(d.maxWeeklyMinutes)} h.`;
    case "below_min_hours":
      return `${who}: ${hr(d.scheduledMinutes)} h scheduled, below their minimum of ${hr(d.minWeeklyMinutes)} h.`;
    case "weekly_rest":
      return `${who}: longest rest this week is ${hr(d.longestRestMinutes)} h; ${d.province === "QC" ? "Quebec" : "Ontario"} requires ${hr(d.requiredMinutes)} h in a row.`;
    case "meal_break_missing":
      return `${who} (${when}): a shift over 5 h needs a ${d.requiredMinutes}-minute unpaid meal break.`;
    case "short_notice_refusable":
      return `${who} (${when}): announced less than 5 days ahead. In Quebec, the employee may refuse this shift.`;
    case "province_rules_missing":
      return `${ctx.clinicName}: no labour rules defined for this province yet.`;
    case "time_off":
      return `${who} is on time off (${when}).`;
    case "travel_time":
      return `${who} doesn't have enough time to travel between clinics.`;
    case "coverage_gap":
      return `${ctx.clinicName}: position not covered from ${d.from} to ${d.to}.`;
    case "credential_expiring":
      return `${who}: ${d.credential} expires on ${d.expiresOn}.`;
  }
}
