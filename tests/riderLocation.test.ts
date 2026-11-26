/**
 * Rider GPS (Phase A, task 1): permission flow, failures, pickup validity, and the LIVE rules
 * (no demo point, no request without a real pickup, nothing persisted).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CITY_CENTER, GPS_PICKUP_ID, MAX_GPS_PICKUP_AGE_MS, canRequestLocation, capability, clientPinBlock, createRequestGate, coarseForNearby, shouldApplyFix, UNSET_PICKUP, locateOnce, mayApplyFix, pickupFromFix, readPermission, shouldAutoLocate, validatePickup,
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

describe('F1 — a GPS result applies only to the pickup revision it was requested for', () => {
  const base = { status: 'located' as const, currentRev: 4, current: UNSET_PICKUP, live: true, inDemoArea: true }
  it('applies when the revision is unchanged', () => {
    expect(shouldApplyFix({ ...base, token: 4 })).toBe(true)
    expect(shouldApplyFix({ ...base, token: 4, byUser: true, current: pin(RIYADH) })).toBe(true) // explicit tap, nothing changed since
  })
  it('drops a late result once the rider changed the pickup by hand (pin, search) or entered a pricing screen', () => {
    expect(shouldApplyFix({ ...base, token: 3 })).toBe(false)
    expect(shouldApplyFix({ ...base, token: 3, byUser: true, current: pin(RIYADH) })).toBe(false) // the reviewed race
  })
  it('drops results without a token, non-located states, and demo fixes outside the demo city', () => {
    expect(shouldApplyFix({ ...base, token: undefined })).toBe(false)
    expect(shouldApplyFix({ ...base, token: 4, status: 'locating' })).toBe(false)
    expect(shouldApplyFix({ ...base, token: 4, live: false, inDemoArea: false })).toBe(false)
  })
  it('an automatic result still never replaces a manual pickup, even with a matching token', () => {
    expect(shouldApplyFix({ ...base, token: 4, current: pin(RIYADH) })).toBe(false)
  })
})

describe('F2 — GPS pickups expire; manual pickups do not need a timestamp', () => {
  const now = 1_800_000_000_000
  it('a fresh GPS pickup is valid, an old one is refused as stale_gps', () => {
    expect(validatePickup(pickupFromFix(RIYADH, 10, now - 60_000), true, now)).toEqual({ ok: true })
    expect(validatePickup(pickupFromFix(RIYADH, 10, now - MAX_GPS_PICKUP_AGE_MS - 1), true, now)).toEqual({ ok: false, problem: 'stale_gps' })
  })
  it('a GPS pickup without a fix time, or from the future, is refused', () => {
    expect(validatePickup({ ...pickupFromFix(RIYADH), fixedAt: undefined }, true, now).ok).toBe(false)
    expect(validatePickup(pickupFromFix(RIYADH, 10, now + 10 * 60_000), true, now).ok).toBe(false)
  })
  it('a manual pin or a search result has no fixedAt and stays valid however old', () => {
    expect(pin(RIYADH).fixedAt).toBeUndefined()
    expect(validatePickup(pin(RIYADH), true, now + 365 * 24 * 3600_000)).toEqual({ ok: true })
  })
  it('the fix time comes from the browser fix, not from when it was applied', () => {
    expect(pickupFromFix(RIYADH, 10, 1234).fixedAt).toBe(1234)
  })
})

describe('F3 — demo zones never decide a LIVE pickup', () => {
  it('LIVE: no client verdict at all (the server decides and the confirm screen shows its refusal)', () => {
    expect(clientPinBlock(true, { restricted: { id: 'z' }, inService: false })).toBeNull()
  })
  it('DEMO: unchanged — restricted and out-of-service zones still block the pin', () => {
    expect(clientPinBlock(false, { restricted: { id: 'z' }, inService: true })).toBe('restricted')
    expect(clientPinBlock(false, { inService: false })).toBe('out_of_service')
    expect(clientPinBlock(false, { inService: true })).toBeNull()
  })
})

describe('F5 — the nearby-cars query is coarse; the ride request is not', () => {
  it('rounds to 3 decimals (≈ 110 m) and never moves more than half a step', () => {
    const p = { lat: 24.774312, lng: 46.738621 }
    const c = coarseForNearby(p)
    expect(c).toEqual({ lat: 24.774, lng: 46.739 })
    expect(Math.abs(c.lat - p.lat)).toBeLessThanOrEqual(0.0005)
    expect(Math.abs(c.lng - p.lng)).toBeLessThanOrEqual(0.0005)
  })
})

/** A controllable browser: every getCurrentPosition call waits until the test resolves it. */
function deferredGeo() {
  const calls: { ok: PositionCallback; err?: PositionErrorCallback | null }[] = []
  return {
    calls,
    geolocation: { getCurrentPosition: (ok: PositionCallback, err?: PositionErrorCallback | null) => void calls.push({ ok, err }) },
    resolve: (i: number, pos: { lat: number; lng: number }, timestamp: number) =>
      calls[i].ok({ coords: { latitude: pos.lat, longitude: pos.lng, accuracy: 12 }, timestamp } as unknown as GeolocationPosition),
  }
}

