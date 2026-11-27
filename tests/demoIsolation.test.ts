/**
 * Demo isolation (C1–C4): a DEMO / Preview build carries no Supabase setting, cannot be built with
 * server credentials in its environment, and refuses to reach Supabase even when code tries.
 * Production (LIVE) behaviour is unchanged: every public setting still reaches the app.
 * The bundle itself is checked by scripts/check-bundle-env.cjs (real builds, probe values).
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PUBLIC_ENV } from '../src/config/publicEnv'
import { NEXT_PUBLIC_ALLOWED, PUBLIC_ENV_KEYS, nextPublicDefines } from '../src/config/publicEnvKeys'
import { buildEnvironmentViolations, demoIsolationViolations } from '../src/ops/buildGuards'
import { SupabaseBlockedInDemo, installDemoNetworkGuard, isSupabaseUrl } from '../src/ops/demoNetworkGuard'
import { AUTH_MODE } from '../src/auth/config'
import { getSupabase } from '../src/auth/supabaseClient'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
const SRC = walk(join(ROOT, 'src')).filter((f) => /\.(ts|tsx)$/.test(f))
/** Source without comments (a comment may mention import.meta.env; only code matters). */
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (p: Record<string, string>) => `${b64({ alg: 'HS256' })}.${b64(p)}.c2ln`
const BETA = 'betabetabetabetabeta'
const PROD = 'prodprodprodprodprod'
const OTHER = 'otherotherotherother'
const url = (r: string) => `https://${r}.supabase.co`

describe('C1 — browser code reads environment variables only by explicit, allowlisted name', () => {
  it('publicEnv.ts and the allowlist list exactly the same variables', () => {
    expect(Object.keys(PUBLIC_ENV).sort()).toEqual([...PUBLIC_ENV_KEYS].sort())
  })
  it('import.meta.env appears ONLY in src/config/publicEnv.ts, and only as import.meta.env.<ALLOWLISTED>', () => {
    for (const f of SRC) {
      const src = code(f)
      const rel = relative(ROOT, f)
      if (rel === join('src', 'config', 'publicEnv.ts')) {
        const refs = [...src.matchAll(/import\.meta\.env(\.[A-Z0-9_]+)?/g)]
        expect(refs.length).toBe(PUBLIC_ENV_KEYS.length)
        for (const m of refs) {
          expect(m[1], `${rel}: whole-object import.meta.env`).toBeDefined()
          expect(PUBLIC_ENV_KEYS as readonly string[], rel).toContain(m[1]!.slice(1))
        }
        continue
      }
      if (rel === join('src', 'config', 'publicEnvKeys.ts')) {
        // Builds the `define` key names as text (`import.meta.env.${k}`); it must never READ the env.
        expect(src.replace(/`import\.meta\.env\.\$\{k\}`/g, ''), rel).not.toMatch(/import\.meta/)
        continue
      }
      expect(src, `${rel} reads the environment; use src/config/publicEnv.ts`).not.toMatch(/import\.meta\.env|\(import\.meta as [^)]*\)\.env/)
    }
  })
  it('no browser module looks for Supabase settings under other names (no fallback to an integration)', () => {
    for (const f of SRC.filter((x) => !x.includes(`${join('src', 'ops')}`))) {
      expect(code(f), relative(ROOT, f)).not.toMatch(/NEXT_PUBLIC_SUPABASE|env\??\.SUPABASE_(URL|ANON_KEY)|SERVICE_ROLE/)
    }
  })
  it('every allowlisted name is meant to be public (no secret-looking names)', () => {
    for (const k of PUBLIC_ENV_KEYS) expect(k).not.toMatch(/SECRET|SERVICE|PASSWORD|PRIVATE|POSTGRES|JWT/)
  })
})

describe('C2 — only VITE_* by prefix; NEXT_PUBLIC_* only when allowlisted', () => {
  it('both Vite configs expose VITE_ only and pass NEXT_PUBLIC_ through the allowlist', () => {
    for (const f of ['vite.config.ts', 'vite.share.config.ts']) {
      const c = read(f)
      expect(c, f).toMatch(/envPrefix: \['VITE_'\]/)
      expect(c, f).toMatch(/nextPublicDefines\(env\)/)
      expect(c, f).not.toMatch(/'NEXT_PUBLIC_'/)
    }
  })
  it('nextPublicDefines emits the allowlisted names only — an integration NEXT_PUBLIC_SUPABASE_* is never defined', () => {
    const d = nextPublicDefines({ NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN: 'pk.x', NEXT_PUBLIC_SUPABASE_URL: url(OTHER), NEXT_PUBLIC_SUPABASE_ANON_KEY: 'k', NEXT_PUBLIC_ANYTHING: 'y' })
    expect(Object.keys(d)).toEqual(NEXT_PUBLIC_ALLOWED.map((k) => `import.meta.env.${k}`))
    expect(d['import.meta.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN']).toBe('"pk.x"')
    expect(JSON.stringify(d)).not.toMatch(/SUPABASE|otherother|"y"/)
  })
  it('an absent allowlisted NEXT_PUBLIC_ variable is undefined (never the whole env object)', () => {
    expect(nextPublicDefines({})['import.meta.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN']).toBe('undefined')
  })
})

