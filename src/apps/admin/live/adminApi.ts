/**
 * Admin console data access for Supabase (live) mode.
 *
 * Every read goes through RLS (admin_can(<permission>) + MFA), every write through
 * the existing SECURITY DEFINER RPCs or the column-limited admin policies, so the
 * database — not this file — decides what a staff member may see and do. Each
 * admin RPC writes the audit log through the table audit triggers.
 */
import { getSupabase } from '../../../auth/supabaseClient'

export type RideStatus = 'searching' | 'driver_assigned' | 'driver_arriving' | 'driver_arrived' | 'in_progress' | 'completed' | 'cancelled'
export const ACTIVE_STATUSES: RideStatus[] = ['searching', 'driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress']

export type Person = { id: string; full_name: string | null; phone: string | null }
export type RideRow = {
  id: string
  ride_number: number
  status: RideStatus
  vehicle_class: string
  rider_id: string
  driver_id: string | null
  pickup_address: string
  dropoff_address: string
  fare_total_halalas: number
  commission_halalas: number
  driver_net_halalas: number
  payment_method: string
  requested_at: string
  completed_at: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  cancellation_reason: string | null
}
export type RideEvent = { id: string; from_status: string | null; to_status: string; actor: string | null; note: string | null; created_at: string }
export type DriverRow = {
  id: string
  status: 'incomplete' | 'pending_review' | 'approved' | 'rejected' | 'suspended'
  is_online: boolean
  rating: number | null
  completed_rides: number
  acceptance_rate: number | null
  wasl_status: string
  status_reason: string | null
  created_at: string
  profile: Person | null
}
export type CustomerRow = { id: string; full_name: string | null; phone: string | null; email: string | null; is_blocked: boolean; blocked_reason: string | null; created_at: string; rating: number | null; completed_rides: number }
export type TicketRow = { id: string; ticket_number: number; opened_by: string; opener_kind: string; ride_id: string | null; category: string; priority: string; status: 'open' | 'pending' | 'resolved'; subject: string; created_at: string; resolved_at: string | null; opener: Person | null }
export type TicketMessage = { id: string; author_kind: string; body: string; is_internal: boolean; created_at: string }
export type PaymentRow = { id: string; kind: string; ride_id: string | null; rider_id: string; provider: string; method_type: string; amount_halalas: number; status: string; created_at: string }
export type PayoutRow = { id: string; driver_id: string; amount_halalas: number; status: string; requested_at: string; paid_at: string | null; failure_reason: string | null; driver: Person | null }
export type TariffRow = { id: string; city_id: string; vehicle_class: string; base_fare_halalas: number; per_km_halalas: number; per_min_halalas: number; min_fare_halalas: number; cancellation_fee_halalas: number; commission_bps: number; vat_bps: number; is_active: boolean; city: { code: string; name_ar: string; name_en: string } | null }
export type MapPoint = { driver_id: string; lat: number; lng: number; heading: number | null; is_available: boolean; vehicle_class: string; updated_at: string }

export type Result<T> = { data: T; error?: undefined } | { data?: undefined; error: string }

const msg = (e: { message?: string } | null | undefined) => (e?.message ?? 'network').replace(/^AURA:\s*/, '')
const ok = <T>(data: T): Result<T> => ({ data })
const fail = <T>(e: { message?: string } | null | undefined): Result<T> => ({ error: msg(e) })

/** Names / phones for a set of profile ids (one query, RLS: admins only). */
async function people(ids: (string | null | undefined)[]): Promise<Map<string, Person>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))]
  if (!uniq.length) return new Map()
  const { data } = await getSupabase().from('profiles').select('id, full_name, phone').in('id', uniq)
  return new Map((data ?? []).map((p) => [p.id as string, p as Person]))
}

/* ---------- Overview ---------- */

export type Overview = { active: number; searching: number; online: number; completedToday: number; grossToday: number; commissionToday: number; pendingApplications: number; openTickets: number }

