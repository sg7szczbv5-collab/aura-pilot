/**
 * POST /functions/v1/request-ride   (Authorization: Bearer <rider JWT>)
 * body: { city?, pickup:{lat,lng,address}, dropoff:{…}, vehicleClass, paymentMethod,
 *         paymentMethodId? | paymentToken?, promoCode?, dryRun? }
 * dryRun → { route, quotes }   else → { rideId, fareTotal, route, dispatched, [paymentStatus, transactionUrl] }
 *
 * Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (provided by
 * Supabase), GOOGLE_MAPS_SERVER_KEY (optional; without it distances are estimated),
 * PAYMENT_PROVIDER / MOYASAR_* / PAYMENT_CALLBACK_URL for card rides.
 * Wiring lives in _shared/requestRideDeps.ts (shared with the end-to-end test).
 */
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { corsHeaders, json } from '../_shared/http.ts'
import { handleRequestRide } from '../_shared/requestRide.ts'
import { buildRequestRideDeps } from '../_shared/requestRideDeps.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  const env = (k: string) => Deno.env.get(k)

  // The rider's own client: RLS + auth.uid() apply (quotes, promo limits).
  const userClient = createClient(env('SUPABASE_URL') ?? '', env('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  // Service client: create_ride / dispatch_ride / payments are not callable by clients.
  const admin = createClient(env('SUPABASE_URL') ?? '', env('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData } = await userClient.auth.getUser()
  const body = await req.json().catch(() => null)

  const result = await handleRequestRide(
    body,
    buildRequestRideDeps({ userId: userData.user?.id ?? null, userClient, admin, env, fetch: (u, i) => fetch(u, i) }),
  )
  return json(result.status, result.body)
})
