/**
 * BETA security — unit tests (no database): A7 (workers refuse on a bad environment), A8
 * (production identity binding), A12 (preflight + Deploy gate), no live call to Moyasar or Elm
 * when the guard fails, BETA settings cannot switch production on, and no demo data on live
 * (Supabase-mode) screens. The database layers are tested in tests/db/beta_security.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decideRuntime, guardedFetch, INTEGRITY_MAX_AGE_MS, LiveCallBlocked, liveRequests, PROD_PROJECT_REF as EDGE_PROD_REF,
  projectRefFromUrl, readRuntimeConfig, refusal, runtimeGuard, type GuardDecision, type RuntimeConfig,
} from '../supabase/functions/_shared/ops/runtimeGuard'
import { getProvider } from '../supabase/functions/_shared/payments/registry'
import { getWaslProvider } from '../supabase/functions/_shared/wasl/worker'
import { healthResponse, type Readiness } from '../supabase/functions/_shared/ops/health'
import { checkConfig, checkGuard, type Env, type GuardConfig } from '../src/ops/configChecks'
import { PROD_PROJECT_REF as APP_PROD_REF, projectRefFromUrl as appRefFromUrl } from '../src/ops/prodBinding'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const BETA = 'betabetabetabetabeta'
const PROD = 'prodprodprodprodprod'
const NOW = new Date('2026-11-26T12:00:00Z')
const fresh = new Date(NOW.getTime() - 60_000).toISOString()
const url = (ref: string) => `https://${ref}.supabase.co`
const env = (vars: Record<string, string> = {}) => (k: string) => vars[k]

const betaCfg = (o: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  marker_state: 'ok', mode: 'beta', project_ref: BETA, prod_project_ref: null, live_allowed: false,
  integrity_ok: true, integrity_checked_at: fresh, ...o,
})
const prodCfg = (o: Partial<RuntimeConfig> = {}): RuntimeConfig => betaCfg({ mode: 'production', project_ref: PROD, prod_project_ref: PROD, live_allowed: true, ...o })

// ────────────────────────────────────────────────────────────────────────────
describe('A7 · D3: workers refuse before any external call when the environment is not safe', () => {
  const decide = (config: RuntimeConfig | null, vars: Record<string, string> = {}, u = url(BETA)) =>
    decideRuntime({ supabaseUrl: u, env: env(vars), config, now: NOW, prodRef: null })

  it('a healthy BETA with mock providers runs (mock only)', () => {
    expect(decide(betaCfg())).toEqual({ ok: true, liveAllowed: false, mode: 'beta', reasons: [] })
  })
  it('integrity failed / stale / never ran → refused', () => {
    expect(decide(betaCfg({ integrity_ok: false })).reasons).toEqual(['integrity_failed'])
    expect(decide(betaCfg({ integrity_checked_at: new Date(NOW.getTime() - INTEGRITY_MAX_AGE_MS - 1).toISOString() })).reasons).toEqual(['integrity_stale'])
    expect(decide(betaCfg({ integrity_ok: null, integrity_checked_at: null })).reasons).toEqual(['integrity_failed'])
    expect(decide(betaCfg({ integrity_checked_at: 'garbage' })).ok).toBe(false)
  })
  it('marker missing / corrupt → refused', () => {
    expect(decide(betaCfg({ marker_state: 'missing', mode: null, project_ref: null })).ok).toBe(false)
    expect(decide(betaCfg({ marker_state: 'corrupt' })).reasons).toContain('marker_corrupt')
  })
  it('database error or missing function (readRuntimeConfig → null) → refused', async () => {
    expect(decide(null)).toMatchObject({ ok: false, reasons: ['environment_unreadable'] })
    const missingFn = { rpc: async () => ({ data: null, error: { message: 'Could not find the function public.ops_runtime_config' } }) }
    const throws = { rpc: async () => { throw new Error('network') } }
    const notObject = { rpc: async () => ({ data: 'ok', error: null }) }
    expect(await readRuntimeConfig(missingFn)).toBeNull()
    expect(await readRuntimeConfig(throws)).toBeNull()
    expect(await readRuntimeConfig(notObject)).toBeNull()
    const g = await runtimeGuard(missingFn, env({ SUPABASE_URL: url(BETA) }))
    expect(g.ok).toBe(false)
  })
  it('a live provider or live credential in BETA → refused (C1)', () => {
    for (const vars of [{ PAYMENT_PROVIDER: 'moyasar' }, { WASL_MODE: 'live' }, { PAYOUT_PROVIDER: 'bank' },
      { MOYASAR_SECRET_KEY: 'sk_live_xxxxxxxx' }, { WASL_APP_KEY: 'k' }]) {
      const d = decide(betaCfg(), vars)
      expect(d.ok, JSON.stringify(vars)).toBe(false)
      expect(d.reasons.join()).toMatch(/live_not_allowed/)
    }
    expect(liveRequests(env({ MOYASAR_SECRET_KEY: 'sk_test_x' }))).toEqual([])
  })
  it('the refusal body hides the reasons (they go to the logs)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(refusal({ ok: false, liveAllowed: false, mode: 'beta', reasons: ['integrity_failed'] })).toEqual({ status: 503, body: { error: 'environment_guard' } })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('A8 · identity binding: SUPABASE_URL ↔ marker ↔ PROD_PROJECT_REF ↔ database', () => {
  const decide = (config: RuntimeConfig, u: string, prodRef: string | null, vars: Record<string, string> = {}) =>
    decideRuntime({ supabaseUrl: u, env: env(vars), config, now: NOW, prodRef })

  it('only a full match allows live: production marker + URL + constant + database all equal', () => {
    expect(decide(prodCfg(), url(PROD), PROD, { PAYMENT_PROVIDER: 'moyasar' })).toMatchObject({ ok: true, liveAllowed: true })
  })
  it('URL of another project than the marker → refused (SUPABASE_URL substitution)', () => {
    expect(decide(prodCfg(), url(BETA), PROD).reasons).toContain('supabase_url_does_not_match_marker')
    expect(decide(betaCfg(), url(PROD), null).reasons).toContain('supabase_url_does_not_match_marker')
  })
  it('URL that is not a project URL (custom domain, http, typo) → refused', () => {
    for (const u of ['https://api.aura.sa', `http://${PROD}.supabase.co`, `https://${PROD}.supabase.co.evil.sa`, '', 'https://short.supabase.co']) {
      expect(decide(prodCfg(), u, PROD).reasons, u).toContain('supabase_url_not_a_project_url')
    }
  })
  it('production marker but constant null / different / database says otherwise → no live', () => {
    expect(decide(prodCfg(), url(PROD), null, { PAYMENT_PROVIDER: 'moyasar' })).toMatchObject({ ok: false, liveAllowed: false })
    expect(decide(prodCfg(), url(PROD), BETA).liveAllowed).toBe(false)
    expect(decide(prodCfg({ prod_project_ref: null }), url(PROD), PROD).liveAllowed).toBe(false)
    expect(decide(prodCfg({ live_allowed: false }), url(PROD), PROD).liveAllowed).toBe(false)
  })
  it('the shipped constants are null (UNVERIFIED) and identical in the app and the Edge Functions', () => {
    expect(EDGE_PROD_REF).toBeNull()
    expect(APP_PROD_REF).toBeNull()
    expect(projectRefFromUrl(url(PROD))).toBe(PROD)
    for (const u of [url(PROD), 'https://x.supabase.co', undefined, 'https://api.aura.sa']) expect(appRefFromUrl(u)).toBe(projectRefFromUrl(u))
    // The default decision uses the shipped constant: nothing can be live today.
    expect(decideRuntime({ supabaseUrl: url(PROD), env: env(), config: prodCfg(), now: NOW }).liveAllowed).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('no live call to Moyasar or Elm when the guard fails', () => {
  const refused: GuardDecision = { ok: false, liveAllowed: false, mode: 'beta', reasons: ['integrity_failed'] }
  const betaOk: GuardDecision = { ok: true, liveAllowed: false, mode: 'beta', reasons: [] }
  const live: GuardDecision = { ok: true, liveAllowed: true, mode: 'production', reasons: [] }
  const okResponse = { ok: true, status: 200, json: async () => ({}) }

  it('guardedFetch blocks Moyasar, Elm and anything unknown unless live is allowed; never calls the real fetch', async () => {
    for (const d of [refused, betaOk]) {
      const real = vi.fn(async () => okResponse)
      const f = guardedFetch(d, real)
      for (const u of ['https://api.moyasar.com/v1/payments', 'https://wasl.elm.sa/api/trips', 'https://example.org', 'not a url']) {
        await expect(f(u, { method: 'POST', headers: {} } as never)).rejects.toBeInstanceOf(LiveCallBlocked)
      }
      expect(real).not.toHaveBeenCalled()
    }
  })
  it('routing (Google) still works in a healthy BETA, but not when the guard failed', async () => {
    const real = vi.fn(async () => okResponse)
    await guardedFetch(betaOk, real)('https://routes.googleapis.com/directions/v2:computeRoutes', { method: 'POST', headers: {} } as never)
    expect(real).toHaveBeenCalledTimes(1)
    await expect(guardedFetch(refused, real)('https://routes.googleapis.com/x', { method: 'POST', headers: {} } as never)).rejects.toBeInstanceOf(LiveCallBlocked)
  })
  it('a Moyasar provider built with guardedFetch cannot reach Moyasar (even with a key configured)', async () => {
    const real = vi.fn(async () => okResponse)
    const p = getProvider('moyasar', env({ MOYASAR_SECRET_KEY: 'sk_test_dummy', MOYASAR_WEBHOOK_SECRET: 'whsec_dummy_dummy' }), guardedFetch(betaOk, real))
    await expect(p.fetchPayment('pay_1')).rejects.toThrow()
    await expect(p.refund('pay_1', 100n)).rejects.toThrow()
    expect(real).not.toHaveBeenCalled()
  })
  it('a live Wasl provider built with guardedFetch cannot reach Elm', async () => {
    const real = vi.fn(async () => okResponse)
    const w = getWaslProvider(env({ WASL_MODE: 'live', WASL_API_BASE_URL: 'https://wasl.elm.sa', WASL_APP_ID: 'id', WASL_APP_KEY: 'key' }), guardedFetch(refused, real))
    const r = await w.call('eligibility_check', { driverId: 'x' }).catch((e: Error) => ({ thrown: e.message }))
    expect(JSON.stringify(r)).toMatch(/live_call_blocked/)
    expect(real).not.toHaveBeenCalled()
  })
  it('live is reachable only through a fully bound production decision', async () => {
    const real = vi.fn(async () => okResponse)
    await guardedFetch(live, real)('https://api.moyasar.com/v1/payments/x', { method: 'GET', headers: {} } as never)
    expect(real).toHaveBeenCalledTimes(1)
  })
  it('every money / Elm Edge Function checks the guard before building a provider, and only hands providers liveFetch', () => {
    for (const fn of ['payments', 'payments-webhook', 'payments-worker', 'wasl-worker', 'request-ride']) {
      const src = read(`supabase/functions/${fn}/index.ts`)
      const guardAt = src.indexOf('await runtimeGuard(admin, env)')
      expect(guardAt, fn).toBeGreaterThan(0)
      expect(src.indexOf('if (!guard.ok)'), fn).toBeGreaterThan(guardAt)
      for (const use of ['getProvider(', 'getWaslProvider(', 'buildRequestRideDeps(', 'handlePaymentAction(', 'handleWebhook(', 'runPaymentWorker(', 'runWaslWorker(']) {
        const at = src.indexOf(use, src.indexOf('Deno.serve'))
        if (at > 0) expect(at, `${fn}: ${use}`).toBeGreaterThan(guardAt)
      }
      // The only raw fetch is the one wrapped by guardedFetch.
      expect(src.match(/fetch\(u, i\)/g)?.length ?? 0, fn).toBe(1)
      expect(src, fn).toMatch(/guardedFetch\(guard, \(u: string[^)]*\) => fetch\(u, i\)\)/)
    }
  })
  it('D2: /health is 503 whenever the guard fails, even with a green readiness report', () => {
    const report: Readiness = { ok: true, generated_at: NOW.toISOString(), summary: { blockers_failed: 0, warnings: 0, passed: 1, total: 1 }, checks: [] }
    expect(healthResponse(report, { detailed: false, guard: refused })).toMatchObject({ status: 503, body: { status: 'guard_failed' } })
    expect(healthResponse(report, { detailed: false, guard: refused }).body).not.toHaveProperty('guard')
    expect(healthResponse(report, { detailed: true, guard: refused }).body).toMatchObject({ guard: ['integrity_failed'] })
    expect(healthResponse(report, { detailed: false, guard: betaOk })).toMatchObject({ status: 200, body: { environment: 'beta', live: false } })
    expect(read('supabase/functions/health/index.ts')).toMatch(/healthResponse\(report, \{[^}]*guard \}\)/)
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('A12 · preflight and Deploy fail closed', () => {
  const S = (c: string) => c.repeat(40)
  const BASE: Env = {
    APP_ENV: 'staging', VITE_SUPABASE_URL: url(BETA), SUPABASE_PROJECT_REF: BETA, VITE_SUPABASE_ANON_KEY: 'anon-key-value',
    PAYMENTS_CRON_SECRET: S('a'), WASL_CRON_SECRET: S('b'), PRIVACY_CRON_SECRET: S('c'), HEALTH_SECRET: S('d'),
  }
  const blockers = (e: Env, target: 'staging' | 'production' = 'staging', prodRef: string | null = PROD) =>
    checkConfig(e, target, prodRef).filter((c) => !c.ok && c.severity === 'blocker').map((c) => c.id)

  it('a mock-only BETA configuration passes', () => {
    expect(blockers(BASE)).toEqual([])
  })
  it('staging pointing at the production project is a blocker (URL or deploy target)', () => {
    expect(blockers({ ...BASE, VITE_SUPABASE_URL: url(PROD), SUPABASE_PROJECT_REF: PROD })).toContain('beta_not_production_project')
    expect(blockers({ ...BASE, SUPABASE_PROJECT_REF: PROD })).toEqual(expect.arrayContaining(['beta_not_production_project', 'project_ref_consistent']))
  })
  it('live keys, Moyasar, WASL live / Elm credentials, bank payouts are blockers in staging', () => {
    expect(blockers({ ...BASE, MOYASAR_SECRET_KEY: 'sk_live_abc' })).toContain('beta_no_live_keys')
    expect(blockers({ ...BASE, VITE_MOYASAR_PUBLISHABLE_KEY: 'pk_live_abc' })).toContain('beta_no_live_keys')
    expect(blockers({ ...BASE, SOME_OTHER_NAME: 'sk_live_hidden' })).toContain('beta_no_live_keys')
    expect(blockers({ ...BASE, PAYMENT_PROVIDER: 'moyasar', MOYASAR_SECRET_KEY: 'sk_test_a', VITE_MOYASAR_PUBLISHABLE_KEY: 'pk_test_a', MOYASAR_WEBHOOK_SECRET: 'whsec_0123456789abcdef' })).toEqual(['beta_payments_mock'])
    expect(blockers({ ...BASE, VITE_PAYMENT_PROVIDER: 'moyasar' })).toContain('beta_payments_mock')
    expect(blockers({ ...BASE, WASL_MODE: 'live', WASL_API_BASE_URL: 'https://wasl.elm.sa', WASL_APP_ID: 'a', WASL_APP_KEY: 'k' })).toContain('beta_wasl_mock')
    expect(blockers({ ...BASE, WASL_APP_KEY: 'k' })).toContain('beta_wasl_mock')
    expect(blockers({ ...BASE, PAYOUT_PROVIDER: 'bank' })).toContain('beta_payouts_mock')
  })
  it('BETA settings cannot enable production: production needs the reviewed constant, never an env var', () => {
    // The shipped constant is null → production is blocked whatever the environment says.
    const asProd = { ...BASE, APP_ENV: 'production', PROD_PROJECT_REF: BETA }
    expect(checkConfig(asProd, 'production').find((c) => c.id === 'production_binding')).toMatchObject({ ok: false, severity: 'blocker' })
    // Even with a verified constant, a BETA URL does not match it.
    expect(blockers(asProd, 'production', PROD)).toContain('production_binding')
    // And at runtime a beta marker can never become live, whatever the variables say.
    expect(decideRuntime({ supabaseUrl: url(BETA), env: env({ PROD_PROJECT_REF: BETA, APP_ENV: 'production' }), config: betaCfg(), now: NOW, prodRef: null }).liveAllowed).toBe(false)
  })
  it('the Deploy gate (checkGuard) fails closed on every bad database state', () => {
    const good: GuardConfig = { marker_state: 'ok', mode: 'beta', project_ref: BETA, live_allowed: false, integrity_ok: true, integrity_checked_at: fresh }
    const failed = (c: GuardConfig | null, target: 'staging' | 'production' = 'staging', ref: string | undefined = BETA) =>
      checkGuard(c, target, ref, NOW).filter((x) => !x.ok).map((x) => x.id)
    expect(failed(good)).toEqual([])
    expect(failed(null)).toEqual(['guard_readable'])
    expect(failed({ ...good, marker_state: 'missing', mode: null, project_ref: null })).toEqual(['guard_marker', 'guard_mode', 'guard_project'])
    expect(failed({ ...good, marker_state: 'corrupt' })).toEqual(['guard_marker'])
    expect(failed(good, 'staging', PROD)).toEqual(['guard_project'])
    expect(checkGuard(good, 'staging', undefined, NOW).filter((x) => !x.ok).map((x) => x.id)).toEqual(['guard_project'])
    expect(failed({ ...good, integrity_ok: false })).toEqual(['guard_integrity'])
    expect(failed({ ...good, integrity_checked_at: new Date(NOW.getTime() - 4 * 60_000).toISOString() })).toEqual(['guard_integrity'])
    expect(failed({ ...good, live_allowed: true })).toEqual(['guard_no_live'])
    expect(failed(good, 'production')).toEqual(['guard_mode'])
  })
  it('deploy.yml: preflight before migrations, the --guard gate after migrations and before any function deploy', () => {
    const y = read('.github/workflows/deploy.yml')
    const pre = y.indexOf('npm run preflight -- --target ${{ inputs.target }}\n')
    const migr = y.indexOf('npx supabase db push')
    const gate = y.indexOf('npm run preflight -- --target ${{ inputs.target }} --guard')
    const fns = y.indexOf('npx supabase functions deploy')
    expect(pre).toBeGreaterThan(0)
    expect(migr).toBeGreaterThan(pre)
    expect(gate).toBeGreaterThan(migr)
    expect(fns).toBeGreaterThan(gate)
    expect(y).toMatch(/SUPABASE_PROJECT_REF: \$\{\{ vars\.SUPABASE_PROJECT_REF \}\}/)
    expect(y).toMatch(/PAYOUT_PROVIDER: \$\{\{ vars\.PAYOUT_PROVIDER \}\}/)
    expect(y).not.toMatch(/^\s+PROD_PROJECT_REF:/m) // never an environment variable
    expect(y).toMatch(/workflow_dispatch/) // never automatic
    expect(read('scripts/preflight.ts')).toMatch(/flag\('guard'\) \|\| flag\('db'\)/)
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('no demo data on live (Supabase-mode) screens', () => {
  const imports = (p: string) => [...read(p).matchAll(/from '([^']+)'/g)].map((m) => m[1])
  const demo = (p: string) => imports(p).filter((i) => /core\/(store|seed)$/.test(i))

  it('the live admin modules never import the demo store or seed', () => {
    for (const p of ['src/apps/admin/live/LivePages.tsx', 'src/apps/admin/live/adminApi.ts', 'src/apps/admin/live/tariffValidation.ts',
      'src/apps/admin/pages/Applications.tsx', 'src/apps/admin/pages/Privacy.tsx', 'src/apps/admin/pages/Readiness.tsx']) {
      expect(demo(p), p).toEqual([])
    }
  })
  it('in Supabase mode every demo-backed admin page is replaced by a live page or hidden', () => {
    const src = read('src/apps/admin/AdminApp.tsx')
    const pageIds = [...src.matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1])
    const live = src.slice(src.indexOf('const LIVE_PAGES'), src.indexOf('const forMode'))
    const mapped = [...live.matchAll(/^\s+([a-z]+): /gm)].map((m) => m[1])
    // Pages kept as-is in Supabase mode are only the server-backed ones (no demo imports, checked above).
    expect(pageIds.filter((id) => !mapped.includes(id)).sort()).toEqual(['applications', 'privacy', 'readiness'])
    expect(src).toMatch(/AUTH_MODE !== 'supabase'\s*\?\s*pages\s*:\s*pages\.flatMap/)
  })
  it('rider screens drop demo promos and inbox in Supabase mode; the support gateway has a live branch', () => {
    const tabs = read('src/apps/passenger/Tabs.tsx')
    expect(tabs).toMatch(/AUTH_MODE === 'supabase' \? \[\] : s\.promos/)
    expect(tabs).toMatch(/AUTH_MODE === 'supabase' \? \[\] : s\.inbox/)
    expect(read('src/apps/passenger/PassengerApp.tsx')).toMatch(/AUTH_MODE === 'supabase' \? 0 : s\.inbox/)
    expect(read('src/data/supportGateway.ts')).toMatch(/const LIVE = AUTH_MODE === 'supabase'/)
  })
})
