/**
 * request-ride: validate the rider's request, price it on a server-computed route
 * and create + dispatch the ride. Dependencies are injected so the logic is
 * unit-tested without Deno or a network.
 */
import { haversineM, type LatLng, type RouteResult } from './routing.ts'

export const VEHICLE_CLASSES = ['go', 'comfort', 'black', 'xl'] as const
export const PAYMENT_METHODS = ['mada', 'card', 'apple_pay', 'stc_pay', 'wallet', 'cash'] as const
type VehicleClass = (typeof VEHICLE_CLASSES)[number]
type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export type Stop = LatLng & { address: string }
export type RideRequest = {
  city: string
  pickup: Stop
  dropoff: Stop
  vehicleClass: VehicleClass
  paymentMethod: PaymentMethod
  paymentMethodId?: string
  /** One-time provider token (new card / Apple Pay) instead of a saved card. */
  paymentToken?: string
  promoCode?: string
  /** true → return route + upfront quotes, create nothing. */
  dryRun: boolean
}

export type Quote = { fare_total_halalas: number; [k: string]: unknown }

export type Deps = {
  userId: string | null
  route(a: LatLng, b: LatLng): Promise<RouteResult>
  quote(args: { city: string; vehicleClass: VehicleClass; pickup: LatLng; distanceM: number; durationS: number; promoCode?: string }): Promise<Quote>
  createRide(args: { userId: string; req: RideRequest; route: RouteResult }): Promise<{ id: string; fare_total_halalas: number }>
  dispatch(rideId: string): Promise<string | null>
  /** Card rides: authorize the fare (the database dispatches once authorized). */
  authorize?(args: { userId: string; rideId: string; req: RideRequest }): Promise<{ status: string; paymentId?: string; transactionUrl?: string; error?: string }>
}

export const isCardMethod = (m: string) => m === 'mada' || m === 'card' || m === 'apple_pay' || m === 'stc_pay'

export type Result = { status: number; body: Record<string, unknown> }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseStop(v: unknown): Stop | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  if (!isNum(s.lat) || !isNum(s.lng) || s.lat < -90 || s.lat > 90 || s.lng < -180 || s.lng > 180) return null
  const address = typeof s.address === 'string' ? s.address.trim().slice(0, 300) : ''
  if (!address) return null
  return { lat: s.lat, lng: s.lng, address }
}

export function parseRideRequest(body: unknown): { ok: true; req: RideRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_body' }
  const b = body as Record<string, unknown>
  const pickup = parseStop(b.pickup)
  const dropoff = parseStop(b.dropoff)
  if (!pickup || !dropoff) return { ok: false, error: 'invalid_stops' }
  const d = haversineM(pickup, dropoff)
  if (d < 100) return { ok: false, error: 'stops_too_close' }
  if (d > 300_000) return { ok: false, error: 'trip_too_long' }
  const vehicleClass = (b.vehicleClass ?? 'go') as VehicleClass
  if (!VEHICLE_CLASSES.includes(vehicleClass)) return { ok: false, error: 'invalid_vehicle_class' }
  const paymentMethod = (b.paymentMethod ?? 'cash') as PaymentMethod
  if (!PAYMENT_METHODS.includes(paymentMethod)) return { ok: false, error: 'invalid_payment_method' }
  if (b.paymentMethodId !== undefined && (typeof b.paymentMethodId !== 'string' || !UUID.test(b.paymentMethodId))) {
    return { ok: false, error: 'invalid_payment_method_id' }
  }
  if (b.paymentToken !== undefined && (typeof b.paymentToken !== 'string' || !/^[A-Za-z0-9_\-:.]{4,200}$/.test(b.paymentToken))) {
    return { ok: false, error: 'invalid_payment_token' }
  }
  const dryRun = b.dryRun === true
  if (!dryRun && isCardMethod(paymentMethod) && !b.paymentMethodId && !b.paymentToken) return { ok: false, error: 'payment_method_required' }
  const city = typeof b.city === 'string' && /^[a-z_]{2,30}$/.test(b.city) ? b.city : 'riyadh'
  const promoCode = typeof b.promoCode === 'string' && b.promoCode.trim() ? b.promoCode.trim().toUpperCase().slice(0, 32) : undefined
  return {
    ok: true,
    req: {
      city,
      pickup,
      dropoff,
      vehicleClass,
      paymentMethod,
      paymentMethodId: b.paymentMethodId as string | undefined,
      paymentToken: b.paymentToken as string | undefined,
      promoCode,
      dryRun,
    },
  }
}

/** Database errors are raised as "AURA: …" — pass those through, hide everything else. */
export function publicError(e: unknown): string {
  const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : ''
  if (msg.startsWith('AURA:')) return msg.replace(/^AURA:\s*/, '')
  // The one-active-ride-per-rider unique index (double tap, app reopened mid-trip):
  // tell the rider instead of a generic error. Other database details stay hidden.
  if (msg.includes('rides_one_active_per_rider')) return 'you already have an active ride'
  return 'internal_error'
}

export async function handleRequestRide(body: unknown, deps: Deps): Promise<Result> {
  if (!deps.userId) return { status: 401, body: { error: 'unauthorized' } }
  const parsed = parseRideRequest(body)
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } }
  const req = parsed.req
  try {
    const route = await deps.route(req.pickup, req.dropoff)
    if (req.dryRun) {
      const quotes: Record<string, Quote> = {}
      for (const c of VEHICLE_CLASSES) {
        try {
          quotes[c] = await deps.quote({ city: req.city, vehicleClass: c, pickup: req.pickup, distanceM: route.distanceM, durationS: route.durationS, promoCode: req.promoCode })
        } catch (e) {
          if (c === req.vehicleClass) throw e
        }
      }
      return { status: 200, body: { route, quotes } }
    }
    const ride = await deps.createRide({ userId: deps.userId, req, route })
    if (isCardMethod(req.paymentMethod)) {
      if (!deps.authorize) return { status: 501, body: { error: 'card_payments_unavailable', rideId: ride.id } }
      const auth = await deps.authorize({ userId: deps.userId, rideId: ride.id, req })
      if (auth.status === 'failed' || auth.error) {
        // The database cancels the unpaid ride when the authorization fails.
        return { status: 402, body: { error: 'payment_failed', rideId: ride.id, paymentId: auth.paymentId } }
      }
      return {
        status: 201,
        body: {
          rideId: ride.id,
          fareTotal: ride.fare_total_halalas,
          route,
          paymentId: auth.paymentId,
          paymentStatus: auth.status,
          dispatched: auth.status === 'authorized' || auth.status === 'paid',
          ...(auth.transactionUrl ? { transactionUrl: auth.transactionUrl } : {}),
        },
      }
    }
    const offeredTo = await deps.dispatch(ride.id)
    return { status: 201, body: { rideId: ride.id, fareTotal: ride.fare_total_halalas, route, dispatched: offeredTo !== null } }
  } catch (e) {
    return { status: 400, body: { error: publicError(e) } }
  }
}
