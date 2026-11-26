/**
 * Which card tokenizer the browser may use (review finding F3).
 *
 * BETA / staging / Vercel Preview are MOCK ONLY: card data must never leave the browser for a
 * payment gateway there. Elsewhere Moyasar is used only when it is chosen EXPLICITLY
 * (VITE_PAYMENT_PROVIDER=moyasar) and a publishable key exists — the key alone is not enough.
 * A non-mock setting in a mock-only build disables card entry (fail closed) instead of
 * silently falling back.
 */
export type Tokenizer = 'moyasar' | 'mock' | 'disabled'
export type PaymentPolicyInput = {
  /** VITE_APP_ENV (development | staging | beta | production). */
  appEnv?: string
  /** Set at build time by vite.config.ts: true for staging / beta / Vercel Preview builds. */
  mockOnlyBuild?: boolean
  /** VITE_PAYMENT_PROVIDER. */
  provider?: string
  /** VITE_MOYASAR_PUBLISHABLE_KEY. */
  publishableKey?: string
  /** AUTH_MODE: Moyasar tokens are only useful against a real backend. */
  authMode: 'supabase' | 'mock'
}
export type PaymentPolicy = { tokenizer: Tokenizer; mockOnly: boolean; reason: string }

/** Environments that are mock-only, whatever else is configured. */
export const MOCK_ONLY_ENVS = ['staging', 'beta', 'preview']

export function isMockOnly(p: Pick<PaymentPolicyInput, 'appEnv' | 'mockOnlyBuild'>): boolean {
  return p.mockOnlyBuild === true || MOCK_ONLY_ENVS.includes((p.appEnv ?? '').trim().toLowerCase())
}

export function decidePaymentPolicy(p: PaymentPolicyInput): PaymentPolicy {
  const mockOnly = isMockOnly(p)
  const provider = (p.provider ?? 'mock').trim().toLowerCase() || 'mock'
  const key = (p.publishableKey ?? '').trim()
  if (mockOnly) {
    if (provider !== 'mock' || key !== '') return { tokenizer: 'disabled', mockOnly, reason: 'payment gateway configured in a mock-only (BETA) build' }
    return { tokenizer: 'mock', mockOnly, reason: 'mock-only environment' }
  }
  if (provider === 'moyasar' && key !== '' && p.authMode === 'supabase') return { tokenizer: 'moyasar', mockOnly, reason: 'Moyasar explicitly selected' }
  return { tokenizer: 'mock', mockOnly, reason: provider === 'moyasar' ? 'Moyasar selected but not usable (no key or demo mode)' : 'mock provider' }
}

/** Hosts of payment gateways the browser must never reach in a mock-only build. */
export const PAYMENT_GATEWAY_HOST = /(^|\.)moyasar\.com$/i

export function isPaymentGatewayUrl(url: string, base = 'http://localhost'): boolean {
  try {
    return PAYMENT_GATEWAY_HOST.test(new URL(url, base).hostname)
  } catch {
    return false
  }
}

/**
 * Build-time check (vite.config.ts): a mock-only build fails when any payment-gateway setting
 * is present. `env` is the full build environment (process.env + .env files).
 */
export const GATEWAY_SETTINGS = ['VITE_MOYASAR_PUBLISHABLE_KEY', 'MOYASAR_SECRET_KEY', 'MOYASAR_WEBHOOK_SECRET', 'MOYASAR_API_BASE_URL'] as const
export function buildPaymentViolations(env: Record<string, string | undefined>): { mockOnly: boolean; violations: string[] } {
  const appEnv = env.VITE_APP_ENV || env.APP_ENV
  const mockOnly = isMockOnly({ appEnv, mockOnlyBuild: env.VERCEL_ENV === 'preview' })
  if (!mockOnly) return { mockOnly, violations: [] }
  const violations: string[] = GATEWAY_SETTINGS.filter((k) => (env[k] ?? '').trim() !== '').map((k) => `${k} is set`)
  for (const k of ['VITE_PAYMENT_PROVIDER', 'PAYMENT_PROVIDER', 'PAYOUT_PROVIDER'] as const) {
    const v = (env[k] ?? '').trim().toLowerCase()
    if (v !== '' && v !== 'mock') violations.push(`${k}=${env[k]}`)
  }
  const w = (env.WASL_MODE ?? '').trim().toLowerCase()
  if (w !== '' && w !== 'mock') violations.push(`WASL_MODE=${env.WASL_MODE}`)
  return { mockOnly, violations }
}
