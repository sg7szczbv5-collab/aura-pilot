/**
 * A2.3 — is the app connected? `navigator.onLine` alone is unreliable (it says "online" on a captive
 * Wi-Fi or a dead mobile link), so a request that fails on the network also marks the app offline,
 * and the next request that gets an answer marks it online again.
 * Listeners run on every change, so screens can show a banner and the data layer can resync.
 */
type Listener = (online: boolean) => void

export function createConnectivity(initial: boolean) {
  let online = initial
  const listeners = new Set<Listener>()
  const set = (v: boolean) => {
    if (v === online) return
    online = v
    listeners.forEach((l) => l(v))
  }
  return {
    isOnline: () => online,
    /** Browser 'online' / 'offline' events. */
    browser: (v: boolean) => set(v),
    /** A request failed without any HTTP answer. */
    requestFailed: () => set(false),
    /** A request got an answer from the server. */
    requestAnswered: () => set(true),
    subscribe(l: Listener) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
}

export const connectivity = createConnectivity(typeof navigator === 'undefined' ? true : navigator.onLine !== false)

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => connectivity.browser(true))
  window.addEventListener('offline', () => connectivity.browser(false))
}
