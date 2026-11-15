import { describe, expect, it } from "vitest";
import {
  distanceMeters,
  evaluatePunch,
  isValidRotatingCode,
  parsePunchFix,
  type PunchLocation,
  rotatingCode,
} from "../src";

const clinic: PunchLocation = {
  id: "gatineau",
  latitude: 45.4765,
  longitude: -75.7013,
  geofenceRadiusM: 150,
  earlyPunchLimitMin: 15,
  wifiBssids: ["aa:bb:cc:dd:ee:01"],
  qrSecret: "test-secret",
};

const start = new Date("2027-01-04T13:00:00Z"); // 8:00 Toronto
const at = (minutesFromStart: number) => new Date(start.getTime() + minutesFromStart * 60_000);
// ~40 m and ~6 km from the clinic
const near = { latitude: 45.4768, longitude: -75.7016, accuracyM: 12 };
const far = { latitude: 45.43, longitude: -75.65, accuracyM: 12 };

describe("distanceMeters", () => {
  it("measures short and long distances", () => {
    expect(distanceMeters(clinic, near)).toBeGreaterThan(30);
    expect(distanceMeters(clinic, near)).toBeLessThan(60);
    expect(distanceMeters(clinic, far)).toBeGreaterThan(5000);
  });
});

describe("evaluatePunch", () => {
  const base = { kind: "in" as const, location: clinic, scheduledStart: start };

  it("accepts a phone punch inside the geofence", () => {
    const d = evaluatePunch({ ...base, method: "phone_geofence", at: at(-5), position: near });
    expect(d.accepted).toBe(true);
    expect(d.flags).toEqual([]);
  });

  it("rejects clocking in more than 15 minutes early and says when it opens", () => {
    const d = evaluatePunch({ ...base, method: "phone_geofence", at: at(-25), position: near });
    expect(d).toMatchObject({ accepted: false, reason: "too_early", opensInMin: 10 });
  });

  it("never blocks clocking out as too early", () => {
    const d = evaluatePunch({ ...base, kind: "out", method: "phone_geofence", at: at(-60), position: near });
    expect(d.accepted).toBe(true);
  });

  it("rejects a phone punch outside the geofence without clinic Wi-Fi", () => {
    const d = evaluatePunch({ ...base, method: "phone_geofence", at: at(0), position: far });
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe("outside_geofence");
    expect(d.distanceM).toBeGreaterThan(5000);
  });

  it("accepts an out-of-zone GPS reading when the phone is on the clinic Wi-Fi, with a flag", () => {
    const d = evaluatePunch({ ...base, method: "phone_geofence", at: at(0), position: far, wifiBssid: "AA:BB:CC:DD:EE:01" });
    expect(d.accepted).toBe(true);
    expect(d.flags).toContain("outside_geofence_wifi_ok");
  });

  it("rejects a fake GPS location", () => {
    const d = evaluatePunch({ ...base, method: "phone_geofence", at: at(0), position: near, mockLocationDetected: true });
    expect(d).toMatchObject({ accepted: false, reason: "mock_location" });
  });

  it("flags an offline punch and a punch with no scheduled shift", () => {
    const d = evaluatePunch({ ...base, scheduledStart: null, method: "kiosk_pin", at: at(0), offline: true });
    expect(d.accepted).toBe(true);
    expect(d.flags).toEqual(["no_shift", "offline"]);
  });

  it("accepts the current or previous rotating QR code and rejects an old one", () => {
    const now = at(0);
    const current = rotatingCode(clinic, now);
    const previous = rotatingCode(clinic, new Date(now.getTime() - 30_000));
    const old = rotatingCode(clinic, new Date(now.getTime() - 120_000));
    expect(current).toMatch(/^[A-Z2-9]{6}$/);
    expect(isValidRotatingCode(clinic, current, now)).toBe(true);
    expect(isValidRotatingCode(clinic, previous, now)).toBe(true);
    expect(evaluatePunch({ ...base, method: "rotating_qr", at: now, qrToken: current }).accepted).toBe(true);
    expect(evaluatePunch({ ...base, method: "rotating_qr", at: now, qrToken: old })).toMatchObject({ accepted: false, reason: "invalid_qr" });
  });

  it("gives each clinic a different code", () => {
    const now = at(0);
    expect(rotatingCode(clinic, now)).not.toBe(rotatingCode({ ...clinic, id: "aylmer" }, now));
  });
});

describe("parsePunchFix", () => {
  const today = "2027-01-06"; // Wednesday

  it("reads English requests", () => {
    expect(parsePunchFix("Forgot to punch out yesterday, left at 5:30", today)).toEqual({ date: "2027-01-05", time: "17:30", kind: "out" });
    expect(parsePunchFix("I arrived at 8:05 am this morning", today)).toEqual({ date: "2027-01-06", time: "08:05", kind: "in" });
    expect(parsePunchFix("forgot to clock out monday, left at 4pm", today)).toEqual({ date: "2027-01-04", time: "16:00", kind: "out" });
  });

  it("reads French requests", () => {
    expect(parsePunchFix("J'ai oublié de puncher hier, je suis partie à 17h30", today)).toEqual({ date: "2027-01-05", time: "17:30", kind: "out" });
    expect(parsePunchFix("Arrivée à 8h ce matin", today)).toEqual({ date: "2027-01-06", time: "08:00", kind: "in" });
  });

  it("returns null when there is no time", () => {
    expect(parsePunchFix("I forgot to punch out", today)).toBeNull();
  });
});
