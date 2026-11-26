# AURA production runbook

The operational reference for deploying, running and recovering AURA. Pair it with `ops/CUTOVER_CHECKLIST.md` (go/no-go) and the stage docs: `supabase/AUTH.md`, `TRIPS.md`, `PAYMENTS.md`, `COMPLIANCE.md`.

## 1. System map

| Part | Where | Notes |
|---|---|---|
| Rider, captain and admin apps | Static hosting (`dist/`) | `dist/_headers` (Netlify / Cloudflare) or `vercel.json` (Vercel) sets CSP, HSTS and caching — keep both identical (preflight check `vercel_headers`). SPA with hash routes, so no rewrites needed |
| Database, Auth, Realtime, Storage | Supabase project | 16 migrations in `supabase/migrations/` (order matters) |
| `request-ride` | Edge Function (JWT) | Routing (Google Routes), pricing, card authorization, dispatch |
| `payments` | Edge Function (JWT) | Save card, top-up, tip, 3-D Secure sync |
| `payments-webhook` | Edge Function (**no JWT**) | Moyasar webhook (secret token, re-fetch) |
| `payments-worker` | Edge Function (cron secret) | Capture, void, refund, stale sync. **Every minute** |
| `wasl-worker` | Edge Function (cron secret) | Wasl registration, re-checks, trip reporting. **Every minute** |
| `privacy-worker` | Edge Function (cron secret) | Erasure cleanup (Storage + login). **Hourly** |
| `dispatch-tick` | Edge Function (cron secret) | Only if pg_cron is unavailable: **every 5 s** |
| `health` | Edge Function (**no JWT**) | Uptime monitor target: 200 or 503 |
| pg_cron jobs | Database | `aura-dispatch-tick` (5 s), `aura-expire-documents` (00:15), `aura-retention` (03:45), `aura-payout-batch` (Sun 06:00 UTC), `aura-purge-route-points` (03:30) |

External services:
- Moyasar (payments)
- Google Maps Platform (browser key, plus a server key for Routes)
- an SMS provider through Supabase Auth
- Wasl (Elm)
- a payout bank or provider

## 2. Environments

| | development | staging | production |
|---|---|---|---|
| Supabase | none (demo store) or local | its own project | its own project in the closest region (check PDPL data residency) |
| Payments | mock | Moyasar **test** keys | Moyasar **live** keys |
| Wasl | mock | mock, or Elm sandbox | **live** |
| Maps | offline map | Google (test key) | Google (restricted keys) |

`npm run preflight -- --target <env> --env-file <file>` enforces these rules: test keys in production, or mock providers in production, are blockers.

## 3. Deploy procedure (staging first, always)

1. **Freeze and verify:** run `npm run verify` locally, or rely on green CI. It covers typecheck, function typecheck, all tests (unit, database, end-to-end rehearsal), the build and the preflight.
2. **Run GitHub Actions → Deploy → target `staging`.** The workflow:
   1. checks out the code, then runs the tests and the build
   2. runs the preflight (config, headers, secrets in the bundle)
   3. runs `supabase db push`, then deploys the Edge Functions
   4. runs the post-deploy `preflight --db`, which calls the live `ops_readiness()`
3. **Publish the hosting build** (`dist/`) for staging.
4. **Smoke test staging** with the manual script in §9.
5. **Run Deploy → target `production`** (requires a reviewer), then publish the hosting build for production.
6. **Watch for 30 minutes:**
   - health stays 200
   - Admin → System readiness stays green
   - Supabase logs show no 5xx from the functions
   - the payments-worker summary has `failed: 0`

**Migrations are forward-only.** Every migration is additive. Never edit an applied migration; add a new one. Test each new migration with `npm run test:db`, which runs all migrations from scratch.

## 4. Rollback

| What broke | Action |
|---|---|
| Frontend | Re-publish the previous `dist/`. `index.html` is `no-cache`, so users get it on the next load |
| An Edge Function | Redeploy the function from the previous git tag: `git checkout <tag> && npx supabase functions deploy <name>` |
| A migration | **Do not drop objects.** Write a corrective migration and deploy it. Restore from Supabase PITR only for data corruption, after a decision by the incident lead |
| A provider | Switch secrets: `PAYMENT_PROVIDER` and `WASL_MODE` are runtime secrets (`npx supabase secrets set …`, then redeploy the function) |

Tag every production deploy: `git tag release-YYYYMMDD-N`.

## 5. Monitoring and alerts

