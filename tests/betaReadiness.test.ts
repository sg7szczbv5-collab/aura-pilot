/**
 * BETA readiness: the BETA app cannot be pointed at production, no secret reaches the browser,
 * and every payment / payout / Wasl path is mock-only (build, runtime, preflight).
 */
import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEnvironmentViolations } from '../src/ops/buildGuards'
import { blockApp, verifyBetaBackend } from '../src/ops/betaBackendGuard'
import { checkConfig, scanBundle } from '../src/ops/configChecks'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BETA = 'betabetabetabetabeta'
const PROD = 'prodprodprodprodprod'
const url = (r: string) => `https://${r}.supabase.co`
const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role, iss: 'supabase' })).replace(/=+$/, '')}.c2lnbmF0dXJlc2lnbmF0dXJl`

describe('a BETA build is bound to the declared BETA project and can never target production', () => {
  const beta = { VITE_APP_ENV: 'staging', VITE_SUPABASE_URL: url(BETA), BETA_PROJECT_REF: BETA }
  it('the declared BETA project builds', () => {
    expect(buildEnvironmentViolations(beta, PROD)).toEqual({ mockOnly: true, violations: [] })
    expect(buildEnvironmentViolations({ VERCEL_ENV: 'preview', VITE_SUPABASE_URL: url(BETA), BETA_PROJECT_REF: BETA }, PROD).violations).toEqual([])
  })
  it('another project, an undeclared one, a custom domain or the production ref all fail the build', () => {
    expect(buildEnvironmentViolations({ ...beta, VITE_SUPABASE_URL: url(PROD) }, PROD).violations)
      .toEqual(['VITE_SUPABASE_URL does not point to BETA_PROJECT_REF', 'VITE_SUPABASE_URL points to the production project'])
    expect(buildEnvironmentViolations({ ...beta, BETA_PROJECT_REF: '' }, PROD).violations).toEqual(['BETA_PROJECT_REF is not set: a mock-only build must declare the BETA project it targets'])
    expect(buildEnvironmentViolations({ ...beta, VITE_SUPABASE_URL: 'https://api.aura.sa' }, PROD).violations).toEqual(['VITE_SUPABASE_URL is not a https://<ref>.supabase.co project URL'])
    // Even a (mis)declared BETA_PROJECT_REF equal to production is refused once the production ref is known.
    expect(buildEnvironmentViolations({ ...beta, VITE_SUPABASE_URL: url(PROD), BETA_PROJECT_REF: PROD }, PROD).violations).toEqual(['VITE_SUPABASE_URL points to the production project'])
  })
  it('demo builds (no Supabase) and production builds are not affected by the binding', () => {
    expect(buildEnvironmentViolations({ VITE_APP_ENV: 'staging' }).violations).toEqual([])
    expect(buildEnvironmentViolations({ VITE_APP_ENV: 'production', VITE_SUPABASE_URL: url(PROD) }).violations).toEqual([])
  })
  it('preflight (staging) enforces the same declaration', () => {
    const blockers = (e: Record<string, string>) => checkConfig(e, 'staging', PROD).filter((c) => !c.ok && c.id === 'beta_project_declared').length
    expect(blockers({ APP_ENV: 'staging', VITE_SUPABASE_URL: url(BETA), BETA_PROJECT_REF: BETA })).toBe(0)
    expect(blockers({ APP_ENV: 'staging', VITE_SUPABASE_URL: url(BETA) })).toBe(1)
    expect(blockers({ APP_ENV: 'staging', VITE_SUPABASE_URL: url(PROD), BETA_PROJECT_REF: BETA })).toBe(1)
  })
  it('the Deploy workflow passes BETA_PROJECT_REF to the build (a vars value, not a secret)', () => {
    expect(readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8')).toMatch(/BETA_PROJECT_REF: \$\{\{ vars\.BETA_PROJECT_REF \}\}/)
  })
  it('a real `vite build` in staging pointed at an undeclared project stops before bundling', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', '/tmp/aura-should-not-exist-2'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, VITE_APP_ENV: 'staging', VITE_SUPABASE_URL: url(PROD), VITE_SUPABASE_ANON_KEY: 'x', BETA_PROJECT_REF: BETA },
    })
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}${r.stderr}`).toMatch(/VITE_SUPABASE_URL does not point to BETA_PROJECT_REF/)
  }, 60_000)
})

