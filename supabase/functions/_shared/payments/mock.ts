/**
 * Offline payment provider for development and tests. Stateless (Edge Function
 * instances share nothing): the payment id encodes its status and amount.
 *
 * Test tokens:  tok_mock_<last4>        → succeeds (authorized if manual, else paid)
 *               tok_mock_3ds_<last4>    → needs 3-D Secure (status initiated + URL)
 *               tok_mock_decline_<last4>→ declined
 */
import type { CreatePaymentInput, PaymentProvider, ProviderPayment, ProviderStatus, SavedCard, WebhookCheck } from './provider.ts'

const rand = () => Math.random().toString(36).slice(2, 10)
const enc = (status: ProviderStatus, amount: bigint, captured: bigint, refunded: bigint, base: string) =>
  `mock_${status}_${amount}_${captured}_${refunded}_${base}`

export function decodeMockId(id: string) {
  const m = /^mock_([a-z]+)_(\d+)_(\d+)_(\d+)_(.+)$/.exec(id)
  if (!m) throw new Error('mock_unknown_payment')
  return { status: m[1] as ProviderStatus, amount: BigInt(m[2]), captured: BigInt(m[3]), refunded: BigInt(m[4]), base: m[5] }
}

function payment(status: ProviderStatus, amount: bigint, captured: bigint, refunded: bigint, base: string, extra: Partial<ProviderPayment> = {}): ProviderPayment {
  const id = enc(status, amount, captured, refunded, base)
  return { id, status, amountHalalas: amount, capturedHalalas: captured, refundedHalalas: refunded, metadata: {}, raw: { id, status }, ...extra }
}

export class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const

  async createPayment(i: CreatePaymentInput): Promise<ProviderPayment> {
    const base = `${i.paymentId.slice(0, 8)}${rand()}`
    const token = i.source.token
    if (token.startsWith('tok_mock_decline')) return payment('failed', i.amountHalalas, 0n, 0n, base, { failureMessage: 'Card declined (mock)' })
    if (token.startsWith('tok_mock_3ds')) {
      const p = payment('initiated', i.amountHalalas, 0n, 0n, base)
      // The "3-D Secure page" simply returns to the app; the app then asks the server to sync.
      return { ...p, transactionUrl: `${i.callbackUrl}${i.callbackUrl.includes('?') ? '&' : '?'}mock_3ds=1` }
    }
    if (!token.startsWith('tok_mock')) return payment('failed', i.amountHalalas, 0n, 0n, base, { failureMessage: 'Unknown mock token' })
    return i.manual
      ? payment('authorized', i.amountHalalas, 0n, 0n, base)
      : payment('paid', i.amountHalalas, i.amountHalalas, 0n, base)
  }

  async fetchPayment(id: string) {
    const d = decodeMockId(id)
    // A 3-D Secure payment "completes" once it is fetched again after the redirect.
    if (d.status === 'initiated') return payment('paid', d.amount, d.amount, 0n, d.base)
    return payment(d.status, d.amount, d.captured, d.refunded, d.base)
  }

  async capture(id: string, amount: bigint) {
    const d = decodeMockId(id)
    if (d.status !== 'authorized' || amount > d.amount) return payment('failed', d.amount, 0n, 0n, d.base, { failureMessage: 'Cannot capture' })
    return payment('paid', d.amount, amount, 0n, d.base)
  }

  async void(id: string) {
    const d = decodeMockId(id)
    return payment('voided', d.amount, 0n, 0n, d.base)
  }

  async refund(id: string, amount: bigint) {
    const d = decodeMockId(id)
    const refunded = d.refunded + amount
    if (refunded > (d.captured || d.amount)) return payment('failed', d.amount, d.captured, d.refunded, d.base, { failureMessage: 'Refund exceeds captured' })
    return payment('refunded', d.amount, d.captured || d.amount, refunded, d.base)
  }

  async fetchToken(id: string): Promise<SavedCard> {
    const last4 = (/(\d{4})$/.exec(id)?.[1] ?? '0000')
    const brand = last4.startsWith('4') ? 'visa' : last4.startsWith('5') ? 'mastercard' : 'mada'
    return { id, status: id.startsWith('tok_mock_decline') ? 'failed' : 'verified', brand, last4, month: 12, year: new Date().getFullYear() + 3, name: 'AURA TEST' }
  }

  verifyWebhook(body: unknown): WebhookCheck {
    const b = (body ?? {}) as { secret_token?: string; type?: string; data?: { id?: string } }
    return b.secret_token === 'mock' ? { ok: true, providerPaymentId: b.data?.id, event: b.type } : { ok: false }
  }
}
