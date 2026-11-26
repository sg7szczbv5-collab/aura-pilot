/**
 * GET /functions/v1/health   (deploy with --no-verify-jwt so uptime monitors can call it)
 * 200 when every readiness blocker passes and the environment guard is satisfied, 503
 * otherwise (database unreachable, marker missing/corrupt, integrity failed or stale > 3 min). Add header x-health-secret: <HEALTH_SECRET> to see failing checks.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { corsHeaders, json, safeEqual } from '../_shared/http.ts'
import { healthResponse, type Readiness } from '../_shared/ops/health.ts'
import { runtimeGuard } from '../_shared/ops/runtimeGuard.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' })
  const env = (k: string) => Deno.env.get(k)
  const secret = env('HEALTH_SECRET') ?? ''
  const detailed = !!secret && safeEqual(req.headers.get('x-health-secret') ?? '', secret)

  const admin = createClient(env('SUPABASE_URL') ?? '', env('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  // With the secret, run the integrity check first (fallback scheduler when pg_cron is unavailable).
  if (detailed) {
    try {
      await admin.rpc('ops_integrity_check')
    } catch {
      // reported below as integrity_failed / stale
    }
  }
  const guard = await runtimeGuard(admin, env)
  let report: Readiness | null = null
  try {
    const { data, error } = await admin.rpc('ops_readiness')
    if (!error) report = data as Readiness
  } catch {
    report = null
  }
  const r = healthResponse(report, { detailed, version: env('AURA_VERSION'), guard })
  return json(r.status, r.body)
})
