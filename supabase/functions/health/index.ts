/**
 * GET /functions/v1/health   (deploy with --no-verify-jwt so uptime monitors can call it)
 * 200 when every readiness blocker passes, 503 otherwise (or when the database is
 * unreachable). Add header x-health-secret: <HEALTH_SECRET> to see failing checks.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { corsHeaders, json, safeEqual } from '../_shared/http.ts'
import { healthResponse, type Readiness } from '../_shared/ops/health.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' })
  const env = (k: string) => Deno.env.get(k)
  const secret = env('HEALTH_SECRET') ?? ''
  const detailed = !!secret && safeEqual(req.headers.get('x-health-secret') ?? '', secret)

  const admin = createClient(env('SUPABASE_URL') ?? '', env('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  let report: Readiness | null = null
  try {
    const { data, error } = await admin.rpc('ops_readiness')
    if (!error) report = data as Readiness
  } catch {
    report = null
  }
  const r = healthResponse(report, { detailed, version: env('AURA_VERSION') })
  return json(r.status, r.body)
})
