/**
 * What reaches the browser bundle? Builds the app with PROBE values (never real ones) and searches
 * every file in the output for each of them.
 *   npm run check:bundle-env [-- --report-only] [-- --json]
 *
 * Scenarios
 *  production   — a production-like build (VERCEL_ENV=production) with every public setting the
 *                 app reads, plus what a Supabase Marketplace integration injects (server keys,
 *                 Postgres URLs, NEXT_PUBLIC_SUPABASE_*) and unlisted VITE_ / NEXT_PUBLIC_ probes.
 *                 Expect: every allowlisted public value present (the app still works); nothing else.
 *  preview-integration — a Vercel Preview build that still carries the Supabase integration
 *                 variables. Expect: the build REFUSES (build guard), naming variables, never values.
 *  preview-demo — a clean Preview build (no Supabase at all) with unlisted probes.
 *                 Expect: builds as DEMO; no probe and no Supabase host in the bundle.
 *
 * The values are fake and unique so a match can only come from the build. Nothing is sent anywhere.
 */
const { spawnSync } = require('node:child_process')
const { mkdtempSync, readdirSync, readFileSync, statSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const reportOnly = process.argv.includes('--report-only')
const asJson = process.argv.includes('--json')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.cHJvYmVzaWc`
const PROD_REF = 'probeprodprobeprodpr' // 20 chars, like a project ref — fake
const OTHER_REF = 'probeintgprobeintgpr'
const OTHER_REF2 = 'probesrvrprobesrvrpr' // unprefixed SUPABASE_URL gets its own value

/** Public settings the app reads on purpose (must survive the build in production). */
const PUBLIC = {
  VITE_SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
  VITE_SUPABASE_ANON_KEY: jwt({ role: 'anon', ref: PROD_REF, probe: 'publicanon' }),
  VITE_AUTH_OTP_LENGTH: '6',
  VITE_APP_ENV: 'production',
  VITE_MAPS_PROVIDER: 'google',
  VITE_GOOGLE_MAPS_API_KEY: 'AIzaProbeGoogleMapsKey000000000000000',
  VITE_GOOGLE_MAPS_MAP_ID: 'probe-map-id-000',
  VITE_PAYMENT_PROVIDER: 'moyasar',
  VITE_MOYASAR_PUBLISHABLE_KEY: 'pk_test_probepublishable000000',
  VITE_MAPBOX_ACCESS_TOKEN: 'pk.probeVitemapbox000',
  NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN: 'pk.probeNextmapbox000',
}
/** Values that must NEVER reach the browser. */
const INTEGRATION = {
  SUPABASE_URL: `https://${OTHER_REF2}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_URL: `https://${OTHER_REF}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt({ role: 'anon', ref: OTHER_REF, probe: 'integrationanon' }),
  SUPABASE_ANON_KEY: jwt({ role: 'anon', ref: OTHER_REF, probe: 'integrationanon2' }),
  SUPABASE_SERVICE_ROLE_KEY: jwt({ role: 'service_role', ref: OTHER_REF, probe: 'servicerole' }),
  SUPABASE_JWT_SECRET: 'probe-jwt-secret-000000000000',
  POSTGRES_URL: `postgres://postgres.${OTHER_REF}:probepgpass000@aws-0.pooler.supabase.com:6543/postgres`,
  POSTGRES_PRISMA_URL: `postgres://postgres.${OTHER_REF}:probepgpass001@aws-0.pooler.supabase.com:6543/postgres`,
  POSTGRES_URL_NON_POOLING: `postgres://postgres.${OTHER_REF}:probepgpass002@db.supabase.com:5432/postgres`,
  POSTGRES_PASSWORD: 'probepgpass003',
}
const UNLISTED = {
  VITE_UNLISTED_PROBE: 'probe-unlisted-vite-000',
  NEXT_PUBLIC_UNLISTED_PROBE: 'probe-unlisted-next-000',
  VITE_DEFAULT_CITY: 'probe-default-city-000', // in .env.example but read by no code
}

function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

function build(name, env) {
  const out = mkdtempSync(join(tmpdir(), `aura-bundle-${name}-`))
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: '1', ...env },
    encoding: 'utf8',
  })
  const ok = r.status === 0
  const text = ok ? files(out).map((f) => readFileSync(f, 'utf8')).join('\n') : ''
  rmSync(out, { recursive: true, force: true })
  const err = ((r.stderr || '') + (r.stdout || '')).match(/AURA: unsafe build configuration[^\n]*/)?.[0] ?? (ok ? '' : (r.stderr || r.stdout || '').slice(0, 300))
  return { ok, text, err }
}
const has = (text, v) => text.includes(v)

const results = []
const expect = (scenario, okCond, label) => results.push({ scenario, ok: !!okCond, label })

// ── production ───────────────────────────────────────────────────────────────────────────────
{
  const r = build('production', { VERCEL: '1', VERCEL_ENV: 'production', ...PUBLIC, ...INTEGRATION, ...UNLISTED })
  expect('production', r.ok, `builds (${r.err || 'ok'})`)
  for (const [k, v] of Object.entries(PUBLIC)) expect('production', has(r.text, v), `public setting ${k} reaches the app`)
  for (const [k, v] of Object.entries({ ...INTEGRATION, ...UNLISTED })) expect('production', !has(r.text, v), `${k} is NOT in the bundle`)
  expect('production', !has(r.text, OTHER_REF) && !has(r.text, OTHER_REF2), 'no trace of the integration project in the bundle')
  expect('production', !/VITE_UNLISTED_PROBE|NEXT_PUBLIC_UNLISTED_PROBE|NEXT_PUBLIC_SUPABASE|SUPABASE_SERVICE_ROLE_KEY/.test(r.text), 'no unlisted variable NAME in the bundle either')
}
// ── preview with the Supabase integration still attached → refused ───────────────────────────
{
  const r = build('preview-integration', { VERCEL: '1', VERCEL_ENV: 'preview', ...INTEGRATION, ...UNLISTED })
  expect('preview-integration', !r.ok, 'refuses to build')
  expect('preview-integration', /SUPABASE_SERVICE_ROLE_KEY/.test(r.err) && /NEXT_PUBLIC_SUPABASE_URL/.test(r.err), `names the offending variables (${r.err.slice(0, 160)}…)`)
  expect('preview-integration', !Object.values(INTEGRATION).some((v) => r.err.includes(v)), 'the error never prints a value')
}
// ── clean preview → DEMO, nothing leaks ──────────────────────────────────────────────────────
{
  const r = build('preview-demo', { VERCEL: '1', VERCEL_ENV: 'preview', VITE_MAPS_PROVIDER: 'mock', ...UNLISTED })
  expect('preview-demo', r.ok, `builds (${r.err || 'ok'})`)
  for (const [k, v] of Object.entries(UNLISTED)) expect('preview-demo', !has(r.text, v), `${k} is NOT in the bundle`)
  expect('preview-demo', !/https:\/\/[a-z0-9]{20}\.supabase\.co/.test(r.text), 'no Supabase project URL in the DEMO bundle')
}

const failed = results.filter((r) => !r.ok)
if (asJson) console.log(JSON.stringify({ failed: failed.length, results }, null, 2))
else {
  for (const r of results) console.log(`${r.ok ? '✔' : '✘'} [${r.scenario}] ${r.label}`)
  console.log(failed.length ? `${failed.length} check(s) failed` : 'All checks passed')
}
process.exit(failed.length && !reportOnly ? 1 : 0)
