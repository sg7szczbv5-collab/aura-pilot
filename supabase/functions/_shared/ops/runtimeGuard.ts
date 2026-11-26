/**
 * BETA / production runtime guard for the Edge Functions (D3 + C1 + PROD_PROJECT_REF binding).
 *
 * Every function that can move money or talk to Elm (payments, payments-webhook,
 * payments-worker, wasl-worker, request-ride) asks the database for its environment
 * (public.ops_runtime_config(), service_role only) and refuses to work when:
 *   - the database cannot be read, or the environment marker is missing / corrupt,
 *   - the project the function is bound to (SUPABASE_URL, set by the platform) is not
 *     the project the marker names,
 *   - the integrity check failed or is stale,
 *   - a live provider (Moyasar, Wasl live, a bank payout provider) or a live credential
 *     is configured while live operations are not allowed.
 * Live operations are allowed only in production: marker mode = production AND the
 * marker's project ref = PROD_PROJECT_REF below = ops_guard.prod_project_ref() in the
 * database = the ref in SUPABASE_URL. Both constants are NULL until a human verifies the
 * production ref, so today live operations are refused everywhere (fail closed).
 *
 * guardedFetch() is the only fetch handed to payment / Wasl providers: while live is not
 * allowed it only lets Google Maps routing through, so a misconfiguration cannot reach
 * Moyasar or Elm.
 */

/**
 * The production Supabase project ref. UNVERIFIED: deliberately null. Set it (and the
 * matching ops_guard.prod_project_ref() in a new migration) only after a human confirms the
 * value from the Supabase dashboard — never from supabase/.temp or any cached file.
 */
export const PROD_PROJECT_REF: string | null = null

/** Integrity results older than this are treated as failed (the job runs every minute). */
export const INTEGRITY_MAX_AGE_MS = 3 * 60 * 1000

export type RuntimeConfig = {
  marker_state: 'ok' | 'missing' | 'corrupt'
  mode: 'production' | 'beta' | null
  project_ref: string | null
  prod_project_ref: string | null
  live_allowed: boolean
  integrity_ok: boolean | null
  integrity_checked_at: string | null
}

export type GuardDecision = {
  /** The function may run at all (mock providers only, unless liveAllowed). */
  ok: boolean
  /** Outbound calls to live providers (Moyasar, Elm, banks) are allowed. */
  liveAllowed: boolean
  mode: 'production' | 'beta' | null
  reasons: string[]
}

type Env = (k: string) => string | undefined

/** `https://<ref>.supabase.co` → ref. Anything else (custom domains, http, localhost) → null. */
export function projectRefFromUrl(url: string | undefined): string | null {
  if (!url) return null
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url.trim())
  return m ? m[1] : null
}

/** Which live integrations the environment variables ask for. */
export function liveRequests(env: Env): string[] {
  const out: string[] = []
  const provider = env('PAYMENT_PROVIDER') ?? 'mock'
  if (provider !== 'mock') out.push(`PAYMENT_PROVIDER=${provider}`)
  if ((env('WASL_MODE') ?? 'mock') !== 'mock') out.push(`WASL_MODE=${env('WASL_MODE')}`)
  if ((env('PAYOUT_PROVIDER') ?? 'mock') !== 'mock') out.push(`PAYOUT_PROVIDER=${env('PAYOUT_PROVIDER')}`)
  if (/^sk_live_/.test(env('MOYASAR_SECRET_KEY') ?? '')) out.push('MOYASAR_SECRET_KEY is a live key')
  if ((env('WASL_APP_KEY') ?? '') !== '') out.push('WASL_APP_KEY is set')
  return out
}

/** Pure decision: no I/O, so it is unit-tested exhaustively. */
export function decideRuntime(p: { supabaseUrl: string | undefined; env: Env; config: RuntimeConfig | null; now?: Date; prodRef?: string | null }): GuardDecision {
  const prodRef = p.prodRef === undefined ? PROD_PROJECT_REF : p.prodRef
  const reasons: string[] = []
  const c = p.config
  const urlRef = projectRefFromUrl(p.supabaseUrl)
  if (!c) reasons.push('environment_unreadable')
  else {
    if (c.marker_state !== 'ok') reasons.push(`marker_${c.marker_state}`)
    if (!urlRef) reasons.push('supabase_url_not_a_project_url')
    else if (c.project_ref !== urlRef) reasons.push('supabase_url_does_not_match_marker')
    if (c.integrity_ok !== true) reasons.push('integrity_failed')
    else {
      const at = c.integrity_checked_at ? Date.parse(c.integrity_checked_at) : NaN
      if (!Number.isFinite(at) || (p.now ?? new Date()).getTime() - at > INTEGRITY_MAX_AGE_MS) reasons.push('integrity_stale')
    }
  }
  const liveAllowed = reasons.length === 0 && !!c && c.mode === 'production' && c.live_allowed === true &&
    prodRef !== null && urlRef === prodRef && c.project_ref === prodRef && c.prod_project_ref === prodRef
  const wanted = liveRequests(p.env)
  if (wanted.length && !liveAllowed) reasons.push(`live_not_allowed:${wanted.join(',')}`)
  return { ok: reasons.length === 0, liveAllowed, mode: c?.mode ?? null, reasons }
}

type Rpc = { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> }

/** Reads the environment from the database; any failure means "unreadable" (fail closed). */
export async function readRuntimeConfig(admin: Rpc): Promise<RuntimeConfig | null> {
  try {
    const { data, error } = await admin.rpc('ops_runtime_config')
    if (error || !data || typeof data !== 'object') return null
    return data as RuntimeConfig
  } catch {
    return null
  }
}

export async function runtimeGuard(admin: Rpc, env: Env, now?: Date): Promise<GuardDecision> {
  return decideRuntime({ supabaseUrl: env('SUPABASE_URL'), env, config: await readRuntimeConfig(admin), now })
}

/** Hosts reachable while live operations are not allowed (routing only, no money, no Elm). */
const NON_LIVE_HOSTS = new Set(['routes.googleapis.com', 'maps.googleapis.com'])

export class LiveCallBlocked extends Error {
  constructor(host: string) {
    super(`live_call_blocked:${host}`)
  }
}

/** Wraps fetch so payment / Wasl providers cannot make a live call unless the guard allows it. */
export function guardedFetch<F extends (url: string, init: never) => Promise<unknown>>(decision: GuardDecision, fetchFn: F): F {
  return (async (url: string, init: never) => {
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      throw new LiveCallBlocked('invalid_url')
    }
    if (!decision.ok || (!decision.liveAllowed && !NON_LIVE_HOSTS.has(host))) throw new LiveCallBlocked(host)
    return fetchFn(url, init)
  }) as F
}

/** Response body for a refused request: reasons are not shown to callers (they go to logs). */
export function refusal(decision: GuardDecision): { status: number; body: Record<string, unknown> } {
  console.error('[ops-guard] refused:', decision.reasons.join('; '))
  return { status: 503, body: { error: 'environment_guard' } }
}
