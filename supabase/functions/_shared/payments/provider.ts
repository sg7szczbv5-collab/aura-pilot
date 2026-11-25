/**
 * Payment provider abstraction. Moyasar is implemented; the same interface takes
 * a HyperPay (or other) adapter without touching the handlers or the database.
 */
export type ProviderName = 'moyasar' | 'hyperpay' | 'mock'
export type ProviderStatus = 'initiated' | 'authorized' | 'paid' | 'failed' | 'voided' | 'refunded'

export type ProviderPayment = {
  id: string
  status: ProviderStatus
  amountHalalas: bigint
  capturedHalalas: bigint
  refundedHalalas: bigint
  /** 3-D Secure page to open when status is `initiated`. */
  transactionUrl?: string
  metadata: Record<string, string>
  failureMessage?: string
  raw: unknown
}

export type PaymentSource = { type: 'token'; token: string } | { type: 'applepay'; token: string }

export type CreatePaymentInput = {
  /** Our payments.id; also sent to the provider for idempotency. */
  paymentId: string
  amountHalalas: bigint
  description: string
  source: PaymentSource
  /** true = authorize only (captured later), false = charge now. */
  manual: boolean
  callbackUrl: string
  metadata: Record<string, string>
}

export type SavedCard = { id: string; status: string; brand: string; last4: string; month: number; year: number; name?: string }

export type WebhookCheck = { ok: false } | { ok: true; providerPaymentId?: string; event?: string }

export interface PaymentProvider {
  readonly name: ProviderName
  createPayment(input: CreatePaymentInput): Promise<ProviderPayment>
  fetchPayment(providerPaymentId: string): Promise<ProviderPayment>
  capture(providerPaymentId: string, amountHalalas: bigint): Promise<ProviderPayment>
  void(providerPaymentId: string): Promise<ProviderPayment>
  refund(providerPaymentId: string, amountHalalas: bigint): Promise<ProviderPayment>
  fetchToken(tokenId: string): Promise<SavedCard>
  verifyWebhook(body: unknown): WebhookCheck
}

export class ProviderError extends Error {
  constructor(message: string, readonly status = 0, readonly type?: string) {
    super(message)
  }
}

/** Provider status → payments.status. */
export function toDbStatus(s: ProviderStatus): 'initiated' | 'authorized' | 'paid' | 'failed' | 'voided' {
  return s === 'refunded' ? 'paid' : s
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>
