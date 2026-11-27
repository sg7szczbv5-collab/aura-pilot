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
import type { Actor, Place, Trip, TripRating, VehicleClassId } from '../core/types'
import { isActive } from '../core/trip'
import { isNetworkError, runRideAction, type AttemptResult, type Confirmation, type RideActionResult } from '../captain/rideAction'
import { refreshRide, syncDriverSelf } from './serverMirror'
import { validatePickup } from '../location/riderLocation'

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
  | 'pickup_invalid'
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
  /** A2.3: captain operations report what the server confirmed (see captain/rideAction.ts). */
  acceptOffer(tripId: string, driverId: string): Promise<RideActionResult>
  declineOffer(tripId: string, driverId: string): Promise<void>
  markArrived(tripId: string): Promise<RideActionResult>
  startTrip(tripId: string, code: string): Promise<RideActionResult>
  completeTrip(tripId: string): Promise<RideActionResult>
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

/** Demo store: synchronous and local, so the answer IS the state. */
const local = (ok: boolean): RideActionResult => (ok ? { ok: true, via: 'response' } : { ok: false, reason: 'rejected' })

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
    return local(!!actions.acceptOffer(id, driverId))
  },
  async declineOffer(id, driverId) {
    actions.declineOffer(id, driverId)
  },
  async markArrived(id) {
    return local(!!actions.markArrived(id))
  },
  async startTrip(id, code) {
    return local(!!actions.startTrip(id, code))
  },
  async completeTrip(id) {
    return local(!!actions.completeTrip(id))
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

/** One RPC call as an attempt: success, a network failure, or the database refusing. */
async function rpcAttempt(fn: string, args: Record<string, unknown>): Promise<AttemptResult> {
  const { error } = await getSupabase().rpc(fn, args)
  return error ? { ok: false, network: isNetworkError(error), message: error.message } : { ok: true }
}

const ASSIGNED = new Set(['driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress', 'completed'])
const ARRIVING_OR_LATER = new Set(['driver_arriving', 'driver_arrived', 'in_progress', 'completed'])

/** Re-read the ride from the server and judge it. No answer → 'unknown' (never a guess). */
async function confirmRide(id: string, judge: (t: Trip) => Confirmation): Promise<Confirmation> {
  const t = await refreshRide(id)
  return t ? judge(t) : 'unknown'
}

/** transition_ride to `to`, judged by the server's status afterwards. */
function advance(id: string, to: 'driver_arriving' | 'driver_arrived' | 'completed', judge: (status: string) => Confirmation) {
  return runRideAction({
    key: `${id}:${to}`,
    attempt: () => rpcAttempt('transition_ride', { p_ride_id: id, p_to: to }),
    confirm: () => confirmRide(id, (t) => judge(t.status)),
  })
}

/** Exported for tests; screens use `trips`. */
export const serverGateway: TripGateway = {
  mode: 'supabase',
  async requestTrip(req) {
    // Defence in depth: the confirm screen already blocks this; no request leaves without a real pickup.
    if (!validatePickup(req.pickup, true).ok) return { ok: false, error: 'pickup_invalid' }
    if ((req.payment === 'mada' || req.payment === 'apple_pay') && !req.paymentMethodId) return { ok: false, error: 'card_required' }
    const { data, error } = await invokeFunction<{ rideId: string; transactionUrl?: string }>('request-ride', rideRequestBody({ ...req, cityId: req.cityId }))
    if (error || !data?.rideId) return { ok: false, error: requestErrorFrom(error ?? ''), message: error }
    await refreshRide(data.rideId)
    return { ok: true, tripId: data.rideId, transactionUrl: data.transactionUrl }
  },
  async cancelTrip(id, _actor, reason) {
    // Same-state transitions are no-ops on the server, so a retry after a lost answer is safe.
    const r = await runRideAction({
      key: `${id}:cancel`,
      attempt: () => rpcAttempt('transition_ride', { p_ride_id: id, p_to: 'cancelled', p_reason: reason }),
      confirm: () => confirmRide(id, (t) => (t.status === 'cancelled' ? 'done' : isActive(t.status) ? 'pending' : 'impossible')),
    })
    await refreshRide(id)
    return r.ok
  },
  async acceptOffer(id, driverId) {
    // accept_ride is NOT idempotent (it only accepts a 'searching' ride): a retry after a lost success
    // is refused. The server read decides: the ride is mine → accepted.
    const accepted = await runRideAction({
      key: `${id}:accept`,
      attempt: () => rpcAttempt('accept_ride', { p_ride_id: id }),
      confirm: () =>
        confirmRide(id, (t) =>
          t.driverId === driverId && ASSIGNED.has(t.status) ? 'done' : t.status === 'searching' && t.offer?.driverId === driverId && t.offer.expiresAt > Date.now() ? 'pending' : 'impossible',
        ),
    })
    if (!accepted.ok) {
      await refreshRide(id)
      return accepted
    }
    // The captain starts navigating immediately (also completes an accept whose follow-up was lost).
    await advance(id, 'driver_arriving', (s) => (s === 'driver_assigned' ? 'pending' : ARRIVING_OR_LATER.has(s) ? 'done' : 'impossible'))
    await refreshRide(id)
    return accepted
  },
  async declineOffer(id) {
    await rpcOk('decline_ride', { p_ride_id: id })
    store.commit((s) => {
      const t = s.trips.find((x) => x.id === id)
      if (t?.server) t.offer = undefined
    })
  },
  async markArrived(id) {
    // An accept whose follow-up (→ arriving) was lost would make 'arrived' an illegal jump: finish it first.
    if (store.state.trips.find((t) => t.id === id)?.status === 'driver_assigned') await advance(id, 'driver_arriving', (s) => (s === 'driver_assigned' ? 'pending' : ARRIVING_OR_LATER.has(s) ? 'done' : 'impossible'))
    const r = await advance(id, 'driver_arrived', (s) => (s === 'driver_arriving' || s === 'driver_assigned' ? 'pending' : s === 'driver_arrived' || s === 'in_progress' || s === 'completed' ? 'done' : 'impossible'))
    await refreshRide(id)
    return r
  },
  async startTrip(id, code) {
    // start_ride refuses a second call once the ride is in progress: the server read decides.
    const r = await runRideAction({
      key: `${id}:start`,
      attempt: async () => {
        const { data, error } = await getSupabase().rpc('start_ride', { p_ride_id: id, p_code: code })
        if (error) return { ok: false, network: isNetworkError(error), message: error.message }
        return data === true ? { ok: true } : { ok: false, network: false, message: 'wrong_code' }
      },
      confirm: () => confirmRide(id, (t) => (t.status === 'in_progress' || t.status === 'completed' ? 'done' : t.status === 'driver_arrived' ? 'pending' : 'impossible')),
    })
    await refreshRide(id)
    return r
  },
  async completeTrip(id) {
    const r = await advance(id, 'completed', (s) => (s === 'in_progress' ? 'pending' : s === 'completed' ? 'done' : 'impossible'))
    await refreshRide(id)
    return r
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
