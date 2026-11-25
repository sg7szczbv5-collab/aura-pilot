/**
 * POST /functions/v1/dispatch-tick   (header x-cron-secret: <DISPATCH_CRON_SECRET>)
 * Expires captain offers, re-dispatches, and cancels rides nobody accepted.
 * Use this only if pg_cron is not enabled (the migration schedules the same
 * work every 5 s through pg_cron when it is available).
 */
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { corsHeaders, json, safeEqual } from '../_shared/http.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const secret = Deno.env.get('DISPATCH_CRON_SECRET') ?? ''
  if (!secret || !safeEqual(req.headers.get('x-cron-secret') ?? '', secret)) return json(401, { error: 'unauthorized' })

  const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await admin.rpc('expire_ride_offers')
  if (error) return json(500, { error: 'dispatch_failed' })
  return json(200, { processed: data })
})
