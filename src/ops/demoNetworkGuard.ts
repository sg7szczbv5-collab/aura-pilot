/**
 * C4 — DEMO network guard (defence in depth, NOT the isolation itself).
 *
 * The isolation is (1) no Supabase variables in a Preview build environment (build guard, C3) and
 * (2) no Supabase settings in the DEMO bundle (C1/C2). This guard is the last layer: in DEMO mode
 * (AUTH_MODE = 'mock') the page refuses ANY request to a Supabase host — fetch, XMLHttpRequest,
 * sendBeacon, WebSocket (Realtime) and EventSource — even if some code, a dependency or a person in
 * the console tries. LIVE builds (AUTH_MODE = 'supabase', i.e. Production) never install it.
 */

export const SUPABASE_HOST = /(^|\.)supabase\.(co|in|com|net)$/i

export class SupabaseBlockedInDemo extends Error {
  constructor(url: string) {
    super(`supabase_blocked_in_demo:${url}`)
  }
}

export function isSupabaseUrl(url: string, base = 'http://localhost'): boolean {
  try {
    return SUPABASE_HOST.test(new URL(url, base).hostname)
  } catch {
    return false
  }
}

type Ctor = new (...a: never[]) => unknown
type GuardTarget = {
  fetch?: typeof fetch
  XMLHttpRequest?: { prototype: { open: (...a: unknown[]) => unknown } }
  navigator?: { sendBeacon?: (url: string, data?: unknown) => boolean }
  WebSocket?: Ctor
  EventSource?: Ctor
  location?: { href: string }
  __auraDemoGuard?: boolean
}

const urlOf = (input: unknown): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url?: string })?.url ?? String(input)

/** Install once when `demo` is true; returns true when the guard is active. */
export function installDemoNetworkGuard(demo: boolean, target: GuardTarget = globalThis as unknown as GuardTarget): boolean {
  if (!demo) return false
  if (target.__auraDemoGuard) return true
  const base = target.location?.href ?? 'http://localhost'
  const blocked = (u: unknown) => isSupabaseUrl(urlOf(u), base)

  if (target.fetch) {
    const original = target.fetch.bind(target)
    target.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      blocked(input) ? Promise.reject(new SupabaseBlockedInDemo(urlOf(input))) : original(input, init)) as typeof fetch
  }
  const xhr = target.XMLHttpRequest?.prototype
  if (xhr) {
    const open = xhr.open
    xhr.open = function (this: unknown, ...args: unknown[]) {
      if (blocked(args[1])) throw new SupabaseBlockedInDemo(urlOf(args[1]))
      return open.apply(this, args)
    }
  }
  const nav = target.navigator
  if (nav?.sendBeacon) {
    const beacon = nav.sendBeacon.bind(nav)
    nav.sendBeacon = (url: string, data?: unknown) => (blocked(url) ? false : beacon(url, data as never))
  }
  for (const key of ['WebSocket', 'EventSource'] as const) {
    const Original = target[key]
    if (!Original) continue
    const Guarded = new Proxy(Original, {
      construct(T, args: unknown[]) {
        if (blocked(args[0])) throw new SupabaseBlockedInDemo(urlOf(args[0]))
        return Reflect.construct(T, args)
      },
    })
    target[key] = Guarded
  }
  target.__auraDemoGuard = true
  return true
}
