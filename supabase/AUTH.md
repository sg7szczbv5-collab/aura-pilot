# AURA: authentication, roles, sessions and PDPL

## Who signs in, and how

| App | Method | Role in `profiles` | Extra requirement |
|---|---|---|---|
| Rider | Phone OTP via SMS | `rider` (default for every new user) | Current consents: terms + privacy |
| Captain | Phone OTP via SMS | Becomes `driver` when the application row is created | Consents: terms, privacy, location, regulatory sharing |
| Admin | Email + password, then **TOTP MFA (mandatory)** | `admin` + `admin_role`, granted only with `private.grant_admin` | Session must be `aal2`. Without MFA, RLS returns nothing |

Roles and permissions use one matrix in two places: `DEFAULT_ROLE_PERMISSIONS` (src/core/seed.ts) and `private.admin_can()` (SQL). Their parity is tested.

## Supabase dashboard settings (production)

These live in the hosted project, not in the migrations.

**Phone OTP** (Authentication → Sign In / Providers → Phone)
- Enable phone sign-in and pick an SMS provider (Twilio, MessageBird, Vonage or Textlocal; for a Saudi provider such as Unifonic, use the Send SMS hook).
- Set the SMS OTP length to 6 to match `VITE_AUTH_OTP_LENGTH`, and the expiry to 300 s.
- Register the sender ID with CST.

**Email** (Authentication → Sign In / Providers → Email)
- Turn **off** "Allow new users to sign up". Staff accounts are invited from the dashboard only.
- Set the minimum password length to 12, require lowercase, uppercase, digits and symbols, and turn on leaked-password protection.

**MFA** (Authentication → Multi-Factor): enable TOTP enrollment and verification.

**Rate limits** (Authentication → Rate Limits): keep SMS and verification limits low, for example 30 SMS per hour per project to start.

**Sessions** (Authentication → Sessions, Pro plan)
- Time-box user sessions: 12 h for staff, matching `ADMIN_SESSION_POLICY.maxAgeMs`.
- Inactivity timeout: 8 h.
- Enable refresh-token rotation with reuse detection.

**URL configuration**: set the site URL to the production domain, and add `…/#/admin` to the redirect URLs (password reset).

Local testing without SMS: under Authentication → Phone, add test numbers with fixed OTPs.

## Session protection in the app

- **Staff:** idle sign-out after Settings → session minutes (default 30), with a 60 s warning. There is an absolute limit of 12 h. Activity in any tab counts, and signing out in one tab signs out all of them. Suspension or role changes are re-checked whenever the console regains focus.
- **Brute force:** 5 wrong OTP, password or MFA codes lock that identifier for 10 minutes on the client, and the SMS resend cooldown is 30 s. Supabase rate limits apply on the server as well.
- **Blocked accounts** are signed out on launch. The database also refuses them: `create_ride` and the `admin_can()` checks.
- In Supabase mode the demo shortcuts ("Enter as demo account", demo codes and demo staff list) are hidden.

## PDPL controls

- **Consents** (`user_consents`) are append-only and versioned. Bumping a version in `src/privacy/consents.ts` **and** in `private.consent_version()` makes every user re-confirm. The database enforces them: no ride request and no going online without current required consents. Withdrawing location consent takes a captain offline immediately.
- **Right of access:** `export_my_data()` returns a JSON copy of the caller's own data, limited to 5 per day, and each export is logged.
- **Requests** (`privacy_requests`) cover correction, deletion, restriction and objection. Each has a 30-day due date and is handled in Admin → Privacy requests, which needs the `privacy.manage` permission (super admin by default).
- **Erasure** (`private.erase_user`) runs only with no active ride, a zero wallet balance and no open payout. It clears name, phone, email, national ID, date of birth, IBAN and emergency contacts, payment tokens, live location, feedback and support text, then blocks the profile. Kept as legally required: ride and payment records and the ledger (tax and TGA), consent proof, and the audit trail (erasure entries carry no personal values).
- **Still to do in a later stage:** an Edge Function that deletes the user's Storage files and deletes or bans the `auth.users` row after erasure, plus retention jobs.
