# Clinic workforce platform

Workforce and HR platform for healthcare clinics: scheduling, time clock, timesheets, time off, credentials and HR, built for multi-company, multi-province clinic groups. Pilot in 4 clinics (Quebec and Ontario), then sold to other clinics.

## What's here (Phase 1 foundation)

| Path | What it is |
|---|---|
| `docs/ARCHITECTURE.md` | Stack, components, hosting, punch-in design, security, AI usage |
| `packages/db/src/schema.ts` | Database schema (Drizzle ORM, PostgreSQL): account → company → location, people, employment, availability, schedules, shifts, punches, timesheets, time off, credentials, documents, announcements, audit log |
| `packages/db/migrations/` | Generated SQL migration |
| `packages/rules/src/` | Labour rules engine (pure TypeScript): overlaps, overtime (QC 40 h / ON 44 h, per company or combined), weekly rest (QC 32 h; ON 24 h or 48 h over 2 weeks), meal breaks, Quebec 5-day notice, availability, allowed clinics, expired licences, min/max hours, scheduled vs desired hours |
| `packages/*/test/` | Automated tests (25) |

## Run it

Requires Node.js 22+.

```bash
npm install
npm test            # runs all tests (database tests use an in-memory Postgres)
npm run typecheck
npm run db:generate # regenerate the SQL migration after editing schema.ts
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
