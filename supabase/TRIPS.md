# AURA: trip lifecycle, live location and maps (Stage 4)

## How a ride flows in Supabase mode

1. **Rider confirms.** The app calls the `request-ride` Edge Function in dry-run mode for the binding price. The function gets the route from Google Routes and runs `quote_trip`, which applies the same surge as `create_ride`.
2. **Rider requests.** `request-ride` runs `create_ride` (service role) and then `dispatch_ride`, which offers the ride to the nearest eligible captain not yet offered it (PostGIS, within 5 km).
3. **Captain responds.**
   - `accept_ride`, then `transition_ride('driver_arriving')`.
   - Or `decline_ride`, which moves to the next captain.
   - `expire_ride_offers()` handles 20-second offer timeouts and cancels the ride after 5 minutes with no captain (`no_captain_available`).
4. **Pickup.** The captain calls `transition_ride('driver_arrived')`. The rider's app shows the code from `issue_ride_verification_code`, and the captain enters it with `start_ride(code)`.
5. **During the trip.** `update_driver_location` stores breadcrumbs. On completion, `transition_ride('completed')` computes the actual distance and duration from them.
6. **Ratings:** `rate_ride` on both sides.

The database enforces every step: the state machine, roles, consents, one active ride per person, and fare arithmetic.

## Live data in the apps

- `src/data/serverMirror.ts` subscribes to `rides` over Realtime (RLS applies), re-reads each change through `ride_view`, and merges it into the local store with `server: true`. The existing screens render it unchanged, and the demo simulator skips it. A 15-second poll covers missed events.
- The rider follows the captain's GPS through Realtime on `driver_locations`, which has plain `lat`/`lng` columns.
- The captain app streams GPS with `navigator.geolocation.watchPosition` while online: at most every 4 s or 25 m. Implausible jumps (over 250 km/h) are rejected on the server.
- **Location privacy:** live location is collected only while the captain is online. Breadcrumbs are kept only for `in_progress` trips and purged after 180 days. The rider map shows nearby cars snapped to a roughly 200 m grid, without captain IDs.

## Setup

**Database:** `npx supabase db push` applies `20261127000100_trips_realtime.sql`.

**Dispatch timer** (choose one):
- Enable **pg_cron** (Database → Extensions) *before* pushing. The migration then schedules `expire_ride_offers()` every 5 s and the breadcrumb purge daily. If you enable it later, run the two `cron.schedule` calls from the end of the migration.
- Or deploy `dispatch-tick`, set `DISPATCH_CRON_SECRET`, and call it every few seconds from an external scheduler with the header `x-cron-secret`.

**Realtime:** `rides`, `ride_events`, `driver_locations` and `ticket_messages` are added to the `supabase_realtime` publication by migration 009.

**Edge Functions:**
```bash
npx supabase functions deploy request-ride
npx supabase functions deploy dispatch-tick          # only without pg_cron
npx supabase secrets set GOOGLE_MAPS_SERVER_KEY=...  DISPATCH_CRON_SECRET=...
npm run typecheck:functions                          # local check, no Deno needed
```

**Google Cloud (two keys):**
- **Browser key** (`VITE_GOOGLE_MAPS_API_KEY`): Maps JavaScript API, Places API (New) and Geocoding API, restricted to your domains. Set `VITE_MAPS_PROVIDER=google`, and optionally `VITE_GOOGLE_MAPS_MAP_ID` (otherwise `DEMO_MAP_ID` is used).
- **Server key** (`GOOGLE_MAPS_SERVER_KEY`): Routes API only. Stored as a Supabase secret, never with a `VITE_` prefix.

**Testing with real captains:** in Supabase mode, captains must already exist on the server, because onboarding with document upload is a later stage. Create one by approving an application with the admin RPCs, or for a dev project by inserting the `drivers` and `vehicles` rows directly, as `makeCaptain()` does in `tests/db/database.test.ts`.

## Not yet in Supabase mode

- Payments and settlement (Stage 5); tips are not stored yet.
- Captain onboarding and document upload to Storage.
- The admin console's live map and trips pages (still demo data).
- In-trip chat, scheduled rides and support tickets.
