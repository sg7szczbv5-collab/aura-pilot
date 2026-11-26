# AURA BETA environment: Supabase, Vercel, variables and secrets

This is a plan only. Nothing here has been created, and no secret has been set. Every item marked **APPROVAL** needs an explicit decision before it is done. The execution order and stop points are in `BETA_SECURITY.md` §5.

Principles:
- **Separate from production:** a separate Supabase organisation, a separate Vercel project, a separate GitHub environment, and separate keys. Nothing shared, and no production value is ever copied.
- **Mock only:** payments, payouts and Wasl. No Moyasar, bank or Elm credential exists anywhere in BETA.
- **No real customer data:** only test phone numbers and staff test accounts.

## 1. Supabase

| Item | Recommendation | Why |
|---|---|---|
| Organisation | **New organisation** `aura-beta`, separate from the production organisation | API tokens, members, billing and audit logs stay apart. A BETA token cannot reach production (M6) |
| Plan | **Pro** | The Free plan pauses inactive projects and has no daily backups. Pro is billed per organisation: **$25/month**, which includes $10 of compute credit, enough for one Micro instance ([pricing](https://supabase.com/pricing), [billing FAQ](https://supabase.com/docs/guides/platform/billing-faq)) |
| Compute | Micro (default) | Enough for a closed group; covered by the credit |
| Expected cost | about **$25/month**, plus usage over the quotas (none expected for a closed BETA) | Check the live pricing page before creating |
| Region | **Decision needed (APPROVAL + legal).** There is no Saudi region in Supabase's list ([regions](https://supabase.com/docs/guides/platform/regions)). Candidates: **eu-central-1 (Frankfurt)** or **ap-south-1 (Mumbai)** | BETA holds testers' phone numbers and locations, so a PDPL cross-border transfer assessment is required whichever region is chosen. Choose the region production will use, so BETA measures the same latency |
| Extensions | pg_cron and PostGIS, enabled **before** the first migration | Migrations only schedule jobs when pg_cron exists |
| Auth | Sign-ups off; JWT expiry 600 s or less; TOTP MFA on; phone test numbers (`BETA_SECURITY.md` §5c); hooks (S6) | — |
| Backups | Pro daily backups. PITR is not needed for BETA | — |

## 2. Vercel

| Item | Recommendation | Note |
|---|---|---|
| Project | **New project `aura-beta`**, never the existing `aura-pilot` project | Its variables are not shared with `aura-pilot` (don't use team-wide shared variables) |
| Team | A separate team is preferred, so a deploy token cannot reach production (M6). If that's not possible, use the same team with project-scoped tokens and variables (accepted risk, documented) | **APPROVAL** |
| Git | Production branch = the BETA branch (S0 SHA). Disable automatic deployments of other branches, or keep them protected | — |
| Deployment Protection | **Vercel Authentication** is included on every plan, but **on Hobby the production domain stays public**. Protecting it needs **Pro**, and Password Protection is a paid Pro add-on ([deployment protection pricing](https://vercel.com/docs/deployment-protection/usage-and-pricing)) | **APPROVAL:** Pro with Password Protection (testers aren't Vercel members), or Pro with Vercel Authentication for staff-only testing |
| Variables | §3, column "Vercel aura-beta", for **every** environment of the project (Production, Preview, Development) | `VITE_APP_ENV=beta` makes even the project's *production* deployment mock-only and bound to the BETA project |
| Headers | `vercel.json` as in the repository (CSP, HSTS) | — |

The existing `aura-pilot` project (S3a): review its **Preview** variables. No production Supabase URL or key, and no Moyasar value. Previews of PR branches are mock-only builds since PR #7, and since PR #8 a Preview that sets `VITE_SUPABASE_URL` without a matching `BETA_PROJECT_REF` fails to build.

## 3. Variables and secrets matrix

**Legend:**
- **var** is a plain value (not secret). **secret** is stored encrypted.
- "—" means not set.
- **Forbidden** means it must not exist: the build or preflight fails, or the runtime refuses.

| Name | GitHub env `staging` | Vercel `aura-beta` | BETA Edge secrets | Value / rule |
|---|---|---|---|---|
| `VITE_APP_ENV` | var `staging` | var `beta` | — | makes the build mock-only |
| `APP_ENV` | (set by Deploy) | — | — | `staging` |
| `VITE_SUPABASE_URL` | var | var | — | `https://<beta-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | var | var | — | the BETA **anon / publishable** key (never service_role: the build fails) |
| `SUPABASE_PROJECT_REF` | var | — | — | `<beta-ref>` (Deploy links this project) |
| `BETA_PROJECT_REF` | var | var | — | `<beta-ref>`, build-only, never bundled |
| `VITE_AUTH_OTP_LENGTH` | var `6` | var `6` | — | matches Auth |
| `VITE_PAYMENT_PROVIDER` | var `mock` | var `mock` | — | anything else fails the build |
| `PAYMENT_PROVIDER` | var `mock` | — | secret `mock` | — |
| `PAYOUT_PROVIDER` | var `mock` | — | secret `mock` | — |
| `WASL_MODE` | var `mock` | — | secret `mock` | — |
| `PAYMENT_CALLBACK_URL` | var | — | secret | `https://<beta-domain>/#/passenger` |
| `VITE_MAPS_PROVIDER` / `VITE_GOOGLE_MAPS_API_KEY` / `VITE_GOOGLE_MAPS_MAP_ID` | var (optional) | var (optional) | — | a **separate** Google key restricted to the BETA domain, or leave unset for the built-in map |
| `GOOGLE_MAPS_SERVER_KEY` | secret (optional) | — | secret (optional) | separate BETA key (Routes API) |
| `SUPABASE_SERVICE_ROLE_KEY` | secret | **forbidden** | (platform-provided) | BETA key; only CI preflight and the platform use it |
| `SUPABASE_ACCESS_TOKEN` | secret | — | — | token of a BETA-org member only |
| `SUPABASE_DB_PASSWORD` | secret | — | — | BETA database password |
| `PAYMENTS_CRON_SECRET`, `WASL_CRON_SECRET`, `PRIVACY_CRON_SECRET`, `HEALTH_SECRET` | secret | — | secret | 4 different values, ≥ 32 random characters each (`openssl rand -hex 32`); also set in the scheduler |
| `AURA_VERSION` | — | — | secret (optional) | release tag shown by `/health` |
| `DISPATCH_CRON_SECRET` | — | — | secret (only without pg_cron) | — |
| `MOYASAR_SECRET_KEY`, `MOYASAR_WEBHOOK_SECRET`, `MOYASAR_API_BASE_URL`, `VITE_MOYASAR_PUBLISHABLE_KEY` | **forbidden** | **forbidden** | **forbidden** | any value (test or live) fails preflight and the build; the Edge runtime refuses |
| `WASL_APP_ID`, `WASL_APP_KEY`, `WASL_API_BASE_URL`, `WASL_CLIENT_ID` | **forbidden** | **forbidden** | **forbidden** | Elm credentials |
| `VITE_APPLE_PAY_MERCHANT_ID` | — | — | — | not used in BETA |
| any `VITE_*` / `NEXT_PUBLIC_*` holding a secret | **forbidden** | **forbidden** | — | the build fails in every environment |

Platform-provided in Edge Functions, never set by hand: `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` (M4).

## 4. Edge Function secrets and schedules (S7)

- **Set** (`supabase secrets set --project-ref <beta-ref>`, by the owner):
  - `PAYMENT_PROVIDER=mock`
  - `PAYOUT_PROVIDER=mock`
  - `WASL_MODE=mock`
  - `PAYMENT_CALLBACK_URL`
  - the four worker secrets
  - optionally `GOOGLE_MAPS_SERVER_KEY` and `AURA_VERSION`
- **Schedule** (Supabase Cron → HTTP request, or any scheduler), each with header `x-cron-secret`:
  - `payments-worker`: every minute
  - `wasl-worker`: every minute
  - `privacy-worker`: hourly
- **Database jobs** (created by the migrations when pg_cron exists): dispatch tick, retention, document expiry, payout batch and `aura-ops-guard-integrity` (every minute). The integrity history purge runs monthly.
- **Monitor:** `GET /functions/v1/health` every minute; alert on two consecutive non-200.

## 5. What protects BETA from production, layer by layer

| Risk | Build | Runtime | Preflight / Deploy | Database |
|---|---|---|---|---|
| The BETA app pointed at the production Supabase | fails unless the URL is `BETA_PROJECT_REF`, and never the production ref | after sign-in `my_environment()` must be `beta`, otherwise sign-out and stop | `beta_project_declared`, `beta_not_production_project`, `project_ref_consistent` | the production database has no beta marker |
| A service_role key in the browser | fails if any `VITE_` / `NEXT_PUBLIC_` value is a secret | — | `no_secrets_in_browser`, `anon_key_is_anon`, `bundle_secrets` | RLS + P1 |
| Moyasar / bank / Elm reached | fails on any gateway setting or non-mock provider | browser network guard; Edge `guardedFetch` + runtime guard | `beta_*` blockers; Deploy `--guard` gate | P2 / P3 refuse live rows |
| Real users | — | sign-ups closed, allowlist, hooks | — | backup trigger on `auth.users`, integrity check flags unlisted accounts |

## 6. Approvals required before any step outside the repository

1. Supabase organisation and plan (Pro, about $25/month) and the **region** (legal PDPL assessment).
2. Vercel team (separate or shared), plan (Pro), and protection type (Password Protection add-on, or Vercel Authentication).
3. The list of test phone numbers and staff e-mails, and the BETA end date (expiry of the test codes).
4. The SMS-provider arrangement required by the phone provider (no credit, or sandbox) (`BETA_SECURITY.md` §5c).
5. Creating each secret (§3 and §4). Values are generated and entered by the owner, never pasted into a chat, an issue or the repository.
6. Each Deploy run (S4, S7).
