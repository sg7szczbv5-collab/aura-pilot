/**
 * Stage 4 unit tests: routing + polyline (Edge Function shared code), the
 * request-ride handler, server→app mapping, map zoom math and the trip gateway.
 */
import { describe, expect, it, vi } from 'vitest'
import { decodePolyline, encodePolyline, estimateRoute, googleRoute, haversineM, routeBetween } from '../supabase/functions/_shared/routing'
import { handleRequestRide, parseRideRequest, publicError, type Deps } from '../supabase/functions/_shared/requestRide'
import { quoteToFare, rideViewCounterparts, rideViewToTrip, toActor, type RideViewJson } from '../src/data/rideMapper'
import { googleZoomToPxPerKm, pxPerKmToGoogleZoom } from '../src/maps/config'
import { requestErrorFrom, rideRequestBody, trips } from '../src/data/tripGateway'
import { actions, store } from '../src/core/store'
import { PLACES } from '../src/core/geo'

const A = { lat: 24.7136, lng: 46.6753 }
const B = { lat: 24.7633, lng: 46.6407 }

describe('routing (Edge Function shared code)', () => {
  it('haversine matches known distances', () => {
    expect(haversineM(A, A)).toBe(0)
    expect(haversineM(A, B) / 1000).toBeCloseTo(6.53, 1)
  })

  it('encodes/decodes Google polylines (reference example)', () => {
    const pts = [{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }]
    expect(encodePolyline(pts)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@')
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual(pts)
  })

  it('estimates city routes without a provider', () => {
    const r = estimateRoute(A, B)
    expect(r.source).toBe('estimate')
    expect(r.distanceM).toBe(Math.round(haversineM(A, B) * 1.3))
    expect(r.durationS).toBe(Math.round(r.distanceM / (30 / 3.6)))
    expect(decodePolyline(r.polyline)).toHaveLength(2)
  })

  it('parses Google Routes API responses and falls back when it fails', async () => {
    const ok = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ routes: [{ distanceMeters: 8123, duration: '901s', polyline: { encodedPolyline: 'abc' } }] }) }))
    expect(await googleRoute(A, B, 'k', ok)).toEqual({ distanceM: 8123, durationS: 901, polyline: 'abc', source: 'google' })
    const [, init] = ok.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(init.headers['X-Goog-Api-Key']).toBe('k')
    expect(init.headers['X-Goog-FieldMask']).toContain('routes.distanceMeters')
    const down = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }))
    expect((await routeBetween(A, B, { googleKey: 'k', fetch: down })).source).toBe('estimate')
    expect((await routeBetween(A, B, {})).source).toBe('estimate')
  })
})

describe('request-ride handler', () => {
  const body = { pickup: { ...A, address: 'Olaya' }, dropoff: { ...B, address: 'KAFD' }, vehicleClass: 'comfort', paymentMethod: 'cash' }
  const deps = (over: Partial<Deps> = {}): Deps => ({
    userId: 'u1',
    route: async (a, b) => estimateRoute(a, b),
    quote: async () => ({ fare_total_halalas: 3335 }),
    createRide: async () => ({ id: 'ride-1', fare_total_halalas: 3335 }),
    dispatch: async () => 'cap-1',
    ...over,
  })

  it('validates input', () => {
    expect(parseRideRequest(null)).toEqual({ ok: false, error: 'invalid_body' })
    expect(parseRideRequest({ ...body, pickup: { lat: 99, lng: 0, address: 'x' } })).toEqual({ ok: false, error: 'invalid_stops' })
    expect(parseRideRequest({ ...body, dropoff: { ...A, address: 'same' } })).toEqual({ ok: false, error: 'stops_too_close' })
    expect(parseRideRequest({ ...body, vehicleClass: 'limo' })).toEqual({ ok: false, error: 'invalid_vehicle_class' })
    expect(parseRideRequest({ ...body, paymentMethodId: 'not-a-uuid' })).toEqual({ ok: false, error: 'invalid_payment_method_id' })
    const ok = parseRideRequest({ ...body, promoCode: ' welcome ' })
    expect(ok.ok && ok.req).toMatchObject({ city: 'riyadh', vehicleClass: 'comfort', promoCode: 'WELCOME', dryRun: false })
  })

  it('requires a signed-in rider', async () => {
    expect(await handleRequestRide(body, deps({ userId: null }))).toEqual({ status: 401, body: { error: 'unauthorized' } })
  })

  it('dry run returns the route and a quote per class, creating nothing', async () => {
    const createRide = vi.fn()
    const r = await handleRequestRide({ ...body, dryRun: true }, deps({ createRide }))
    expect(r.status).toBe(200)
    expect(Object.keys(r.body.quotes as object)).toEqual(['go', 'comfort', 'black', 'xl'])
    expect(createRide).not.toHaveBeenCalled()
  })

  it('creates and dispatches, passing the server route to the database', async () => {
    const createRide = vi.fn(async () => ({ id: 'ride-9', fare_total_halalas: 4200 }))
    const r = await handleRequestRide(body, deps({ createRide }))
    expect(r).toMatchObject({ status: 201, body: { rideId: 'ride-9', fareTotal: 4200, dispatched: true } })
    const arg = (createRide.mock.calls[0] as unknown as [{ userId: string; route: { distanceM: number } }])[0]
    expect(arg.userId).toBe('u1')
    expect(arg.route.distanceM).toBe(estimateRoute(A, B).distanceM)
  })

  it('passes database business errors through and hides everything else', async () => {
    const fail = (message: string) => deps({ createRide: async () => Promise.reject({ message }) })
    expect((await handleRequestRide(body, fail('AURA: pickup is outside the service area'))).body).toEqual({ error: 'pickup is outside the service area' })
    expect((await handleRequestRide(body, fail('connection reset by peer'))).body).toEqual({ error: 'internal_error' })
    expect(publicError(new Error('AURA: x'))).toBe('x')
    // Double request (unique index) → a message the app maps to «لديك رحلة نشطة بالفعل», other SQL stays hidden.
    const dup = 'duplicate key value violates unique constraint "rides_one_active_per_rider_ix"'
    expect((await handleRequestRide(body, fail(dup))).body).toEqual({ error: 'you already have an active ride' })
    expect(requestErrorFrom('you already have an active ride')).toBe('active_exists')
    expect(publicError({ message: 'duplicate key value violates unique constraint "payments_idem_ix"' })).toBe('internal_error')
  })
})

