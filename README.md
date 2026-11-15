# Clinic workforce platform

Workforce and HR platform for healthcare clinics: scheduling, time clock, timesheets, time off, credentials and HR, built for multi-company, multi-province clinic groups. Pilot in 4 clinics (Quebec and Ontario), then sold to other clinics.

## What's here

| Path | What it is |
|---|---|
| `docs/ARCHITECTURE.md` | Stack, components, hosting, punch-in design, security, AI usage |
| `supabase/migrations` | Database (Supabase / PostgreSQL, Canada region): tables, row-level security per role, server-side punch checks (zone, Wi-Fi, iPad code, PIN), kiosk pairing, invitations. Deployed automatically when merged to `main` |
| `supabase/tests` | Permission and punch tests on a local PostgreSQL (`npm run test:db`) |
| `packages/rules` | Labour rules engine: overlaps, overtime (QC 40 h / ON 44 h), weekly rest, meal breaks, Quebec 5-day notice, availability, allowed clinics, expired licences, min/max hours |
| `packages/timeclock` | Punch decisions: early-punch limit, geofence, clinic Wi-Fi, fake GPS, offline, rotating QR code; plain-language punch fixes |
| `packages/sample-data` | Fictional clinics, companies, staff and schedules used by the demos and the app |
| `apps/schedule-demo` | Manager schedule builder (web demo) |
| `apps/staff-demo` | Staff app and clinic iPad kiosk (web demo) |
| `apps/mobile` | iPhone / Android / iPad app (Expo). See `apps/mobile/README.md` to install with TestFlight |

## Run it

Requires Node.js 22+.

```bash
npm install
npm test            # logic tests (rules, time clock)
npm run test:db     # database permission and punch tests (starts a local PostgreSQL)
npm run typecheck
npm run demo:build  # build both web demos into apps/*/dist
```

## Rules engine example

```ts
import { validateSchedule } from "@clinic-workforce/rules";

const result = validateSchedule({ locations, employments, shifts, availabilityRules, credentials, now: new Date() });
result.publishable; // false if any error (overlap, expired licence, clinic not allowed)
result.issues;      // [{ code: "overtime", severity: "warning", details: { overtimeMinutes: 150, ... } }, ...]
result.hours;       // scheduled vs desired hours per employee per week
```

Issue codes are stable and translated in the UI (fr-CA / en-CA).

Pass the shifts of the week before and the week after the weeks being checked, so rest periods that cross week boundaries are measured exactly.

## Important

- Labour rule values in `packages/rules/src/provinces.ts` must be validated by an employment lawyer in Quebec and in Ontario before go-live.
- Add a province by adding its rules to `PROVINCE_RULES`; until then its clinics get a `province_rules_missing` warning.

## Next steps

1. API (auth, roles, tenant isolation with row-level security)
2. Manager web app: schedule builder that calls the rules engine live
3. Staff mobile app: schedule, availability, punch-in (geofence + Wi-Fi + rotating QR), iPad kiosk mode
4. Timesheets from punches, payroll export per company
