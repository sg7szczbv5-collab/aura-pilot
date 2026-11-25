/**
 * Maps server documents (public.ride_view JSON, quote rows) to the shapes the
 * existing screens already render (Trip, Driver, Vehicle, Customer, FareBreakdown).
 * Pure functions — unit-tested.
 */
import type { Actor, CityId, Customer, Driver, FareBreakdown, PaymentMethodId, Place, Trip, TripStatus, VehicleClassId, Vehicle } from '../core/types'

export type RideViewJson = {
  id: string
  ride_number: number
  viewer: 'rider' | 'driver' | 'offered' | 'admin'
  status: TripStatus
  vehicle_class: VehicleClassId
  city: string
  rider_id: string
  driver_id: string | null
  offered_driver_id: string | null
  offer_expires_at: string | null
  pickup: { lat: number; lng: number; address: string }
  dropoff: { lat: number; lng: number; address: string }
  route_polyline: string | null
  estimated_distance_m: number
  estimated_duration_s: number
  actual_distance_m: number | null
  actual_duration_s: number | null
  fare: {
    base: number; distance: number; time: number; surge: number; min_topup: number; subtotal: number
    discount: number; vat: number; total: number; commission: number; driver_net: number; tip: number
    surge_multiplier: number | string; commission_bps: number; vat_bps: number; promo_code: string | null
  }
  payment_method: string
  requested_at: string
  updated_at: string
  cancelled_at: string | null
  cancelled_by: string | null
  cancellation_reason: string | null
  rating_by_rider: number | null
  rating_by_driver: number | null
  events: { status: TripStatus; actor: string; at: string; note: string | null }[]
  driver: null | {
    id: string
    name: string | null
    rating: number | string | null
    ratings_count: number
    vehicle: null | { id: string; class: VehicleClassId; make: string; model: string; year: number; color: string; plate_letters: string; plate_number: string }
    location: null | { lat: number; lng: number; heading: number | string | null; at: string }
  }
  rider: null | { id: string; first_name: string; rating: number | string | null }
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : 0)
const num = (v: number | string | null | undefined, d = 0) => (v === null || v === undefined || v === '' ? d : Number(v))

/** Server actor names → app actor names. */
export const toActor = (a: string | null | undefined): Actor => (a === 'rider' ? 'passenger' : a === 'driver' || a === 'admin' ? a : 'system')

export const toPaymentMethod = (m: string): PaymentMethodId => (m === 'apple_pay' || m === 'wallet' || m === 'cash' ? m : 'mada')

const CITIES: CityId[] = ['riyadh', 'jeddah', 'dammam', 'khobar', 'makkah', 'madinah']
const toCity = (c: string): CityId => (CITIES.includes(c as CityId) ? (c as CityId) : 'riyadh')

const LATIN_TO_AR: Record<string, string> = { A: 'أ', B: 'ب', J: 'ح', D: 'د', R: 'ر', S: 'س', X: 'ص', T: 'ط', E: 'ع', G: 'ق', K: 'ك', L: 'ل', Z: 'م', N: 'ن', H: 'ه', U: 'و', V: 'ى' }
const COLOR_HEX: Record<string, string> = { white: '#F5F5F3', black: '#141516', silver: '#B9BCBE', grey: '#6E7174', gray: '#6E7174', blue: '#2F4E8C', red: '#9C2B2B' }

function stop(kind: 'pu' | 'do', rideId: string, s: { lat: number; lng: number; address: string }): Place {
  return { id: `srv-${kind}-${rideId}`, name: { ar: s.address, en: s.address }, sub: { ar: '', en: '' }, pos: { lat: s.lat, lng: s.lng }, kind: 'pin' }
}

export type QuoteRow = {
  fare_base_halalas: number; fare_distance_halalas: number; fare_time_halalas: number; fare_surge_halalas: number
  fare_min_topup_halalas: number; fare_subtotal_halalas: number; fare_discount_halalas: number; fare_vat_halalas: number
  fare_total_halalas: number; commission_halalas: number; driver_net_halalas: number
  commission_bps: number; vat_bps: number; surge_multiplier: number | string
}

/** quote_trip / create_ride row → FareBreakdown. */
export function quoteToFare(q: QuoteRow, route: { distanceM: number; durationS: number }, promoCode?: string): FareBreakdown {
  return {
    base: q.fare_base_halalas,
    distance: q.fare_distance_halalas,
    time: q.fare_time_halalas,
    surge: q.fare_surge_halalas,
    minFareTopUp: q.fare_min_topup_halalas,
    subtotal: q.fare_subtotal_halalas,
    discount: q.fare_discount_halalas,
    vat: q.fare_vat_halalas,
    total: q.fare_total_halalas,
    commission: q.commission_halalas,
    driverNet: q.driver_net_halalas,
    vatRate: q.vat_bps / 10000,
    commissionRate: q.commission_bps / 10000,
    surgeMultiplier: num(q.surge_multiplier, 1),
    distanceKm: Math.round(route.distanceM / 100) / 10,
    durationMin: Math.round(route.durationS / 60),
    promoCode: q.fare_discount_halalas > 0 ? promoCode : undefined,
  }
}

