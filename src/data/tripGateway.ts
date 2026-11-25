/**
 * Trip lifecycle gateway used by the rider and captain screens.
 *   mock     : the existing local store actions (demo; unchanged behaviour)
 *   supabase : Edge Function request-ride + RPCs (accept/decline/transition/start/rate),
 *              then the ride is re-read into the store by the mirror.
 * The database enforces the state machine, permissions, consents and pricing.
 */
import { AUTH_MODE } from '../auth/config'
import { getSupabase } from '../auth/supabaseClient'
import { actions, store, type TripRequest } from '../core/store'
import type { Actor, Place, TripRating, VehicleClassId } from '../core/types'
import { refreshRide, syncDriverSelf } from './serverMirror'

export type RequestError =
  | 'restricted'
  | 'out_of_service'
  | 'blocked'
  | 'active_exists'
  | 'consent_required'
  | 'wallet_low'
  | 'promo_invalid'
  | 'payment_failed'
  | 'card_required'
  | 'network'
/** transactionUrl: open it for 3-D Secure; the app returns with ?payment=<id>. */
export type RequestResult = { ok: true; tripId: string; transactionUrl?: string } | { ok: false; error: RequestError; message?: string }
/** Card rides in supabase mode carry the saved card to authorize. */
export type TripRequestWithCard = TripRequest & { paymentMethodId?: string }
export type OnlineResult = { ok: true } | { ok: false; error: 'consent_required' | 'vehicle_required' | 'not_approved' | 'network' }

export interface TripGateway {
  readonly mode: 'mock' | 'supabase'
  requestTrip(req: TripRequestWithCard): Promise<RequestResult>
  cancelTrip(tripId: string, actor: Actor, reason: string): Promise<boolean>
  acceptOffer(tripId: string, driverId: string): Promise<boolean>
  declineOffer(tripId: string, driverId: string): Promise<void>
  markArrived(tripId: string): Promise<boolean>
  startTrip(tripId: string, code: string): Promise<boolean>
  completeTrip(tripId: string): Promise<boolean>
  rateDriver(tripId: string, rating: TripRating): Promise<void>
  rateRider(tripId: string, rating: TripRating): Promise<void>
  setOnline(driverId: string, online: boolean): Promise<OnlineResult>
}

/** Map database messages ("AURA: …") to the error codes the screens translate. */
export function requestErrorFrom(message: string): RequestError {
  const m = message.toLowerCase()
  if (m.includes('restricted')) return 'restricted'
  if (m.includes('outside the service area') || m.includes('not in service') || m.includes('unknown city')) return 'out_of_service'
  if (m.includes('blocked')) return 'blocked'
  if (m.includes('one_active') || m.includes('duplicate key') || m.includes('active ride')) return 'active_exists'
  if (m.includes('terms and privacy')) return 'consent_required'
  if (m.includes('wallet')) return 'wallet_low'
  if (m.includes('promo')) return 'promo_invalid'
  if (m.includes('payment_method_required')) return 'card_required'
  if (m.includes('payment_failed') || m.includes('declined')) return 'payment_failed'
  return 'network'
}

/* ============================== MOCK ============================== */

const mockGateway: TripGateway = {
  mode: 'mock',
  async requestTrip(req) {
    const r = actions.requestTrip(req)
    return r.ok ? { ok: true, tripId: r.trip.id } : { ok: false, error: r.error }
  },
  async cancelTrip(id, actor, reason) {
    return !!actions.cancelTrip(id, actor, reason)
  },
  async acceptOffer(id, driverId) {
    return !!actions.acceptOffer(id, driverId)
  },
  async declineOffer(id, driverId) {
    actions.declineOffer(id, driverId)
  },
  async markArrived(id) {
    return !!actions.markArrived(id)
  },
  async startTrip(id, code) {
    return !!actions.startTrip(id, code)
  },
  async completeTrip(id) {
    return !!actions.completeTrip(id)
  },
  async rateDriver(id, rating) {
    actions.rateDriver(id, rating)
  },
  async rateRider(id, rating) {
    actions.rateRider(id, rating)
  },
  async setOnline(id, online) {
    actions.setOnline(id, online)
    return { ok: true }
  },
}

/* ============================== SUPABASE ============================== */

