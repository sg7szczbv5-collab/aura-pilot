# AURA BETA security (migration 021)

The controls that keep a closed BETA from moving real money, talking to Elm, or letting in strangers, and keep a BETA from ever being taken for production.

- **Status:** implemented in the repository and tested on PGlite and in unit tests. **Not applied to any Supabase project. Not deployed.**
- **Production:** live operations stay refused everywhere until `PROD_PROJECT_REF` is verified by a human (see §6).

## 1. Layers

| Layer | Kind | What it does | Where |
|---|---|---|---|
| P1 | preventive | `anon`, `authenticated` and `service_role` have no `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES` or `TRIGGER` on `payments`, `payment_methods`, `payouts` or `wasl_sync_log`. The privilege check runs before any trigger, so a disabled trigger cannot be exploited through REST. | migration 021 |
| P2 | preventive | Each of the 11 sensitive writers calls `ops_guard.assert_environment()` first. Before any non-mock effect, it also calls `ops_guard.assert_live_allowed()`. | migration 021 (bodies regenerated from the latest definitions; only the guard lines are new) |
| P3 | preventive | `aa_ops_guard_write` (insert/update) and `aa_ops_guard_truncate` on the four tables, **ENABLE ALWAYS**, so they fire under `session_replication_role = replica` too. | migration 021 |
| Marker | preventive | `ops_guard.environment` holds one immutable row (mode `beta` \| `production`, project ref, digest). Missing or corrupt means everything sensitive is refused. Production requires `project_ref = ops_guard.prod_project_ref()`, which is NULL. | migration 021 |
| Allowlist | preventive | `ops_guard.allowlist` changes only through `allow_tester()` and `revoke_tester()`. Every change is logged in `allowlist_log`, which is append-only. | migration 021 |
| D1 | detection | `ops_guard.integrity_check()` runs every minute through pg_cron. It records `integrity_status` and appends `integrity_events` when the state changes. A failure makes every sensitive write refuse. | migration 021 |
| D2 | detection | `/health` returns 503 on a bad marker, failed or stale (> 3 min) integrity, a URL/marker mismatch, or a live provider. With the health secret it also runs the integrity check, which is the fallback when pg_cron is unavailable. | `health`, `_shared/ops/health.ts` |
| D3 | detection | `payments`, `payments-webhook`, `payments-worker`, `wasl-worker` and `request-ride` call `ops_runtime_config()` and refuse (503) before building a provider. Providers only receive `guardedFetch`, which blocks every host except Google routing unless live is allowed. | `_shared/ops/runtimeGuard.ts` |
| C1 | compensating | BETA has no live credentials. Preflight blocks `sk_live_`/`pk_live_` anywhere, any non-mock payment, payout or Wasl setting, and Elm credentials. Runtime refuses the same. | `src/ops/configChecks.ts`, `runtimeGuard.ts` |
| C2 | compensating | Identity binding: `ref(SUPABASE_URL)` = marker ref = `PROD_PROJECT_REF` (code constant, never an env var) = `ops_guard.prod_project_ref()`. | both constants are null today |
| C3 | compensating | Closed sign-ups: disabled in GoTrue (manual), the **Before User Created** hook, a backup `BEFORE INSERT` trigger on `auth.users`, and the **Custom Access Token** hook, which also runs on refresh. | migration 021 |
| C4 | compensating | `revoke_tester()` removes the tester from the allowlist, sets `is_blocked` and deletes sessions and refresh tokens. The Auth ban is a manual Admin API step. | migration 021 |

**What this does not prevent:** the database owner (`postgres`) can still undo any of it. Against the owner, protection relies on detection (D1 → D2/D3, alerts) and on C1 (no live credentials exist in BETA), not on prevention.

## 2. Inventory: write paths (proven from the repository)

All 13 functions are `SECURITY DEFINER`, owned by `postgres`, with `search_path = ''`. The test `inventory` in `tests/db/beta_security.test.ts` fails if a new function starts writing one of these tables.

