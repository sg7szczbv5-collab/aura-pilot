/**
 * Production wiring of the request-ride handler (used by request-ride/index.ts
 * and by the end-to-end cutover test, so both run the exact same code).
 */
import type { SupabaseLike } from './payments/db.ts'
import { createPaymentsDb } from './payments/db.ts'
import { charge } from './payments/handlers.ts'
import { getProvider } from './payments/registry.ts'
import type { FetchLike as PaymentsFetch } from './payments/provider.ts'
import type { Deps, Quote } from './requestRide.ts'
import { routeBetween } from './routing.ts'

type Res = { data: unknown; error: { message: string } | null }
const ok = <T>(r: Res): T => {
  if (r.error) throw r.error
  return r.data as T
}

export function buildRequestRideDeps(p: {
  userId: string | null
  userClient: SupabaseLike
  admin: SupabaseLike
  env: (k: string) => string | undefined
  fetch: PaymentsFetch
}): Deps {
  const providerName = (p.env('PAYMENT_PROVIDER') ?? 'mock') as 'mock' | 'moyasar'
  const googleKey = p.env('GOOGLE_MAPS_SERVER_KEY') || undefined
  return {
    userId: p.userId,
    route: (a, b) => routeBetween(a, b, { googleKey, fetch: (u, i) => p.fetch(u, i) }),
    quote: async (a) =>
      ok<Quote>(
        await p.userClient
          .rpc('quote_trip', {
            p_city_code: a.city,
            p_vehicle_class: a.vehicleClass,
            p_pickup_lat: a.pickup.lat,
            p_pickup_lng: a.pickup.lng,
            p_distance_m: a.distanceM,
            p_duration_s: a.durationS,
            p_promo_code: a.promoCode ?? null,
          })
          .single(),
      ),
    createRide: async ({ userId, req: r, route }) =>
      ok<{ id: string; fare_total_halalas: number }>(
        await p.admin
          .rpc('create_ride', {
            p_rider_id: userId,
            p_city_code: r.city,
            p_vehicle_class: r.vehicleClass,
            p_pickup_lat: r.pickup.lat,
            p_pickup_lng: r.pickup.lng,
            p_pickup_address: r.pickup.address,
            p_dropoff_lat: r.dropoff.lat,
            p_dropoff_lng: r.dropoff.lng,
            p_dropoff_address: r.dropoff.address,
            p_distance_m: route.distanceM,
            p_duration_s: route.durationS,
            p_payment_method: r.paymentMethod,
            p_payment_method_id: r.paymentMethodId ?? null,
            p_promo_code: r.promoCode ?? null,
            p_route_polyline: route.polyline,
          })
          .single(),
      ),
    dispatch: async (rideId) => (ok<string | null>(await p.admin.rpc('dispatch_ride', { p_ride_id: rideId })) ?? null),
    authorize: async ({ userId, rideId, req: r }) => {
      const res = await charge(
        {
          kind: 'charge',
          rideId,
          amountHalalas: null,
          methodType: r.paymentMethod === 'mada' || r.paymentMethod === 'apple_pay' || r.paymentMethod === 'stc_pay' ? r.paymentMethod : 'card',
          paymentMethodId: r.paymentMethodId ?? null,
          token: r.paymentToken ?? null,
          applePay: r.paymentMethod === 'apple_pay',
        },
        {
          userId,
          provider: getProvider(providerName, p.env, p.fetch),
          db: createPaymentsDb(p.admin, providerName),
          callbackUrl: p.env('PAYMENT_CALLBACK_URL') ?? 'http://localhost:5180/#/passenger',
        },
      )
      return {
        status: String(res.body.status ?? (res.status === 402 ? 'failed' : 'initiated')),
        paymentId: res.body.paymentId as string | undefined,
        transactionUrl: res.body.transactionUrl as string | undefined,
        error: res.status >= 400 ? String(res.body.error) : undefined,
      }
    },
  }
}
