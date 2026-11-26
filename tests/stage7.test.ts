/**
 * Stage 7 unit tests: production config checks, secret scanning, security
 * headers, health responses, env parsing.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkConfig, jwtRole, looksSecret, scanBundle, summarize, type Env } from '../src/ops/configChecks'
import { allows, checkHeaders, diffVercelHeaders, parseCsp, parseHeadersFile } from '../src/ops/securityHeaders'
import { parseEnvFile } from '../src/ops/envFile'
import { healthResponse, type Readiness } from '../supabase/functions/_shared/ops/health'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role, iss: 'supabase' })).replace(/=+$/, '')}.c2lnbmF0dXJlc2lnbmF0dXJl`
const S = (n: string) => n.repeat(40)

const PROD: Env = {
  APP_ENV: 'production',
  VITE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  VITE_SUPABASE_ANON_KEY: jwt('anon'),
  SUPABASE_SERVICE_ROLE_KEY: jwt('service_role'),
  VITE_AUTH_OTP_LENGTH: '6',
  PAYMENT_PROVIDER: 'moyasar',
  VITE_PAYMENT_PROVIDER: 'moyasar',
  MOYASAR_SECRET_KEY: 'sk_live_abc123abc123',
  VITE_MOYASAR_PUBLISHABLE_KEY: 'pk_live_abc123abc123',
  MOYASAR_WEBHOOK_SECRET: 'whsec_0123456789abcdef',
  PAYMENT_CALLBACK_URL: 'https://app.aura.sa/#/passenger',
  PAYMENTS_CRON_SECRET: S('a'),
  WASL_CRON_SECRET: S('b'),
  PRIVACY_CRON_SECRET: S('c'),
  HEALTH_SECRET: S('d'),
  VITE_MAPS_PROVIDER: 'google',
  VITE_GOOGLE_MAPS_API_KEY: 'AIza-browser',
  GOOGLE_MAPS_SERVER_KEY: 'AIza-server',
  WASL_MODE: 'live',
  WASL_API_BASE_URL: 'https://wasl.example.sa',
  WASL_APP_ID: 'app',
  WASL_APP_KEY: 'key',
}
/** These tests model a production ref that has been verified; the shipped constant is still null (see below). */
const VERIFIED_REF = 'abcdefghijklmnopqrst'
const failing = (env: Env, target: 'production' | 'staging' | 'development' = 'production') =>
  checkConfig(env, target, VERIFIED_REF).filter((c) => !c.ok && c.severity === 'blocker').map((c) => c.id)

describe('production configuration checks', () => {
  it('a complete production configuration is ready once the production ref is verified', () => {
    const checks = checkConfig(PROD, 'production', VERIFIED_REF)
    expect(checks.filter((c) => !c.ok)).toEqual([])
    expect(summarize(checks).ok).toBe(true)
  })

  it('with the shipped (unverified, null) PROD_PROJECT_REF a production deploy is blocked — by that alone', () => {
    const blockers = checkConfig(PROD, 'production').filter((c) => !c.ok && c.severity === 'blocker').map((c) => c.id)
    expect(blockers).toEqual(['production_binding'])
  })

  it('catches secrets leaking into the browser bundle variables', () => {
    expect(failing({ ...PROD, VITE_SUPABASE_ANON_KEY: jwt('service_role') })).toEqual(expect.arrayContaining(['no_secrets_in_browser', 'anon_key_is_anon']))
    expect(failing({ ...PROD, VITE_MOYASAR_SECRET: 'sk_live_xyz' })).toContain('no_secrets_in_browser')
    expect(failing({ ...PROD, VITE_STRIPE_TOKEN: 'abc' })).toContain('no_secrets_in_browser')
    expect(looksSecret('pk_live_abc')).toBe(false)
    expect(jwtRole(jwt('anon'))).toBe('anon')
    expect(jwtRole('not-a-jwt')).toBeUndefined()
  })

  it('refuses test/mock providers and mixed keys in production, accepts them in staging', () => {
    expect(failing({ ...PROD, PAYMENT_PROVIDER: 'mock' })).toContain('payment_provider')
    expect(failing({ ...PROD, MOYASAR_SECRET_KEY: 'sk_test_abc', VITE_MOYASAR_PUBLISHABLE_KEY: 'pk_test_abc' })).toEqual(['moyasar_live_in_production'])
    expect(failing({ ...PROD, MOYASAR_SECRET_KEY: 'sk_test_abc' })).toEqual(expect.arrayContaining(['moyasar_mode_consistent']))
    expect(failing({ ...PROD, WASL_MODE: 'mock' })).toEqual(['wasl_mode'])
    expect(failing({ ...PROD, WASL_API_BASE_URL: 'http://insecure' })).toEqual(['wasl_config'])
    expect(failing({ ...PROD, PAYMENT_CALLBACK_URL: 'http://localhost:5180/#/passenger' })).toEqual(['payment_callback'])
    // staging is the closed BETA (migration 021): mock providers only, no Elm credentials.
    const { WASL_APP_ID: _a, WASL_APP_KEY: _k, ...noWasl } = PROD
    const staging = { ...noWasl, APP_ENV: 'staging', VITE_SUPABASE_URL: 'https://betabetabetabetabeta.supabase.co', BETA_PROJECT_REF: 'betabetabetabetabeta', MOYASAR_SECRET_KEY: 'sk_test_abc', VITE_MOYASAR_PUBLISHABLE_KEY: 'pk_test_abc', WASL_MODE: 'mock' }
    expect(failing(staging, 'staging')).toEqual(['beta_payments_mock', 'beta_no_provider_credentials'])
    const { MOYASAR_SECRET_KEY: _s, VITE_MOYASAR_PUBLISHABLE_KEY: _p, MOYASAR_WEBHOOK_SECRET: _w, ...noMoyasar } = staging
    expect(failing({ ...noMoyasar, PAYMENT_PROVIDER: 'mock', VITE_PAYMENT_PROVIDER: 'mock' }, 'staging')).toEqual([])
  })

  it('demands strong, distinct worker secrets outside development', () => {
    expect(failing({ ...PROD, HEALTH_SECRET: 'short' })).toEqual(['worker_secrets'])
    const same = checkConfig({ ...PROD, WASL_CRON_SECRET: S('a') }, 'production').find((c) => c.id === 'worker_secrets_distinct')
    expect(same).toMatchObject({ ok: false, severity: 'warning' })
    expect(failing({}, 'development')).toEqual([])
  })
})

