# AURA database (Supabase · PostgreSQL · PostGIS)

## Migrations (apply in order)

| File | Contents |
|---|---|
| `20261125000100_extensions_and_types.sql` | PostGIS, `private` schema, all enum types |
| `20261125000200_catalog.sql` | cities, zones, tariffs, promos |
| `20261125000300_identity.sql` | profiles, riders, drivers, vehicles, driver_documents, driver_locations, plus auth helpers |
| `20261125000400_rides.sql` | rides, ride_events, trip state machine (same as `src/core/trip.ts`) |
| `20261125000500_finance.sql` | payment_methods, payments, wallet_accounts, wallet_ledger (double entry), payouts |
| `20261125000600_support_audit_wasl.sql` | tickets, ticket_messages, audit_log, wasl_sync_log |
| `20261125000700_rls.sql` | RLS on all 21 tables, column grants, policies per role |
| `20261125000800_rpc.sql` | RPC functions (ride lifecycle, onboarding, admin, settlement, Wasl) |
| `20261125000900_storage_realtime.sql` | Storage buckets and policies, Realtime publication |
| `20261130000100_ops_readiness.sql` | Stage 7: `ops_readiness()`, live go-live checks (security, config, payments, Wasl, PDPL, safety, operations). See `ops/RUNBOOK.md` |
| `20261129000100_compliance.sql` | Stage 6: Wasl queue/backoff/trip hooks, dispatch and online gates, onboarding rules (ID/IBAN checksums, expiry, vehicle age, consents), document expiry, trip_shares + SOS, PDPL restriction/objection/cleanup/export v2, retention. See `COMPLIANCE.md` |
| `20261128000100_payments_enums.sql` | Stage 5: new enum values (tip payments, wallet holds, cash deposits) |
| `20261128000200_payments.sql` | Stage 5: wallet holds, auto-settlement, card authorize/capture, tips, refunds, cash deposits, payout batches, statements, `ledger_health()`. See `PAYMENTS.md` |
| `20261127000100_trips_realtime.sql` | Stage 4: ride_offers, ride_route_points, dispatch, GPS ingestion, breadcrumbs → actual distance, ride_view, quote_trip, pg_cron schedules. See `TRIPS.md` |
| `20261126000100_auth_privacy.sql` | Stage 3: admin requires MFA (aal2), `privacy.manage`, user_consents, privacy_requests, consent enforcement, data export, erasure. See `AUTH.md` |

`seed.sql` holds reference data only: 6 cities, placeholder tariffs and Riyadh zones.

## Test without Docker

```bash
npm run test:db     # PGlite (PostgreSQL 18 + PostGIS 3.6 in-process)
```

## Apply to Supabase

```bash
npx supabase init                     # once: creates supabase/config.toml
npx supabase login
npx supabase link --project-ref <ref>
npx supabase db push                  # applies migrations/
# local stack (needs Docker): npx supabase start && npx supabase db reset
```

Make the first admin from the SQL editor, after the user has signed up:

```sql
select private.grant_admin('<auth user uuid>', 'super_admin');
```

## Rules

- Money is stored as integer halalas. The ledger is append-only, and each transaction must sum to 0.
- Clients never write rides or money tables. They go through RPCs (authenticated) or Edge Functions (service_role).
- Clients select explicit columns. `private.*` (PIN hashes, payment tokens) is not reachable from the API.
