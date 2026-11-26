/**
 * AURA production preflight.
 *
 *   npm run preflight                                   # development defaults, local files
 *   npm run preflight -- --target production --env-file .env.production
 *   npm run preflight -- --target production --env-file .env.production --db   # + live ops_readiness()
 *   add --json for machine-readable output (CI)
 *
 * Checks: configuration & secret hygiene (src/ops/configChecks.ts), hosting
 * security headers (public/_headers), secrets in the built bundle (dist/), and
 * with --db the live database (public.ops_readiness via the service role).
 * Exit code 1 when any blocker fails. Secret values are never printed.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkConfig, scanBundle, summarize, type Check, type Env, type Target } from '../src/ops/configChecks'
import { checkHeaders, diffVercelHeaders } from '../src/ops/securityHeaders'
import { parseEnvFile } from '../src/ops/envFile'

const root = resolve(import.meta.dirname ?? '.', '..')
const argv = process.argv.slice(2).filter((a) => a !== '--')
const flag = (name: string) => argv.includes(`--${name}`)
const values = (name: string) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []))

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

async function main() {
  const target = (values('target')[0] ?? 'development') as Target
  if (!['development', 'staging', 'production'].includes(target)) throw new Error(`unknown target ${target}`)
  const envFiles = values('env-file')
  const env: Env = {}
  for (const f of envFiles) Object.assign(env, parseEnvFile(readFileSync(resolve(root, f), 'utf8')))
  for (const [k, v] of Object.entries(process.env)) if (/^(VITE_|SUPABASE_|PAYMENT|MOYASAR_|GOOGLE_MAPS_|WASL_|PRIVACY_|HEALTH_|APP_ENV|DISPATCH_)/.test(k)) env[k] = v

  const checks: Check[] = [...checkConfig(env, target)]

  const headersPath = join(root, 'public', '_headers')
  if (existsSync(headersPath)) checks.push(...checkHeaders(readFileSync(headersPath, 'utf8')))
  else checks.push({ id: 'headers_file', area: 'hosting', severity: 'blocker', ok: false, detail: 'public/_headers is missing' })

  // Vercel ignores public/_headers: the same headers must be in vercel.json.
  const vercelPath = join(root, 'vercel.json')
  if (existsSync(headersPath) && existsSync(vercelPath)) {
    const diffs = diffVercelHeaders(readFileSync(headersPath, 'utf8'), JSON.parse(readFileSync(vercelPath, 'utf8')))
    checks.push({ id: 'vercel_headers', area: 'hosting', severity: 'blocker', ok: diffs.length === 0, detail: diffs.length ? `vercel.json differs from public/_headers: ${diffs.join('; ')}` : 'vercel.json carries the same security headers (Vercel ignores _headers)' })
  }

  const dist = join(root, 'dist')
  if (existsSync(dist)) {
    const files = walk(dist).filter((p) => /\.(js|html|css|map|json)$/.test(p)).map((p) => ({ name: p.slice(root.length + 1), content: readFileSync(p, 'utf8') }))
    checks.push(scanBundle(files))
    checks.push({ id: 'bundle_headers', area: 'hosting', severity: 'blocker', ok: existsSync(join(dist, '_headers')), detail: 'dist/_headers shipped with the build' })
  } else {
    checks.push({ id: 'bundle_secrets', area: 'security', severity: target === 'production' ? 'blocker' : 'warning', ok: false, detail: 'dist/ not found: run npm run build first' })
  }

  if (flag('db')) {
    const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
    const key = env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
      checks.push({ id: 'db_reachable', area: 'database', severity: 'blocker', ok: false, detail: 'Set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY for --db' })
    } else {
      const { createClient } = await import('@supabase/supabase-js')
      const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
      const { data, error } = await sb.rpc('ops_readiness')
      if (error || !data) checks.push({ id: 'db_reachable', area: 'database', severity: 'blocker', ok: false, detail: error?.message ?? 'no data' })
      else for (const c of (data as { checks: Check[] }).checks) checks.push({ ...c, id: `db.${c.id}`, area: `db/${c.area}` })
    }
  }

  const s = summarize(checks)
  if (flag('json')) {
    console.log(JSON.stringify({ target, ...s, checks }, null, 2))
  } else {
    console.log(`\nAURA preflight · target: ${target}${envFiles.length ? ` · env: ${envFiles.join(', ')}` : ''}\n`)
    const areas = [...new Set(checks.map((c) => c.area))]
    for (const area of areas) {
      console.log(`  ${area}`)
      for (const c of checks.filter((x) => x.area === area)) {
        const mark = c.ok ? '✔' : c.severity === 'blocker' ? '✖' : '!'
        console.log(`    ${mark} ${c.id.padEnd(30)} ${c.detail}`)
      }
    }
    console.log(`\n  ${s.ok ? 'READY' : 'NOT READY'}: ${s.blockersFailed} blocker(s) failing, ${s.warnings} warning(s), ${s.passed}/${s.total} passed\n`)
  }
  process.exit(s.ok ? 0 : 1)
}

main().catch((e) => {
  console.error(`preflight failed: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(2)
})
