# AURA — BETA readiness report

Branch `feature/beta-readiness` · base `main` @ `1e92c03` · 2026-11-26

**Verdict: READY WITH LIMITATIONS** — the code is ready for a closed field test once the
operational prerequisites in §7 are done (they need the owner's accounts: Supabase, Vercel,
SMS provider). Nothing in this branch has been deployed.

---

## 1. Scope and method

Whole repository inspected: `src/` (rider, captain, admin apps, data layer, maps, payments,
privacy), `supabase/` (18 migrations, 8 Edge Functions, docs), `scripts/`, `tests/`, CI and
deployment configuration. Evidence comes from:

- **Database tests** on the real migrations (PostgreSQL 17 + PostGIS in-process, `tests/db`),
  run as each Supabase role (anon / rider / captain / staff with and without MFA / service).
- **End-to-end server rehearsal** (`tests/e2e/cutover.test.ts`): onboarding → Wasl → trip →
  payments worker → settlement → payout → privacy erasure on one database.
- **End-to-end UI test** (`npm run e2e:ui`): a full trip driven in the browser.
- **Security headers / bundle scan** (`npm run preflight`), CSP checked in a real browser.

Not testable here (no credentials / network): the production Supabase project, Moyasar
sandbox, Elm Wasl, the SMS provider, Vercel. These are listed as open items, not as passed.

## 2. Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| C1 | Critical | Admin console in live (Supabase) mode: 11 of 14 pages showed the **browser's demo data**; their actions (suspend, cancel, block, pricing) changed only the browser copy. | **Fixed** — live pages on real data/RPCs; unbacked pages hidden in live mode |
| C2 | Critical | Migrations never applied to Supabase (Deploy workflow has never run). Document rejection, vehicle correction and chat fail live until applied. | **Open — owner action** (§7) |
| H1 | High | Rider/captain support tickets and trip complaints stayed in the browser in live mode. | **Fixed** — `public.tickets` / `ticket_messages` |
| H2 | High | In-trip chat stayed on the sender's device in live mode. | **Fixed** — migration 018 `ride_messages` + Realtime |
| H3 | High | Captain earnings in live mode showed a demo incentive programme and generated "paid" weeks. | **Fixed** — server statement, real payouts and trips |
| H4 | High | Scheduled rides had no server backend but appeared to work in live mode. | **Mitigated** — hidden in live mode; backend is future work |
| H5 | High | `supabase/.temp` committed: production project ref, organisation id, pooler host (no password). | **Fixed** — untracked + ignored (remains in git history; no secret, rotation not required) |
| H6 | High | Duplicate ride request returned a generic `internal_error` (double tap / app reopened mid-trip). | **Fixed** — "you already have an active ride" → «لديك رحلة نشطة بالفعل» |
| M1 | Medium | Profile edit stayed local in live mode. | **Fixed** — `profiles.full_name`; e-mail read-only |
| M2 | Medium | Demo notifications and demo promo codes (rejected by the server) shown to real users. | **Fixed** — hidden in live mode |
| M3 | Medium | `PAYMENT_PROVIDER=mock` accepts any webhook carrying `secret_token=mock`. | **By design for test**; preflight blocks it for production. BETA must use its own project (§6) |
| L1 | Low | Saved places (home/work) are per device. | Open — acceptable for BETA |
| L2 | Low | Online captain may switch current vehicle without re-check at that moment. | **Not exploitable** — dispatch re-checks vehicle approval + Wasl on every offer |

Previously fixed on `main` this week and re-verified here: maps always render (Google →
Mapbox → offline), Vercel security headers (`vercel.json`), pricing retry / promo errors,
captain resubmission, rejection-reason flows.

## 3. Changes in this branch

### Admin console — live mode (`src/apps/admin/live/`)
- `adminApi.ts`: typed data access. Reads go through RLS (`admin_can(permission)` + MFA);
  writes through the existing audited RPCs (`transition_ride`, `admin_set_driver_status`,
  `admin_set_profile_blocked`, `admin_set_payout_status`, `create_payout_batch`) or the
  admin write policies (`tariffs`, `tickets`). Every write is captured by the audit triggers.
- `LivePages.tsx`: Overview (live KPIs), Trips (log, admin cancel with reason), Captains
  (suspend / reactivate), Customers (block / unblock), Support (thread, reply, internal
  notes, status), Finance (ledger health, payments, payouts, payout batch), Pricing (tariffs
  and commission), Live map (captains seen in the last 10 min), Staff.
