/**
 * F3 (second review): BETA / staging / Vercel Preview never contact a payment gateway.
 * Browser policy, tokenizer, network guard, build-time check, preflight ↔ Edge parity and a
 * whole-repository documentation scan. The real-browser check is scripts/e2e-beta-payments.cjs.
 */
import { describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPaymentViolations, decidePaymentPolicy, GATEWAY_SETTINGS, isPaymentGatewayUrl } from '../src/payments/paymentPolicy'
import { installPaymentNetworkGuard, PaymentGatewayBlocked } from '../src/payments/networkGuard'
import { tokenizeCard } from '../src/payments/cards'
import { checkConfig } from '../src/ops/configChecks'
import { decideRuntime, liveRequests, SERVER_GATEWAY_SETTINGS, type RuntimeConfig } from '../supabase/functions/_shared/ops/runtimeGuard'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KEY = 'pk_test_dummydummydummy'
const CARD = { number: '4111 1111 1111 1111', name: 'Test Rider', month: 12, year: 2030, cvc: '123' }

describe('browser payment policy: explicit provider, mock-only in BETA', () => {
  const live = { authMode: 'supabase' as const }
  it('BETA / staging / Preview: any gateway setting disables card entry (fail closed); mock stays mock', () => {
    for (const appEnv of ['staging', 'beta', 'STAGING', 'preview']) {
      expect(decidePaymentPolicy({ ...live, appEnv, publishableKey: KEY }).tokenizer, appEnv).toBe('disabled')
      expect(decidePaymentPolicy({ ...live, appEnv, provider: 'moyasar' }).tokenizer, appEnv).toBe('disabled')
      expect(decidePaymentPolicy({ ...live, appEnv, provider: 'moyasar', publishableKey: KEY }).tokenizer, appEnv).toBe('disabled')
      expect(decidePaymentPolicy({ ...live, appEnv, provider: 'mock' })).toMatchObject({ tokenizer: 'mock', mockOnly: true })
    }
    // A Preview build is mock-only whatever VITE_APP_ENV says.
    expect(decidePaymentPolicy({ ...live, appEnv: 'production', mockOnlyBuild: true, provider: 'moyasar', publishableKey: KEY }).tokenizer).toBe('disabled')
  })
  it('elsewhere the key alone is not enough: Moyasar only when chosen explicitly (production unchanged when configured)', () => {
    expect(decidePaymentPolicy({ ...live, appEnv: 'production', publishableKey: KEY }).tokenizer).toBe('mock')
    expect(decidePaymentPolicy({ ...live, appEnv: 'production', provider: 'moyasar', publishableKey: KEY })).toMatchObject({ tokenizer: 'moyasar', mockOnly: false })
    expect(decidePaymentPolicy({ authMode: 'mock', appEnv: 'production', provider: 'moyasar', publishableKey: KEY }).tokenizer).toBe('mock') // demo mode
    expect(decidePaymentPolicy({ ...live, appEnv: 'production', provider: 'moyasar' }).tokenizer).toBe('mock')
  })
  it('the tokenizer never calls the network when disabled or mock; only an explicit Moyasar build does', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: 'tok_1', status: 'active' })))
    expect(await tokenizeCard(CARD, 'https://x/#/passenger', f as never, 'disabled')).toEqual({ ok: false, error: 'payments_disabled' })
    expect(await tokenizeCard(CARD, 'https://x/#/passenger', f as never, 'mock')).toMatchObject({ ok: true })
    expect(f).not.toHaveBeenCalled()
    await tokenizeCard(CARD, 'https://x/#/passenger', f as never, 'moyasar')
    expect(f).toHaveBeenCalledTimes(1)
    expect((f.mock.calls[0] as unknown[])[0]).toBe('https://api.moyasar.com/v1/tokens')
  })
})

