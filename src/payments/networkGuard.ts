/**
 * Browser-side network guard (review finding F3). In a mock-only (BETA / staging / Preview)
 * build, any request to a payment gateway is refused before it leaves the page — fetch,
 * XMLHttpRequest and sendBeacon — even if a wrong setting reached the bundle.
 */
import { isPaymentGatewayUrl } from './paymentPolicy'

export class PaymentGatewayBlocked extends Error {
  constructor(url: string) {
    super(`payment_gateway_blocked:${url}`)
  }
}

type GuardTarget = {
  fetch?: typeof fetch
  XMLHttpRequest?: { prototype: { open: (...a: unknown[]) => unknown } }
  navigator?: { sendBeacon?: (url: string, data?: unknown) => boolean }
  location?: { href: string }
  __auraPaymentGuard?: boolean
}

const urlOf = (input: unknown): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url?: string })?.url ?? String(input)

/** Install once; returns true when the guard is active. */
export function installPaymentNetworkGuard(mockOnly: boolean, target: GuardTarget = globalThis as unknown as GuardTarget): boolean {
  if (!mockOnly) return false
  if (target.__auraPaymentGuard) return true
  const base = target.location?.href ?? 'http://localhost'
  if (target.fetch) {
    const original = target.fetch.bind(target)
    target.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input)
      if (isPaymentGatewayUrl(url, base)) return Promise.reject(new PaymentGatewayBlocked(url))
      return original(input, init)
    }) as typeof fetch
  }
  const xhr = target.XMLHttpRequest?.prototype
  if (xhr) {
    const open = xhr.open
    xhr.open = function (this: unknown, ...args: unknown[]) {
      const url = urlOf(args[1])
      if (isPaymentGatewayUrl(url, base)) throw new PaymentGatewayBlocked(url)
      return open.apply(this, args)
    }
  }
  const nav = target.navigator
  if (nav?.sendBeacon) {
    const beacon = nav.sendBeacon.bind(nav)
    nav.sendBeacon = (url: string, data?: unknown) => (isPaymentGatewayUrl(url, base) ? false : beacon(url, data as never))
  }
  target.__auraPaymentGuard = true
  return true
}
