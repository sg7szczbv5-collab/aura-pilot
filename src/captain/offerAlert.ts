/**
 * A2.1 — new-trip alert for the captain: a synthesised tone + vibration, repeated until the offer is
 * accepted, declined, withdrawn or expires.
 *
 * Browser rules this respects:
 *  - Sound needs a user gesture first (autoplay policy). unlock() must be called from a tap
 *    ("Go online", "Enable sound", "Test alert"); until then the status is 'locked' and the UI says so.
 *  - Vibration exists on Android Chrome; iOS Safari has no Vibration API → 'unsupported', no error.
 *  - Nothing runs while the page is suspended (iOS background / locked screen): see
 *    docs/a2/background-capabilities.md. This module never claims otherwise.
 * The tone is generated with Web Audio (no audio file, no CSP change). Every browser API is injected,
 * so the behaviour is unit-tested without a browser.
 */

export type SoundStatus = 'ready' | 'locked' | 'muted' | 'unsupported'
export type AlertStatus = { sound: SoundStatus; vibration: boolean; ringing: string | null }

type OscLike = { type: string; frequency: { value: number }; connect(n: unknown): unknown; start(t?: number): void; stop(t?: number): void }
type GainLike = { gain: { value: number; setValueAtTime(v: number, t: number): void; linearRampToValueAtTime(v: number, t: number): void }; connect(n: unknown): unknown }
export type AudioCtxLike = {
  state: string
  currentTime: number
  destination: unknown
  resume(): Promise<void>
  createOscillator(): OscLike
  createGain(): GainLike
}
export type AlertEnv = {
  createAudio?: () => AudioCtxLike | null
  vibrate?: (pattern: number[]) => boolean
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (id: unknown) => void
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
  now: () => number
  loadMuted?: () => boolean
  saveMuted?: (m: boolean) => void
}

/** One alert cycle: two short beeps, and the vibration pattern. Repeated every CYCLE_MS. */
export const CYCLE_MS = 2000
export const VIBRATION = [400, 150, 400]
/** Never ring longer than this, whatever the offer says (protects against a bad expiry). */
export const MAX_RING_MS = 120_000

export function createOfferAlert(env: AlertEnv) {
  let ctx: AudioCtxLike | null | undefined // undefined = not created yet
  let muted = env.loadMuted?.() ?? false
  let ringing: string | null = null
  let cycle: unknown = null
  let deadline: unknown = null
  // Offers that were answered or expired: they never ring again. A card that merely re-mounts
  // (React StrictMode, tab switch) resumes the same still-open offer instead.
  const resolved: string[] = []
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((l) => l())

  const audio = () => {
    if (ctx === undefined) {
      try {
        ctx = env.createAudio?.() ?? null
      } catch {
        ctx = null
      }
    }
    return ctx
  }
  const soundStatus = (): SoundStatus => {
    if (!env.createAudio || ctx === null) return 'unsupported'
    if (muted) return 'muted'
    return ctx && ctx.state === 'running' ? 'ready' : 'locked'
  }

  function beep(c: AudioCtxLike) {
    const t0 = c.currentTime
    for (const [i, f] of [[0, 880], [0.28, 1175]] as const) {
      const o = c.createOscillator()
      const g = c.createGain()
      o.type = 'sine'
      o.frequency.value = f
      g.gain.setValueAtTime(0, t0 + i)
      g.gain.linearRampToValueAtTime(0.35, t0 + i + 0.02)
      g.gain.linearRampToValueAtTime(0, t0 + i + 0.22)
      o.connect(g)
      g.connect(c.destination)
      o.start(t0 + i)
      o.stop(t0 + i + 0.24)
    }
  }
  function once() {
    const c = audio()
    if (c && !muted && c.state === 'running') {
      try {
        beep(c)
      } catch {
        /* a failed beep never breaks the offer card */
      }
    }
    try {
      env.vibrate?.(VIBRATION)
    } catch {
      /* ignore */
    }
  }

  const api = {
    /** Call from a user gesture. Creates/resumes the audio context. */
    async unlock(): Promise<SoundStatus> {
      const c = audio()
      if (c && c.state !== 'running') {
        try {
          await c.resume()
        } catch {
          /* stays locked */
        }
      }
      emit()
      return soundStatus()
    },
    /**
     * Start ringing for an offer. Returns false when it is already ringing (no second alert), when it
     * was answered or expired before, or when it has expired. Stops by itself at `expiresAt`
     * (capped at MAX_RING_MS). A newer offer replaces the ringing one.
     */
    start(offerId: string, expiresAt: number): boolean {
      if (ringing === offerId || resolved.includes(offerId)) return false
      const left = Math.min(expiresAt - env.now(), MAX_RING_MS)
      if (left <= 0) return false
      api.stop()
      ringing = offerId
      once()
      cycle = env.setInterval(once, CYCLE_MS)
      deadline = env.setTimeout(() => api.resolve(offerId), left)
      emit()
      return true
    },
    /** Accepted, declined or expired: stop, and never ring for this offer again. */
    resolve(offerId: string) {
      if (!resolved.includes(offerId)) {
        resolved.push(offerId)
        if (resolved.length > 50) resolved.shift()
      }
      api.stop(offerId)
    },
    /** Stop ringing (all, or only if `offerId` is the one ringing). */
    stop(offerId?: string) {
      if (offerId && ringing !== offerId) return
      if (cycle !== null) env.clearInterval(cycle)
      if (deadline !== null) env.clearTimeout(deadline)
      cycle = deadline = null
      const was = ringing
      ringing = null
      if (was) {
        try {
          env.vibrate?.([0]) // cancel an ongoing vibration
        } catch {
          /* ignore */
        }
        emit()
      }
    },
    /** One cycle on demand ("Test alert"). Call from a tap: it also unlocks the sound. */
    async test(): Promise<SoundStatus> {
      const s = await api.unlock()
      once()
      return s
    },
    setMuted(m: boolean) {
      muted = m
      env.saveMuted?.(m)
      emit()
    },
    status(): AlertStatus {
      return { sound: soundStatus(), vibration: !!env.vibrate, ringing }
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
  return api
}

export type OfferAlert = ReturnType<typeof createOfferAlert>

const MUTE_KEY = 'aura.captain.alertSound.muted'

/** The real browser environment. Storage is used only for the per-device "sound off" preference. */
export function browserAlertEnv(): AlertEnv {
  const w = typeof window !== 'undefined' ? (window as Window & { webkitAudioContext?: new () => AudioCtxLike }) : undefined
  const AC = w ? ((w as unknown as { AudioContext?: new () => AudioCtxLike }).AudioContext ?? w.webkitAudioContext) : undefined
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { vibrate?: (p: number[]) => boolean }) : undefined
  return {
    createAudio: AC ? () => new AC() : undefined,
    vibrate: typeof nav?.vibrate === 'function' ? (p) => nav.vibrate!(p) : undefined,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    loadMuted: () => {
      try {
        return localStorage.getItem(MUTE_KEY) === '1'
      } catch {
        return false
      }
    },
    saveMuted: (m) => {
      try {
        localStorage.setItem(MUTE_KEY, m ? '1' : '0')
      } catch {
        /* preference only */
      }
    },
  }
}

/** App-wide instance (one ringing offer at a time). */
export const offerAlert = createOfferAlert(browserAlertEnv())
