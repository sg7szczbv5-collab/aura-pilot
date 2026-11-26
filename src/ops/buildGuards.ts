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
 */
import { buildPaymentViolations } from '../payments/paymentPolicy'
import { looksSecret } from './configChecks'
import { PROD_PROJECT_REF, projectRefFromUrl } from './prodBinding'

type BuildEnv = Record<string, string | undefined>

const PLACEHOLDER = /your-project-ref|<.*>/i

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
  return { mockOnly: pay.mockOnly, violations }
}
