/**
 * POST /functions/v1/wasl-worker   (header x-cron-secret: <WASL_CRON_SECRET>)
 * Drains the Wasl work queue: captain/vehicle registration, daily eligibility
 * re-checks, trip registration at start and trip updates at completion.
 * Schedule every minute. WASL_MODE=mock (default) or live (see _shared/wasl/http.ts).
 */
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { corsHeaders, json, safeEqual } from '../_shared/http.ts'
import { getWaslProvider, runWaslWorker } from '../_shared/wasl/worker.ts'
import { createWaslDb } from '../_shared/wasl/db.ts'
import { guardedFetch, refusal, runtimeGuard } from '../_shared/ops/runtimeGuard.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const env = (k: string) => Deno.env.get(k)
  const secret = env('WASL_CRON_SECRET') ?? ''
  if (!secret || !safeEqual(req.headers.get('x-cron-secret') ?? '', secret)) return json(401, { error: 'unauthorized' })

  const admin = createClient(env('SUPABASE_URL') ?? '', env('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  // BETA / production guard (D3, C1): refuse before any provider call when the environment is not safe.
  const guard = await runtimeGuard(admin, env)
  if (!guard.ok) {
    const r = refusal(guard)
    return json(r.status, r.body)
  }
  const liveFetch = guardedFetch(guard, (u: string, i: { method: string; headers: Record<string, string>; body?: string }) => fetch(u, i))
  let provider
  try {
    provider = getWaslProvider(env, liveFetch)
  } catch {
    return json(500, { error: 'wasl_not_configured' })
  }
  const db = createWaslDb(admin)
  return json(200, await runWaslWorker({ provider, queue: () => db.queue(), record: (r) => db.record(r) }))
})
