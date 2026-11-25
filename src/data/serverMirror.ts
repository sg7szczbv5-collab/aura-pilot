/**
 * Supabase → local store mirror (supabase mode only).
 *
 * The existing screens render from the local store. In supabase mode the store
 * becomes a cache of the server: rides arrive through Realtime (postgres_changes,
 * filtered by RLS), each change is re-read through public.ride_view, mapped, and
 * merged with `server: true` so the demo simulator never touches it.
 * The captain's live position streams from driver_locations (lat/lng columns).
 */
import type { RealtimeChannel } from '@supabase/supabase-js'
import { getSupabase } from '../auth/supabaseClient'
import { store } from '../core/store'
import { isActive } from '../core/trip'
import type { CityId, Customer, Driver, DriverDoc, Trip } from '../core/types'
import { rideViewCounterparts, rideViewToTrip, vehicleFromServer, type RideViewJson } from './rideMapper'

type App = 'rider' | 'driver'
const state: { app?: App; uid?: string; trackedDriver?: string; locChannel?: RealtimeChannel | null } = {}

/* ---------- Rider pickup code (issued once per ride, kept for this browser session) ---------- */
const CODES = 'aura.rideCodes'
const readCodes = (): Record<string, string> => {
  try {
    return JSON.parse(sessionStorage.getItem(CODES) ?? '{}')
  } catch {
    return {}
  }
}
const saveCode = (rideId: string, code: string) => {
  try {
    sessionStorage.setItem(CODES, JSON.stringify({ ...readCodes(), [rideId]: code }))
  } catch {
    /* noop */
  }
}

async function riderCode(trip: Trip): Promise<string> {
  if (!['driver_assigned', 'driver_arriving', 'driver_arrived'].includes(trip.status)) return ''
  const cached = readCodes()[trip.id]
  if (cached) return cached
  const { data, error } = await getSupabase().rpc('issue_ride_verification_code', { p_ride_id: trip.id })
  if (error || typeof data !== 'string') return ''
  saveCode(trip.id, data)
  return data
}

/** Re-read one ride from the server and merge it into the store. */
export async function refreshRide(rideId: string): Promise<Trip | null> {
  const { data, error } = await getSupabase().rpc('ride_view', { p_ride_id: rideId })
  if (error || !data) return null
  const view = data as RideViewJson
  const trip = rideViewToTrip(view)
  if (state.app === 'rider' && view.viewer === 'rider') trip.otp = await riderCode(trip)
  const local = store.state.trips.find((t) => t.id === trip.id)
  if (local?.live && trip.live && local.live.at > trip.live.at) trip.live = local.live // keep the fresher Realtime fix
  const extra = rideViewCounterparts(view)
  store.mergeServer({ trips: [trip], ...extra })
  if (state.app === 'rider') trackDriver(isActive(trip.status) && trip.driverId ? trip.driverId : undefined, trip.id)
  return trip
}

