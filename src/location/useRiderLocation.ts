/**
 * React hook around riderLocation.ts. Asks the browser for the rider's position:
 *  - silently once per page session when permission is already granted,
 *  - otherwise only when the rider taps "Use my location" (request()).
 * Nothing is persisted: the fix lives in memory only.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { capability, locateOnce, readPermission, shouldAutoLocate, type LocState, type PermissionHint } from './riderLocation'

/** One automatic attempt per page load, shared by every mount (tabs, re-renders). */
let autoTried = false

export function useRiderLocation(enabled: boolean): { state: LocState; permission: PermissionHint; request: () => void } {
  const [state, setState] = useState<LocState>({ status: 'idle' })
  const [permission, setPermission] = useState<PermissionHint>('unknown')
  const busy = useRef(false)
  const alive = useRef(true)

  const run = useCallback(async (byUser: boolean) => {
    if (busy.current) return
    busy.current = true
    setState((s) => ({ ...s, status: 'locating' }))
    const r = await locateOnce({
      geolocation: typeof navigator !== 'undefined' ? navigator.geolocation : undefined,
      isSecureContext: typeof window !== 'undefined' ? window.isSecureContext : undefined,
    })
    busy.current = false
    if (!alive.current) return
    setState({ ...r, byUser })
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
    const perms = typeof navigator !== 'undefined' ? (navigator.permissions as unknown as Parameters<typeof readPermission>[0]) : undefined
    void readPermission(perms).then((p) => {
      if (cancelled) return
      setPermission(p)
      if (p === 'denied') setState({ status: 'denied' }) // known without prompting: never ask again
      else if (shouldAutoLocate(p, autoTried)) {
        autoTried = true
        void run(false)
      }
    })
    return () => {
      cancelled = true
      alive.current = false
    }
  }, [enabled, run])

  return { state, permission, request: () => void run(true) }
}

/** Test hook: reset the once-per-page flag. */
export function __resetAutoLocate() {
  autoTried = false
}
