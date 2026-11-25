# AURA production cutover: go / no-go checklist

**How to use it:**
- Each line needs an **owner** and **evidence** before launch.
- **Auto** items are enforced by code: `npm run preflight` (config, headers, bundle), `ops_readiness()` (live database), or the test suite.
- **Manual** items need a person to confirm.
- Any open ❗ item is a **no-go**.

## A. Legal and regulatory ❗

| # | Item | Type | Owner | Evidence |
|---|---|---|---|---|
| A1 | TGA operator licence issued; licence number in the Terms (`src/legal/documents.ts`) | Manual | Legal | |
| A2 | Wasl API specification received from Elm; `_shared/wasl/http.ts` paths, headers and response fields aligned; sandbox tested | Manual | Engineering | |
| A3 | Vehicle age rule confirmed (`compliance_setting('vehicle_max_age_years')`, `VEHICLE_MAX_AGE_YEARS`) | Manual | Ops + Legal | |
| A4 | Terms, Privacy Policy, Captain Agreement and Safety texts finalised: `[brackets]` completed, `draft: false`; if wording changed materially, versions bumped in `consents.ts` **and** `private.consent_version()` | Manual | Legal | |
| A5 | DPO named; privacy contact published; SDAIA registration if required | Manual | Legal | |
| A6 | Hosting region and cross-border transfer basis documented (PDPL) | Manual | Legal + Eng | |
| A7 | Wallet limits confirmed (`money_limit('wallet_max')`) and stored-value rules checked with SAMA | Manual | Finance | |
| A8 | ZATCA e-invoicing approach agreed (VAT is computed and stored per ride) | Manual | Finance | |

## B. Accounts and keys ❗

| # | Item | Type | Owner | Evidence |
|---|---|---|---|---|
| B1 | Production Supabase project (separate from staging), PITR enabled | Manual | Eng | |
| B2 | Supabase Auth: phone provider plus SMS sender ID registered with CST; email sign-ups **off**; TOTP MFA **on**; password policy; rate limits; session time-box (see `supabase/AUTH.md`) | Manual | Eng | |
| B3 | Moyasar **live** keys; webhook URL and secret set in the dashboard; Apple Pay domain verified | Auto (`moyasar_*`) + Manual | Finance | |
| B4 | Google: browser key restricted to domains; server key restricted to Routes API; separate keys | Auto (`maps_*`) + Manual | Eng | |
| B5 | `WASL_MODE=live` and its credentials | Auto (`wasl_mode`, `wasl_config`) | Eng | |
| B6 | Worker and health secrets: 32+ characters, distinct | Auto (`worker_secrets*`) | Eng | |
| B7 | No secret in `VITE_*` or in the built bundle | Auto (`no_secrets_in_browser`, `bundle_secrets`) | Eng | |
| B8 | Payout bank/provider contracted; source IBAN configured | Manual | Finance | |

## C. Database ❗

| # | Item | Type | Owner | Evidence |
|---|---|---|---|---|
| C1 | All migrations applied (`supabase db push` shows nothing pending) | Manual | Eng | |
| C2 | pg_cron enabled **before** the push, or external schedules for dispatch-tick, expiry, retention and payouts | Auto (`schedules`) | Eng | |
| C3 | RLS on every table; no anonymous access except share links; definer functions pinned; private schema locked | Auto (`rls_enabled`, `anon_*`, `definer_search_path`, `private_schema_locked`) | Eng | |
| C4 | Real tariffs per city and class (not the seed placeholders) approved by the business | Auto (`tariffs`) + Manual | Ops | |
| C5 | Service-area polygons for live cities; restricted and airport zones drawn | Auto (`service_areas`) + Manual | Ops | |
| C6 | Storage buckets private; Realtime publication includes rides and locations | Auto (`storage_buckets`, `realtime`) | Eng | |
| C7 | 1–5 super admins; all staff invited with least-privilege roles; TOTP enrolled | Auto (`super_admin`, `staff_mfa_enrolled`) | Ops | |
| C8 | Ledger balanced (`ledger_health().ok`) | Auto (`ledger_balanced`) | Finance | |

## D. Application and hosting

| # | Item | Type | Owner | Evidence |
|---|---|---|---|---|
| D1 | `npm run verify` green on the release commit (all tests, including the end-to-end rehearsal) | Auto (CI) | Eng | |
| D2 | Security headers deployed (`dist/_headers` honoured by the host; verify with `curl -I`) | Auto (`csp_*`, `hsts`) + Manual | Eng | |
| D3 | Custom domain on HTTPS; `PAYMENT_CALLBACK_URL` points to it | Auto (`payment_callback`) | Eng | |
| D4 | Edge Functions deployed; `payments-webhook` and `health` with `--no-verify-jwt` | Manual | Eng | |
| D5 | Schedulers calling `payments-worker` (1 min), `wasl-worker` (1 min), `privacy-worker` (1 h) | Manual | Eng | |
| D6 | Uptime monitor on `/health`; alert routes to on-call | Manual | Eng | |

## E. Operational readiness

| # | Item | Type | Owner | Evidence |
|---|---|---|---|---|
| E1 | On-call rota, with a safety on-call (15-minute triage target) | Manual | Ops | |
| E2 | Support team trained on Privacy requests (30-day deadline), refunds, safety tickets | Manual | Ops | |
| E3 | First captains onboarded on staging-like production: documents reviewed and **Wasl-eligible** | Auto (`online_captains_compliant`) + Manual | Ops | |
| E4 | Staging smoke test (RUNBOOK §9) passed on the release build | Manual | QA | |
| E5 | Rollback rehearsed: previous `dist/` and function versions available; git tag created | Manual | Eng | |
| E6 | Incident playbooks read by on-call (payments, Wasl, SMS, safety, breach, ledger) | Manual | Ops | |

## Go / no-go

```bash
npm run verify
npm run preflight -- --target production --env-file .env.production --db
```

**Go** when both commands exit 0, every manual ❗ item has an owner and evidence, and the staging smoke test passed.

| Role | Name | Decision | Date |
|---|---|---|---|
| Engineering lead | | | |
| Operations lead | | | |
| Finance | | | |
| Legal / DPO | | | |
