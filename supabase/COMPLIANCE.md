# AURA: TGA/Wasl, captain onboarding, PDPL completeness, safety (Stage 6)

> Values marked **placeholder** (vehicle age limit, Wasl endpoints/fields, legal text in [brackets]) must be confirmed with TGA, Elm and AURA's legal team before launch.

## 1. Wasl (Transport General Authority, operated by Elm)

**What is sent, and when** (`public.wasl_work_queue()`):

| Operation | When | Payload |
|---|---|---|
| `driver_registration` | Captain submits an application (status `pending_review`) | National ID/Iqama, date of birth, name, mobile, email, city |
| `vehicle_registration` | Same, for the current vehicle | Sequence number, plate, make/model/year/colour, class, captain ID |
| `eligibility_check` | Daily for every approved captain | National ID, vehicle sequence number |
| `trip_registration` | As soon as a trip starts | Ride number, captain ID, vehicle sequence, class, start time, pickup coordinates |
| `trip_update` | When the trip completes | Wasl reference, completion time, drop-off coordinates, distance, duration, fare |

No rider personal data is sent (tested).

**Results** (`record_wasl_result`):
- **Accepted:** the captain or vehicle becomes `eligible`, and trips get a Wasl reference and a reported time.
- **Explicit rejection (not eligible):**
  - the captain is set `ineligible` and an approved one is **suspended** and taken offline
  - the vehicle is set `inactive`
  - there is no automatic retry
- **Technical error** (HTTP failure, timeout, unexpected body):
  - retried with exponential backoff (2, 4, 8… minutes, up to 24 h), at most 8 attempts, then flagged for manual follow-up
  - it **never** takes an eligible captain off the road
- Every attempt is in `wasl_sync_log`. Payloads are redacted after 365 days.

**Gates in the database:**
- Approval requires captain **and** vehicle eligibility (Stage 2).
- Going online and being dispatched now also require it, and `dispatch_candidates` re-checks it.

**Provider** (`supabase/functions/_shared/wasl/`):
- `WASL_MODE=mock`: offline rules (invalid ID → ineligible, an ID starting `1099` → ineligible, vehicle over the age limit → ineligible).
- `WASL_MODE=live`: `WaslHttpProvider` with a configurable base URL, per-operation paths (`WASL_PATH_*`), auth headers, and response mapping (`interpretWaslBody`). **All of these must be aligned with the Elm specification.**

## 2. Captain onboarding (Supabase mode)

The captain app runs phone OTP, then the steps below:
1. **Personal details:** name, ID/Iqama with checksum, date of birth (18+), Saudi IBAN (mod-97), city.
2. **ID documents** with expiry dates.
3. **Vehicle:** age limit (placeholder 10 years), Saudi plate letters, Istimara sequence number.
4. **Vehicle documents** with expiry dates, plus consent to the Captain Agreement, privacy, location and Wasl sharing.

Files upload to `driver-documents/<uid>/…`: the Storage policy restricts each captain to their own folder, with JPG/PNG/PDF up to 10 MB. `submit_driver_application` re-checks everything on the server and queues Wasl.

**Review:** Admin → **Applications** (Supabase mode). It shows documents (5-minute signed URLs), the vehicle and the Wasl log. Documents, the vehicle and the captain are approved or rejected through the permission-checked admin functions.

**Expiry:** `expire_documents()` runs daily (pg_cron 00:15). It expires documents and takes the affected captains offline; they can't go online again until the document is renewed and approved. The captain app shows each document's expiry, or the rejection reason.

## 3. PDPL completeness

| Right / control | Implementation |
|---|---|
| Consent | Versioned, append-only (Stage 3). Each purpose links to its full document |
| Access | `export_my_data()` v2: adds GPS breadcrumbs of the rider's own rides, Wasl submissions (without payloads) and share links |
| Correction | Request → staff correct the data → complete with a note |
| Restriction | Completing the request sets `profiles.processing_restricted`, which excludes the person from marketing (`private.can_contact_for_marketing`). Lifted by `admin_lift_restriction` |
| Objection | Completing the request withdraws marketing and analytics consent |
| Deletion | `erase_user` (Stage 3), then **privacy-worker**: removes the person's files from `driver-documents` and `avatars` and disables (bans) the login, recording the outcome on the request |
| Retention | `private.apply_retention()` daily: breadcrumbs 180 days, Wasl payloads 365 days, expired share links after 30 days, pickup codes of finished rides |

## 4. Safety

- **SOS:** reports an incident via `report_safety_incident`, which opens an *urgent* safety ticket with the location and writes the audit log, then dials **911**. Captains can report incidents too.
- **Live trip sharing** (`create_trip_share`):
  - a 256-bit token, stored hashed
  - `#/track/<token>` opens without an account and calls `trip_share_view` (the only function anonymous users can run)
  - it shows status, the captain's first name, the vehicle and plate, and the live location only while the trip is active
  - the link is revocable, expires after 12 h, and stops working 30 minutes after the trip ends
  - at most 5 active links per trip
- **Legal and safety texts:** `src/legal/documents.ts` holds the Terms, Privacy Policy, Captain Agreement and Safety guidelines in Arabic and English, marked as **drafts for legal review** and versioned with the consents.

## Setup

```bash
npx supabase db push                                   # 20261129000100_compliance.sql
npx supabase functions deploy wasl-worker
npx supabase functions deploy privacy-worker
npx supabase secrets set WASL_MODE=mock WASL_CRON_SECRET=... PRIVACY_CRON_SECRET=...
# live: WASL_MODE=live WASL_API_BASE_URL=... WASL_APP_ID=... WASL_APP_KEY=... [WASL_CLIENT_ID, WASL_PATH_*]
```

- **Schedules:** call `wasl-worker` every minute and `privacy-worker` hourly (Supabase Cron → HTTP, with the header `x-cron-secret`). `expire_documents` and `apply_retention` run through pg_cron when it is enabled.
- **Storage:** the `driver-documents` bucket and policies come from migration 009.