/** Body for the request-ride Edge Function (also used for dry-run quotes). */
export function rideRequestBody(p: {
  pickup: Place
  dropoff: Place
  classId: VehicleClassId
  payment: string
  promoCode?: string
  cityId?: string
  dryRun?: boolean
  lang?: 'ar' | 'en'
  paymentMethodId?: string
}) {
  const label = (pl: Place) => (p.lang === 'en' ? pl.name.en : pl.name.ar) || pl.name.ar || pl.name.en || `${pl.pos.lat.toFixed(5)}, ${pl.pos.lng.toFixed(5)}`
  return {
    city: p.cityId ?? 'riyadh',
    pickup: { lat: p.pickup.pos.lat, lng: p.pickup.pos.lng, address: label(p.pickup) },
    dropoff: { lat: p.dropoff.pos.lat, lng: p.dropoff.pos.lng, address: label(p.dropoff) },
    vehicleClass: p.classId,
    paymentMethod: p.payment,
    paymentMethodId: p.paymentMethodId,
    promoCode: p.promoCode,
    dryRun: p.dryRun === true,
  }
}

/** Call an Edge Function and surface its JSON error body. */
export async function invokeFunction<T>(name: string, body: unknown): Promise<{ data?: T; error?: string }> {
  const { data, error } = await getSupabase().functions.invoke(name, { body: body as Record<string, unknown> })
  if (!error) return { data: data as T }
  const ctx = (error as { context?: Response }).context
  try {
    const j = ctx ? ((await ctx.json()) as { error?: string }) : null
    return { error: j?.error ?? error.message }
  } catch {
    return { error: error.message }
  }
}

async function rpcOk(fn: string, args: Record<string, unknown>): Promise<boolean> {
  const { error } = await getSupabase().rpc(fn, args)
  return !error
}

const serverGateway: TripGateway = {
  mode: 'supabase',
  async requestTrip(req) {
    if ((req.payment === 'mada' || req.payment === 'apple_pay') && !req.paymentMethodId) return { ok: false, error: 'card_required' }
    const { data, error } = await invokeFunction<{ rideId: string; transactionUrl?: string }>('request-ride', rideRequestBody({ ...req, cityId: req.cityId }))
    if (error || !data?.rideId) return { ok: false, error: requestErrorFrom(error ?? ''), message: error }
    await refreshRide(data.rideId)
    return { ok: true, tripId: data.rideId, transactionUrl: data.transactionUrl }
  },
  async cancelTrip(id, _actor, reason) {
    const ok = await rpcOk('transition_ride', { p_ride_id: id, p_to: 'cancelled', p_reason: reason })
    await refreshRide(id)
    return ok
  },
  async acceptOffer(id) {
    const { error } = await getSupabase().rpc('accept_ride', { p_ride_id: id })
    if (error) {
      await refreshRide(id)
      return false
    }
    // The captain starts navigating immediately.
    await rpcOk('transition_ride', { p_ride_id: id, p_to: 'driver_arriving' })
    await refreshRide(id)
    return true
  },
  async declineOffer(id) {
    await rpcOk('decline_ride', { p_ride_id: id })
    store.commit((s) => {
      const t = s.trips.find((x) => x.id === id)
      if (t?.server) t.offer = undefined
    })
  },
  async markArrived(id) {
    const ok = await rpcOk('transition_ride', { p_ride_id: id, p_to: 'driver_arrived' })
    await refreshRide(id)
    return ok
  },
  async startTrip(id, code) {
    const { data, error } = await getSupabase().rpc('start_ride', { p_ride_id: id, p_code: code })
    await refreshRide(id)
    return !error && data === true
  },
  async completeTrip(id) {
    const ok = await rpcOk('transition_ride', { p_ride_id: id, p_to: 'completed' })
    await refreshRide(id)
    return ok
  },
  async rateDriver(id, rating) {
    // Tips are part of payments (Stage 5); the rating and comment are stored now.
    await rpcOk('rate_ride', { p_ride_id: id, p_stars: rating.stars, p_feedback: rating.comment ?? null })
    await refreshRide(id)
  },
  async rateRider(id, rating) {
    await rpcOk('rate_ride', { p_ride_id: id, p_stars: rating.stars, p_feedback: null })
    await refreshRide(id)
  },
  async setOnline(id, online) {
    const { error } = await getSupabase().from('drivers').update({ is_online: online }).eq('id', id)
    await syncDriverSelf(id)
    if (!error) return { ok: true }
    const m = error.message.toLowerCase()
    return { ok: false, error: m.includes('accept the current') ? 'consent_required' : m.includes('vehicle') ? 'vehicle_required' : m.includes('approval') ? 'not_approved' : 'network' }
  },
}

export const trips: TripGateway = AUTH_MODE === 'supabase' ? serverGateway : mockGateway