/** Rider: follow the captain's GPS while the ride is active. */
function trackDriver(driverId: string | undefined, rideId: string) {
  if (state.trackedDriver === driverId) return
  const sb = getSupabase()
  if (state.locChannel) void sb.removeChannel(state.locChannel)
  state.locChannel = null
  state.trackedDriver = driverId
  if (!driverId) return
  state.locChannel = sb
    .channel(`aura-loc-${driverId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_locations', filter: `driver_id=eq.${driverId}` }, (p) => {
      const row = p.new as { lat?: number; lng?: number; heading?: number | string | null; updated_at?: string }
      if (typeof row.lat !== 'number' || typeof row.lng !== 'number') return
      setLive(rideId, row.lat, row.lng, Number(row.heading ?? 0), Date.parse(row.updated_at ?? '') || Date.now())
    })
    .subscribe()
}

/** Update the live position of a ride in the store (Realtime, or the captain's own GPS). */
export function setLive(rideId: string, lat: number, lng: number, heading: number, at = Date.now()) {
  const t = store.state.trips.find((x) => x.id === rideId)
  if (!t || !t.server) return
  store.mergeServer({ trips: [{ ...t, live: { pos: { lat, lng }, heading, at } }] })
}

/* ---------- Own account ---------- */

/** Rider: profile → local Customer with id = auth user id. */
export async function syncRiderSelf(uid: string): Promise<Customer | null> {
  const sb = getSupabase()
  const [{ data: p }, { data: r }, { data: w }] = await Promise.all([
    sb.from('profiles').select('full_name, phone, created_at, is_blocked').eq('id', uid).maybeSingle(),
    sb.from('riders').select('rating').eq('id', uid).maybeSingle(),
    sb.from('wallet_accounts').select('balance_halalas').eq('owner_id', uid).eq('account_type', 'rider_wallet').maybeSingle(),
  ])
  if (!p) return null
  const existing = store.state.customers.find((c) => c.id === uid)
  const name = p.full_name ?? ''
  const c: Customer = {
    id: uid,
    name: { ar: name, en: name },
    phone: p.phone ?? '',
    cityId: existing?.cityId ?? 'riyadh',
    status: p.is_blocked ? 'blocked' : 'active',
    joinedAt: Date.parse(p.created_at) || Date.now(),
    rating: Number(r?.rating ?? 5),
    walletBalance: Number(w?.balance_halalas ?? 0),
    tier: existing?.tier ?? 'standard',
    saved: existing?.saved ?? { others: [] },
    server: true,
  }
  store.mergeServer({ customers: [c] })
  return c
}

export type ServerDocRow = { doc_type: string; status: 'uploaded' | 'approved' | 'rejected' | 'expired'; expires_at: string | null; rejection_reason: string | null }
const DOC_ID: Record<string, DriverDoc['id']> = {
  national_id: 'national_id',
  driving_license: 'license',
  profile_photo: 'photo',
  vehicle_registration: 'registration',
  vehicle_insurance: 'insurance',
}

/** Latest server document per type → the app's document list (expired shows as rejected with a note). */
export function docsFromServer(rows: ServerDocRow[]): DriverDoc[] {
  const latest = new Map<DriverDoc['id'], ServerDocRow>()
  for (const r of rows) {
    const id = DOC_ID[r.doc_type]
    if (id) latest.set(id, r) // rows arrive oldest first
  }
  return (['national_id', 'license', 'photo', 'registration', 'insurance'] as DriverDoc['id'][]).map((id) => {
    const r = latest.get(id)
    if (!r) return { id, status: 'missing' }
    return {
      id,
      status: r.status === 'expired' ? 'rejected' : r.status,
      expires: r.expires_at ?? undefined,
      note: r.status === 'expired' ? 'expired' : (r.rejection_reason ?? undefined),
    }
  })
}

/** Captain: drivers row (+ vehicle) → local Driver with id = auth user id. Null if not a captain on the server. */
export async function syncDriverSelf(uid: string): Promise<Driver | null> {
  const sb = getSupabase()
  const { data: d } = await sb
    .from('drivers')
    .select('status, is_online, rating, ratings_count, acceptance_rate, current_vehicle_id, created_at, status_reason, cities(code)')
    .eq('id', uid)
    .maybeSingle()
  if (!d) return null
  const [{ data: p }, { data: ve }, { data: docRows }] = await Promise.all([
    sb.from('profiles').select('full_name, phone, email').eq('id', uid).maybeSingle(),
    d.current_vehicle_id
      ? sb.from('vehicles').select('id, vehicle_class, make, model, year, color, plate_letters, plate_number').eq('id', d.current_vehicle_id).maybeSingle()
      : Promise.resolve({ data: null }),
    sb.from('driver_documents').select('doc_type, status, expires_at, rejection_reason, created_at').eq('driver_id', uid).order('created_at'),
  ])
  const existing = store.state.drivers.find((x) => x.id === uid)
  const name = p?.full_name ?? ''
  const city = (d.cities as unknown as { code?: string } | null)?.code as CityId | undefined
  const driver: Driver = {
    id: uid,
    name: { ar: name, en: name },
    phone: p?.phone ?? '',
    nationalId: '',
    email: p?.email ?? undefined,
    cityId: city ?? 'riyadh',
    status: d.status === 'approved' || d.status === 'pending_review' || d.status === 'rejected' || d.status === 'suspended' ? d.status : 'incomplete',
    rejectionReason: d.status_reason ?? undefined,
    online: d.is_online,
    rating: Number(d.rating ?? 5),
    ratingsCount: d.ratings_count ?? 0,
    joinedAt: Date.parse(d.created_at) || Date.now(),
    vehicleId: ve?.id,
    docs: docRows?.length ? docsFromServer(docRows as ServerDocRow[]) : (existing?.docs ?? []),
    acceptanceRate: d.acceptance_rate === null ? 1 : Number(d.acceptance_rate) / 100,
    cancellationRate: existing?.cancellationRate ?? 0,
    punctuality: existing?.punctuality ?? 1,
    appUser: true,
    server: true,
  }
  store.mergeServer({ drivers: [driver], vehicles: ve ? [vehicleFromServer(ve, uid)] : [] })
  return driver
}

/* ---------- Subscriptions ---------- */

/**
 * Start mirroring this user's rides. Returns a stop function.
 * Realtime delivers changes (RLS applies); a 15 s poll of active rides covers gaps.
 */
export function startRideSync(app: App, uid: string): () => void {
  const sb = getSupabase()
  state.app = app
  state.uid = uid
  const refresh = (id?: string) => id && void refreshRide(id)
  const onChange = (p: { new: Record<string, unknown>; old: Record<string, unknown> }) =>
    refresh((p.new?.id as string | undefined) ?? (p.old?.id as string | undefined))

  // Initial load: recent rides (RLS returns only this user's).
  void sb
    .from('rides')
    .select('id')
    .order('requested_at', { ascending: false })
    .limit(10)
    .then(({ data }) => data?.forEach((r) => refresh(r.id as string)))

  let ch = sb.channel(`aura-rides-${app}-${uid}`)
  if (app === 'rider') {
    ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: 'rides', filter: `rider_id=eq.${uid}` }, onChange)
  } else {
    ch = ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rides', filter: `driver_id=eq.${uid}` }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rides', filter: `offered_driver_id=eq.${uid}` }, onChange)
  }
  ch.subscribe()

  const poll = window.setInterval(() => {
    store.state.trips.filter((t) => t.server && (isActive(t.status) || t.offer)).forEach((t) => refresh(t.id))
    if (app === 'driver') void syncDriverSelf(uid)
  }, 15_000)

  return () => {
    window.clearInterval(poll)
    void sb.removeChannel(ch)
    if (state.locChannel) void sb.removeChannel(state.locChannel)
    state.locChannel = null
    state.trackedDriver = undefined
  }
}

/** Sign-out: forget the mirrored server data in this browser. */
export function clearServerMirror() {
  try {
    sessionStorage.removeItem(CODES)
  } catch {
    /* noop */
  }
  store.dropServer()
}