describe('DEMO mode: no Supabase variables → no Supabase client at all', () => {
  it('the test environment (no VITE_SUPABASE_*) is DEMO, and getSupabase() refuses instead of connecting', () => {
    expect(AUTH_MODE).toBe('mock')
    expect(() => getSupabase()).toThrow(/not configured/)
  })
  it('the mode is decided by VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY only', () => {
    expect(read('src/auth/config.ts')).toMatch(/env\.VITE_SUPABASE_URL/)
    expect(read('src/auth/config.ts')).not.toMatch(/NEXT_PUBLIC_|process\.env/)
  })
})

describe('C3 — a mock-only (Preview / BETA) build environment carries no server credential and no foreign Supabase', () => {
  const preview = (extra: Record<string, string>) => buildEnvironmentViolations({ VERCEL: '1', VERCEL_ENV: 'preview', ...extra }, PROD).violations
  const INTEGRATION: Record<string, string> = {
    SUPABASE_SERVICE_ROLE_KEY: jwt({ role: 'service_role', ref: OTHER }),
    SUPABASE_SECRET_KEY: 'sb_secret_abc',
    SUPABASE_JWT_SECRET: 'jwtsecretvalue',
    POSTGRES_URL: 'postgres://u:pw@h/db',
    POSTGRES_PASSWORD: 'pgpasswordvalue',
    POSTGRES_PRISMA_URL: 'postgres://u:pw2@h/db',
    DATABASE_URL: 'postgres://u:pw3@h/db',
  }
  it.each(Object.keys(INTEGRATION))('%s in a Preview build → refused (by name, whatever the value)', (k) => {
    const v = preview({ [k]: INTEGRATION[k] })
    expect(v.some((m) => m.startsWith(`${k} is set`))).toBe(true)
  })
  it('a service_role key under ANY other name is refused too (by value)', () => {
    expect(preview({ MY_RENAMED_KEY: jwt({ role: 'service_role', ref: OTHER }) })).toEqual([expect.stringMatching(/^MY_RENAMED_KEY holds a server secret/)])
  })
  it('the integration URL / key under other names → refused when no BETA project is declared (BETA is never assumed)', () => {
    const v = preview({ NEXT_PUBLIC_SUPABASE_URL: url(OTHER), SUPABASE_URL: url(OTHER), NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt({ role: 'anon', ref: OTHER }), SUPABASE_ANON_KEY: jwt({ role: 'anon', ref: OTHER }) })
    for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY']) expect(v.some((m) => m.startsWith(`${k} `) && /no BETA_PROJECT_REF/.test(m))).toBe(true)
  })
  it('with a declared BETA project: matching settings pass, a different project is refused, the production project is refused', () => {
    const ok = preview({ BETA_PROJECT_REF: BETA, VITE_SUPABASE_URL: url(BETA), VITE_SUPABASE_ANON_KEY: jwt({ role: 'anon', ref: BETA }), NEXT_PUBLIC_SUPABASE_URL: url(BETA), NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt({ role: 'anon', ref: BETA }) })
    expect(ok).toEqual([])
    expect(preview({ BETA_PROJECT_REF: BETA, SUPABASE_URL: url(OTHER) })).toContain('SUPABASE_URL does not point to BETA_PROJECT_REF')
    expect(preview({ BETA_PROJECT_REF: BETA, VITE_SUPABASE_URL: url(BETA), VITE_SUPABASE_ANON_KEY: jwt({ role: 'anon', ref: OTHER }) })).toContain('VITE_SUPABASE_ANON_KEY belongs to another project than BETA_PROJECT_REF')
    expect(preview({ BETA_PROJECT_REF: PROD, NEXT_PUBLIC_SUPABASE_URL: url(PROD) })).toContain('NEXT_PUBLIC_SUPABASE_URL points to the production project')
  })
  it('messages name variables, never values', () => {
    const all = preview({ ...INTEGRATION, NEXT_PUBLIC_SUPABASE_URL: url(OTHER) }).join(' | ')
    for (const v of Object.values(INTEGRATION)) expect(all).not.toContain(v)
    expect(all).not.toContain(OTHER)
  })
  it('a clean Preview (DEMO, no Supabase at all) passes', () => {
    expect(preview({ VITE_MAPS_PROVIDER: 'mock', NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN: 'pk.x' })).toEqual([])
  })
  it('BETA / staging builds (VITE_APP_ENV) get the same rule as Vercel Preview', () => {
    expect(buildEnvironmentViolations({ VITE_APP_ENV: 'beta', POSTGRES_PASSWORD: 'x' }).violations).toContain('POSTGRES_PASSWORD is set: a mock-only (Preview / BETA) build must not have server credentials in its build environment')
  })
  it('PRODUCTION is untouched: the same integration variables do not change a production build verdict', () => {
    const prodEnv = { VERCEL: '1', VERCEL_ENV: 'production', VITE_SUPABASE_URL: url(PROD), VITE_SUPABASE_ANON_KEY: jwt({ role: 'anon', ref: PROD }), ...INTEGRATION, NEXT_PUBLIC_SUPABASE_URL: url(PROD) }
    expect(buildEnvironmentViolations(prodEnv, PROD)).toEqual({ mockOnly: false, violations: [] })
    expect(buildEnvironmentViolations({ VITE_SUPABASE_URL: url(PROD), ...INTEGRATION })).toEqual({ mockOnly: false, violations: [] }) // local / CI builds too
  })
  it('demoIsolationViolations is only applied to mock-only builds', () => {
    expect(read('src/ops/buildGuards.ts')).toMatch(/if \(pay\.mockOnly\) violations\.push\(\.\.\.demoIsolationViolations\(env, prodRef\)\)/)
    expect(demoIsolationViolations({}, PROD)).toEqual([])
  })
})