- `AdminApp.tsx`: in live mode those pages replace the demo pages; Vehicles, Zones,
  Marketing, Reports and Settings are hidden (no server backing yet) rather than showing
  demo data. Applications, Privacy and Readiness were already live.

### Rider and captain apps — live mode
- `src/data/supportGateway.ts`: tickets and replies in the database (demo mode unchanged).
- Chat: `sendRideMessage` / `rideChat` in `src/data/serverMirror.ts`, Realtime subscription
  on `ride_messages`; `ChatSheet` uses it.
- Profile name saved server-side; scheduled rides, demo notifications and demo promos hidden.
- Captain earnings: `LiveEarnings` (server statement, payouts, completed trips).

### Server
- `supabase/migrations/20261203000100_ride_messages.sql` (additive, no data change):
  participants-only read/write, writes only while the ride is active, sender set by the
  database, staff read with `trips.view`, Realtime, 30-day retention job.
- `supabase/migrations/20261204000100_ride_messages_privacy.sql` (019): `private.erase_user`
  also anonymises the user's chat messages and `export_my_data` includes the messages the
  user sent (functions copied from their latest versions with only these additions).
- `supabase/migrations/20261205000100_tariff_bounds.sql` (020): server-side bounds for tariff
  edits (`NOT VALID`: enforced on new / edited rows), mirrored by
  `src/apps/admin/live/tariffValidation.ts`; the Pricing page rejects empty / malformed /
  out-of-range input and requires a review (old → new) and explicit confirmation.
- `supabase/functions/_shared/requestRide.ts`: duplicate-request message.

### Repository / ops
- `supabase/.temp/` untracked and ignored; `.env.local`, `.env.beta`, `.env.staging` ignored.
- `.env.beta.example`, this report, `npm run e2e:ui` (`scripts/e2e-ui-trip.cjs`).

## 4. Database and security review

- **27 tables, RLS enabled on all**, UUID keys, PostGIS indexes (tests `schema`).
- **Isolation verified by tests** (new group *BETA: concurrency, isolation and failure cases*
  plus existing suites): a rider sees only their own profile, wallet, rides, events, route,
  chat, payments and tickets; a captain only their own documents, earnings, payouts and the
  rides offered/assigned to them; another rider/captain gets nothing and cannot transition,
  view or chat on someone else's ride.
- **Staff**: every admin power requires MFA (`aal2`); `admin_can()` matches the TypeScript
  role matrix for every role × permission; support lacks approval rights; audit log only with
  `audit.view`.
- **Cannot be bypassed from the client**: column-limited grants (riders cannot change role,
  captains cannot approve themselves), money tables not writable by clients, service-only
  RPCs (`create_ride`, `dispatch_ride`, `settle_ride`, money functions) refused to users.
- **Secrets**: none in the repository or the built bundle (preflight `bundle_secrets`,
  `no_secrets_in_browser`); browser and server Google keys must differ (check present).
- **Webhooks**: Moyasar `secret_token` compared in constant time; payment re-fetched from the
  provider (body never trusted); `record_provider_payment` idempotent; amount tampering
  flagged (tests).
- **Headers**: CSP / HSTS / framing / caching in `public/_headers` and `vercel.json`, kept
  identical by preflight + tests; checked in a browser with 0 violations.
- **Input validation**: Saudi ID / IBAN / plate / sequence checksums identical in SQL and
  TypeScript; text lengths bounded by CHECK constraints; parameterised queries only
  (PostgREST / RPC) — no SQL string building in the client.
- **Rate limiting**: SMS / verification limits are set in the Supabase dashboard (documented
  in `supabase/AUTH.md`); not verifiable from here.

## 5. Test results (this branch)

| Suite | Result |
|---|---|
| TypeScript (app) `npm run typecheck` | pass |
| TypeScript (Edge Functions) `npm run typecheck:functions` | pass |
| Unit + DB + server E2E `npm test` | **250 passed / 0 failed** (15 files) |
| UI E2E `npm run e2e:ui` (full trip) | **16 / 16 steps passed**, 0 JS errors |
| Build `npm run build` | pass |
| Preflight (development) | 29/31 — 2 config warnings |
| Preflight (staging, no secrets set) | NOT READY — 3 blockers: Supabase URL, anon key, worker secrets (expected; §7) |
| Lint | no ESLint config in the repository; TypeScript strict + unused checks act as lint |