export async function loadOverview(now = new Date()): Promise<Result<Overview>> {
  const sb = getSupabase()
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const count = (q: PromiseLike<{ count: number | null; error: { message: string } | null }>) => q
  const [active, searching, online, done, apps, tickets] = await Promise.all([
    count(sb.from('rides').select('id', { count: 'exact', head: true }).in('status', ACTIVE_STATUSES)),
    count(sb.from('rides').select('id', { count: 'exact', head: true }).eq('status', 'searching')),
    count(sb.from('drivers').select('id', { count: 'exact', head: true }).eq('is_online', true)),
    sb.from('rides').select('fare_total_halalas, commission_halalas').eq('status', 'completed').gte('completed_at', dayStart).limit(5000),
    count(sb.from('drivers').select('id', { count: 'exact', head: true }).eq('status', 'pending_review')),
    count(sb.from('tickets').select('id', { count: 'exact', head: true }).neq('status', 'resolved')),
  ])
  const firstError = [active, searching, online, done, apps, tickets].find((r) => r.error)?.error
  if (firstError) return fail(firstError)
  const rows = (done.data ?? []) as { fare_total_halalas: number; commission_halalas: number }[]
  return ok({
    active: active.count ?? 0,
    searching: searching.count ?? 0,
    online: online.count ?? 0,
    completedToday: rows.length,
    grossToday: rows.reduce((s, r) => s + (r.fare_total_halalas ?? 0), 0),
    commissionToday: rows.reduce((s, r) => s + (r.commission_halalas ?? 0), 0),
    pendingApplications: apps.count ?? 0,
    openTickets: tickets.count ?? 0,
  })
}

/* ---------- Trips ---------- */

const RIDE_COLS =
  'id, ride_number, status, vehicle_class, rider_id, driver_id, pickup_address, dropoff_address, fare_total_halalas, commission_halalas, driver_net_halalas, payment_method, requested_at, completed_at, cancelled_at, cancelled_by, cancellation_reason'

export async function loadRides(filter: 'active' | 'completed' | 'cancelled' | 'all', limit = 300): Promise<Result<{ rides: RideRow[]; people: Map<string, Person> }>> {
  let q = getSupabase().from('rides').select(RIDE_COLS).order('requested_at', { ascending: false }).limit(limit)
  if (filter === 'active') q = q.in('status', ACTIVE_STATUSES)
  else if (filter !== 'all') q = q.eq('status', filter)
  const { data, error } = await q
  if (error) return fail(error)
  const rides = (data ?? []) as RideRow[]
  return ok({ rides, people: await people(rides.flatMap((r) => [r.rider_id, r.driver_id])) })
}

export async function loadRideEvents(rideId: string): Promise<RideEvent[]> {
  const { data } = await getSupabase().from('ride_events').select('id, from_status, to_status, actor, note, created_at').eq('ride_id', rideId).order('created_at')
  return (data ?? []) as RideEvent[]
}

/** Admin cancellation (permission trips.cancel, checked by transition_ride). */
export async function cancelRide(rideId: string, reason: string): Promise<Result<true>> {
  const { error } = await getSupabase().rpc('transition_ride', { p_ride_id: rideId, p_to: 'cancelled', p_reason: reason })
  return error ? fail(error) : ok(true)
}

/* ---------- Captains ---------- */

export async function loadDrivers(filter: 'approved' | 'online' | 'suspended' | 'all'): Promise<Result<DriverRow[]>> {
  let q = getSupabase()
    .from('drivers')
    .select('id, status, is_online, rating, completed_rides, acceptance_rate, wasl_status, status_reason, created_at')
    .order('created_at', { ascending: false })
    .limit(500)
  if (filter === 'online') q = q.eq('is_online', true)
  else if (filter === 'suspended') q = q.in('status', ['suspended', 'rejected'])
  else if (filter === 'approved') q = q.eq('status', 'approved')
  const { data, error } = await q
  if (error) return fail(error)
  const rows = (data ?? []) as Omit<DriverRow, 'profile'>[]
  const ppl = await people(rows.map((r) => r.id))
  return ok(rows.map((r) => ({ ...r, profile: ppl.get(r.id) ?? null })))
}