const VIEW: RideViewJson = {
  id: 'r1', ride_number: 1042, viewer: 'rider', status: 'driver_arriving', vehicle_class: 'go', city: 'riyadh',
  rider_id: 'rid', driver_id: 'drv', offered_driver_id: null, offer_expires_at: null,
  pickup: { ...A, address: 'Olaya St' }, dropoff: { ...B, address: 'KAFD' }, route_polyline: null,
  estimated_distance_m: 10000, estimated_duration_s: 1200, actual_distance_m: null, actual_duration_s: null,
  fare: { base: 600, distance: 1650, time: 600, surge: 0, min_topup: 50, subtotal: 2900, discount: 0, vat: 435, total: 3335,
    commission: 580, driver_net: 2320, tip: 0, surge_multiplier: '1.00', commission_bps: 2000, vat_bps: 1500, promo_code: null },
  payment_method: 'card', requested_at: '2026-11-27T10:00:00Z', updated_at: '2026-11-27T10:01:00Z',
  cancelled_at: null, cancelled_by: null, cancellation_reason: null, rating_by_rider: null, rating_by_driver: null,
  events: [
    { status: 'searching', actor: 'rider', at: '2026-11-27T10:00:00Z', note: null },
    { status: 'driver_assigned', actor: 'driver', at: '2026-11-27T10:00:30Z', note: null },
  ],
  driver: {
    id: 'drv', name: 'Faisal', rating: '4.90', ratings_count: 120,
    vehicle: { id: 'veh', class: 'go', make: 'Toyota', model: 'Camry', year: 2024, color: 'White', plate_letters: 'ABJ', plate_number: '1234' },
    location: { lat: 24.72, lng: 46.67, heading: '92', at: '2026-11-27T10:01:00Z' },
  },
  rider: { id: 'rid', first_name: 'Sara', rating: null },
}

