/**
 * Build-time guards shared by vite.config.ts and vite.share.config.ts. A build that would ship an
 * unsafe configuration FAILS instead of producing a bundle.
 *
 *  1. Payments (F3): a mock-only (staging / BETA / Vercel Preview) build refuses any payment-gateway
 *     setting or non-mock provider (src/payments/paymentPolicy.ts).
 *  2. Secrets: no build may inline a secret into the browser (any VITE_ / NEXT_PUBLIC_ variable that
 *     holds a service_role JWT, an sb_secret_ key, an sk_ key or a private key).
 *  3. Backend identity: a mock-only build that talks to Supabase must target exactly the declared BETA
 *     project (BETA_PROJECT_REF, build-only, never bundled) and never the production ref.
 *  4. Demo isolation (C3): a mock-only build (Vercel Preview / BETA / staging) must not even HAVE
 *     server credentials in its build environment (a Supabase Marketplace integration injects
 *     SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET, POSTGRES_* …; any build script of an unreviewed
 *     branch could read them), and every Supabase URL / key it carries — under any name — must belong
 *     to the declared BETA project. No BETA_PROJECT_REF declared → no Supabase at all (DEMO).
 *     Production builds are not affected by rule 4. Messages name variables, never values.
 */
import { buildPaymentViolations } from '../payments/paymentPolicy'
import { looksSecret } from './configChecks'
import { PROD_PROJECT_REF, projectRefFromUrl } from './prodBinding'

type BuildEnv = Record<string, string | undefined>

const PLACEHOLDER = /your-project-ref|<.*>/i

/** Server-only credentials: never in a mock-only build environment, whatever their value. */
export const SERVER_CREDENTIAL_NAME = /^(SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|SUPABASE_JWT_SECRET|SUPABASE_DB_PASSWORD|SUPABASE_ACCESS_TOKEN|DATABASE_URL|POSTGRES_[A-Z0-9_]+)$/
/** Supabase connection settings under names other than the app's own VITE_SUPABASE_*. */
const OTHER_SUPABASE_URL = /^(?!VITE_)[A-Z0-9_]*SUPABASE_URL$/
const OTHER_SUPABASE_KEY = /^(?!VITE_)[A-Z0-9_]*SUPABASE_(ANON|PUBLISHABLE)_KEY$/

/** `ref` claim of a Supabase JWT key, if it is one. */
function jwtRef(token: string): string | undefined {
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(atob(p.padEnd(p.length + ((4 - (p.length % 4)) % 4), '=')))
    return typeof json.ref === 'string' ? json.ref : undefined
  } catch {
    return undefined
  }
}

export function buildEnvironmentViolations(env: BuildEnv, prodRef: string | null = PROD_PROJECT_REF): { mockOnly: boolean; violations: string[] } {
  const pay = buildPaymentViolations(env)
  const violations = [...pay.violations]
  for (const [k, v] of Object.entries(env)) {
    if ((k.startsWith('VITE_') || k.startsWith('NEXT_PUBLIC_')) && v && looksSecret(v.trim())) violations.push(`${k} holds a secret (it would be inlined into the browser bundle)`)
  }
  const url = (env.VITE_SUPABASE_URL ?? '').trim()
  if (pay.mockOnly && url !== '' && !PLACEHOLDER.test(url)) {
    const ref = projectRefFromUrl(url)
    const beta = (env.BETA_PROJECT_REF ?? '').trim()
    if (!ref) violations.push('VITE_SUPABASE_URL is not a https://<ref>.supabase.co project URL')
    else {
      if (!beta) violations.push('BETA_PROJECT_REF is not set: a mock-only build must declare the BETA project it targets')
      else if (ref !== beta) violations.push('VITE_SUPABASE_URL does not point to BETA_PROJECT_REF')
      if (prodRef && ref === prodRef) violations.push('VITE_SUPABASE_URL points to the production project')
    }
  }
  if (pay.mockOnly) violations.push(...demoIsolationViolations(env, prodRef))
  return { mockOnly: pay.mockOnly, violations }
}

/** Rule 4 (C3) — only called for mock-only builds. */
export function demoIsolationViolations(env: BuildEnv, prodRef: string | null = PROD_PROJECT_REF): string[] {
  const out: string[] = []
  const beta = (env.BETA_PROJECT_REF ?? '').trim()
  for (const [k, raw] of Object.entries(env)) {
    const v = (raw ?? '').trim()
    if (!v) continue
    if (SERVER_CREDENTIAL_NAME.test(k)) {
      out.push(`${k} is set: a mock-only (Preview / BETA) build must not have server credentials in its build environment`)
      continue
    }
    if (!k.startsWith('VITE_') && !k.startsWith('NEXT_PUBLIC_') && looksSecret(v)) {
      out.push(`${k} holds a server secret: a mock-only (Preview / BETA) build must not have it in its build environment`)
      continue
    }
    if (OTHER_SUPABASE_URL.test(k) && !PLACEHOLDER.test(v)) {
      const ref = projectRefFromUrl(v)
      if (!ref) out.push(`${k} is not a https://<ref>.supabase.co project URL`)
      else if (!beta) out.push(`${k} points to a Supabase project but no BETA_PROJECT_REF is declared (a Preview without a BETA project is DEMO only)`)
      else if (ref !== beta) out.push(`${k} does not point to BETA_PROJECT_REF`)
      if (ref && prodRef && ref === prodRef) out.push(`${k} points to the production project`)
    }
    if (OTHER_SUPABASE_KEY.test(k) && !PLACEHOLDER.test(v)) {
      const ref = jwtRef(v)
      if (!beta) out.push(`${k} is set but no BETA_PROJECT_REF is declared (a Preview without a BETA project is DEMO only)`)
      else if (ref && ref !== beta) out.push(`${k} belongs to another project than BETA_PROJECT_REF`)
      if (ref && prodRef && ref === prodRef) out.push(`${k} belongs to the production project`)
    }
  }
  // The app's own key must match the declared BETA project too (rule 3 checks the URL).
  const anon = (env.VITE_SUPABASE_ANON_KEY ?? '').trim()
  const anonRef = anon && !PLACEHOLDER.test(anon) ? jwtRef(anon) : undefined
  if (anonRef && (!beta || anonRef !== beta)) out.push('VITE_SUPABASE_ANON_KEY belongs to another project than BETA_PROJECT_REF')
  if (anonRef && prodRef && anonRef === prodRef) out.push('VITE_SUPABASE_ANON_KEY belongs to the production project')
  return out
}
