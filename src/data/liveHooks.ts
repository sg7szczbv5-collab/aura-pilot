/**
 * Hooks that switch between the demo simulation and live Supabase data:
 *   useQuotes      upfront fares (server: request-ride dry run on the real route)
 *   useNearbyCars  cars on the rider map (server: anonymised nearby_vehicle_markers)
 *   useDriverGps   captain GPS → update_driver_location while online (server only)
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AUTH_MODE } from '../auth/config'
import { coarseForNearby } from '../location/riderLocation'
import { getSupabase } from '../auth/supabaseClient'
import { VEHICLE_CLASSES } from '../core/pricing'
import { nearbyAvailable, quoteTrip, store, useNow } from '../core/store'
import type { FareBreakdown, LatLng, Place, VehicleClassId } from '../core/types'
import { haversineKm } from '../core/geo'
import { quoteToFare, type QuoteRow } from './rideMapper'
import { invokeFunction, rideRequestBody } from './tripGateway'
import { setLive } from './serverMirror'

const SERVER = AUTH_MODE === 'supabase'

/* ---------- Quotes ---------- */

export type Quotes = {
  /** Fare per class. Local estimate until the server answers (supabase mode). */
  byClass: Record<VehicleClassId, FareBreakdown>
  /** True when the fares are the server's binding upfront prices. */
  exact: boolean
  loading: boolean
  error?: string
  /** Ask the server again (after an error). */
  retry: () => void
}

/** Server promo errors (compute_quote → eligible_promo) — the fix is to remove the code. */
export const isPromoError = (e?: string) => !!e && /promo/i.test(e)

const localQuotes = (pickup: Place, dropoff: Place, promo?: string) =>
  Object.fromEntries(VEHICLE_CLASSES.map((c) => [c.id, quoteTrip(pickup, dropoff, c.id, promo)])) as Record<VehicleClassId, FareBreakdown>

export function useQuotes(pickup: Place, dropoff: Place, promo: string | undefined, classId: VehicleClassId, lang: 'ar' | 'en'): Quotes {
  const local = useMemo(() => localQuotes(pickup, dropoff, promo), [pickup, dropoff, promo])
  const [server, setServer] = useState<{ key: string; byClass?: Record<VehicleClassId, FareBreakdown>; error?: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  // The selected class is part of the key: the server fails the whole quote only when
  // *that* class cannot be priced, so another class must be asked for again.
  const key = `${pickup.pos.lat},${pickup.pos.lng}|${dropoff.pos.lat},${dropoff.pos.lng}|${promo ?? ''}|${classId}|${attempt}`
  const retry = () => setAttempt((n) => n + 1)

  useEffect(() => {
    if (!SERVER) return
    let live = true
    const id = setTimeout(async () => {
      const { data, error } = await invokeFunction<{ route: { distanceM: number; durationS: number }; quotes: Record<string, QuoteRow> }>(
        'request-ride',
        rideRequestBody({ pickup, dropoff, classId, payment: 'cash', promoCode: promo, dryRun: true, lang }),
      )
      if (!live) return
      if (error || !data) return setServer({ key, error: error ?? 'network' })
      const byClass = { ...local }
      for (const [c, q] of Object.entries(data.quotes)) byClass[c as VehicleClassId] = quoteToFare(q, data.route, promo)
      setServer({ key, byClass })
    }, 200)
    return () => {
      live = false
      clearTimeout(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!SERVER) return { byClass: local, exact: true, loading: false, retry }
  const fresh = server?.key === key ? server : null
  return { byClass: fresh?.byClass ?? local, exact: !!fresh?.byClass, loading: !fresh, error: fresh?.error, retry }
}

/* ---------- Nearby cars ---------- */

export type NearbyCar = { id: string; pos: LatLng; heading: number; classId?: VehicleClassId }

export function useNearbyCars(center: LatLng, radiusKm = 6): NearbyCar[] {
  const now = useNow(SERVER ? 60_000 : 1000)
  const [remote, setRemote] = useState<NearbyCar[]>([])
  // F5: the server only needs ~100 m precision for this query; the ride request keeps full precision.
  const q = coarseForNearby(center)
  useEffect(() => {
    if (!SERVER) return
    let live = true
    const load = async () => {
      const { data } = await getSupabase().rpc('nearby_vehicle_markers', { p_lat: q.lat, p_lng: q.lng, p_radius_m: Math.round(radiusKm * 1000) })
      if (!live || !Array.isArray(data)) return
      setRemote(
        (data as { lat: number; lng: number; heading: number; vehicle_class: VehicleClassId }[]).map((r, i) => ({
          id: `near-${i}`,
          pos: { lat: r.lat, lng: r.lng },
          heading: r.heading,
          classId: r.vehicle_class,
        })),
      )
    }
    void load()
    const id = window.setInterval(load, 10_000)
    return () => {
      live = false
      window.clearInterval(id)
    }
  }, [q.lat, q.lng, radiusKm])
  const local = useMemo(
    () => (SERVER ? [] : nearbyAvailable(center, now, radiusKm).map((u) => ({ id: u.driverId, pos: u.pos, heading: u.heading, classId: u.classId }))),
    [center, now, radiusKm],
  )
  return SERVER ? remote : local
}

/** Minutes until the nearest car that can serve `classId` reaches `pickup`. */
export function etaFromCars(cars: NearbyCar[], pickup: LatLng, classId: VehicleClassId, factor = 1): number {
  const serves = (c?: VehicleClassId) => !c || c === classId || (classId === 'go' && c !== 'black') || (classId === 'comfort' && c === 'black')
  const kms = cars.filter((c) => serves(c.classId)).map((c) => haversineKm(c.pos, pickup))
  const km = kms.length ? Math.min(...kms) : 3
  return Math.max(2, Math.round((km / 30) * 60 * factor))
}

/* ---------- Captain GPS ---------- */

export type GpsState = 'off' | 'waiting' | 'live' | 'denied' | 'unsupported'

/** While online (supabase mode), stream the phone's GPS to the server every ~4 s / 25 m. */
export function useDriverGps(enabled: boolean): GpsState {
  const [state, setState] = useState<GpsState>('off')
  const last = useRef<{ at: number; lat: number; lng: number } | null>(null)

  useEffect(() => {
    if (!SERVER || !enabled) {
      setState('off')
      return
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState('unsupported')
      return
    }
    setState('waiting')
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const { latitude: lat, longitude: lng, heading, speed, accuracy } = p.coords
        const now = Date.now()
        const prev = last.current
        const moved = prev ? haversineKm({ lat, lng }, { lat: prev.lat, lng: prev.lng }) * 1000 : Infinity
        if (prev && now - prev.at < 4000 && moved < 25) return
        last.current = { at: now, lat, lng }
        setState('live')
        const h = heading !== null && !Number.isNaN(heading) ? heading : 0
        // Show the captain's own position immediately on their active trip.
        const active = store.state.trips.find((t) => t.server && t.driverId && ['driver_arriving', 'driver_arrived', 'in_progress', 'driver_assigned'].includes(t.status))
        if (active) setLive(active.id, lat, lng, h, now)
        void getSupabase().rpc('update_driver_location', {
          p_lat: lat,
          p_lng: lng,
          p_heading: h,
          p_speed_kmh: speed !== null && speed >= 0 ? speed * 3.6 : null,
          p_accuracy_m: accuracy ?? null,
        })
      },
      (e) => setState(e.code === e.PERMISSION_DENIED ? 'denied' : 'waiting'),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20_000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [enabled])

  return state
}
