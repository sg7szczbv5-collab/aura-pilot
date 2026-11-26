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
/**
 * byUser: the fix came from an explicit "Use my location" tap (it may replace a manual pickup).
 * token: the pickup revision captured when the request started (F1 — stale results are dropped).
 */
export type LocState = { status: LocStatus; pos?: LatLng; accuracyM?: number; at?: number; byUser?: boolean; token?: number }
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
/** A GPS pickup older than this is refused at request time: the rider may have moved (F2). */
export const MAX_GPS_PICKUP_AGE_MS = 5 * 60_000
export function pickupFromFix(pos: LatLng, accuracyM?: number, fixedAt: number = Date.now()): Place {
  const acc = accuracyM && Number.isFinite(accuracyM) ? Math.round(accuracyM) : undefined
  return {
    id: GPS_PICKUP_ID,
    name: { ar: 'موقعك الحالي', en: 'Your current location' },
    sub: acc ? { ar: `دقة تقريبية ± ${acc} م`, en: `Accuracy ± ${acc} m` } : { ar: 'من GPS', en: 'From GPS' },
    pos: { lat: pos.lat, lng: pos.lng },
    kind: 'pin',
    fixedAt,
  }
}

/** A fix worse than this is shown as approximate and the rider is invited to adjust the pin. */
export const APPROXIMATE_ACCURACY_M = 150

/** Saudi Arabia, generously: anything outside is a bad fix or a bad coordinate, not a pickup. */
const KSA = { minLat: 16, maxLat: 33, minLng: 34, maxLng: 56 }

export type PickupProblem = 'unset' | 'demo_location' | 'invalid_coordinates' | 'outside_country' | 'unresolved' | 'stale_gps'

/**
 * Is this pickup acceptable for a ride request? Client-side sanity only: the country box below is
 * NOT the service area. The service area and restricted zones are decided by the server
 * (create_ride), whose refusal the confirm screen shows.
 * GPS pickups must also be fresh (fixedAt within MAX_GPS_PICKUP_AGE_MS); manual pickups (pin,
 * search, saved place) carry no timestamp and are never refused for that.
 */
export function validatePickup(p: Place | undefined, live: boolean, now: number = Date.now()): { ok: true } | { ok: false; problem: PickupProblem } {
  if (!p || p.id === UNSET_PICKUP.id) return { ok: false, problem: 'unset' }
  if (live && p.id === 'current') return { ok: false, problem: 'demo_location' }
  const { lat, lng } = p.pos ?? ({} as LatLng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ok: false, problem: 'invalid_coordinates' }
  if (p.id.startsWith('gplace:')) return { ok: false, problem: 'unresolved' }
  if (lat < KSA.minLat || lat > KSA.maxLat || lng < KSA.minLng || lng > KSA.maxLng) return { ok: false, problem: 'outside_country' }
  if (p.id === GPS_PICKUP_ID && (!p.fixedAt || now - p.fixedAt > MAX_GPS_PICKUP_AGE_MS || p.fixedAt > now + 60_000)) return { ok: false, problem: 'stale_gps' }
  return { ok: true }
}

/**
 * F1 — may this GPS result change the pickup now? Every fix carries the pickup revision that was
 * current when it was requested; any manual change (pin, search, saved place) and any move to a
 * screen where the pickup is being priced or edited bumps the revision, so a late result is dropped.
 */
export function shouldApplyFix(p: { status: LocStatus; token?: number; byUser?: boolean; currentRev: number; current: Place; live: boolean; inDemoArea: boolean }): boolean {
  if (p.status !== 'located' || p.token === undefined || p.token !== p.currentRev) return false
  if (!p.live && !p.inDemoArea) return false // demo: a fix outside the demo city is ignored
  return mayApplyFix(p.current, p.live, p.byUser)
}

/** Screens on which the pickup is priced or being edited: entering one freezes pending GPS results. */
export const PICKUP_FREEZING_STEPS = ['pick', 'vehicles', 'confirm'] as const

/**
 * F5 — the nearby-cars query only needs ~100 m precision (cars come back snapped to ~200 m and the
 * radius is kilometres). The ride request itself keeps full precision.
 */
export function coarseForNearby(p: LatLng, decimals = 3): LatLng {
  const f = 10 ** decimals
  return { lat: Math.round(p.lat * f) / f, lng: Math.round(p.lng * f) / f }
}

/** F3 — client-side zone check for the pin screen: demo only. LIVE leaves it to the server. */
export function clientPinBlock(live: boolean, zone: { restricted?: unknown; inService: boolean }): 'restricted' | 'out_of_service' | null {
  if (live) return null
  if (zone.restricted) return 'restricted'
  if (!zone.inService) return 'out_of_service'
  return null
}

/**
 * L2 — latest request wins. Each request takes a number; only the newest one may report a result,
 * so a tap during a pending (automatic) request supersedes it and the older result is discarded.
 */
export function createRequestGate() {
  let seq = 0
  return { begin: () => ++seq, owns: (id: number) => id === seq }
}

/**
 * L2 — may the rider tap "Use my location" now? Also while an AUTOMATIC request is pending (it may
 * be slow; the tap supersedes it). Not while their own tap is pending, after a refusal (never
 * prompt again), when unsupported, or when a fresh GPS pickup is already set.
 */
export function canRequestLocation(state: Pick<LocState, 'status' | 'byUser'>, pickupFromGps: boolean, pickupStale: boolean): boolean {
  if (state.status === 'denied' || state.status === 'unsupported' || state.status === 'insecure') return false
  if (state.status === 'locating') return !state.byUser
  return !pickupFromGps || pickupStale
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
          // L1: the age of a fix is the age of the reading itself (Position.timestamp), not when it
          // reached us: a cached position (maximumAge) can be older than the callback. A missing or
          // non-positive timestamp falls back to now; an old or future one is judged by validatePickup.
          const ts = typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) && p.timestamp > 0 ? p.timestamp : undefined
          finish({ status: 'located', pos, accuracyM: p.coords.accuracy, at: ts ?? env.now?.() ?? Date.now() })
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