/** Suspend / reactivate (drivers.suspend / drivers.approve, checked by admin_set_driver_status). */
export async function setDriverStatus(driverId: string, status: 'approved' | 'suspended', reason: string | null): Promise<Result<true>> {
  const { error } = await getSupabase().rpc('admin_set_driver_status', { p_driver_id: driverId, p_status: status, p_reason: reason })
  return error ? fail(error) : ok(true)
}

export async function loadDriverRides(driverId: string): Promise<RideRow[]> {
  const { data } = await getSupabase().from('rides').select(RIDE_COLS).eq('driver_id', driverId).order('requested_at', { ascending: false }).limit(50)
  return (data ?? []) as RideRow[]
}

/* ---------- Customers ---------- */

export async function loadCustomers(filter: 'all' | 'blocked'): Promise<Result<CustomerRow[]>> {
  let q = getSupabase()
    .from('profiles')
    .select('id, full_name, phone, email, is_blocked, blocked_reason, created_at')
    .eq('role', 'rider')
    .order('created_at', { ascending: false })
    .limit(500)
  if (filter === 'blocked') q = q.eq('is_blocked', true)
  const { data, error } = await q
  if (error) return fail(error)
  const profiles = (data ?? []) as Omit<CustomerRow, 'rating' | 'completed_rides'>[]
  const ids = profiles.map((p) => p.id)
  const { data: riders } = ids.length ? await getSupabase().from('riders').select('id, rating, completed_rides').in('id', ids) : { data: [] }
  const byId = new Map((riders ?? []).map((r) => [r.id as string, r as { rating: number | null; completed_rides: number }]))
  return ok(profiles.map((p) => ({ ...p, rating: byId.get(p.id)?.rating ?? null, completed_rides: byId.get(p.id)?.completed_rides ?? 0 })))
}

/** Block / unblock (customers.block, checked by admin_set_profile_blocked). */
export async function setCustomerBlocked(id: string, blocked: boolean, reason: string | null): Promise<Result<true>> {
  const { error } = await getSupabase().rpc('admin_set_profile_blocked', { p_profile_id: id, p_blocked: blocked, p_reason: reason })
  return error ? fail(error) : ok(true)
}

export async function loadRiderRides(riderId: string): Promise<RideRow[]> {
  const { data } = await getSupabase().from('rides').select(RIDE_COLS).eq('rider_id', riderId).order('requested_at', { ascending: false }).limit(50)
  return (data ?? []) as RideRow[]
}

/* ---------- Support ---------- */

export async function loadTickets(filter: 'open' | 'pending' | 'resolved' | 'all'): Promise<Result<TicketRow[]>> {
  let q = getSupabase()
    .from('tickets')
    .select('id, ticket_number, opened_by, opener_kind, ride_id, category, priority, status, subject, created_at, resolved_at')
    .order('created_at', { ascending: false })
    .limit(500)
  if (filter !== 'all') q = q.eq('status', filter)
  const { data, error } = await q
  if (error) return fail(error)
  const rows = (data ?? []) as Omit<TicketRow, 'opener'>[]
  const ppl = await people(rows.map((r) => r.opened_by))
  return ok(rows.map((r) => ({ ...r, opener: ppl.get(r.opened_by) ?? null })))
}

export async function loadTicketMessages(ticketId: string): Promise<TicketMessage[]> {
  const { data } = await getSupabase().from('ticket_messages').select('id, author_kind, body, is_internal, created_at').eq('ticket_id', ticketId).order('created_at')
  return (data ?? []) as TicketMessage[]
}

/** Agent reply or internal note (support.reply; author kind is set by the database). */
export async function replyTicket(ticketId: string, authorId: string, body: string, internal: boolean): Promise<Result<true>> {
  const { error } = await getSupabase().from('ticket_messages').insert({ ticket_id: ticketId, author_id: authorId, body: body.trim(), is_internal: internal })
  return error ? fail(error) : ok(true)
}

