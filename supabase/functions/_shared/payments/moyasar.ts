/**
 * Moyasar REST adapter (https://docs.moyasar.com). Amounts are integers in the
 * smallest unit (halalas), currency SAR. Uses the SECRET key: server only.
 *
 * Verify against the Moyasar docs/your account before going live:
 *  - `source.manual: true` (authorize now, capture on completion)
 *  - `given_id` (our payment uuid) for idempotent creation
 *  - webhook `secret_token` configured in the dashboard = MOYASAR_WEBHOOK_SECRET
 */
import { safeEqual } from '../http.ts'
import { toSafeNumber } from '../money.ts'
import {
  ProviderError,
  type CreatePaymentInput,
  type FetchLike,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderStatus,
  type SavedCard,
  type WebhookCheck,
} from './provider.ts'

type MoyasarPayment = {
  id: string
  status: string
  amount: number
  captured?: number
  refunded?: number
  metadata?: Record<string, string> | null
  source?: { transaction_url?: string | null; message?: string | null } | null
}

const STATUS: Record<string, ProviderStatus> = {
  initiated: 'initiated',
  authorized: 'authorized',
  paid: 'paid',
  captured: 'paid',
  failed: 'failed',
  voided: 'voided',
  refunded: 'refunded',
}

export function mapMoyasarPayment(p: MoyasarPayment): ProviderPayment {
  return {
    id: p.id,
    status: STATUS[p.status] ?? 'failed',
    amountHalalas: BigInt(p.amount),
    capturedHalalas: BigInt(p.captured ?? 0),
    refundedHalalas: BigInt(p.refunded ?? 0),
    transactionUrl: p.source?.transaction_url ?? undefined,
    metadata: p.metadata ?? {},
    failureMessage: p.source?.message ?? undefined,
    raw: p,
  }
}

const b64 = (s: string) => btoa(s) // available in Deno, browsers and Node ≥ 16

export class MoyasarProvider implements PaymentProvider {
  readonly name = 'moyasar' as const

  constructor(
    private readonly secretKey: string,
    private readonly fetchFn: FetchLike,
    private readonly webhookSecret = '',
    private readonly baseUrl = 'https://api.moyasar.com/v1',
  ) {
    if (!secretKey) throw new ProviderError('moyasar_secret_key_missing')
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Basic ${b64(`${this.secretKey}:`)}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as { message?: string; type?: string }
    if (!res.ok) throw new ProviderError(json.message ?? `moyasar_http_${res.status}`, res.status, json.type)
    return json as T
  }

  async createPayment(i: CreatePaymentInput): Promise<ProviderPayment> {
    const p = await this.call<MoyasarPayment>('POST', '/payments', {
      given_id: i.paymentId,
      amount: toSafeNumber(i.amountHalalas),
      currency: 'SAR',
      description: i.description.slice(0, 255),
      callback_url: i.callbackUrl,
      metadata: { ...i.metadata, aura_payment_id: i.paymentId },
      source: { type: i.source.type, token: i.source.token, ...(i.manual ? { manual: true } : {}) },
    })
    return mapMoyasarPayment(p)
  }

  async fetchPayment(id: string) {
    return mapMoyasarPayment(await this.call<MoyasarPayment>('GET', `/payments/${encodeURIComponent(id)}`))
  }

  async capture(id: string, amount: bigint) {
    return mapMoyasarPayment(await this.call<MoyasarPayment>('POST', `/payments/${encodeURIComponent(id)}/capture`, { amount: toSafeNumber(amount) }))
  }

  async void(id: string) {
    return mapMoyasarPayment(await this.call<MoyasarPayment>('POST', `/payments/${encodeURIComponent(id)}/void`))
  }

  async refund(id: string, amount: bigint) {
    return mapMoyasarPayment(await this.call<MoyasarPayment>('POST', `/payments/${encodeURIComponent(id)}/refund`, { amount: toSafeNumber(amount) }))
  }

  async fetchToken(id: string): Promise<SavedCard> {
    const t = await this.call<{ id: string; status: string; brand: string; last_four: string; month: string | number; year: string | number; name?: string }>(
      'GET',
      `/tokens/${encodeURIComponent(id)}`,
    )
    return { id: t.id, status: t.status, brand: t.brand, last4: t.last_four, month: Number(t.month), year: Number(t.year), name: t.name }
  }

  verifyWebhook(body: unknown): WebhookCheck {
    const b = (body ?? {}) as { secret_token?: string; type?: string; data?: { id?: string } }
    if (!this.webhookSecret || typeof b.secret_token !== 'string' || !safeEqual(b.secret_token, this.webhookSecret)) return { ok: false }
    return { ok: true, providerPaymentId: b.data?.id, event: b.type }
  }
}
