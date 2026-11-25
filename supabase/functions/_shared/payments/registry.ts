import { MockProvider } from './mock.ts'
import { MoyasarProvider } from './moyasar.ts'
import { ProviderError, type FetchLike, type PaymentProvider, type ProviderName } from './provider.ts'

/**
 * PAYMENT_PROVIDER=mock | moyasar  (hyperpay: implement PaymentProvider in
 * hyperpay.ts and add it here; handlers and database stay unchanged).
 */
export function getProvider(name: string | undefined, env: (k: string) => string | undefined, fetchFn: FetchLike): PaymentProvider {
  const n = (name ?? 'mock') as ProviderName
  switch (n) {
    case 'mock':
      return new MockProvider()
    case 'moyasar':
      return new MoyasarProvider(env('MOYASAR_SECRET_KEY') ?? '', fetchFn, env('MOYASAR_WEBHOOK_SECRET') ?? '', env('MOYASAR_API_BASE_URL') || undefined)
    default:
      throw new ProviderError(`payment_provider_not_supported:${n}`)
  }
}
