/**
 * A2.4 — keep the screen on while the captain is online (Screen Wake Lock API), and only then.
 *
 *  - want(true) when the captain goes online; want(false) when they go offline or sign out → released.
 *  - The system releases the lock whenever the page is hidden (another app, screen locked, low
 *    battery). It is re-acquired when the page is visible again and the captain is still online.
 *  - No API (older iOS Safari < 16.4, some in-app browsers) → 'unsupported'; a refusal
 *    (NotAllowedError: battery saver, policy) → 'failed'. Neither breaks anything; the UI says so.
 * Browser APIs are injected so the rules are unit-tested.
 */

export type WakeStatus = 'off' | 'on' | 'pending' | 'released' | 'unsupported' | 'failed'
type Sentinel = { released: boolean; release(): Promise<void>; addEventListener(t: 'release', f: () => void): void }
export type WakeEnv = {
  request?: () => Promise<Sentinel>
  visible: () => boolean
  onVisibility: (f: () => void) => () => void
}

export function createWakeLock(env: WakeEnv) {
  let wanted = false
  let sentinel: Sentinel | null = null
  let status: WakeStatus = env.request ? 'off' : 'unsupported'
  let seq = 0
  const listeners = new Set<() => void>()
  const set = (s: WakeStatus) => {
    if (s === status) return
    status = s
    listeners.forEach((l) => l())
  }

  async function acquire() {
    if (!env.request || !wanted || sentinel || !env.visible()) return
    const mine = ++seq
    set('pending')
    try {
      const s = await env.request()
      if (mine !== seq || !wanted) {
        // went offline while the request was pending
        void s.release().catch(() => undefined)
        return
      }
      sentinel = s
      s.addEventListener('release', () => {
        if (sentinel !== s) return
        sentinel = null
        set(wanted ? 'released' : 'off') // the system took it (page hidden); re-acquired on return
      })
      set('on')
    } catch {
      if (mine === seq) set('failed')
    }
  }
  async function drop() {
    seq++
    const s = sentinel
    sentinel = null
    if (s && !s.released) await s.release().catch(() => undefined)
    set(env.request ? 'off' : 'unsupported')
  }

  const offVis = env.onVisibility(() => {
    if (env.visible() && wanted && !sentinel) void acquire()
  })

  return {
    async want(on: boolean) {
      if (on === wanted) return
      wanted = on
      if (on) await acquire()
      else await drop()
    },
    status: () => status,
    subscribe(l: () => void) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    dispose() {
      offVis()
      void drop()
    },
  }
}

export type WakeLock = ReturnType<typeof createWakeLock>

export function browserWakeEnv(): WakeEnv {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<Sentinel> } }) : undefined
  const wl = nav?.wakeLock
  return {
    request: wl && typeof wl.request === 'function' ? () => wl.request('screen') : undefined,
    visible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    onVisibility: (f) => {
      if (typeof document === 'undefined') return () => undefined
      document.addEventListener('visibilitychange', f)
      return () => document.removeEventListener('visibilitychange', f)
    },
  }
}

/** App-wide instance. */
export const screenWakeLock = createWakeLock(browserWakeEnv())
