/**
 * POST /functions/v1/payments-worker   (header x-cron-secret: <PAYMENTS_CRON_SECRET>)
 * Captures card rides after completion, voids authorizations of cancelled rides,
 * executes approved refunds, and re-syncs stale payments. Schedule every minute
 * (Supabase Cron → HTTP request, or any scheduler).
 */
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { corsHeaders, json, safeEqual } from '../_shared/http.ts'
import { runPaymentWorker } from '../_shared/payments/handlers.ts'
import { createPaymentsDb } from '../_shared/payments/db.ts'
import { getProvider } from '../_shared/payments/registry.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const env = (k: string) => Deno.env.get(k)
  const secret = env('PAYMENTS_CRON_SECRET') ?? ''
  if (!secret || !safeEqual(req.headers.get('x-cron-secret') ?? '', secret)) return json(401, { error: 'unauthorized' })

  const admin = createClient(env('SUPABASE_URL') ?? '', env('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const fetchFn = (u: string, i: { method: string; headers: Record<string, string>; body?: string }) => fetch(u, i)
  const db = createPaymentsDb(admin, (env('PAYMENT_PROVIDER') ?? 'mock') as 'mock' | 'moyasar')
  const summary = await runPaymentWorker({
    queue: () => db.queue(),
    provider: (name) => getProvider(name, env, fetchFn),
    db,
  })
  return json(200, summary)
})