describe('browser network guard', () => {
  const fakeTarget = () => {
    const sent: string[] = []
    const xhrOpened: string[] = []
    class XHR { open(_m: string, url: string) { xhrOpened.push(url) } }
    const target = {
      fetch: vi.fn(async (u: RequestInfo | URL) => { sent.push(String(u)); return new Response('ok') }),
      XMLHttpRequest: XHR as unknown as { prototype: { open: (...a: unknown[]) => unknown } },
      navigator: { sendBeacon: vi.fn((u: string) => { sent.push(u); return true }) },
      location: { href: 'https://beta.example.org/#/passenger' },
    }
    return { target, sent, xhrOpened, XHR }
  }
  it('mock-only: fetch, XHR and sendBeacon to Moyasar are refused before anything leaves; other hosts work', async () => {
    const { target, sent, xhrOpened, XHR } = fakeTarget()
    expect(installPaymentNetworkGuard(true, target as never)).toBe(true)
    for (const u of ['https://api.moyasar.com/v1/tokens', 'https://API.MOYASAR.COM/v1/payments', 'https://moyasar.com/x', 'https://cdn.moyasar.com/mpf.js']) {
      await expect((target.fetch as unknown as typeof fetch)(u)).rejects.toBeInstanceOf(PaymentGatewayBlocked)
      await expect((target.fetch as unknown as typeof fetch)(new Request(u))).rejects.toBeInstanceOf(PaymentGatewayBlocked)
      expect(() => new XHR().open('POST', u)).toThrow(PaymentGatewayBlocked)
      expect(target.navigator.sendBeacon(u)).toBe(false)
    }
    expect(sent).toEqual([])
    expect(xhrOpened).toEqual([])
    await (target.fetch as unknown as typeof fetch)('https://abcdefghijklmnopqrst.supabase.co/rest/v1/x')
    expect(sent).toEqual(['https://abcdefghijklmnopqrst.supabase.co/rest/v1/x'])
    expect(isPaymentGatewayUrl('https://moyasar.com.evil.example')).toBe(false)
  })
  it('production builds are untouched (no guard installed)', () => {
    const { target } = fakeTarget()
    const before = target.fetch
    expect(installPaymentNetworkGuard(false, target as never)).toBe(false)
    expect(target.fetch).toBe(before)
  })
  it('the app installs the guard before anything else runs', () => {
    const main = readFileSync(join(ROOT, 'src/main.tsx'), 'utf8')
    expect(main.indexOf('installPaymentNetworkGuard(PAYMENT_POLICY.mockOnly)')).toBeGreaterThan(0)
    expect(main.indexOf('installPaymentNetworkGuard(PAYMENT_POLICY.mockOnly)')).toBeLessThan(main.indexOf('startDispatcher()\n'))
    expect(main.indexOf('installPaymentNetworkGuard(PAYMENT_POLICY.mockOnly)')).toBeLessThan(main.indexOf('createRoot('))
  })
})