describe('bundle secret scan', () => {
  it('finds secret keys and service-role JWTs in built files only', () => {
    expect(scanBundle([{ name: 'assets/index.js', content: `const k="${jwt('anon')}"; const p="pk_live_123"` }]).ok).toBe(true)
    const bad = scanBundle([
      { name: 'a.js', content: `x="sk_live_0123456789"` },
      { name: 'b.js', content: `y="${jwt('service_role')}"` },
    ])
    expect(bad.ok).toBe(false)
    expect(bad.detail).toContain('a.js: Moyasar secret key')
    expect(bad.detail).toContain('b.js: service_role JWT')
  })
})

describe('security headers (public/_headers)', () => {
  const file = readFileSync(join(ROOT, 'public', '_headers'), 'utf8')

  it('the shipped headers pass every check', () => {
    expect(checkHeaders(file).filter((c) => !c.ok)).toEqual([])
  })

  it('parses rules and CSP, and matches wildcard origins correctly', () => {
    const rules = parseHeadersFile(file)
    expect(Object.keys(rules)).toEqual(['/*', '/assets/*', '/index.html'])
    const csp = parseCsp(rules['/*']['content-security-policy'])
    expect(csp['frame-ancestors']).toEqual(["'none'"])
    expect(allows(csp['connect-src'], 'wss://xyz.supabase.co')).toBe(true)
    expect(allows(csp['connect-src'], 'https://evil.co')).toBe(false)
    expect(allows(csp['connect-src'], 'https://supabase.co.evil.com')).toBe(false)
    expect(allows(['https://*.supabase.co'], 'wss://x.supabase.co')).toBe(false) // scheme must match
  })

  it('flags a weakened policy', () => {
    const weak = file.replace("frame-ancestors 'none'", "frame-ancestors *").replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace('https://api.moyasar.com ', '')
    const ids = checkHeaders(weak).filter((c) => !c.ok).map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining(['csp_frame_ancestors', 'csp_no_inline_script', 'csp_connect_origins']))
  })
})

describe('health endpoint response', () => {
  const report = (ok: boolean): Readiness => ({
    ok,
    generated_at: '2026-11-30T00:00:00Z',
    summary: { blockers_failed: ok ? 0 : 1, warnings: 1, passed: 10, total: 12 },
    checks: [
      { id: 'rls_enabled', area: 'security', severity: 'blocker', ok, detail: ok ? 'fine' : 'RLS disabled on: promos' },
      { id: 'no_mock_wasl', area: 'wasl', severity: 'warning', ok: false, detail: 'mock' },
    ],
  })
  it('200 when blockers pass, 503 when not or when the database is down; details only with the secret', () => {
    const now = new Date('2026-11-30T01:00:00Z')
    expect(healthResponse(report(true), { detailed: false, now })).toEqual({
      status: 200,
      body: { service: 'aura', version: 'unknown', checked_at: now.toISOString(), status: 'ok_with_warnings', blockers_failed: 0, warnings: 1 },
    })
    const bad = healthResponse(report(false), { detailed: true, now })
    expect(bad.status).toBe(503)
    expect(bad.body.failing).toEqual([
      { id: 'rls_enabled', area: 'security', severity: 'blocker', detail: 'RLS disabled on: promos' },
      { id: 'no_mock_wasl', area: 'wasl', severity: 'warning', detail: 'mock' },
    ])
    expect(healthResponse(report(false), { detailed: false }).body).not.toHaveProperty('failing')
    expect(healthResponse(null, { detailed: true })).toMatchObject({ status: 503, body: { status: 'down' } })
  })
})

describe('.env parsing', () => {
  it('handles comments, quotes and export without evaluating anything', () => {
    expect(parseEnvFile('# c\nexport A=1\nB="two words"\nC=x # note\nD=\'$(rm -rf /)\'\nbad line\n')).toEqual({ A: '1', B: 'two words', C: 'x', D: '$(rm -rf /)' })
  })
})

describe('vercel.json security headers', () => {
  const headers = readFileSync(join(ROOT, 'public', '_headers'), 'utf8')
  const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'))
  it('carries exactly the headers of public/_headers (Vercel ignores _headers)', () => {
    expect(diffVercelHeaders(headers, vercel)).toEqual([])
  })
  it('detects drift', () => {
    const changed = structuredClone(vercel)
    changed.headers[0].headers[0].value = "default-src *"
    expect(diffVercelHeaders(headers, changed)).toEqual(['/*: content-security-policy'])
  })
  it('CSP allows the map providers the app can use (Google, Mapbox)', () => {
    const csp = parseCsp(parseHeadersFile(headers)['/*']['content-security-policy'])
    for (const u of ['https://api.mapbox.com', 'https://events.mapbox.com', 'https://a.tiles.mapbox.com', 'https://maps.googleapis.com']) expect(allows(csp['connect-src'], u)).toBe(true)
  })
})
