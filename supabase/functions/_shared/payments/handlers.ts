/**
 * Payment use-cases for the Edge Functions, with injected dependencies (database
 * RPCs + provider) so they are unit-tested without Deno or a network.
 *
 *   rider actions : save_card · authorize_ride · topup · tip · sync (after 3-D Secure)
 *   webhook       : verify → re-fetch from provider → record_provider_payment
 *   worker        : capture completed card rides · void cancelled · refunds · stale sync
 */
import { MoneyError, toHalalas } from '../money.ts'
import { ProviderError, toDbStatus, type PaymentProvider, type PaymentSource, type ProviderPayment } from './provider.ts'

export type PaymentRow = {
  id: string
  kind: 'charge' | 'tip' | 'wallet_topup' | 'refund'
  status: 'initiated' | 'authorized' | 'paid' | 'failed' | 'voided'
  amount_halalas: number | string
  provider_payment_id: string | null
  ride_id: string | null
  rider_id: string
}

export type PaymentsDb = {
  createIntent(a: {
    userId: string
    kind: 'charge' | 'tip' | 'wallet_topup'
    rideId: string | null
    amountHalalas: bigint | null
    methodType: 'mada' | 'card' | 'apple_pay' | 'stc_pay'
    paymentMethodId: string | null
  }): Promise<PaymentRow>
  record(a: { paymentId: string; status: PaymentRow['status']; providerPaymentId?: string; amountHalalas?: bigint; failureCode?: string; failureMessage?: string; raw?: unknown }): Promise<PaymentRow>
  savedToken(paymentMethodId: string, userId: string): Promise<string | null>
  saveCard(a: { userId: string; methodType: 'mada' | 'card'; token: string; brand: string; last4: string; month: number; year: number; name?: string }): Promise<{ id: string }>
  getPayment(paymentId: string): Promise<PaymentRow | null>
}