describe('build-time check (vite.config.ts)', () => {
  it('a mock-only build fails on each Moyasar setting and on any non-mock provider', () => {
    for (const base of [{ VITE_APP_ENV: 'staging' }, { APP_ENV: 'staging' }, { VITE_APP_ENV: 'beta' }, { VERCEL_ENV: 'preview' }]) {
      for (const k of GATEWAY_SETTINGS) expect(buildPaymentViolations({ ...base, [k]: 'x' }).violations, `${JSON.stringify(base)} ${k}`).toEqual([`${k} is set`])
      expect(buildPaymentViolations({ ...base, VITE_PAYMENT_PROVIDER: 'moyasar' }).violations).toEqual(['VITE_PAYMENT_PROVIDER=moyasar'])
      expect(buildPaymentViolations({ ...base, PAYMENT_PROVIDER: 'moyasar' }).violations).toEqual(['PAYMENT_PROVIDER=moyasar'])
      expect(buildPaymentViolations({ ...base, PAYOUT_PROVIDER: 'bank', WASL_MODE: 'live' }).violations).toEqual(['PAYOUT_PROVIDER=bank', 'WASL_MODE=live'])
      expect(buildPaymentViolations({ ...base, VITE_PAYMENT_PROVIDER: 'mock', PAYMENT_PROVIDER: 'mock' })).toEqual({ mockOnly: true, violations: [] })
    }
  })
  it('production and development builds are not affected', () => {
    const prod = { VITE_APP_ENV: 'production', VERCEL_ENV: 'production', VITE_PAYMENT_PROVIDER: 'moyasar', VITE_MOYASAR_PUBLISHABLE_KEY: KEY, MOYASAR_SECRET_KEY: 'sk_x' }
    expect(buildPaymentViolations(prod)).toEqual({ mockOnly: false, violations: [] })
    expect(buildPaymentViolations({})).toEqual({ mockOnly: false, violations: [] })
  })
  it('both build configs (app and single-file share) apply the same check', () => {
    for (const f of ['vite.config.ts', 'vite.share.config.ts']) {
      const src = readFileSync(join(ROOT, f), 'utf8')
      expect(src, f).toMatch(/buildPaymentViolations\(/)
      expect(src, f).toMatch(/throw new Error\(`AURA: payment gateways are not allowed/)
      expect(src, f).toMatch(/VITE_AURA_PAYMENTS_MOCK_ONLY/)
    }
  })
  it('a real `vite build` in staging with a Moyasar key stops before bundling', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', '/tmp/aura-should-not-exist'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, VITE_APP_ENV: 'staging', VITE_MOYASAR_PUBLISHABLE_KEY: KEY },
    })
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}${r.stderr}`).toMatch(/payment gateways are not allowed in a mock-only .* VITE_MOYASAR_PUBLISHABLE_KEY is set/)
  }, 60_000)
})

describe('preflight and the Edge runtime guard enforce the same server-side list', () => {
  it('server-side gateway settings are identical', () => {
    expect([...SERVER_GATEWAY_SETTINGS].sort()).toEqual(GATEWAY_SETTINGS.filter((k) => !k.startsWith('VITE_')).sort())
  })
  it('each setting is a staging blocker and a runtime refusal', () => {
    const BETA = 'betabetabetabetabeta'
    const base = { APP_ENV: 'staging', VITE_SUPABASE_URL: `https://${BETA}.supabase.co`, SUPABASE_PROJECT_REF: BETA, VITE_SUPABASE_ANON_KEY: 'anon',
      PAYMENTS_CRON_SECRET: 'a'.repeat(40), WASL_CRON_SECRET: 'b'.repeat(40), PRIVACY_CRON_SECRET: 'c'.repeat(40), HEALTH_SECRET: 'd'.repeat(40) }
    const cfg: RuntimeConfig = { marker_state: 'ok', mode: 'beta', project_ref: BETA, prod_project_ref: null, live_allowed: false, integrity_ok: true, integrity_checked_at: new Date().toISOString() }
    for (const k of GATEWAY_SETTINGS) {
      expect(checkConfig({ ...base, [k]: 'x' }, 'staging').find((c) => c.id === 'beta_no_provider_credentials')?.ok, k).toBe(false)
    }
    for (const k of SERVER_GATEWAY_SETTINGS) {
      expect(liveRequests((n) => (n === k ? 'x' : undefined)).length, k).toBe(1)
      expect(decideRuntime({ supabaseUrl: `https://${BETA}.supabase.co`, env: (n) => (n === k ? 'x' : undefined), config: cfg, prodRef: null }).ok, k).toBe(false)
    }
    expect(checkConfig({ ...base, VITE_PAYMENT_PROVIDER: 'moyasar' }, 'staging').find((c) => c.id === 'beta_payments_mock')?.ok).toBe(false)
  })
  it('production preflight requires the explicit browser provider (the key alone no longer enables Moyasar)', () => {
    const blocker = (env: Record<string, string>) => checkConfig(env, 'production').find((c) => c.id === 'browser_payment_provider')
    expect(blocker({ VITE_MOYASAR_PUBLISHABLE_KEY: KEY })).toMatchObject({ ok: false, severity: 'blocker' })
    expect(blocker({ VITE_MOYASAR_PUBLISHABLE_KEY: KEY, VITE_PAYMENT_PROVIDER: 'moyasar' })?.ok).toBe(true)
  })
})

describe('no instruction anywhere allows Moyasar test keys or an Elm sandbox in staging / BETA', () => {
  const files = execFileSync('git', ['ls-files', '*.md', '*.example', '*.yml', '*.yaml'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  it('RUNBOOK environment table: the staging column is mock-only for payments, payouts and Wasl', () => {
    const rb = readFileSync(join(ROOT, 'ops/RUNBOOK.md'), 'utf8')
    const table = rb.slice(rb.indexOf('## 2. Environments'), rb.indexOf('## 3.'))
    for (const row of ['Payments', 'Payouts', 'Wasl']) {
      const cells = (table.split('\n').find((l) => l.startsWith(`| ${row} |`)) ?? '').split('|').map((c) => c.trim())
      expect(cells[3], row).toMatch(/^\*\*mock only\*\*/)
    }
  })
  it('every line that pairs staging / BETA / Preview with a gateway test mode is a prohibition', () => {
    const env = /\b(staging|beta|preview)\b/i
    const gateway = /(pk_test|sk_test|test keys?|sandbox|moyasar\s+\**test|elm sandbox|4111)/i
    const negation = /(never|not |no |mock[- ]only|mock only|\*\*mock\*\*|refuse|blocked|blocker|cannot|must not|fails?|only in a separate|separate, reviewed)/i
    const offenders: string[] = []
    for (const f of files) {
      if (f.startsWith('tests/')) continue
      readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
        if (env.test(line) && gateway.test(line) && !negation.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
