# Technical architecture

Workforce and HR platform for healthcare clinics. Pilot: 4 clinics (separate companies, Quebec and Ontario). Target: sold to other clinics, then the 60-clinic franchise network.

This document covers Phase 1 (pilot core) in detail and leaves room for Phases 2–3. See the feature spec doc for the full feature list.

## 1. Principles

1. **Multi-tenant from day one.** Every row belongs to an account. No feature may assume "Tony's clinics".
2. **Configuration, not code.** Professions, credential types, roles, protocols, exams, branding and labour rules are data.
3. **Rules by province.** Labour rules are resolved from the location's province, overtime is counted per company.
4. **French first.** Every string goes through i18n. French is the default for Quebec locations. No hard-coded UI text.
5. **Minimum personal data.** Location checked only at punch time. No biometric matching. Photos at punch only.
6. **AI drafts, a person decides.** No hiring, discipline, evaluation or pay decision is made by AI alone.
7. **Buy commodity parts.** Chat, e-signature, push, email, translation are bought services behind our own interfaces.

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One language for AI and humans to work in; shared types between apps |
| Mobile app (staff) + iPad kiosk | React Native with Expo (dev builds) | One codebase for iOS, Android and iPad; native modules for location, NFC, Wi-Fi, camera |
| Web app (managers, head office) | Next.js (React) | Schedule builder, timesheet approval, admin console |
| API | Node.js (Fastify or Next.js route handlers), REST + typed client | Simple, well known, easy to test |
| Database | PostgreSQL 16 | Relational data, row-level security for tenant isolation |
| ORM / migrations | Drizzle ORM + drizzle-kit | Schema in TypeScript, plain SQL migrations, no binary engine |
| Background jobs | Postgres-backed queue (pg-boss) | Reminders, exports, expiry alerts, AI jobs without extra infrastructure |
| Auth | Email/phone + password or magic link, TOTP 2FA; SSO in Phase 3 | Staff often have no company email |
| Hosting | AWS ca-central-1 (Montréal) or Azure Canada Central (Toronto) | Canadian data residency (Law 25) |
| File storage | S3-compatible bucket in the same Canadian region | Documents, punch photos, attachments |
| Monorepo | npm workspaces | `packages/db`, `packages/rules`, later `apps/mobile`, `apps/web`, `apps/api` |

### Bought services (wrapped behind our own interface so they can be swapped)

| Need | Options to evaluate | Notes |
|---|---|---|
| Chat | Stream, Sendbird | Must offer data residency or a self-hosted option; check Canada |
| E-signature | Dropbox Sign, DocuSign, Yousign | Bilingual templates, audit trail |
| Push notifications | Expo Push (APNs/FCM) | Free with Expo |
| Email / SMS | Postmark or AWS SES; Twilio for SMS | Schedule published, shift offers, 2FA |
| Translation and AI | Claude API | FR/EN translation, timesheet review, drafts; check processing region and cover in the privacy impact assessment |

## 3. Components

```
apps/mobile   Staff app (iOS/Android) + kiosk mode (iPad)
apps/web      Manager and head-office web app
apps/api      API, auth, background jobs
packages/db   Database schema and migrations (Drizzle)
packages/rules  Labour rules engine (pure functions, no I/O)
packages/i18n   FR/EN strings (Phase 1)
```

`packages/rules` is pure: it takes shifts, employments and location data and returns violations and warnings. The API calls it when a schedule is saved or published; the web app calls the same code to show warnings live while a manager builds the schedule.

## 4. Data model (summary)

```
Account (owner / head office)
 └─ Company (legal employer: payroll export, overtime, time-off balances)
     └─ Location (clinic: province, timezone, geofence, Wi-Fi, kiosk devices)
Person (one login, one profile)
 └─ Employment (person × company: role, pay rate, hours targets)
     └─ EmploymentLocation (which clinics this employment may work at)
Schedule week (per location) ─ Shift (employment × location × start/end)
Availability rule (recurring) · Availability exception (dated)
Punch (clock in/out, method, location check result, photo) → Timesheet entry
Time-off policy → Time-off balance → Time-off request
Credential type (configurable per profession) → Credential (per person, expiry)
```

Full definitions: `packages/db/src/schema.ts`.

Key rules encoded in the model:
- Every table carries `account_id` for tenant isolation (enforced with Postgres row-level security in the API).
- Overtime is computed per **company**; the account flag `combine_related_company_hours` merges hours across companies when they must be treated as one employer.
- A person working for two companies has two `employment` rows and appears in two payroll exports, but their shifts are checked together for overlaps.

## 5. Punch-in design

| Method | Device | Proof of presence | Proof of identity |
|---|---|---|---|
| Kiosk PIN / QR badge | Clinic iPad (Guided Access or MDM single-app) | Device is registered to the location | PIN or badge + photo at punch |
| Phone geofence | Staff phone | GPS within the location radius (default 150 m) **and** connected to a registered clinic Wi-Fi (BSSID) when available | Logged-in staff app |
| Rotating QR | iPad shows a code that changes every 30 s; phone scans it | Code is signed by the server and valid ~45 s | Logged-in staff app |
| NFC tag (Phase 2) | Tag at clinic door, phone taps it | Tag ID registered to the location | Logged-in staff app |

Rules:
- Each punch records method, device, location check result and any flag (outside geofence, mock location detected, offline).
- Offline punches are stored on the device with the device time and a signed sequence number, then synced; the server flags large clock drift.
- Early punch limit and auto clock-out are location settings.
- No continuous tracking. No face recognition (Quebec CAI biometric rules).

Platform notes:
- iOS needs the "Access Wi-Fi Information" entitlement and location permission to read the Wi-Fi network.
- Android can detect mock locations; iOS detection is limited, so Wi-Fi or rotating QR is the stronger check there.

## 6. Security

- TLS everywhere; data encrypted at rest (managed Postgres + bucket encryption).
- Row-level security on every tenant table; every API request carries account and role.
- Roles: employee, clinic manager, company admin, head office, account owner. Permissions are checked server-side.
- Admin activity log (who changed what, when) in an append-only table.
- 2FA for managers and admins in Phase 1.
- External security audit / penetration test before go-live with real employee data.
- Backups: daily, 30-day retention, restore tested before pilot.

## 7. Internationalization

- All UI strings in `packages/i18n` (fr-CA, en-CA). French is complete before any release (Bill 96).
- Dates, times and numbers formatted per locale; all times stored in UTC with the location's timezone.
- Employer-to-employee communications default to French for Quebec locations; the employee may choose English.

## 8. AI usage (Phase 1)

| Feature | Input | Output | Human step |
|---|---|---|---|
| FR/EN translation | Announcement or message | Translated text | Author can edit before sending |
| Timesheet review | Punches + schedule for a pay period | List of anomalies with explanations | Manager approves or corrects |
| Plain-language punch fix | "Forgot to punch out yesterday, left at 5:30" | Structured correction request | Manager approves |

All AI calls go through one internal service that strips unnecessary personal data, logs prompts and outputs for audit, and can be turned off per account.

## 9. Environments and delivery

- `dev` (local), `staging` (Canadian region, fake data), `production`.
- CI on every push: typecheck, unit tests (rules engine, schema), migration check.
- Mobile releases through Expo EAS to TestFlight / Google Play internal testing, then the stores.

## 10. Open technical decisions

- Chat vendor (data residency in Canada).
- E-signature vendor.
- Payroll export format (depends on the payroll provider).
- AWS vs Azure.