describe('runtime: after sign-in a BETA build checks the database it talks to', () => {
  const client = (data: unknown, error: { message: string } | null = null) => ({ rpc: vi.fn(async () => ({ data, error })) })
  it('"beta" → continue; anything else → sign out', async () => {
    for (const [c, ok] of [[client('beta'), true], [client('production'), false], [client(null), false], [client(null, { message: 'function not found' }), false],
      [{ rpc: async () => { throw new Error('network') } }, false]] as const) {
      const signOut = vi.fn(async () => undefined)
      expect(await verifyBetaBackend(c, signOut)).toBe(ok)
      expect(signOut).toHaveBeenCalledTimes(ok ? 0 : 1)
    }
  })
  it('the app installs the check for mock-only Supabase builds and stops on failure', () => {
    const main = readFileSync(join(ROOT, 'src/main.tsx'), 'utf8')
    expect(main).toMatch(/if \(PAYMENT_POLICY\.mockOnly && AUTH_MODE === 'supabase'\)/)
    expect(main).toMatch(/verifyBetaBackend\(sb, \(\) => sb\.auth\.signOut\(\)\)\.then\(\(ok\) => \{ if \(!ok\) blockApp\(\) \}\)/)
    const doc = { body: { innerHTML: '<div id="root">app</div>' } }
    blockApp(doc)
    expect(doc.body.innerHTML).not.toContain('id="root"')
    expect(doc.body.innerHTML).toContain('BETA')
  })
})

describe('service_role and other secrets never reach the browser', () => {
  it('a build fails when any browser variable holds a secret (all environments)', () => {
    for (const [k, v] of [['VITE_SUPABASE_ANON_KEY', jwt('service_role')], ['NEXT_PUBLIC_SUPABASE_KEY', jwt('service_role')], ['VITE_X', 'sb_secret_abcdefghijkl'], ['VITE_PAY', 'sk_live_abcdefgh'], ['VITE_PAY', 'sk_test_abcdefgh']]) {
      for (const appEnv of ['production', 'staging', 'development']) {
        expect(buildEnvironmentViolations({ VITE_APP_ENV: appEnv, [k]: v }).violations, `${appEnv} ${k}`).toContain(`${k} holds a secret (it would be inlined into the browser bundle)`)
      }
    }
    expect(buildEnvironmentViolations({ VITE_SUPABASE_ANON_KEY: jwt('anon'), SUPABASE_SERVICE_ROLE_KEY: jwt('service_role') }).violations).toEqual([]) // server-only name: never bundled
  })
  it('a real build with a service_role key in VITE_SUPABASE_ANON_KEY fails', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', '/tmp/aura-should-not-exist-3'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, VITE_APP_ENV: 'production', VITE_SUPABASE_ANON_KEY: jwt('service_role') },
    })
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}${r.stderr}`).toMatch(/VITE_SUPABASE_ANON_KEY holds a secret/)
  }, 60_000)
  it('only VITE_ variables (plus allowlisted NEXT_PUBLIC_) are bundled, and the service key is only read by server code', () => {
    // C2 (demo isolation) tightened this: NEXT_PUBLIC_* is no longer a bundled prefix; only allowlisted names pass via define.
    const vc = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')
    expect(vc).toMatch(/envPrefix: \['VITE_'\]/)
    expect(vc).toMatch(/nextPublicDefines\(env\)/)
    const deploy = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8')
    expect(deploy).toMatch(/SUPABASE_SERVICE_ROLE_KEY: \$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/)
    expect(deploy).not.toMatch(/VITE_[A-Z_]*: \$\{\{ secrets\./) // no secret is ever mapped to a browser variable
    expect(scanBundle([{ name: 'a.js', content: `k="${jwt('service_role')}"` }]).ok).toBe(false)
  })
})

describe('payments, payouts and Wasl are mock-only in BETA (summary across layers)', () => {
  it('build, preflight and runtime agree on mock for every provider', () => {
    const build = buildEnvironmentViolations({ VITE_APP_ENV: 'staging', PAYMENT_PROVIDER: 'moyasar', PAYOUT_PROVIDER: 'bank', WASL_MODE: 'live', VITE_PAYMENT_PROVIDER: 'moyasar' }).violations
    expect(build).toEqual(expect.arrayContaining(['PAYMENT_PROVIDER=moyasar', 'PAYOUT_PROVIDER=bank', 'WASL_MODE=live', 'VITE_PAYMENT_PROVIDER=moyasar']))
    const pre = checkConfig({ APP_ENV: 'staging', VITE_SUPABASE_URL: url(BETA), BETA_PROJECT_REF: BETA, PAYMENT_PROVIDER: 'moyasar', PAYOUT_PROVIDER: 'bank', WASL_MODE: 'live' }, 'staging', PROD)
      .filter((c) => !c.ok && c.severity === 'blocker').map((c) => c.id)
    expect(pre).toEqual(expect.arrayContaining(['beta_payments_mock', 'beta_payouts_mock', 'beta_wasl_mock']))
  })
})
