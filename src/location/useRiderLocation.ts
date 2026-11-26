/**
 * React hook around riderLocation.ts. Asks the browser for the rider's position:
 *  - silently once per page session when permission is already granted,
 *  - otherwise only when the rider taps "Use my location" (request()).
 * Nothing is persisted: the fix lives in memory only.
 *
 * F1: every request gets a sequence number — only the LATEST request may report a result, so a tap
 * during a pending request is never dropped and an older request can never land after it. Each
 * result also carries the pickup revision (token) captured when it was requested; the caller drops
 * it if the rider changed the pickup by hand since.
 * F5: the permission is re-read when the page becomes visible again (return from the device's
 * settings, e.g. iOS Safari) and on Permissions API change events where they exist. The
 * Permissions API is optional: without it, a refusal is retried only by an explicit tap.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { capability, locateOnce, readPermission, shouldAutoLocate, type LocState, type PermissionHint } from './riderLocation'

/** One automatic attempt per page load, shared by every mount (tabs, re-renders). */
let autoTried = false

type PermissionStatusLike = { state: string; onchange: null | (() => void) }
type PermissionsLike = { query(d: { name: 'geolocation' }): Promise<PermissionStatusLike> }

export function useRiderLocation(enabled: boolean, getToken: () => number = () => 0): { state: LocState; permission: PermissionHint; request: () => void } {
  const [state, setState] = useState<LocState>({ status: 'idle' })
  const [permission, setPermission] = useState<PermissionHint>('unknown')
  const seq = useRef(0)
  const alive = useRef(true)
  const tokenOf = useRef(getToken)
  tokenOf.current = getToken

  const run = useCallback(async (byUser: boolean) => {
    const mine = ++seq.current
    const token = tokenOf.current()
    setState((s) => ({ ...s, status: 'locating', byUser, token }))
    const r = await locateOnce({
      geolocation: typeof navigator !== 'undefined' ? navigator.geolocation : undefined,
      isSecureContext: typeof window !== 'undefined' ? window.isSecureContext : undefined,
    })
    if (!alive.current || mine !== seq.current) return // a newer request owns the result
    setState({ ...r, byUser, token })
    if (r.status === 'denied') setPermission('denied')
    if (r.status === 'located') setPermission('granted')
  }, [])

  useEffect(() => {
    alive.current = true
    if (!enabled) return
    let cancelled = false
    // Known up front, without asking: no Geolocation API, or a page that is not https.
    const cap = capability({
      geolocation: typeof navigator !== 'undefined' ? navigator.geolocation : undefined,
      isSecureContext: typeof window !== 'undefined' ? window.isSecureContext : undefined,
    })
    if (cap !== 'ok') {
      setState({ status: cap })
      return
    }
    const perms = typeof navigator !== 'undefined' ? (navigator.permissions as unknown as PermissionsLike | undefined) : undefined
    const apply = (p: PermissionHint, first: boolean) => {
      if (cancelled) return
      setPermission(p)
      if (p === 'denied') setState((s) => (s.status === 'locating' ? s : { status: 'denied' })) // never prompt again
      // A refusal lifted in the device settings: offer the button again (no automatic prompt).
      else setState((s) => (s.status === 'denied' ? { status: 'idle' } : s))
      if (first && shouldAutoLocate(p, autoTried)) {
        autoTried = true
        void run(false)
      }
    }
    void readPermission(perms).then((p) => apply(p, true))
    let status: PermissionStatusLike | undefined
    perms?.query?.({ name: 'geolocation' }).then((s) => {
      if (cancelled) return
      status = s
      s.onchange = () => apply(s.state === 'granted' || s.state === 'denied' || s.state === 'prompt' ? s.state : 'unknown', false)
    }).catch(() => undefined)
    // Return from the device settings (iOS Safari has no change events on older versions).
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (perms) void readPermission(perms).then((p) => apply(p, false))
      else setState((s) => (s.status === 'denied' ? { status: 'idle' } : s)) // unknown: allow one explicit retry
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      alive.current = false
      if (status) status.onchange = null
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, run])

  return { state, permission, request: () => void run(true) }
}

/** Test hook: reset the once-per-page flag. */
export function __resetAutoLocate() {
  autoTried = false
}