| Function | Table | Caller | Via | EXECUTE | P2 live check |
|---|---|---|---|---|---|
| `create_payment_intent` | payments | `_shared/payments/db.ts` | RPC | service_role | `p_provider <> 'mock'` |
| `record_provider_payment` | payments | `payments-webhook`, `handlers.ts`, `db.ts` | RPC | service_role | payment's provider ≠ mock |
| `admin_refund_payment` | payments | (no app caller) | RPC | authenticated (finance.settle + MFA), service_role | payment's provider ≠ mock |
| `save_payment_method` | payment_methods | `_shared/payments/db.ts` | RPC | service_role | `p_provider <> 'mock'` |
| `set_default_payment_method` | payment_methods | `src/payments/paymentsGateway.ts` | RPC | authenticated, service_role | environment only |
| `remove_payment_method` | payment_methods | `src/payments/paymentsGateway.ts` | RPC | authenticated, service_role | environment only |
| `request_payout` | payouts | `src/payments/paymentsGateway.ts` | RPC | authenticated, service_role | environment only (always creates a mock payout) |
| `create_payout_batch` | payouts | `adminApi.ts`, pg_cron | RPC / SQL | authenticated (finance.settle), service_role | environment only (mock payouts) |
| `admin_set_payout_status` | payouts | `adminApi.ts` | RPC | authenticated (finance.settle + MFA), service_role | payout provider ≠ mock |
| `complete_payout` | payouts | (no app caller) | RPC | service_role | payout provider ≠ mock |
| `record_wasl_result` | wasl_sync_log | `_shared/wasl/worker.ts`, `db.ts` | RPC | service_role | `p_provider <> 'mock'` |
| `private.erase_user` | payment_methods | `_shared/privacy/cleanup.ts`, SQL | RPC / SQL | service_role | **not gated** (PDPL) |
| `private.redact_wasl_payloads` | wasl_sync_log | `apply_retention()` (pg_cron) | SQL | service_role | **not gated** (PDPL) |

No Edge Function or app code writes these tables through REST (`.from(table).insert/update/delete`); a test checks the files. Because every legitimate path is a `SECURITY DEFINER` function running as `postgres`, revoking the direct privileges (P1) affects none of them, which the suite proves end to end.

## 3. Privileges: before and after

The four tables (`payments`, `payment_methods`, `payouts`, `wasl_sync_log`), read from `information_schema.role_table_grants` after all migrations:

| Role | Before (≤ 020) | After (021) |
|---|---|---|
| anon | none | none |
| authenticated | SELECT | SELECT |
| service_role | SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER | **SELECT** |

The `ops_guard` schema:
- **anon, authenticated, service_role:** no `USAGE` and no table rights.
- **supabase_auth_admin:** `USAGE` plus `EXECUTE` on the two hooks only.
- **service_role:** may execute only `public.ops_runtime_config()`, `public.ops_integrity_check()` and `ops_guard.integrity_check()`.

## 4. Verification matrix

### Automated (this repository)