export function rideViewToTrip(v: RideViewJson): Trip {
  const f = v.fare
  const fare: FareBreakdown = {
    base: f.base,
    distance: f.distance,
    time: f.time,
    surge: f.surge,
    minFareTopUp: f.min_topup,
    subtotal: f.subtotal,
    discount: f.discount,
    vat: f.vat,
    total: f.total,
    commission: f.commission,
    driverNet: f.driver_net,
    vatRate: f.vat_bps / 10000,
    commissionRate: f.commission_bps / 10000,
    surgeMultiplier: num(f.surge_multiplier, 1),
    distanceKm: Math.round((v.actual_distance_m ?? v.estimated_distance_m) / 100) / 10,
    durationMin: Math.round((v.actual_duration_s ?? v.estimated_duration_s) / 60),
    promoCode: f.promo_code ?? undefined,
  }
  const loc = v.driver?.location
  return {
    id: v.id,
    rideNumber: v.ride_number,
    server: true,
    status: v.status,
    cityId: toCity(v.city),
    vehicleClass: v.vehicle_class,
    pickup: stop('pu', v.id, v.pickup),
    dropoff: stop('do', v.id, v.dropoff),
    passengerId: v.rider_id,
    driverId: v.driver_id ?? undefined,
    otp: '',
    fare,
    paymentMethod: toPaymentMethod(v.payment_method),
    createdAt: ms(v.requested_at),
    updatedAt: ms(v.updated_at),
    timeline: v.events.map((e) => ({ status: e.status, at: ms(e.at), actor: toActor(e.actor), note: e.note ?? undefined })),
    offer:
      v.status === 'searching' && v.offered_driver_id && v.offer_expires_at
        ? { driverId: v.offered_driver_id, expiresAt: ms(v.offer_expires_at), declined: [] }
        : undefined,
    cancel: v.status === 'cancelled' ? { by: toActor(v.cancelled_by), reason: v.cancellation_reason ?? '', at: ms(v.cancelled_at) } : undefined,
    passengerRating: v.rating_by_rider ? { stars: v.rating_by_rider, tags: [] } : undefined,
    driverRating: v.rating_by_driver ? { stars: v.rating_by_driver, tags: [] } : undefined,
    live: loc ? { pos: { lat: loc.lat, lng: loc.lng }, heading: num(loc.heading), at: ms(loc.at) } : undefined,
  }
}

/** Counterpart records the screens look up by id (getDriver / getVehicle / getCustomer). */
export function rideViewCounterparts(v: RideViewJson): { drivers: Driver[]; vehicles: Vehicle[]; customers: Customer[] } {
  const out = { drivers: [] as Driver[], vehicles: [] as Vehicle[], customers: [] as Customer[] }
  const d = v.driver
  // The rider (or staff) sees the captain; a captain's own record is synced separately.
  if (d && (v.viewer === 'rider' || v.viewer === 'admin')) {
    const name = d.name ?? ''
    out.drivers.push({
      id: d.id,
      name: { ar: name, en: name },
      phone: '',
      nationalId: '',
      cityId: toCity(v.city),
      status: 'approved',
      online: true,
      rating: num(d.rating, 5),
      ratingsCount: d.ratings_count,
      joinedAt: 0,
      vehicleId: d.vehicle?.id,
      docs: [],
      acceptanceRate: 1,
      cancellationRate: 0,
      punctuality: 1,
      server: true,
    })
    if (d.vehicle) out.vehicles.push(vehicleFromServer(d.vehicle, d.id))
  }
  if (v.rider && (v.viewer === 'driver' || v.viewer === 'offered' || v.viewer === 'admin')) {
    out.customers.push({
      id: v.rider.id,
      name: { ar: v.rider.first_name, en: v.rider.first_name },
      phone: '',
      cityId: toCity(v.city),
      status: 'active',
      joinedAt: 0,
      rating: num(v.rider.rating, 5),
      walletBalance: 0,
      tier: 'standard',
      saved: { others: [] },
      server: true,
    })
  }
  return out
}

export function vehicleFromServer(
  ve: { id: string; class?: VehicleClassId; vehicle_class?: VehicleClassId; make: string; model: string; year: number; color: string; plate_letters: string; plate_number: string },
  driverId: string,
): Vehicle {
  const letters = ve.plate_letters.toUpperCase()
  return {
    id: ve.id,
    make: ve.make,
    model: ve.model,
    year: ve.year,
    color: { ar: ve.color, en: ve.color },
    colorHex: COLOR_HEX[ve.color.toLowerCase()] ?? '#B9BCBE',
    plate: { digits: ve.plate_number, lettersEn: letters, lettersAr: letters.split('').map((l) => LATIN_TO_AR[l] ?? l).join(' ') },
    classId: (ve.class ?? ve.vehicle_class ?? 'go') as VehicleClassId,
    status: 'active',
    driverId,
    server: true,
  }
}