export type Result = { status: number; body: Record<string, unknown> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = /^[A-Za-z0-9_\-:.]{4,200}$/
const METHOD_TYPES = ['mada', 'card', 'apple_pay', 'stc_pay'] as const

export const publicError = (e: unknown): string => {
  const m = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : ''
  return m.startsWith('AURA:') ? m.replace(/^AURA:\s*/, '') : e instanceof ProviderError ? 'provider_error' : e instanceof MoneyError ? 'invalid_amount' : 'internal_error'
}

type ChargeInput = {
  kind: 'charge' | 'tip' | 'wallet_topup'
  rideId: string | null
  amountHalalas: bigint | null
  methodType: (typeof METHOD_TYPES)[number]
  paymentMethodId: string | null
  token: string | null
  applePay: boolean
}

function parseCharge(kind: ChargeInput['kind'], b: Record<string, unknown>): ChargeInput | string {
  const rideId = typeof b.rideId === 'string' ? b.rideId : null
  if (kind !== 'wallet_topup' && (!rideId || !UUID.test(rideId))) return 'invalid_ride'
  const paymentMethodId = typeof b.paymentMethodId === 'string' ? b.paymentMethodId : null
  if (paymentMethodId && !UUID.test(paymentMethodId)) return 'invalid_payment_method_id'
  const token = typeof b.token === 'string' ? b.token : null
  if (token && !TOKEN.test(token)) return 'invalid_token'
  if (!token && !paymentMethodId) return 'payment_method_required'
  const methodType = (b.methodType ?? 'card') as ChargeInput['methodType']
  if (!METHOD_TYPES.includes(methodType)) return 'invalid_method_type'
  let amount: bigint | null = null
  if (b.amountHalalas !== undefined && b.amountHalalas !== null) {
    try {
      amount = toHalalas(b.amountHalalas as string)
    } catch {
      return 'invalid_amount'
    }
    if (amount <= 0n) return 'invalid_amount'
  } else if (kind !== 'charge') return 'invalid_amount'
  return { kind, rideId: kind === 'wallet_topup' ? null : rideId, amountHalalas: amount, methodType, paymentMethodId, token, applePay: methodType === 'apple_pay' }
}

export type ChargeDeps = { userId: string; provider: PaymentProvider; db: PaymentsDb; callbackUrl: string }

/** Create (or resume) a payment and send it to the provider. */
export async function charge(i: ChargeInput, d: ChargeDeps): Promise<Result> {
  const intent = await d.db.createIntent({ userId: d.userId, kind: i.kind, rideId: i.rideId, amountHalalas: i.amountHalalas, methodType: i.methodType, paymentMethodId: i.paymentMethodId })
  if (intent.status !== 'initiated' || intent.provider_payment_id) {
    return { status: 200, body: { paymentId: intent.id, status: intent.status } } // idempotent retry
  }
  const tokenValue = i.token ?? (i.paymentMethodId ? await d.db.savedToken(i.paymentMethodId, d.userId) : null)
  if (!tokenValue) return { status: 400, body: { error: 'payment_method_required' } }
  const source: PaymentSource = i.applePay ? { type: 'applepay', token: tokenValue } : { type: 'token', token: tokenValue }

  let pp: ProviderPayment
  try {
    pp = await d.provider.createPayment({
      paymentId: intent.id,
      amountHalalas: toHalalas(intent.amount_halalas),
      description: i.kind === 'charge' ? `AURA ride ${i.rideId}` : i.kind === 'tip' ? `AURA tip ${i.rideId}` : 'AURA wallet top-up',
      source,
      manual: i.kind === 'charge',
      callbackUrl: `${d.callbackUrl}${d.callbackUrl.includes('?') ? '&' : '?'}payment=${intent.id}`,
      metadata: { kind: i.kind, ride_id: i.rideId ?? '' },
    })
  } catch (e) {
    await d.db.record({ paymentId: intent.id, status: 'failed', failureCode: 'provider_error', failureMessage: e instanceof Error ? e.message : String(e) })
    return { status: 402, body: { error: 'payment_failed', paymentId: intent.id } }
  }
  const row = await d.db.record({
    paymentId: intent.id,
    status: toDbStatus(pp.status),
    providerPaymentId: pp.id,
    amountHalalas: pp.amountHalalas,
    failureCode: pp.status === 'failed' ? 'declined' : undefined,
    failureMessage: pp.failureMessage,
    raw: pp.raw,
  })
  if (row.status === 'failed') return { status: 402, body: { error: 'payment_failed', paymentId: intent.id, message: pp.failureMessage } }
  return {
    status: 200,
    body: { paymentId: intent.id, status: row.status, ...(row.status === 'initiated' && pp.transactionUrl ? { transactionUrl: pp.transactionUrl } : {}) },
  }
}

/** POST /payments  body: { action, ... } */
export async function handlePaymentAction(body: unknown, d: Omit<ChargeDeps, 'userId'> & { userId: string | null }): Promise<Result> {
  if (!d.userId) return { status: 401, body: { error: 'unauthorized' } }
  if (!body || typeof body !== 'object') return { status: 400, body: { error: 'invalid_body' } }
  const b = body as Record<string, unknown>
  const deps: ChargeDeps = { ...d, userId: d.userId }
  try {
    switch (b.action) {
      case 'save_card': {
        if (typeof b.token !== 'string' || !TOKEN.test(b.token)) return { status: 400, body: { error: 'invalid_token' } }
        const t = await d.provider.fetchToken(b.token)
        if (!['verified', 'active', 'initiated'].includes(t.status) || !/^\d{4}$/.test(t.last4)) return { status: 402, body: { error: 'card_not_verified' } }
        const methodType = t.brand.toLowerCase() === 'mada' ? 'mada' : 'card'
        const saved = await d.db.saveCard({ userId: d.userId, methodType, token: t.id, brand: t.brand, last4: t.last4, month: t.month, year: t.year, name: t.name })
        return { status: 201, body: { paymentMethodId: saved.id, brand: t.brand, last4: t.last4, methodType } }
      }
      case 'authorize_ride':
      case 'topup':
      case 'tip': {
        const kind = b.action === 'authorize_ride' ? 'charge' : b.action === 'topup' ? 'wallet_topup' : 'tip'
        const parsed = parseCharge(kind, b)
        if (typeof parsed === 'string') return { status: 400, body: { error: parsed } }
        return await charge(parsed, deps)
      }
      case 'sync': {
        if (typeof b.paymentId !== 'string' || !UUID.test(b.paymentId)) return { status: 400, body: { error: 'invalid_payment' } }
        const p = await d.db.getPayment(b.paymentId)
        if (!p || p.rider_id !== d.userId) return { status: 404, body: { error: 'not_found' } }
        if (!p.provider_payment_id || p.status !== 'initiated') return { status: 200, body: { paymentId: p.id, status: p.status } }
        const pp = await d.provider.fetchPayment(p.provider_payment_id)
        const row = await d.db.record({ paymentId: p.id, status: toDbStatus(pp.status), amountHalalas: pp.amountHalalas, failureMessage: pp.failureMessage, raw: pp.raw })
        return { status: 200, body: { paymentId: row.id, status: row.status } }
      }
      default:
        return { status: 400, body: { error: 'unknown_action' } }
    }
  } catch (e) {
    return { status: 400, body: { error: publicError(e) } }
  }
}

/** Provider webhook: never trust the body — verify, then re-fetch the payment. */
export async function handleWebhook(body: unknown, d: { provider: PaymentProvider; db: Pick<PaymentsDb, 'record' | 'getPayment'> }): Promise<Result> {
  const check = d.provider.verifyWebhook(body)
  if (!check.ok) return { status: 401, body: { error: 'invalid_signature' } }
  if (!check.providerPaymentId) return { status: 200, body: { ignored: true } }
  const pp = await d.provider.fetchPayment(check.providerPaymentId)
  const ours = pp.metadata.aura_payment_id
  if (!ours || !UUID.test(ours) || !(await d.db.getPayment(ours))) return { status: 200, body: { ignored: true } }
  const row = await d.db.record({
    paymentId: ours,
    status: toDbStatus(pp.status),
    providerPaymentId: pp.id,
    amountHalalas: pp.amountHalalas,
    failureMessage: pp.failureMessage,
    raw: { event: check.event, payment: pp.raw },
  })
  return { status: 200, body: { paymentId: row.id, status: row.status } }
}

export type QueueItem = { payment_id: string; action: 'capture' | 'void' | 'refund' | 'sync'; provider: string; provider_payment_id: string | null; amount_halalas: number | string }

/** Captures, voids, refunds and stale syncs. Each item is isolated: one failure never blocks the rest. */
export async function runPaymentWorker(d: {
  queue(): Promise<QueueItem[]>
  provider(name: string): PaymentProvider
  db: Pick<PaymentsDb, 'record'>
}): Promise<{ processed: number; failed: number; results: { paymentId: string; action: string; ok: boolean; error?: string }[] }> {
  const items = await d.queue()
  const results: { paymentId: string; action: string; ok: boolean; error?: string }[] = []
  for (const it of items) {
    try {
      if (!it.provider_payment_id) throw new Error('missing_provider_reference')
      const p = d.provider(it.provider)
      const amount = toHalalas(it.amount_halalas)
      if (it.action === 'capture') {
        const pp = await p.capture(it.provider_payment_id, amount)
        // The stored provider reference stays authoritative after creation.
        await d.db.record({ paymentId: it.payment_id, status: toDbStatus(pp.status), amountHalalas: pp.capturedHalalas || pp.amountHalalas, failureMessage: pp.failureMessage, raw: pp.raw })
      } else if (it.action === 'void') {
        const pp = await p.void(it.provider_payment_id)
        await d.db.record({ paymentId: it.payment_id, status: pp.status === 'voided' ? 'voided' : toDbStatus(pp.status), raw: pp.raw })
      } else if (it.action === 'refund') {
        const pp = await p.refund(it.provider_payment_id, amount)
        await d.db.record({
          paymentId: it.payment_id,
          status: pp.status === 'refunded' ? 'paid' : 'failed',
          providerPaymentId: `${it.provider_payment_id}:refund:${it.payment_id}`,
          amountHalalas: amount,
          failureCode: pp.status === 'refunded' ? undefined : 'refund_failed',
          failureMessage: pp.failureMessage,
          raw: pp.raw,
        })
      } else {
        const pp = await p.fetchPayment(it.provider_payment_id)
        await d.db.record({ paymentId: it.payment_id, status: toDbStatus(pp.status), amountHalalas: pp.amountHalalas, failureMessage: pp.failureMessage, raw: pp.raw })
      }
      results.push({ paymentId: it.payment_id, action: it.action, ok: true })
    } catch (e) {
      results.push({ paymentId: it.payment_id, action: it.action, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { processed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results }
}
