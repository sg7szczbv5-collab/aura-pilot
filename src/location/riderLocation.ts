/**
 * Rider location (GPS) — pure logic, no React, so every rule is unit-tested.
 *
 *  - Permission is asked only after a user gesture ("Use my location"), except when the browser
 *    already reports it as granted, in which case the fix is taken silently once per session.
 *  - A denied permission is never asked again in this session; manual pickup (map pin or search)
 *    always works.
 *  - The fix stays in memory. It is not stored in localStorage / sessionStorage and is sent to the
 *    server only as the pickup of a ride request (and as the centre of the anonymised nearby-cars
 *    query), exactly like a manually chosen pickup.
 *  - In LIVE mode the pickup starts UNSET (never the demo point) and a ride cannot be requested
 *    until the pickup is valid.
 */
import type { LatLng, Place } from '../core/types'

export type LocStatus = 'idle' | 'locating' | 'located' | 'denied' | 'unavailable' | 'timeout' | 'unsupported' | 'insecure'
/** byUser: the fix came from an explicit "Use my location" tap (it may replace a manual pickup). */
export type LocState = { status: LocStatus; pos?: LatLng; accuracyM?: number; at?: number; byUser?: boolean }
export type PermissionHint = 'granted' | 'denied' | 'prompt' | 'unknown'

/** Riyadh centre: where maps open before a pickup exists. It is NEVER a valid pickup by itself. */
export const CITY_CENTER: LatLng = { lat: 24.7136, lng: 46.6753 }

/** Placeholder pickup for LIVE mode until GPS, a pin or a search result sets a real one. */
export const UNSET_PICKUP: Place = {
  id: 'pickup-unset',
  name: { ar: 'حدّد موقع الالتقاء', en: 'Set your pickup' },
  sub: { ar: 'استخدم موقعك أو اختر على الخريطة', en: 'Use your location or pick on the map' },
  pos: CITY_CENTER,
  kind: 'pin',
}

/** The pickup a GPS fix produces. Its id marks it as automatic, so a manual choice is never overwritten. */
export const GPS_PICKUP_ID = 'gps-current'
export function pickupFromFix(pos: LatLng, accuracyM?: number): Place {
  const acc = accuracyM && Number.isFinite(accuracyM) ? Math.round(accuracyM) : undefined
  return {
    id: GPS_PICKUP_ID,
    name: { ar: 'موقعك الحالي', en: 'Your current location' },
    sub: acc ? { ar: `دقة تقريبية ± ${acc} م`, en: `Accuracy ± ${acc} m` } : { ar: 'من GPS', en: 'From GPS' },
    pos: { lat: pos.lat, lng: pos.lng },
    kind: 'pin',
  }
}

/** A fix worse than this is shown as approximate and the rider is invited to adjust the pin. */
export const APPROXIMATE_ACCURACY_M = 150

/** Saudi Arabia, generously: anything outside is a bad fix or a bad coordinate, not a pickup. */
const KSA = { minLat: 16, maxLat: 33, minLng: 34, maxLng: 56 }

export type PickupProblem = 'unset' | 'demo_location' | 'invalid_coordinates' | 'outside_country' | 'unresolved'

/** Is this pickup acceptable for a ride request? (The server still checks the service area.) */
export function validatePickup(p: Place | undefined, live: boolean): { ok: true } | { ok: false; problem: PickupProblem } {
  if (!p || p.id === UNSET_PICKUP.id) return { ok: false, problem: 'unset' }
  if (live && p.id === 'current') return { ok: false, problem: 'demo_location' }
  const { lat, lng } = p.pos ?? ({} as LatLng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ok: false, problem: 'invalid_coordinates' }
  if (p.id.startsWith('gplace:')) return { ok: false, problem: 'unresolved' }
  if (lat < KSA.minLat || lat > KSA.maxLat || lng < KSA.minLng || lng > KSA.maxLng) return { ok: false, problem: 'outside_country' }
  return { ok: true }
}

/** Should the app take a fix without a user gesture? Only when the browser already granted it. */
export function shouldAutoLocate(permission: PermissionHint, alreadyTriedThisSession: boolean): boolean {
  return permission === 'granted' && !alreadyTriedThisSession
}

/**
 * May a GPS fix replace the current pickup? An explicit "Use my location" tap always may; an
 * automatic fix never replaces a pickup the rider chose by hand (pin, search, saved place).
 */
export function mayApplyFix(current: Place, live: boolean, byUser = false): boolean {
  if (byUser) return true
  if (current.id === UNSET_PICKUP.id || current.id === GPS_PICKUP_ID) return true
  return !live && current.id === 'current' // demo: the demo point may be replaced by a real fix
}

export const GEO_OPTIONS: PositionOptions = { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 }

type GeoLike = Pick<Geolocation, 'getCurrentPosition'>
type Env = { geolocation?: GeoLike; isSecureContext?: boolean; now?: () => number }

/** One fix. Never throws: every failure is a status the UI can explain. */
export function locateOnce(env: Env, options: PositionOptions = GEO_OPTIONS): Promise<LocState> {
  if (env.isSecureContext === false) return Promise.resolve({ status: 'insecure' })
  if (!env.geolocation) return Promise.resolve({ status: 'unsupported' })
  return new Promise((resolve) => {
    let done = false
    const finish = (s: LocState) => {
      if (!done) {
        done = true
        resolve(s)
      }
    }
    // Some browsers never call back when the prompt is dismissed: our own deadline as a backstop.
    const backstop = setTimeout(() => finish({ status: 'timeout' }), (options.timeout ?? 12_000) + 3_000)
    try {
      env.geolocation!.getCurrentPosition(
        (p) => {
          clearTimeout(backstop)
          const pos = { lat: p.coords.latitude, lng: p.coords.longitude }
          if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return finish({ status: 'unavailable' })
          finish({ status: 'located', pos, accuracyM: p.coords.accuracy, at: env.now?.() ?? Date.now() })
        },
        (e) => {
          clearTimeout(backstop)
          finish({ status: e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable' })
        },
        options,
      )
    } catch {
      clearTimeout(backstop)
      finish({ status: 'unavailable' })
    }
  })
}

type PermissionsLike = { query(d: { name: 'geolocation' }): Promise<{ state: string }> }

/** What the browser can do before anything is asked: no API → unsupported; http page → insecure. */
export function capability(env: { geolocation?: unknown; isSecureContext?: boolean }): 'ok' | 'unsupported' | 'insecure' {
  if (env.isSecureContext === false) return 'insecure'
  return env.geolocation ? 'ok' : 'unsupported'
}

/** Ask the Permissions API without prompting. Unsupported (older iOS Safari) → 'unknown'. */
export async function readPermission(permissions?: PermissionsLike): Promise<PermissionHint> {
  if (!permissions?.query) return 'unknown'
  try {
    const s = (await permissions.query({ name: 'geolocation' })).state
    return s === 'granted' || s === 'denied' || s === 'prompt' ? s : 'unknown'
  } catch {
    return 'unknown'
  }
}
