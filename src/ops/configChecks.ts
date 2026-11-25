/**
 * Production configuration checks (run by `npm run preflight`). Pure functions:
 * environment in, list of checks out. Never prints secret values.
 *
 * severity "blocker": the release must not go out (or stay out) with this failing.
 * severity "warning": works, but a decision or follow-up is needed.
 */
export type Severity = 'blocker' | 'warning'
export type Check = { id: string; area: string; severity: Severity; ok: boolean; detail: string }
export type Target = 'development' | 'staging' | 'production'
export type Env = Record<string, string | undefined>

const MIN_SECRET = 32
const PLACEHOLDER = /your-project-ref|your-anon|changeme|example|xxxx|<.*>/i

const has = (v?: string) => !!v && v.trim() !== '' && !PLACEHOLDER.test(v)

/** Decode a JWT payload without verifying it (only to read the role claim). */
export function jwtRole(token?: string): string | undefined {
  if (!token || token.split('.').length !== 3) return undefined
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(atob(p.padEnd(p.length + ((4 - (p.length % 4)) % 4), '=')))
    return typeof json.role === 'string' ? json.role : undefined
  } catch {
    return undefined
  }
}

/** Browser-exposed variables (Vite inlines every VITE_* into the bundle). */
const PUBLIC_ALLOWED = new Set([
  'VITE_APP_ENV', 'VITE_DEFAULT_CITY', 'VITE_DEFAULT_LOCALE', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY',
  'VITE_MAPS_PROVIDER', 'VITE_GOOGLE_MAPS_API_KEY', 'VITE_GOOGLE_MAPS_MAP_ID', 'VITE_PAYMENT_PROVIDER',
  'VITE_MOYASAR_PUBLISHABLE_KEY', 'VITE_APPLE_PAY_MERCHANT_ID', 'VITE_AUTH_OTP_LENGTH',
])

/** A value that must never reach a browser. */
export function looksSecret(value: string): boolean {
  return /^sk_(live|test)_/.test(value) || jwtRole(value) === 'service_role' || /^sb_secret_/.test(value) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
}

