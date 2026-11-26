/**
 * Rider GPS (Phase A, task 1): permission flow, failures, pickup validity, and the LIVE rules
 * (no demo point, no request without a real pickup, nothing persisted).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CITY_CENTER, GPS_PICKUP_ID, capability, UNSET_PICKUP, locateOnce, mayApplyFix, pickupFromFix, readPermission, shouldAutoLocate, validatePickup,
} from '../src/location/riderLocation'
import { DEMO_CURRENT } from '../src/core/geo'
import { serverGateway } from '../src/data/tripGateway'
import type { Place } from '../src/core/types'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const RIYADH = { lat: 24.7743, lng: 46.7386 }
const pin = (pos: { lat: number; lng: number }, id = 'pin-1'): Place => ({ id, name: { ar: 'x', en: 'x' }, sub: { ar: '', en: '' }, pos, kind: 'pin' })

type Coords = { latitude: number; longitude: number; accuracy: number }
const geo = (behaviour: { ok?: Coords; code?: 1 | 2 | 3; throws?: boolean; silent?: boolean }) => ({
  getCurrentPosition: vi.fn((ok: PositionCallback, err?: PositionErrorCallback | null) => {
    if (behaviour.throws) throw new Error('boom')
    if (behaviour.silent) return
    if (behaviour.ok) ok({ coords: behaviour.ok, timestamp: 0 } as unknown as GeolocationPosition)
    else err?.({ code: behaviour.code, message: '' } as GeolocationPositionError)
  }),
})

afterEach(() => vi.useRealTimers())

describe('one GPS fix: every outcome is a state, never an exception', () => {
  it('success → located with position and accuracy', async () => {
    const r = await locateOnce({ geolocation: geo({ ok: { latitude: RIYADH.lat, longitude: RIYADH.lng, accuracy: 18 } }), isSecureContext: true, now: () => 5 })
    expect(r).toEqual({ status: 'located', pos: RIYADH, accuracyM: 18, at: 5 })
  })
  it('permission refused → denied; position unavailable → unavailable; timeout → timeout', async () => {
    expect((await locateOnce({ geolocation: geo({ code: 1 }), isSecureContext: true })).status).toBe('denied')
    expect((await locateOnce({ geolocation: geo({ code: 2 }), isSecureContext: true })).status).toBe('unavailable')
    expect((await locateOnce({ geolocation: geo({ code: 3 }), isSecureContext: true })).status).toBe('timeout')
  })
  it('no Geolocation API → unsupported; insecure page (http) → insecure, without touching the API', async () => {
    expect((await locateOnce({ isSecureContext: true })).status).toBe('unsupported')
    const g = geo({ ok: { latitude: 1, longitude: 1, accuracy: 1 } })
    expect((await locateOnce({ geolocation: g, isSecureContext: false })).status).toBe('insecure')
    expect(g.getCurrentPosition).not.toHaveBeenCalled()
  })
  it('a throwing API or invalid coordinates → unavailable', async () => {
    expect((await locateOnce({ geolocation: geo({ throws: true }), isSecureContext: true })).status).toBe('unavailable')
    expect((await locateOnce({ geolocation: geo({ ok: { latitude: NaN, longitude: 46, accuracy: 5 } }), isSecureContext: true })).status).toBe('unavailable')
  })
  it('a browser that never answers (prompt dismissed) → timeout via our own backstop', async () => {
    vi.useFakeTimers()
    const p = locateOnce({ geolocation: geo({ silent: true }), isSecureContext: true }, { timeout: 1000 })
    vi.advanceTimersByTime(4_100)
    expect((await p).status).toBe('timeout')
  })
  it('asks for a high-accuracy, bounded, recent-enough fix', async () => {
    const g = geo({ ok: { latitude: RIYADH.lat, longitude: RIYADH.lng, accuracy: 5 } })
    await locateOnce({ geolocation: g, isSecureContext: true })
    expect(g.getCurrentPosition.mock.calls[0][2]).toEqual({ enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 })
  })
})

describe('permission: never asked without a reason, never asked again after a refusal', () => {
  it('reads the state without prompting; unsupported Permissions API → unknown', async () => {
    for (const st of ['granted', 'denied', 'prompt'] as const) expect(await readPermission({ query: async () => ({ state: st }) })).toBe(st)
    expect(await readPermission(undefined)).toBe('unknown')
    expect(await readPermission({ query: async () => { throw new Error('x') } })).toBe('unknown')
  })
  it('a silent automatic fix only when already granted, and only once per page session', () => {
    expect(shouldAutoLocate('granted', false)).toBe(true)
    expect(shouldAutoLocate('granted', true)).toBe(false)
    for (const p of ['prompt', 'denied', 'unknown'] as const) expect(shouldAutoLocate(p, false)).toBe(false)
  })
  it('the hook marks a known refusal as denied without prompting, and the UI hides the retry button when denied', () => {
    const hook = read('src/location/useRiderLocation.ts')
    expect(hook).toMatch(/if \(p === 'denied'\) setState\(\{ status: 'denied' \}\)/)
    const ui = read('src/apps/passenger/PickupLocation.tsx')
    expect(ui).toMatch(/const canAsk = status !== 'locating' && status !== 'denied'/)
  })
})

describe('pickup validity (blocks the request)', () => {
  it('LIVE: unset, the demo point, bad or out-of-country coordinates and unresolved search results are refused', () => {
    expect(validatePickup(UNSET_PICKUP, true)).toEqual({ ok: false, problem: 'unset' })
    expect(validatePickup(undefined, true)).toEqual({ ok: false, problem: 'unset' })
    expect(validatePickup(DEMO_CURRENT, true)).toEqual({ ok: false, problem: 'demo_location' })
    expect(validatePickup(pin({ lat: NaN, lng: 46 }), true)).toEqual({ ok: false, problem: 'invalid_coordinates' })
    expect(validatePickup(pin({ lat: 120, lng: 46 }), true)).toEqual({ ok: false, problem: 'invalid_coordinates' })
    expect(validatePickup(pin({ lat: 51.5, lng: -0.12 }), true)).toEqual({ ok: false, problem: 'outside_country' })
    expect(validatePickup(pin({ lat: NaN, lng: NaN }, 'gplace:abc'), true).ok).toBe(false)
  })
  it('LIVE: a GPS fix, a map pin or a resolved search result is accepted', () => {
    expect(validatePickup(pickupFromFix(RIYADH, 20), true)).toEqual({ ok: true })
    expect(validatePickup(pin(RIYADH), true)).toEqual({ ok: true })
  })
  it('DEMO: the demo point stays a valid pickup (demo mode unchanged)', () => {
    expect(validatePickup(DEMO_CURRENT, false)).toEqual({ ok: true })
    expect(validatePickup(UNSET_PICKUP, false).ok).toBe(false)
  })
  it('the unset placeholder is the city centre for the map only, and is never valid', () => {
    expect(UNSET_PICKUP.pos).toEqual(CITY_CENTER)
    expect(validatePickup({ ...UNSET_PICKUP }, true).ok).toBe(false)
  })
  it('the LIVE gateway refuses an invalid pickup before any network call', async () => {
    const base = { passengerId: 'p', dropoff: pin(RIYADH, 'pin-2'), classId: 'go' as const, payment: 'cash' as const }
    expect(await serverGateway.requestTrip({ ...base, pickup: UNSET_PICKUP })).toEqual({ ok: false, error: 'pickup_invalid' })
    expect(await serverGateway.requestTrip({ ...base, pickup: DEMO_CURRENT })).toEqual({ ok: false, error: 'pickup_invalid' })
  })
})

describe('GPS never overwrites a manual choice', () => {
  it('an explicit "Use my location" tap may replace anything, including a manual pin', () => {
    expect(mayApplyFix(pin(RIYADH), true, true)).toBe(true)
  })
  it('the browser capability is known before asking (no API → unsupported, http → insecure)', () => {
    expect(capability({ geolocation: {}, isSecureContext: true })).toBe('ok')
    expect(capability({ isSecureContext: true })).toBe('unsupported')
    expect(capability({ geolocation: {}, isSecureContext: false })).toBe('insecure')
  })
  it('an automatic fix replaces the unset placeholder or a previous GPS pickup; keeps a pin or a search result', () => {
    expect(mayApplyFix(UNSET_PICKUP, true)).toBe(true)
    expect(mayApplyFix(pickupFromFix(RIYADH), true)).toBe(true)
    expect(mayApplyFix(pin(RIYADH), true)).toBe(false)
    expect(mayApplyFix(DEMO_CURRENT, false)).toBe(true) // demo: the demo point may give way to a real fix
    expect(mayApplyFix(DEMO_CURRENT, true)).toBe(false)
  })
  it('a fix becomes a GPS pickup with rounded accuracy', () => {
    const p = pickupFromFix({ lat: 24.7, lng: 46.7 }, 23.6)
    expect(p.id).toBe(GPS_PICKUP_ID)
    expect(p.sub.en).toBe('Accuracy ± 24 m')
  })
})

describe('LIVE mode never uses the demo point, and location data is not persisted', () => {
  it('the LIVE pickup starts unset; the home map and nearby cars follow the real pickup', () => {
    expect(read('src/apps/passenger/PassengerApp.tsx')).toMatch(/pickup: live \? UNSET_PICKUP : DEMO_CURRENT/)
    const booking = read('src/apps/passenger/Booking.tsx')
    expect(booking).not.toMatch(/useNearbyCars\(DEMO_CURRENT/)
    expect(booking).not.toMatch(/center=\{DEMO_CURRENT\.pos\}/)
    expect(booking).toMatch(/const center = hasPickup \? pickup\.pos : CITY_CENTER/)
  })
  it('no storage API in the location code; nothing new is sent to the server', () => {
    for (const f of ['src/location/riderLocation.ts', 'src/location/useRiderLocation.ts', 'src/apps/passenger/PickupLocation.tsx']) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') // code only, not comments
      expect(src, f).not.toMatch(/localStorage|sessionStorage|indexedDB|getSupabase|rpc\(|fetch\(/)
    }
  })
})
