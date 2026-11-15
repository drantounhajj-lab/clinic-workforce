/**
 * Labour rules by province. Values must be validated by an employment lawyer
 * in each province before go-live. Add a province here to support it.
 */

export type Province =
  | "AB" | "BC" | "MB" | "NB" | "NL" | "NS" | "NT" | "NU" | "ON" | "PE" | "QC" | "SK" | "YT";

export interface ProvinceRules {
  /** Paid minutes per week after which overtime applies. */
  overtimeWeeklyMinutes: number;
  /** Minimum consecutive rest inside each week. */
  weeklyRestMinutes: number;
  /** Alternative: minimum consecutive rest inside each 2-week period (Ontario). */
  biweeklyRestMinutes?: number;
  /** A meal break is required once a shift's worked time exceeds this. */
  mealBreakAfterMinutes: number;
  mealBreakMinutes: number;
  /**
   * Days of notice below which an employee may refuse a shift (Quebec, s. 59.0.1 LNT).
   * Undefined = no such rule.
   */
  scheduleNoticeDays?: number;
}

export const PROVINCE_RULES: Partial<Record<Province, ProvinceRules>> = {
  QC: {
    overtimeWeeklyMinutes: 40 * 60,
    weeklyRestMinutes: 32 * 60,
    mealBreakAfterMinutes: 5 * 60,
    mealBreakMinutes: 30,
    scheduleNoticeDays: 5,
  },
  ON: {
    overtimeWeeklyMinutes: 44 * 60,
    weeklyRestMinutes: 24 * 60,
    biweeklyRestMinutes: 48 * 60,
    mealBreakAfterMinutes: 5 * 60,
    mealBreakMinutes: 30,
  },
};

export function rulesFor(province: Province): ProvinceRules | undefined {
  return PROVINCE_RULES[province];
}
