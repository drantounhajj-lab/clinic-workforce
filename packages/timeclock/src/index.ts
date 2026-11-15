/**
 * Time clock logic: decides whether a punch is accepted and which flags it carries.
 * Pure functions, no I/O. The API runs the same checks server-side; the app runs
 * them to give the employee an immediate answer.
 */

export type PunchMethod = "kiosk_pin" | "kiosk_qr_badge" | "phone_geofence" | "rotating_qr" | "nfc" | "manual";

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface PunchLocation extends GeoPoint {
  id: string;
  geofenceRadiusM: number;
  /** Minutes before the scheduled start when clocking in becomes possible. */
  earlyPunchLimitMin: number;
  /** Registered clinic Wi-Fi access points (BSSID). */
  wifiBssids: string[];
  /** Secret used to sign the rotating QR code shown on the clinic iPad. */
  qrSecret: string;
}

export interface PunchAttempt {
  kind: "in" | "out";
  method: PunchMethod;
  at: Date;
  location: PunchLocation;
  /** Start of the shift being clocked into, if one is scheduled. */
  scheduledStart?: Date | null;
  position?: (GeoPoint & { accuracyM?: number }) | null;
  wifiBssid?: string | null;
  mockLocationDetected?: boolean;
  offline?: boolean;
  qrToken?: string | null;
}

export type PunchFlag = "outside_geofence_wifi_ok" | "offline" | "no_shift" | "low_accuracy";
export type RejectReason = "too_early" | "outside_geofence" | "no_position" | "invalid_qr" | "mock_location";

export interface PunchDecision {
  accepted: boolean;
  reason?: RejectReason;
  flags: PunchFlag[];
  distanceM?: number;
  /** Minutes until clocking in opens, when rejected as too early. */
  opensInMin?: number;
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres. */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export const QR_PERIOD_SECONDS = 30;

/**
 * Code shown on the clinic iPad, changing every 30 seconds.
 * Demo implementation (FNV-1a). Production signs it server-side with HMAC-SHA256.
 */
export function rotatingCode(location: Pick<PunchLocation, "id" | "qrSecret">, at: Date, periodSeconds = QR_PERIOD_SECONDS): string {
  const window = Math.floor(at.getTime() / 1000 / periodSeconds);
  return codeForWindow(location, window);
}

function codeForWindow(location: Pick<PunchLocation, "id" | "qrSecret">, window: number): string {
  let hash = 0x811c9dc5;
  for (const ch of `${location.qrSecret}|${location.id}|${window}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) {
    hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d) >>> 0;
    out += alphabet[hash % alphabet.length];
  }
  return out;
}

/** Accepts the current code and the previous one (scan just as it changed). */
export function isValidRotatingCode(location: Pick<PunchLocation, "id" | "qrSecret">, token: string, at: Date, periodSeconds = QR_PERIOD_SECONDS): boolean {
  const window = Math.floor(at.getTime() / 1000 / periodSeconds);
  return token === codeForWindow(location, window) || token === codeForWindow(location, window - 1);
}

/** Text encoded in the QR code on the clinic iPad: "cw1:<clinicId>:<code>". */
export function qrPayload(locationId: string, code: string): string {
  return `cw1:${locationId}:${code}`;
}

/** Reads a scanned QR text. Returns null for anything that isn't a clinic code. */
export function parseQrPayload(text: string): { locationId: string; code: string } | null {
  const m = /^cw1:([a-z0-9-]{1,64}):([A-Z2-9]{6})$/.exec(text.trim());
  return m ? { locationId: m[1], code: m[2] } : null;
}

export function evaluatePunch(p: PunchAttempt): PunchDecision {
  const flags: PunchFlag[] = [];

  if (p.kind === "in") {
    if (p.scheduledStart) {
      const opensAt = p.scheduledStart.getTime() - p.location.earlyPunchLimitMin * 60_000;
      if (p.at.getTime() < opensAt) {
        return { accepted: false, reason: "too_early", flags, opensInMin: Math.ceil((opensAt - p.at.getTime()) / 60_000) };
      }
    } else {
      flags.push("no_shift");
    }
  }

  let distanceM: number | undefined;

  if (p.method === "phone_geofence") {
    if (p.mockLocationDetected) return { accepted: false, reason: "mock_location", flags };
    const wifiOk = !!p.wifiBssid && p.location.wifiBssids.includes(p.wifiBssid.toLowerCase());
    if (!p.position) {
      if (!wifiOk) return { accepted: false, reason: "no_position", flags };
    } else {
      distanceM = Math.round(distanceMeters(p.position, p.location));
      if (p.position.accuracyM !== undefined && p.position.accuracyM > 100) flags.push("low_accuracy");
      if (distanceM > p.location.geofenceRadiusM) {
        // GPS drifts indoors: a registered clinic Wi-Fi overrides an out-of-zone reading.
        if (!wifiOk) return { accepted: false, reason: "outside_geofence", flags, distanceM };
        flags.push("outside_geofence_wifi_ok");
      }
    }
  }

  if (p.method === "rotating_qr") {
    if (!p.qrToken || !isValidRotatingCode(p.location, p.qrToken, p.at)) {
      return { accepted: false, reason: "invalid_qr", flags };
    }
  }

  if (p.offline) flags.push("offline");
  return { accepted: true, flags, distanceM };
}

// ---------- Punch fixes typed in plain language ----------

export interface PunchFix {
  /** "YYYY-MM-DD" */
  date: string;
  /** "HH:MM" */
  time: string;
  kind: "in" | "out";
}

const WEEKDAYS: Record<string, number> = {
  monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
  lundi: 0, mardi: 1, mercredi: 2, jeudi: 3, vendredi: 4, samedi: 5, dimanche: 6,
};

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return t.toISOString().slice(0, 10);
}

function weekdayOfDate(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/**
 * Reads a correction request such as "forgot to punch out yesterday, left at 5:30"
 * or "j'ai oublié de puncher hier, je suis partie à 17h30".
 * Rule-based fallback; in the real app an AI model reads the text and this runs as a check.
 * Returns null when it can't find a time.
 */
export function parsePunchFix(text: string, today: string): PunchFix | null {
  const s = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  let date = today;
  if (/\b(yesterday|hier)\b/.test(s)) date = shiftDate(today, -1);
  else if (/\b(today|aujourd'?hui|this morning|ce matin)\b/.test(s)) date = today;
  else {
    for (const [name, wd] of Object.entries(WEEKDAYS)) {
      if (new RegExp(`\\b${name}\\b`).test(s)) {
        const diff = (weekdayOfDate(today) - wd + 7) % 7 || 7; // most recent past occurrence
        date = shiftDate(today, -diff);
        break;
      }
    }
  }

  const outWords = /\b(out|left|leave|leaving|finished|sortie?|partie?|quitte|depart|fini|termine)\b/;
  const inWords = /\b(in|arrived|started|start|arrivee?|commence|entree?|debut)\b/;
  const kind: "in" | "out" = outWords.test(s) ? "out" : inWords.test(s) ? "in" : "out";

  const m = s.match(/\b(\d{1,2})(?:\s*(?::|h)\s*(\d{2})?)?\s*(am|pm|a\.m\.|p\.m\.)?(?![\d:])/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3]?.replace(/\./g, "");
  if (hour > 23 || minute > 59) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  else if (meridiem === "am" && hour === 12) hour = 0;
  else if (!meridiem && kind === "out" && hour >= 1 && hour <= 7) hour += 12; // "left at 5:30" = 17:30
  const pad = (n: number) => String(n).padStart(2, "0");
  return { date, time: `${pad(hour)}:${pad(minute)}`, kind };
}