describe('L1 — a fix is as old as the reading (Position.timestamp), not as its delivery', () => {
  const NOW = 1_800_000_000_000
  const fixWithTimestamp = async (timestamp: number) => {
    const g = geo({ ok: { latitude: RIYADH.lat, longitude: RIYADH.lng, accuracy: 10 } })
    g.getCurrentPosition.mockImplementation((ok: PositionCallback) => ok({ coords: { latitude: RIYADH.lat, longitude: RIYADH.lng, accuracy: 10 }, timestamp } as unknown as GeolocationPosition))
    return locateOnce({ geolocation: g, isSecureContext: true, now: () => NOW })
  }
  it('a fresh reading keeps its own timestamp and is valid', async () => {
    const r = await fixWithTimestamp(NOW - 20_000)
    expect(r.at).toBe(NOW - 20_000)
    expect(validatePickup(pickupFromFix(r.pos!, r.accuracyM, r.at), true, NOW)).toEqual({ ok: true })
  })
  it('an OLD cached reading delivered now is refused as stale (the callback time would have hidden it)', async () => {
    const r = await fixWithTimestamp(NOW - MAX_GPS_PICKUP_AGE_MS - 1_000)
    expect(r.status).toBe('located')
    expect(r.at).toBe(NOW - MAX_GPS_PICKUP_AGE_MS - 1_000)
    expect(validatePickup(pickupFromFix(r.pos!, r.accuracyM, r.at), true, NOW)).toEqual({ ok: false, problem: 'stale_gps' })
  })
  it('the 5-minute limit is unchanged: just inside passes, just outside fails', async () => {
    const inside = await fixWithTimestamp(NOW - MAX_GPS_PICKUP_AGE_MS + 1_000)
    expect(validatePickup(pickupFromFix(inside.pos!, 10, inside.at), true, NOW).ok).toBe(true)
    expect(MAX_GPS_PICKUP_AGE_MS).toBe(5 * 60_000)
  })
  it('a reading from the FUTURE (bad clock) is refused; small skew (< 1 min) is tolerated', async () => {
    const future = await fixWithTimestamp(NOW + 10 * 60_000)
    expect(validatePickup(pickupFromFix(future.pos!, 10, future.at), true, NOW)).toEqual({ ok: false, problem: 'stale_gps' })
    const skew = await fixWithTimestamp(NOW + 20_000)
    expect(validatePickup(pickupFromFix(skew.pos!, 10, skew.at), true, NOW).ok).toBe(true)
  })
  it('a missing / zero / invalid timestamp falls back to the delivery time', async () => {
    for (const ts of [0, -5, NaN, undefined as unknown as number]) expect((await fixWithTimestamp(ts)).at).toBe(NOW)
  })
})

