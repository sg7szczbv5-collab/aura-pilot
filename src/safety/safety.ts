/**
 * Rider/captain safety actions.
 *   supabase : report_safety_incident (urgent ticket + audit), create_trip_share
 *              (anonymous, expiring live link → #/track/<token>)
 *   mock     : the demo ticket and a demo link
 */
import { AUTH_MODE } from '../auth/config'
import { getSupabase } from '../auth/supabaseClient'
import { actions } from '../core/store'
import type { LatLng } from '../core/types'

export type IncidentKind = 'sos' | 'unsafe_driving' | 'harassment' | 'accident' | 'route_deviation' | 'other'
export const SAUDI_EMERGENCY_NUMBER = '911'

export async function reportIncident(p: {
  rideId: string
  kind: IncidentKind
  pos?: LatLng
  note?: string
  reporter: { kind: 'customer' | 'driver'; id: string }
}): Promise<{ ok: boolean; ticketId?: string }> {
  if (AUTH_MODE !== 'supabase') {
    const t = actions.createTicket({
      requester: p.reporter,
      subject: p.kind === 'sos' ? 'SOS triggered' : `Safety report: ${p.kind}`,
      category: 'safety',
      priority: 'urgent',
      tripId: p.rideId,
      text: p.note ?? (p.kind === 'sos' ? 'SOS button pressed (demo).' : 'Safety report from the in-trip toolkit (demo).'),
    })
    return { ok: true, ticketId: t.id }
  }
  const { data, error } = await getSupabase().rpc('report_safety_incident', {
    p_ride_id: p.rideId,
    p_kind: p.kind,
    p_lat: p.pos?.lat ?? null,
    p_lng: p.pos?.lng ?? null,
    p_note: p.note ?? null,
  })
  return error ? { ok: false } : { ok: true, ticketId: data as string }
}

export const trackUrl = (token: string) =>
  typeof window === 'undefined' ? `#/track/${token}` : `${window.location.origin}${window.location.pathname}#/track/${token}`

/** A link anyone can open (no account) to follow the trip until shortly after it ends. */
export async function createShareLink(rideId: string): Promise<{ ok: true; url: string; expiresAt?: number } | { ok: false }> {
  if (AUTH_MODE !== 'supabase') return { ok: true, url: `https://aura.demo/t/${rideId}` }
  const { data, error } = await getSupabase().rpc('create_trip_share', { p_ride_id: rideId })
  const row = (Array.isArray(data) ? data[0] : data) as { token?: string; expires_at?: string } | null
  if (error || !row?.token) return { ok: false }
  return { ok: true, url: trackUrl(row.token), expiresAt: row.expires_at ? Date.parse(row.expires_at) : undefined }
}

export type SharedTrip = {
  ride_number: number
  status: string
  ended: boolean
  pickup: { address: string; lat: number; lng: number }
  dropoff: { address: string; lat: number; lng: number }
  captain: { first_name: string; rating: number | null } | null
  vehicle: { make: string; model: string; color: string; plate: string } | null
  location: { lat: number; lng: number; heading: number | null; at: string } | null
}

/** Public tracking page data (works signed out, with the anon key). */
export async function fetchSharedTrip(token: string): Promise<SharedTrip | null> {
  if (AUTH_MODE !== 'supabase' || !/^[0-9a-f]{64}$/.test(token)) return null
  const { data, error } = await getSupabase().rpc('trip_share_view', { p_token: token })
  return error ? null : ((data as SharedTrip | null) ?? null)
}
