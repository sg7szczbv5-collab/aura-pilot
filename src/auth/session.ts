/**
 * Session protection for the staff console:
 *  - absolute lifetime (ADMIN_SESSION_POLICY.maxAgeMs)
 *  - idle sign-out after Settings → session minutes, with a warning first
 *  - activity in any tab counts; signing out in one tab signs out all tabs
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ADMIN_SESSION_POLICY } from './config'

export type SessionEndReason = 'idle' | 'expired' | 'signed_out_elsewhere' | 'blocked'

export function adminSessionState(p: { authAt?: number; lastActiveAt?: number; idleMinutes: number; now: number }): {
  valid: boolean
  reason?: 'idle' | 'expired'
  msLeft: number
} {
  if (!p.authAt) return { valid: false, reason: 'expired', msLeft: 0 }
  const hardLeft = p.authAt + ADMIN_SESSION_POLICY.maxAgeMs - p.now
  const idleLeft = (p.lastActiveAt ?? p.authAt) + p.idleMinutes * 60_000 - p.now
  if (hardLeft <= 0) return { valid: false, reason: 'expired', msLeft: 0 }
  if (idleLeft <= 0) return { valid: false, reason: 'idle', msLeft: 0 }
  return { valid: true, msLeft: Math.min(hardLeft, idleLeft) }
}

const ACTIVE_KEY = 'aura.admin.lastActive'
const SIGNOUT_KEY = 'aura.auth.signout'

const lsGet = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* noop */ } }

export const readLastActive = () => Number(lsGet(ACTIVE_KEY) ?? 0) || undefined
export const touchActivity = (at = Date.now()) => lsSet(ACTIVE_KEY, String(at))

/** Tell every open tab of this browser that `app` signed out. */
export function broadcastSignOut(app: 'rider' | 'driver' | 'admin', reason: SessionEndReason = 'signed_out_elsewhere') {
  lsSet(SIGNOUT_KEY, JSON.stringify({ app, reason, at: Date.now() }))
}

/** Subscribe to sign-outs that happened in other tabs. */
export function onCrossTabSignOut(app: 'rider' | 'driver' | 'admin', cb: (reason: SessionEndReason) => void): () => void {
  const on = (e: StorageEvent) => {
    if (e.key !== SIGNOUT_KEY || !e.newValue) return
    try {
      const v = JSON.parse(e.newValue) as { app: string; reason: SessionEndReason }
      if (v.app === app) cb(v.reason)
    } catch { /* noop */ }
  }
  window.addEventListener('storage', on)
  return () => window.removeEventListener('storage', on)
}

/**
 * Idle + absolute timeout for an authenticated staff session.
 * Returns the ms left and whether to show the "still there?" warning.
 */
export function useAdminSessionGuard(opts: { enabled: boolean; authAt?: number; idleMinutes: number; onExpire: (reason: 'idle' | 'expired') => void }) {
  const { enabled, authAt, idleMinutes, onExpire } = opts
  const [msLeft, setMsLeft] = useState(Infinity)
  const expired = useRef(false)
  const lastWrite = useRef(0)

  const stayActive = useCallback(() => {
    touchActivity()
    lastWrite.current = Date.now()
    setMsLeft(Infinity)
  }, [])

  useEffect(() => {
    if (!enabled) return
    expired.current = false
    const mark = () => {
      const now = Date.now()
      if (now - lastWrite.current > 5_000) {
        lastWrite.current = now
        touchActivity(now)
      }
    }
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
    events.forEach((e) => window.addEventListener(e, mark, { passive: true }))
    if (!readLastActive()) touchActivity()

    const tick = () => {
      const s = adminSessionState({ authAt, lastActiveAt: readLastActive(), idleMinutes, now: Date.now() })
      setMsLeft(s.msLeft)
      if (!s.valid && !expired.current) {
        expired.current = true
        onExpire(s.reason ?? 'expired')
      }
    }
    tick()
    const id = window.setInterval(tick, 5_000)
    return () => {
      events.forEach((e) => window.removeEventListener(e, mark))
      window.clearInterval(id)
    }
  }, [enabled, authAt, idleMinutes, onExpire])

  return { msLeft, warn: enabled && msLeft <= ADMIN_SESSION_POLICY.warnBeforeMs, stayActive }
}