describe('L2 — "Use my location" during a pending automatic request: latest request wins', () => {
  const A = { lat: 24.70, lng: 46.60 } // automatic (slow) reading
  const B = { lat: 24.80, lng: 46.70 } // the tap's reading
  /** The hook's flow without React: gate (latest only) + pickup revision token (F1) + shouldApplyFix. */
  function harness() {
    const g = deferredGeo()
    const gate = createRequestGate()
    let rev = 0
    let pickup: Place = UNSET_PICKUP
    let state: { status: 'idle' | 'locating' | 'located'; byUser?: boolean } = { status: 'idle' }
    const start = (byUser: boolean) => {
      const id = gate.begin()
      const token = rev
      state = { status: 'locating', byUser }
      return locateOnce({ geolocation: g.geolocation, isSecureContext: true }).then((r) => {
        if (!gate.owns(id)) return 'discarded'
        state = { status: 'located', byUser }
        if (shouldApplyFix({ status: r.status, token, byUser, currentRev: rev, current: pickup, live: true, inDemoArea: true })) pickup = pickupFromFix(r.pos!, r.accuracyM, r.at)
        return 'owned'
      })
    }
    return { g, start, manual: (p: Place) => { rev++; pickup = p }, get pickup() { return pickup }, get state() { return state } }
  }

  it('the button is offered while the AUTOMATIC request is pending, not while the rider\'s own tap is', () => {
    expect(canRequestLocation({ status: 'locating', byUser: false }, false, false)).toBe(true)
    expect(canRequestLocation({ status: 'locating', byUser: true }, false, false)).toBe(false)
    expect(canRequestLocation({ status: 'denied' }, false, false)).toBe(false)
    expect(canRequestLocation({ status: 'unsupported' }, false, false)).toBe(false)
    expect(canRequestLocation({ status: 'located' }, true, false)).toBe(false) // fresh GPS pickup already set
    expect(canRequestLocation({ status: 'located' }, true, true)).toBe(true) // stale → refresh
    expect(canRequestLocation({ status: 'idle' }, false, false)).toBe(true)
  })
  it('tap during the pending automatic request; the automatic reading lands LAST → discarded, the tap\'s reading is the pickup', async () => {
    const h = harness()
    const auto = h.start(false)
    const tap = h.start(true)
    h.g.resolve(1, B, Date.now())
    expect(await tap).toBe('owned')
    h.g.resolve(0, A, Date.now())
    expect(await auto).toBe('discarded')
    expect(h.pickup.pos).toEqual(B)
  })
  it('the automatic reading lands FIRST → still discarded (not the latest); the pickup waits for the tap', async () => {
    const h = harness()
    const auto = h.start(false)
    const tap = h.start(true)
    h.g.resolve(0, A, Date.now())
    expect(await auto).toBe('discarded')
    expect(h.pickup.id).toBe(UNSET_PICKUP.id)
    expect(h.state.status).toBe('locating')
    h.g.resolve(1, B, Date.now())
    await tap
    expect(h.pickup.pos).toEqual(B)
  })
  it('a manual pin after the tap beats both pending readings (F1 kept)', async () => {
    const h = harness()
    const auto = h.start(false)
    const tap = h.start(true)
    const manual = pin({ lat: 24.75, lng: 46.65 })
    h.manual(manual)
    h.g.resolve(0, A, Date.now())
    h.g.resolve(1, B, Date.now())
    await Promise.all([auto, tap])
    expect(h.pickup).toBe(manual)
  })
  it('a gate number is owned only until the next request begins', () => {
    const g = createRequestGate()
    const a = g.begin()
    expect(g.owns(a)).toBe(true)
    const b = g.begin()
    expect(g.owns(a)).toBe(false)
    expect(g.owns(b)).toBe(true)
  })
})