| Test | Where | Covers |
|---|---|---|
| A1 | `tests/db/beta_security.test.ts` | P1 on all four tables for service_role, a rider and anon, with the guard trigger disabled first |
| A2 | same | P2 alone (triggers disabled): `create_payment_intent`, `save_payment_method`, `record_provider_payment`, `admin_refund_payment`, `complete_payout`, `admin_set_payout_status`, `record_wasl_result` |
| A3 | same | P3 alone (owner insert, no function), also under `replica`; owner update to a live provider; TRUNCATE; all 8 triggers ALWAYS |
| A4 | same | marker missing, corrupt, two rows, unknown mode or forged production → refused; only (production, verified ref, fresh integrity) is live. All 11 writers refuse with a missing or corrupt marker |
| per writer | same | each of the 13 functions: mock works in BETA, live is refused, the verified production path is allowed, clients cannot call service-only writers |
| A5 | same | marker immutable for the owner; allowlist only through functions, logged; no API role reaches `ops_guard` |
| A6 | same | integrity check detects a disabled or downgraded trigger, a forbidden owner row, a removed P2, an unlisted account, a re-granted privilege; history appended; writes refused |
| A7 | `tests/betaSecurity.test.ts` | workers refuse on failed, stale or unread integrity, a missing function, a DB error, a bad marker, or live config in BETA |
| A8 | same | URL ↔ marker ↔ constant ↔ DB binding; substituted URL or custom domain refused; shipped constants null and equal |
| A9 | `tests/db/beta_security.test.ts` | shadow tables and functions in `public` change nothing; EXECUTE grants exact |
| A10 | same | exact privilege matrix on the four tables; broad re-grant detected and blocking |
| A11 | same | backup `auth.users` trigger (direct, as `supabase_auth_admin`, under replica); both hooks; `revoke_tester` → refresh refused, `create_ride` refused, `admin_can` false at once |
| A12 | `tests/betaSecurity.test.ts` | staging blockers (prod ref, live keys anywhere, Moyasar, Wasl live or Elm credentials, bank payouts); production blocked while the ref is unverified; `checkGuard` fails closed; deploy.yml order (preflight → migrations → `--guard` → functions) |
| live calls | same | `guardedFetch` blocks Moyasar, Elm and unknown hosts; real fetch never called; Moyasar and Wasl providers built with it cannot connect; Edge entry points guard before building providers |
| demo | same | live admin modules don't import the demo store; demo-backed admin pages replaced or hidden in Supabase mode; rider promos and inbox empty in Supabase mode |

### Manual Required (on the BETA project, during S7)

| # | Check |
|---|---|
| M1 | Real PostgREST: `curl` with the BETA service_role key on each table → 401/403 "permission denied". The owner disables a trigger in a controlled session and the `curl` is still refused; then the trigger is re-enabled |
| M2 | D2 end to end: unschedule `aura-ops-guard-integrity`; `/health` returns 503 within 3 minutes and the external monitor alerts; restore |
| M3 | GoTrue: with sign-ups disabled, an OTP to an unknown number creates no user; Admin API creation of an unlisted number fails; the hooks refuse issuance and refresh for a revoked tester; ban plus session deletion stops the user; Realtime closes when the token expires |
| M4 | `supabase secrets set SUPABASE_URL=…` is refused by the platform |
| M5 | Edge Functions with a fake `sk_live_…` or `WASL_MODE=live` (no real key) answer 503 `environment_guard` and make no outbound call (function logs); restore |
| M6 | Vercel Preview checks; the deploy token cannot reach the production organisation |

### UNVERIFIED (not proven here; do not treat as working)

- **`ENABLE ALWAYS` on `auth.users`:** on Supabase, `postgres` may not own `auth.users`. The migration then leaves the trigger in normal mode (a notice is raised) and the integrity check only requires it to be enabled.
- **Supabase Auth behaviour:** with sign-ups disabled, and the exact hook semantics on sign-up, sign-in, refresh and the Admin API (M3). That includes whether a hook function in the `ops_guard` schema can be selected in the dashboard.
- **Deleting `auth.sessions` and `auth.refresh_tokens` as `postgres`:** permitted on the target plan? (`revoke_tester` skips missing tables.)
- **`SUPABASE_URL`:** platform-injected and not overridable (M4).
- **Plan support:** pg_cron, Auth hooks and log retention on the BETA plan. Without pg_cron, integrity runs only through `/health` with the secret, which must then be scheduled.
- **Production ref:** the real value has not been verified, so `PROD_PROJECT_REF` and `ops_guard.prod_project_ref()` are null.

## 5. BETA execution: step by step, with stop points

Every step outside the repository needs **explicit human approval** first. Never touch the production project.