describe('server → app mapping', () => {
  it('maps a ride_view document to a Trip the screens render', () => {
    const t = rideViewToTrip(VIEW)
    expect(t).toMatchObject({ id: 'r1', rideNumber: 1042, server: true, status: 'driver_arriving', passengerId: 'rid', driverId: 'drv', paymentMethod: 'mada' })
    expect(t.pickup.pos).toEqual(A)
    expect(t.pickup.name.ar).toBe('Olaya St')
    expect(t.fare).toMatchObject({ subtotal: 2900, total: 3335, driverNet: 2320, vatRate: 0.15, commissionRate: 0.2, distanceKm: 10, durationMin: 20 })
    expect(t.timeline.map((e) => e.actor)).toEqual(['passenger', 'driver'])
    expect(t.live).toEqual({ pos: { lat: 24.72, lng: 46.67 }, heading: 92, at: Date.parse('2026-11-27T10:01:00Z') })
    expect(t.offer).toBeUndefined()
  })

  it('maps offers and cancellations', () => {
    const offered = rideViewToTrip({ ...VIEW, viewer: 'offered', status: 'searching', driver_id: null, driver: null, offered_driver_id: 'drv', offer_expires_at: '2026-11-27T10:00:20Z' })
    expect(offered.offer).toEqual({ driverId: 'drv', expiresAt: Date.parse('2026-11-27T10:00:20Z'), declined: [] })
    const c = rideViewToTrip({ ...VIEW, status: 'cancelled', cancelled_by: 'system', cancellation_reason: 'no_captain_available', cancelled_at: '2026-11-27T10:05:00Z' })
    expect(c.cancel).toEqual({ by: 'system', reason: 'no_captain_available', at: Date.parse('2026-11-27T10:05:00Z') })
    expect(toActor('rider')).toBe('passenger')
  })

  it('creates counterpart records according to who is viewing', () => {
    const forRider = rideViewCounterparts(VIEW)
    expect(forRider.drivers.map((d) => [d.id, d.rating, d.vehicleId])).toEqual([['drv', 4.9, 'veh']])
    expect(forRider.vehicles[0].plate).toEqual({ digits: '1234', lettersEn: 'ABJ', lettersAr: 'أ ب ح' })
    expect(forRider.customers).toEqual([])
    const forDriver = rideViewCounterparts({ ...VIEW, viewer: 'driver' })
    expect(forDriver.drivers).toEqual([]) // never overwrite the captain's own record
    expect(forDriver.customers.map((c) => c.name.en)).toEqual(['Sara'])
  })

  it('maps server quotes to FareBreakdown', () => {
    const f = quoteToFare(
      { fare_base_halalas: 600, fare_distance_halalas: 1650, fare_time_halalas: 600, fare_surge_halalas: 0, fare_min_topup_halalas: 50,
        fare_subtotal_halalas: 2900, fare_discount_halalas: 290, fare_vat_halalas: 392, fare_total_halalas: 3002,
        commission_halalas: 580, driver_net_halalas: 2320, commission_bps: 2000, vat_bps: 1500, surge_multiplier: '1.20' },
      { distanceM: 10049, durationS: 1190 }, 'WELCOME')
    expect(f).toMatchObject({ total: 3002, discount: 290, surgeMultiplier: 1.2, distanceKm: 10, durationMin: 20, promoCode: 'WELCOME' })
  })
})

describe('maps', () => {
  it('converts CityMap px/km zoom to Google zoom levels and back', () => {
    const z = pxPerKmToGoogleZoom(70, 24.7)
    expect(z).toBeGreaterThan(13)
    expect(z).toBeLessThan(13.5)
    expect(googleZoomToPxPerKm(z, 24.7)).toBeCloseTo(70, -1)
    expect(pxPerKmToGoogleZoom(1e9, 0)).toBe(21)
  })
})

describe('trip gateway', () => {
  it('maps database messages to screen error codes', () => {
    expect(requestErrorFrom('pickup is outside the service area')).toBe('out_of_service')
    expect(requestErrorFrom('pickup or drop-off is in a restricted zone')).toBe('restricted')
    expect(requestErrorFrom('rider must accept the current terms and privacy policy')).toBe('consent_required')
    expect(requestErrorFrom('duplicate key value violates unique constraint "rides_one_active_per_rider_ix"')).toBe('active_exists')
    expect(requestErrorFrom('insufficient wallet balance')).toBe('wallet_low')
    expect(requestErrorFrom('???')).toBe('network')
  })

  it('builds the Edge Function body from places', () => {
    const b = rideRequestBody({ pickup: PLACES[0], dropoff: PLACES[1], classId: 'xl', payment: 'cash', dryRun: true, lang: 'en' })
    expect(b).toMatchObject({ city: 'riyadh', vehicleClass: 'xl', paymentMethod: 'cash', dryRun: true })
    expect(b.pickup).toEqual({ lat: PLACES[0].pos.lat, lng: PLACES[0].pos.lng, address: PLACES[0].name.en })
  })

  it('mock mode drives the existing local lifecycle unchanged', async () => {
    expect(trips.mode).toBe('mock')
    const pid = actions.registerCustomer({ name: { ar: 'اختبار', en: 'Gateway Test' }, phone: '+966 50 000 9999' })
    const r = await trips.requestTrip({ passengerId: pid, pickup: PLACES[0], dropoff: PLACES[1], classId: 'go', payment: 'cash' })
    expect(r.ok).toBe(true)
    const id = r.ok ? r.tripId : ''
    expect(store.state.trips.find((t) => t.id === id)?.status).toBe('searching')
    expect(await trips.cancelTrip(id, 'passenger', 'changed_mind')).toBe(true)
    expect(store.state.trips.find((t) => t.id === id)?.status).toBe('cancelled')
  })
})