export async function updateTicket(ticketId: string, patch: { status?: TicketRow['status']; priority?: string }): Promise<Result<true>> {
  const { error } = await getSupabase().from('tickets').update(patch).eq('id', ticketId)
  return error ? fail(error) : ok(true)
}

/* ---------- Finance ---------- */

export async function loadFinance(): Promise<Result<{ health: Record<string, unknown> | null; payments: PaymentRow[]; payouts: PayoutRow[] }>> {
  const sb = getSupabase()
  const [h, p, o] = await Promise.all([
    sb.rpc('ledger_health'),
    sb.from('payments').select('id, kind, ride_id, rider_id, provider, method_type, amount_halalas, status, created_at').order('created_at', { ascending: false }).limit(300),
    sb.from('payouts').select('id, driver_id, amount_halalas, status, requested_at, paid_at, failure_reason').order('requested_at', { ascending: false }).limit(300),
  ])
  if (p.error) return fail(p.error)
  if (o.error) return fail(o.error)
  const payouts = (o.data ?? []) as Omit<PayoutRow, 'driver'>[]
  const ppl = await people(payouts.map((x) => x.driver_id))
  return ok({ health: (h.data as Record<string, unknown> | null) ?? null, payments: (p.data ?? []) as PaymentRow[], payouts: payouts.map((x) => ({ ...x, driver: ppl.get(x.driver_id) ?? null })) })
}

export async function setPayoutStatus(id: string, status: 'approved' | 'cancelled' | 'failed', reason: string | null): Promise<Result<true>> {
  const { error } = await getSupabase().rpc('admin_set_payout_status', { p_payout_id: id, p_status: status, p_reason: reason })
  return error ? fail(error) : ok(true)
}

export async function createPayoutBatch(): Promise<Result<number>> {
  const { data, error } = await getSupabase().rpc('create_payout_batch')
  return error ? fail(error) : ok(Number(data ?? 0))
}

/* ---------- Pricing ---------- */

export async function loadTariffs(): Promise<Result<TariffRow[]>> {
  const { data, error } = await getSupabase()
    .from('tariffs')
    .select('id, city_id, vehicle_class, base_fare_halalas, per_km_halalas, per_min_halalas, min_fare_halalas, cancellation_fee_halalas, commission_bps, vat_bps, is_active, city:cities(code, name_ar, name_en)')
    .order('vehicle_class')
  return error ? fail(error) : ok((data ?? []) as unknown as TariffRow[])
}

export type TariffPatch = Pick<TariffRow, 'base_fare_halalas' | 'per_km_halalas' | 'per_min_halalas' | 'min_fare_halalas' | 'cancellation_fee_halalas' | 'commission_bps'>

/** pricing.edit (RLS policy tariffs_admin_write); the database checks the value ranges. */
export async function updateTariff(id: string, patch: TariffPatch): Promise<Result<true>> {
  const { error } = await getSupabase().from('tariffs').update(patch).eq('id', id)
  return error ? fail(error) : ok(true)
}

/* ---------- Live map ---------- */

export async function loadMap(): Promise<Result<MapPoint[]>> {
  // Captains seen in the last 10 minutes (RLS: livemap.view).
  const since = new Date(Date.now() - 10 * 60_000).toISOString()
  const { data, error } = await getSupabase().from('driver_locations').select('driver_id, lat, lng, heading, is_available, vehicle_class, updated_at').gte('updated_at', since).limit(2000)
  return error ? fail(error) : ok((data ?? []) as MapPoint[])
}

/* ---------- Staff ---------- */

export async function loadStaff(): Promise<Result<{ id: string; full_name: string | null; phone: string | null; email: string | null; admin_role: string | null; is_blocked: boolean }[]>> {
  const { data, error } = await getSupabase().from('profiles').select('id, full_name, phone, email, admin_role, is_blocked').eq('role', 'admin').order('full_name')
  return error ? fail(error) : ok((data ?? []) as never)
}

/** SAR from halalas, 2 decimals. */
export const sar = (h: number | null | undefined) => ((h ?? 0) / 100).toFixed(2)