describe('C4 — DEMO network guard (defence in depth): every way to reach Supabase is refused', () => {
  function fakeWindow() {
    const sent: string[] = []
    class WS { constructor(public u: string) { sent.push(`ws:${u}`) } }
    class ES { constructor(public u: string) { sent.push(`es:${u}`) } }
    const w = {
      location: { href: 'https://preview.example.app/' },
      fetch: vi.fn(async (i: RequestInfo | URL) => (sent.push(`fetch:${typeof i === 'string' ? i : i instanceof URL ? i.href : i.url}`), new Response('ok'))),
      XMLHttpRequest: { prototype: { open: vi.fn(function (_m: unknown, u: unknown) { sent.push(`xhr:${String(u)}`) }) } },
      navigator: { sendBeacon: vi.fn((u: string) => (sent.push(`beacon:${u}`), true)) },
      WebSocket: WS as unknown as new (...a: never[]) => unknown,
      EventSource: ES as unknown as new (...a: never[]) => unknown,
    }
    return { w, sent }
  }
  const targets = [
    'https://prodprodprodprodprod.supabase.co/rest/v1/rides',
    'https://PRODPRODPRODPRODPROD.SUPABASE.CO/auth/v1/otp',
    'https://abc.supabase.in/functions/v1/x',
    'https://api.supabase.com/v1/projects',
  ]
  it.each(targets)('fetch / XHR / sendBeacon to %s are refused before leaving the page', async (u) => {
    const { w, sent } = fakeWindow()
    expect(installDemoNetworkGuard(true, w)).toBe(true)
    await expect(w.fetch(u)).rejects.toBeInstanceOf(SupabaseBlockedInDemo)
    await expect(w.fetch(new URL(u))).rejects.toBeInstanceOf(SupabaseBlockedInDemo)
    await expect(w.fetch({ url: u } as Request)).rejects.toBeInstanceOf(SupabaseBlockedInDemo)
    expect(() => w.XMLHttpRequest.prototype.open.call({}, 'GET', u)).toThrow(SupabaseBlockedInDemo)
    expect(w.navigator.sendBeacon(u)).toBe(false)
    expect(sent).toEqual([])
  })
  it('Realtime (WebSocket) and EventSource to Supabase are refused', () => {
    const { w, sent } = fakeWindow()
    installDemoNetworkGuard(true, w)
    expect(() => new w.WebSocket('wss://prodprodprodprodprod.supabase.co/realtime/v1/websocket' as never)).toThrow(SupabaseBlockedInDemo)
    expect(() => new w.EventSource('https://prodprodprodprodprod.supabase.co/x' as never)).toThrow(SupabaseBlockedInDemo)
    expect(sent).toEqual([])
  })
  it('other hosts still work (maps, the app itself), and look-alikes are not Supabase', async () => {
    const { w, sent } = fakeWindow()
    installDemoNetworkGuard(true, w)
    await w.fetch('https://maps.googleapis.com/maps/api/js')
    await w.fetch('/assets/app.js')
    new w.WebSocket('wss://localhost:5180/' as never)
    expect(sent).toEqual(['fetch:https://maps.googleapis.com/maps/api/js', 'fetch:/assets/app.js', 'ws:wss://localhost:5180/'])
    expect(isSupabaseUrl('https://supabase.co.evil.example/x')).toBe(false)
    expect(isSupabaseUrl('https://evilsupabase.co/x')).toBe(false)
  })
  it('LIVE (Production) never installs it: requests to its Supabase go through unchanged', async () => {
    const { w, sent } = fakeWindow()
    expect(installDemoNetworkGuard(false, w)).toBe(false)
    await w.fetch('https://prodprodprodprodprod.supabase.co/rest/v1/rides')
    new w.WebSocket('wss://prodprodprodprodprod.supabase.co/realtime/v1/websocket' as never)
    expect(sent).toHaveLength(2)
  })
  it('installed once only, and wired in main.tsx for DEMO only', () => {
    const { w } = fakeWindow()
    installDemoNetworkGuard(true, w)
    const f = w.fetch
    installDemoNetworkGuard(true, w)
    expect(w.fetch).toBe(f)
    expect(read('src/main.tsx')).toMatch(/installDemoNetworkGuard\(AUTH_MODE === 'mock'\)/)
  })
})
