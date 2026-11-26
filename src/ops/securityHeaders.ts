/**
 * Parse and verify public/_headers (Netlify / Cloudflare Pages format).
 * The CSP must allow every origin the app really talks to, and nothing risky.
 */
import type { Check } from './configChecks'

export type HeaderRules = Record<string, Record<string, string>>

export function parseHeadersFile(text: string): HeaderRules {
  const rules: HeaderRules = {}
  let path: string | null = null
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    if (!/^\s/.test(raw)) {
      path = raw.trim()
      rules[path] ??= {}
      continue
    }
    const i = raw.indexOf(':')
    if (path && i > 0) rules[path][raw.slice(0, i).trim().toLowerCase()] = raw.slice(i + 1).trim()
  }
  return rules
}

export function parseCsp(value: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const part of value.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) out[name.toLowerCase()] = sources
  }
  return out
}

/** Does a CSP source list allow this URL (exact host, *.wildcard or 'self')? */
export function allows(sources: string[] | undefined, url: string): boolean {
  if (!sources) return false
  const u = new URL(url)
  return sources.some((s) => {
    if (s === `${u.protocol}//${u.host}`) return true
    const m = /^(https?:|wss?:)\/\/\*\.(.+)$/.exec(s)
    return !!m && m[1] === u.protocol && (u.host === m[2] || u.host.endsWith(`.${m[2]}`))
  })
}

/** Origins the production app uses (Supabase API/Realtime, Moyasar tokenization, Google Maps/Places). */
export const REQUIRED_CONNECT = [
  'https://abcdefgh.supabase.co',
  'wss://abcdefgh.supabase.co',
  'https://api.moyasar.com',
  'https://maps.googleapis.com',
  'https://places.googleapis.com',
]

export function checkHeaders(text: string): Check[] {
  const rules = parseHeadersFile(text)
  const all = rules['/*'] ?? {}
  const out: Check[] = []
  const add = (id: string, ok: boolean, detail: string, severity: Check['severity'] = 'blocker') => out.push({ id, area: 'hosting', severity, ok, detail })

  const csp = parseCsp(all['content-security-policy'] ?? '')
  add('csp_present', !!all['content-security-policy'], 'Content-Security-Policy on every page')
  add('csp_frame_ancestors', (csp['frame-ancestors'] ?? []).includes("'none'"), "frame-ancestors 'none' (no clickjacking)")
  add('csp_object_src', (csp['object-src'] ?? []).includes("'none'"), "object-src 'none'")
  add('csp_no_inline_script', !(csp['script-src'] ?? []).includes("'unsafe-inline'") && !(csp['script-src'] ?? []).includes('*'), 'Scripts: no inline, no wildcard')
  add('csp_default_self', (csp['default-src'] ?? []).join(' ') === "'self'", "default-src 'self'")
  const missing = REQUIRED_CONNECT.filter((u) => !allows(csp['connect-src'], u))
  add('csp_connect_origins', missing.length === 0, missing.length === 0 ? 'Supabase, Realtime, Moyasar and Google are allowed' : `connect-src blocks: ${missing.join(', ')}`)
  add('csp_maps_script', allows(csp['script-src'], 'https://maps.googleapis.com/maps/api/js'), 'Google Maps loader script allowed')
  const hsts = /max-age=(\d+)/.exec(all['strict-transport-security'] ?? '')
  add('hsts', !!hsts && Number(hsts[1]) >= 31536000, 'HSTS for at least one year')
  add('nosniff', all['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options: nosniff')
  add('referrer_policy', /strict-origin|no-referrer/.test(all['referrer-policy'] ?? ''), 'Referrer-Policy limits leakage of share-link tokens')
  add('permissions_geolocation', /geolocation=\(self\)/.test(all['permissions-policy'] ?? '') && /camera=\(\)/.test(all['permissions-policy'] ?? ''), 'Geolocation only for AURA; camera/microphone off')
  add('cache_index', /no-cache|no-store/.test(rules['/index.html']?.['cache-control'] ?? ''), 'index.html is never cached (instant rollouts/rollbacks)', 'warning')
  add('cache_assets', /immutable/.test(rules['/assets/*']?.['cache-control'] ?? ''), 'Hashed assets cached immutably', 'warning')
  return out
}

/**
 * vercel.json must carry the same headers as public/_headers (Vercel ignores _headers).
 * Returns the paths / header names that differ; empty when in sync.
 */
export function diffVercelHeaders(headersText: string, vercelJson: { headers?: { source: string; headers: { key: string; value: string }[] }[] }): string[] {
  const want = parseHeadersFile(headersText)
  const toSource = (path: string) => (path === '/*' ? '/(.*)' : path.replace(/\*/g, '(.*)'))
  const have = new Map((vercelJson.headers ?? []).map((h) => [h.source, Object.fromEntries(h.headers.map((x) => [x.key.toLowerCase(), x.value]))]))
  const diffs: string[] = []
  for (const [path, headers] of Object.entries(want)) {
    const got = have.get(toSource(path))
    if (!got) {
      diffs.push(`${path}: missing in vercel.json`)
      continue
    }
    for (const [k, v] of Object.entries(headers)) if (got[k] !== v) diffs.push(`${path}: ${k}`)
  }
  return diffs
}