| Signal | Source | Alert when |
|---|---|---|
| Health | `GET /functions/v1/health` (uptime monitor, 1 min) | non-200 twice in a row |
| Readiness | Admin → System readiness, or `/health` with `x-health-secret` | any blocker fails |
| Payments | `payments-worker` response; readiness checks `stuck_payments`, `unsettled_rides`, `amount_mismatch` | `failed > 0` for 3 consecutive runs, or any amount mismatch |
| Wasl | `wasl-worker` response; `wasl_exhausted`, `wasl_trips_reported` | errors for 10 min, or any exhausted submission |
| PDPL | `privacy_requests_on_time`, `erasure_cleanup` | any overdue request (legal deadline) |
| Safety | `safety_tickets_triaged` | any safety report unassigned for over 15 min: **page on-call** |
| Ledger | `ledger_balanced` | never expected to fail. **Stop payouts** and escalate |

## 6. Incident playbooks

### Payment gateway outage (Moyasar)
1. Card rides fail at authorization, and the database cancels them as `payment_failed`, so riders see "payment declined".
2. Post an in-app notice suggesting cash or wallet (Admin → Marketing → Inbox).
3. The worker retries captures automatically (`sync` / `capture`). Nothing else is needed once the gateway recovers.
4. Afterwards, check `stuck_payments` and `unsettled_rides` reach 0.

### Wasl outage
1. Technical errors are retried with backoff, and **eligible captains keep working** (by design).
2. Trip reports queue up and are delivered on recovery. Watch `wasl_trips_reported`.
3. If an outage lasts more than 24 h, notify TGA per the operator agreement.

### SMS / OTP outage
- Existing sessions continue; new sign-ins fail.
- Switch the SMS provider in Supabase Auth, if a second one is configured, and post a status notice.

### Safety incident (SOS)
1. The ticket arrives as **urgent** and the `safety_tickets_triaged` alert pages on-call.
2. Call the rider or captain. If in danger: emergency services (911) first.
3. Preserve evidence: ride events, GPS breadcrumbs (kept 180 days) and the audit log. **Do not** run erasure on involved accounts while an investigation is open: reject the deletion request with the legal reason.
4. Suspend the captain if needed (Admin → Applications → Suspend). It is audited.

### Personal-data breach (PDPL)
1. Contain: rotate the affected keys (§7) and revoke sessions (`supabase auth` → sign out users).
2. The incident lead and DPO assess scope from the audit log and Supabase logs.
3. **Notify SDAIA within 72 hours** of becoming aware, and affected people where required. Confirm current timelines with legal.
4. Record the incident, its impact and the remediation.

### Ledger imbalance (should never happen)
1. Stop payouts: no `admin_set_payout_status` approvals.
2. `select public.ledger_health();` and inspect the transactions it reports.
3. Fix with a **balanced adjustment transaction** (finance + engineering, both reviewed). The ledger is append-only by design.

## 7. Secret rotation

| Secret | Where | How |
|---|---|---|
| Supabase service role | Supabase dashboard → API | Rotate the JWT secret / keys, update the function env (automatic) and the CI `SUPABASE_SERVICE_ROLE_KEY` |
| Moyasar secret / webhook | Moyasar dashboard | New key → `supabase secrets set MOYASAR_SECRET_KEY …` → redeploy `payments*`, `request-ride` |
| Worker / health secrets | Supabase secrets + scheduler | Generate 32+ random characters (e.g. `openssl rand -hex 32`), update both sides |
| Google keys | Cloud Console | Create, restrict, swap, then delete the old one |
| Wasl app key | Elm | Per the contract |

After any rotation, run `npm run preflight -- --target production --env-file … --db`.

## 8. Data protection operations

- **Requests:** handle data-subject requests in Admin → Privacy requests. The legal deadline is 30 days, and readiness blocks on overdue ones.
- **Erasure:** runs in the database, then `privacy-worker` removes Storage files and disables the login. Financial and trip records are kept, anonymised, for the legally required period.
- **Retention:** `apply_retention()` runs daily (breadcrumbs 180 d, Wasl payloads 365 d, share links, pickup codes).
- **Staff access:** staff use mandatory TOTP. Every admin action is in `audit_log`. Review staff accounts monthly.

## 9. Manual smoke test (staging, ~15 minutes)

1. Rider signs up with phone OTP, sees the consent screen, accepts, and checks the legal documents open.
2. Rider adds the test card `4111 1111 1111 1111`, sees an upfront price, and requests a card ride.
3. On a second phone, a test captain (approved, Wasl mock eligible) goes online. Check location permission: there's a banner if denied.
4. Captain accepts, arrives; the rider shares the trip (open the link signed out) and shows the PIN; the captain starts, drives, completes.
5. Within a minute the ride is captured and settled, and the captain's statement shows the earning.
6. Rider tips; finance refunds 10 SAR in Admin; the next worker run shows it paid.
7. Rider downloads "my data" and checks it includes the trip.
8. SOS test: a test ticket appears as urgent in Support.
9. Admin → System readiness shows no blockers.