export function checkConfig(env: Env, target: Target): Check[] {
  const prod = target === 'production'
  const live = target !== 'development'
  const out: Check[] = []
  const add = (id: string, area: string, severity: Severity, ok: boolean, detail: string) => out.push({ id, area, severity, ok, detail })
  const blockerIf = (cond: boolean): Severity => (cond ? 'blocker' : 'warning')

  // ── Secrets hygiene ───────────────────────────────────────────────────────
  const exposed = Object.entries(env).filter(([k, v]) => k.startsWith('VITE_') && v && (looksSecret(v) || (!PUBLIC_ALLOWED.has(k) && /SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|TOKEN/i.test(k))))
  add('no_secrets_in_browser', 'security', 'blocker', exposed.length === 0,
    exposed.length === 0 ? 'No secret is exposed through a VITE_ variable' : `Secret-looking browser variables: ${exposed.map(([k]) => k).join(', ')}`)

  const anonRole = jwtRole(env.VITE_SUPABASE_ANON_KEY)
  add('anon_key_is_anon', 'security', 'blocker', anonRole !== 'service_role',
    anonRole === 'service_role' ? 'VITE_SUPABASE_ANON_KEY is a SERVICE ROLE key: rotate it now' : 'Browser key is not the service role')

  const cronSecrets = ['PAYMENTS_CRON_SECRET', 'WASL_CRON_SECRET', 'PRIVACY_CRON_SECRET', 'HEALTH_SECRET'] as const
  const weak = cronSecrets.filter((k) => live && (!has(env[k]) || (env[k] ?? '').length < MIN_SECRET))
  add('worker_secrets', 'security', blockerIf(live), weak.length === 0,
    weak.length === 0 ? `Worker/health secrets set (≥ ${MIN_SECRET} chars)` : `Missing or shorter than ${MIN_SECRET} chars: ${weak.join(', ')}`)
  const values = cronSecrets.map((k) => env[k]).filter(has)
  add('worker_secrets_distinct', 'security', 'warning', new Set(values).size === values.length, 'Each worker uses its own secret')

  // ── Supabase ──────────────────────────────────────────────────────────────
  const url = env.VITE_SUPABASE_URL ?? ''
  add('supabase_url', 'config', blockerIf(live), has(url) && /^https:\/\//.test(url),
    has(url) ? (url.startsWith('https://') ? 'Supabase URL is HTTPS' : 'Supabase URL must use HTTPS') : 'VITE_SUPABASE_URL is not set (the app would run in demo mode)')
  add('supabase_anon_key', 'config', blockerIf(live), has(env.VITE_SUPABASE_ANON_KEY), 'Browser (anon/publishable) key')
  add('app_env', 'config', 'warning', !live || env.APP_ENV === target, `APP_ENV=${env.APP_ENV ?? '(unset)'} for target ${target}`)
  const otp = Number(env.VITE_AUTH_OTP_LENGTH ?? 6)
  add('otp_length', 'config', 'warning', Number.isInteger(otp) && otp >= 6 && otp <= 10, `SMS OTP length ${otp} (must match Supabase Auth, 6+ recommended)`)

  // ── Payments ──────────────────────────────────────────────────────────────
  const provider = env.PAYMENT_PROVIDER ?? 'mock'
  add('payment_provider', 'payments', blockerIf(prod), !prod || provider === 'moyasar', `PAYMENT_PROVIDER=${provider}`)
  if (provider === 'moyasar' || prod) {
    const sk = env.MOYASAR_SECRET_KEY ?? ''
    const pk = env.VITE_MOYASAR_PUBLISHABLE_KEY ?? ''
    add('moyasar_keys', 'payments', 'blocker', /^sk_(live|test)_/.test(sk) && /^pk_(live|test)_/.test(pk), 'Moyasar secret (server) and publishable (browser) keys')
    const skLive = sk.startsWith('sk_live_')
    const pkLive = pk.startsWith('pk_live_')
    add('moyasar_mode_consistent', 'payments', 'blocker', skLive === pkLive, skLive === pkLive ? `Both keys are ${skLive ? 'live' : 'test'}` : 'Secret and publishable keys are from different modes (live/test)')
    add('moyasar_live_in_production', 'payments', blockerIf(prod), !prod || (skLive && pkLive), prod ? (skLive ? 'Live keys in production' : 'Test keys in production') : 'Test keys outside production are fine')
    add('moyasar_webhook_secret', 'payments', 'blocker', has(env.MOYASAR_WEBHOOK_SECRET) && (env.MOYASAR_WEBHOOK_SECRET ?? '').length >= 16, 'Webhook secret token (also set in the Moyasar dashboard)')
  }
  const cb = env.PAYMENT_CALLBACK_URL ?? ''
  add('payment_callback', 'payments', blockerIf(prod), !prod || (/^https:\/\//.test(cb) && !/localhost|127\.0\.0\.1/.test(cb) && cb.includes('#/passenger')),
    prod ? `3-D Secure return URL: ${cb || '(unset)'}` : 'Callback URL only checked for production')
  add('payment_provider_matches_app', 'payments', 'warning', (env.VITE_PAYMENT_PROVIDER ?? 'mock') === provider || (provider === 'moyasar' && has(env.VITE_MOYASAR_PUBLISHABLE_KEY)),
    'Browser tokenization and server provider agree (mock tokens only work with the mock provider)')

  // ── Maps ──────────────────────────────────────────────────────────────────
  const maps = env.VITE_MAPS_PROVIDER ?? 'mock'
  add('maps_provider', 'config', 'warning', !prod || (maps === 'google' && has(env.VITE_GOOGLE_MAPS_API_KEY)), `VITE_MAPS_PROVIDER=${maps}`)
  add('maps_server_key', 'config', 'warning', !prod || has(env.GOOGLE_MAPS_SERVER_KEY), has(env.GOOGLE_MAPS_SERVER_KEY) ? 'Routes API key for pricing' : 'No GOOGLE_MAPS_SERVER_KEY: prices use the straight-line estimate')
  add('maps_keys_separate', 'security', 'warning', !has(env.GOOGLE_MAPS_SERVER_KEY) || env.GOOGLE_MAPS_SERVER_KEY !== env.VITE_GOOGLE_MAPS_API_KEY,
    'Browser and server Google keys are different (each restricted separately)')

  // ── Wasl ──────────────────────────────────────────────────────────────────
  const wasl = env.WASL_MODE ?? 'mock'
  add('wasl_mode', 'wasl', blockerIf(prod), !prod || wasl === 'live', `WASL_MODE=${wasl}`)
  if (wasl === 'live') {
    add('wasl_config', 'wasl', 'blocker', /^https:\/\//.test(env.WASL_API_BASE_URL ?? '') && has(env.WASL_APP_ID) && has(env.WASL_APP_KEY), 'Wasl base URL (HTTPS), app id and key')
  }

  return out
}

/** Scan built files for secrets that must never ship to browsers. */
export function scanBundle(files: { name: string; content: string }[]): Check {
  const hits: string[] = []
  for (const f of files) {
    if (/sk_(live|test)_[A-Za-z0-9]{8,}/.test(f.content)) hits.push(`${f.name}: Moyasar secret key`)
    if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(f.content)) hits.push(`${f.name}: Supabase secret key`)
    for (const m of f.content.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)) {
      if (jwtRole(m[0]) === 'service_role') hits.push(`${f.name}: service_role JWT`)
    }
  }
  return { id: 'bundle_secrets', area: 'security', severity: 'blocker', ok: hits.length === 0, detail: hits.length === 0 ? `No secrets in ${files.length} built file(s)` : hits.join('; ') }
}

export const summarize = (checks: Check[]) => ({
  ok: !checks.some((c) => c.severity === 'blocker' && !c.ok),
  blockersFailed: checks.filter((c) => c.severity === 'blocker' && !c.ok).length,
  warnings: checks.filter((c) => c.severity === 'warning' && !c.ok).length,
  passed: checks.filter((c) => c.ok).length,
  total: checks.length,
})