| Step | Action | Who | Stop point |
|---|---|---|---|
| S0 | Review and approve this PR (and PR #4). Neither is merged by this work. | reviewer | **STOP:** approval to proceed |
| S1 | Create a **new** Supabase project for BETA on the chosen plan. Record its ref from the dashboard. Enable pg_cron and PostGIS. | owner | **STOP:** confirm the ref, plan, region and cost |
| S2 | In Auth settings, disable sign-ups (phone and email); set the JWT expiry (e.g. 10 min). | owner | **STOP:** screenshot of the settings |
| S3 | GitHub environment `staging`: set `vars.SUPABASE_PROJECT_REF` = BETA ref and `VITE_SUPABASE_URL` = `https://<beta-ref>.supabase.co`. `PAYMENT_PROVIDER`, `VITE_PAYMENT_PROVIDER`, `PAYOUT_PROVIDER` and `WASL_MODE` = `mock`. No Moyasar, Wasl or bank secrets at all. | owner | **STOP:** `npm run preflight -- --target staging --env-file .env.beta` is green locally |
| S4 | Run Deploy → `staging`. Preflight passes, migrations 001–021 apply, then the **environment gate stops the run** (no marker yet). This is expected. | owner | **STOP:** confirm the run stopped at the gate, before any function deploy |
| S5 | In the BETA SQL editor (as postgres): `select ops_guard.set_environment('beta', '<beta-ref>');` then `select ops_guard.allow_tester('9665…', 'name');` for each tester, then `select ops_guard.integrity_check();` (must return `ok: true`). | owner | **STOP:** paste the integrity result |
| S6 | Dashboard → Auth → Hooks: Before User Created = `ops_guard.hook_before_user_created`; Custom Access Token = `ops_guard.hook_custom_access_token`. | owner | **STOP:** confirm both hooks are enabled |
| S7 | Re-run Deploy → `staging`. The gate passes and the functions deploy. Run M1–M6. | owner + reviewer | **STOP:** M1–M6 results recorded; any failure means stop and roll back the functions |
| S8 | Publish the BETA hosting build (Vercel Preview or a separate project), with an uptime monitor on `/health` (alert on two 503s in a row). | owner | **STOP:** monitor alert tested (M2) |
| S9 | Invite allowlisted testers. Revoke with `select ops_guard.revoke_tester('9665…');` plus the Auth ban (Admin API). | owner | ongoing |

**Rollback:** remove the BETA functions (or set them to refuse by un-setting the hooks or allowlist); the BETA project can be paused or deleted. Production is unaffected throughout.

## 6. Before production: what must happen first (not part of this PR)

- A human reads the production ref from the Supabase dashboard. Never use `supabase/.temp` or any cached file.
- A new reviewed migration replaces `ops_guard.prod_project_ref()`, and the same value is set in `src/ops/prodBinding.ts` and `supabase/functions/_shared/ops/runtimeGuard.ts`. A test keeps the code constants equal.
- Applying 021 to production refuses every financial and Wasl write, and every sign-up, until the production marker is written with `set_environment('production', <ref>)`. Schedule both in one change window.
- Until then, `npm run preflight -- --target production` blocks on `production_binding`. That is intentional: the production Deploy cannot start.

## 7. Residual risks

| Risk | Mitigation | Remaining |
|---|---|---|
| The owner (`postgres`) or anyone with the DB password can disable everything | D1 every minute → D2 503 + alert, D3 workers refuse; C1 no live credentials exist in BETA | detection only, not prevention |
| The marker digest is a tamper indicator, not a signature (md5 of public fields) | immutability triggers ALWAYS; no API role can reach the table | the owner can forge it; detection relies on mode/ref binding and integrity |
| pg_cron unavailable or stopped | integrity goes stale → `/health` 503, workers refuse, live disallowed | BETA mock operations still run in the DB until a failure is recorded (staleness alone doesn't block DB writes) |
| The Auth hooks are not configured (S6 skipped) | backup trigger on `auth.users`, GoTrue sign-ups disabled, integrity flags unlisted accounts | revocation then waits for JWT expiry plus the ban |
| Revoked tester keeps a valid access token until it expires | `is_blocked` refuses sensitive RPCs at once; sessions and refresh tokens deleted | read access via RLS until JWT expiry (keep expiry short) |
| Moyasar test mode cannot be exercised in BETA (any non-mock payment is refused) | by design (strictest) | a separate reviewed change would be needed for a sandbox mode |
| The `auth.users` trigger may not be ENABLE ALWAYS on Supabase | UNVERIFIED; integrity requires it enabled | under `replica`, the trigger could be skipped by the owner |
| `request-ride` routing can still call Google | Google routing host allowlisted only while the guard passes | not a money or Elm path |