**Trip lifecycle** (DB tests + server rehearsal + UI E2E): request → server price (binding)
→ dispatch to nearest compliant captain → offer / decline / timeout → re-offer → single accept
→ arriving → arrived → PIN start → GPS breadcrumbs → completion → fare / commission / VAT →
automatic settlement (balanced double entry, once) → captain statement → payout. Failure
cases: duplicate request, second/late accept, wrong state transitions, cancellation (rider /
admin / system after max search time), wallet holds released, card not dispatched until
authorised, failed authorisation cancels the ride, replayed webhooks credited once.

**Rider app**: sign-up/sign-in (OTP; demo code in demo mode), consents, destination,
classes and prices, confirm, live trip, chat, PIN, rating — passed (UI E2E, demo mode).
Profile, support, chat — verified against the database by code path + RLS tests; live-mode
UI against a real project not run (no project credentials here).

**Captain app**: onboarding, resubmission, online/offline, offer, accept/decline, arrival,
PIN, start, end, summary — passed (UI E2E + DB tests). Earnings statement and payouts —
DB tests.

**Admin**: live pages compile and use only RLS-checked queries and audited RPCs; their
permissions are proven by DB tests. Not run against a live project (no credentials).

## 6. Payments and Wasl

| Integration | State | Evidence |
|---|---|---|
| Moyasar | Implemented (cards, mada, Apple Pay tokens, 3-D Secure callback, capture / void / refund worker, webhook) | Mock-provider tests incl. replay and tampering. **Sandbox not exercised** — no test keys available here |
| HyperPay | Interface only (not implemented) | — |
| Captain payouts | Ledger + batch + status flow; provider `mock` | DB tests |
| Wasl (Elm) | Mock rules + configurable HTTP adapter; endpoint paths and field mapping await the Elm specification | DB tests on the queue / retry / eligibility gate. **Live API not testable** |
| SMS OTP | Supabase phone auth — provider to configure (Twilio / MessageBird / Vonage, or a Saudi provider through the Send-SMS hook) | Not testable here |
| Maps | Google / Mapbox / offline, each falling back to the next | Browser tests |
| Push notifications | Not implemented (in-app only) | — |

## 7. Requirements before the field test

1. **Separate BETA Supabase project** (do not use `aura-nexus-prod`); apply all migrations
   with the Deploy workflow (`Actions → Deploy → staging`) or `supabase db push`.
2. **Auth**: phone provider + OTP length 6; admin TOTP MFA enabled; SMS rate limits.
3. **Secrets** on the BETA project and Vercel environment (`.env.beta.example`): Supabase
   URL / anon key, four worker secrets (≥ 32 chars, all different), maps keys (optional).
4. **Payments**: `mock`, or Moyasar **test** keys only, with the webhook secret set on both
   sides. No live keys in BETA.
5. **Staff accounts** granted with `private.grant_admin` and MFA enrolled.
6. **pg_cron** enabled (dispatch offer expiry, document expiry, purges) — or the
   `dispatch-tick` function scheduled.
7. Run `npm run preflight -- --target staging` with the BETA env (must be green) and check
   *System readiness* in the admin console after deploying.
8. **Rollback**: deploy BETA from a tag; migrations are additive (this branch adds one table, redefines the two privacy functions and adds tariff bounds);
   Supabase PITR / daily backups on the BETA project; Vercel instant rollback.
9. **Monitoring**: `health` Edge Function (with `HEALTH_SECRET`) on an uptime monitor;
   Supabase logs for Edge Functions; admin *System readiness*.

## 8. Known limitations (BETA)

- Scheduled rides: not available in live mode.
- Push / SMS notifications to riders and captains: not implemented (in-app status only).
- Admin pages without server backing in live mode: Vehicles (covered by Applications /
  Captains), Zones editing, Marketing (promo management), Reports, Settings.
- Saved places per device. Rider cannot edit e-mail in-app.
- Wasl live and Moyasar live/sandbox unverified until credentials exist.

## 9. Recommendation

**READY WITH LIMITATIONS.** The backend (permissions, trip state machine, dispatch, money,
compliance) is strongly tested, and the gaps that made live mode show demo data or lose
messages/tickets are closed. Start a closed BETA (small group of known captains and riders,
`mock` or Moyasar test payments, `WASL_MODE=mock`) after the §7 checklist is complete and
preflight is green on the BETA project. Do not take real payments or connect live Wasl until
those integrations are verified against their sandboxes.
