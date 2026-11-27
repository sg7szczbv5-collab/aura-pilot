/**
 * Card entry helpers. With Moyasar, raw card numbers go straight from the browser to Moyasar
 * (publishable key, save_only token); AURA only ever stores the token, brand, last 4 digits
 * and expiry. Which tokenizer is used is decided by paymentPolicy.ts: Moyasar only when chosen
 * explicitly (VITE_PAYMENT_PROVIDER=moyasar) outside BETA; mock-only builds never reach it.
 */
import { AUTH_MODE } from '../auth/config'
import { decidePaymentPolicy } from './paymentPolicy'

import { PUBLIC_ENV } from '../config/publicEnv'

// C1: explicit, allowlisted variables only (src/config/publicEnv.ts) — never the whole import.meta.env.
const env: Record<string, string | undefined> = PUBLIC_ENV
export const MOYASAR_PUBLISHABLE_KEY = env.VITE_MOYASAR_PUBLISHABLE_KEY?.trim() || undefined
export const PAYMENT_POLICY = decidePaymentPolicy({
  appEnv: env.VITE_APP_ENV,
  mockOnlyBuild: env.VITE_AURA_PAYMENTS_MOCK_ONLY === '1',
  provider: env.VITE_PAYMENT_PROVIDER,
  publishableKey: MOYASAR_PUBLISHABLE_KEY,
  authMode: AUTH_MODE,
})
/** Server-side PAYMENT_PROVIDER must match: mock tokens only work with the mock provider. */
export const CARD_TOKENIZER = PAYMENT_POLICY.tokenizer

export const digitsOnly = (s: string) => s.replace(/\D/g, '')

export function luhnValid(num: string): boolean {
  const d = digitsOnly(num)
  if (d.length < 12 || d.length > 19) return false
  let sum = 0
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48
    if (i % 2 === 1) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
  }
  return sum % 10 === 0
}

/** Representative mada BINs (not exhaustive; the gateway reports the definitive brand). */
const MADA_BINS = ['440647', '440795', '446404', '457865', '968208', '588845', '636120', '417633', '468540', '468541', '468542', '468543', '968201', '968202', '968203', '968204', '968205', '968206', '968207', '968209', '968211', '446393', '409201', '458456', '484783', '410685', '504300', '529415', '535825', '543085', '549760', '554180', '588848', '589206']

export type CardBrand = 'mada' | 'visa' | 'mastercard' | 'unknown'
export function cardBrand(num: string): CardBrand {
  const d = digitsOnly(num)
  if (MADA_BINS.some((b) => d.startsWith(b))) return 'mada'
  if (/^4/.test(d)) return 'visa'
  if (/^(5[1-5]|2[2-7])/.test(d)) return 'mastercard'
  return 'unknown'
}

export function expiryValid(month: number, year: number, now = new Date()): boolean {
  if (!Number.isInteger(month) || month < 1 || month > 12) return false
  const y = year < 100 ? 2000 + year : year
  return y > now.getFullYear() || (y === now.getFullYear() && month >= now.getMonth() + 1)
}

export type CardInput = { name: string; number: string; month: number; year: number; cvc: string }
export type CardCheck = { ok: true } | { ok: false; field: 'name' | 'number' | 'expiry' | 'cvc' }

export function validateCard(c: CardInput): CardCheck {
  if (c.name.trim().length < 2) return { ok: false, field: 'name' }
  if (!luhnValid(c.number)) return { ok: false, field: 'number' }
  if (!expiryValid(c.month, c.year)) return { ok: false, field: 'expiry' }
  if (!/^\d{3,4}$/.test(c.cvc)) return { ok: false, field: 'cvc' }
  return { ok: true }
}

export type TokenResult =
  | { ok: true; token: string; verificationUrl?: string }
  | { ok: false; error: 'invalid_card' | 'declined' | 'network' | 'payments_disabled' }

/**
 * Tokenize a card. Moyasar: POST /v1/tokens with the publishable key (save_only).
 * Mock: deterministic test tokens (4000 0000 0000 0002 is declined,
 * 4000 0000 0000 3220 needs 3-D Secure).
 */
export async function tokenizeCard(c: CardInput, callbackUrl: string, fetchFn: typeof fetch = fetch, tokenizer: typeof CARD_TOKENIZER = CARD_TOKENIZER): Promise<TokenResult> {
  if (!validateCard(c).ok) return { ok: false, error: 'invalid_card' }
  // Fail closed: a misconfigured mock-only build never sends card data anywhere.
  if (tokenizer === 'disabled') return { ok: false, error: 'payments_disabled' }
  const number = digitsOnly(c.number)
  const last4 = number.slice(-4)
  if (tokenizer === 'mock') {
    if (number === '4000000000000002') return { ok: false, error: 'declined' }
    return { ok: true, token: number === '4000000000003220' ? `tok_mock_3ds_${last4}` : `tok_mock_${last4}` }
  }
  try {
    const res = await fetchFn('https://api.moyasar.com/v1/tokens', {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${MOYASAR_PUBLISHABLE_KEY}:`)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: c.name.trim(),
        number,
        cvc: c.cvc,
        month: String(c.month).padStart(2, '0'),
        year: String(c.year < 100 ? 2000 + c.year : c.year),
        save_only: true,
        callback_url: callbackUrl,
      }),
    })
    const j = (await res.json().catch(() => ({}))) as { id?: string; status?: string; verification_url?: string }
    if (!res.ok || !j.id) return { ok: false, error: res.status === 400 ? 'invalid_card' : 'declined' }
    return { ok: true, token: j.id, verificationUrl: j.status === 'initiated' ? j.verification_url : undefined }
  } catch {
    return { ok: false, error: 'network' }
  }
}
