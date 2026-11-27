/**
 * A2.2 — open the captain's current target in Google Maps or Waze.
 *
 * Target: the pickup until the rider is on board, then the drop-off. Only coordinates leave the app —
 * never the rider's name, phone, ride id or address text — and the links open in a new context with
 * noopener / noreferrer. Official universal URLs (they open the native app when it is installed):
 *   Google Maps: https://developers.google.com/maps/documentation/urls/get-started  (dir, api=1)
 *   Waze:        https://developers.google.com/waze/deeplinks                       (ul, ll, navigate=yes)
 */
import type { LatLng } from '../core/types'

export type NavApp = 'google' | 'waze'
export type NavLeg = 'pickup' | 'dropoff'

/** Statuses in which the captain is driving somewhere. Anything else has no navigation target. */
const TO_PICKUP = new Set(['driver_assigned', 'driver_arriving'])
const TO_DROPOFF = new Set(['in_progress'])

export function navTarget(trip: { status: string; pickup: { pos: LatLng }; dropoff: { pos: LatLng } }): { leg: NavLeg; pos: LatLng } | null {
  if (TO_PICKUP.has(trip.status)) return { leg: 'pickup', pos: trip.pickup.pos }
  if (TO_DROPOFF.has(trip.status)) return { leg: 'dropoff', pos: trip.dropoff.pos }
  return null
}

/** A real, finite coordinate pair (not 0,0, which is a "null island" placeholder, not a place). */
export function validCoords(p: LatLng | undefined): p is LatLng {
  if (!p) return false
  const { lat, lng } = p
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)
}

/** 6 decimals (≈ 0.1 m) without trailing zeros. */
const fmt = (n: number) => String(Number(n.toFixed(6)))

/** Deep link for the app, or null when the coordinates are not usable. */
export function navUrl(app: NavApp, p: LatLng): string | null {
  if (!validCoords(p)) return null
  const ll = `${fmt(p.lat)},${fmt(p.lng)}`
  if (app === 'google') return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(ll)}&travelmode=driving`
  return `https://waze.com/ul?ll=${encodeURIComponent(ll)}&navigate=yes`
}

/** iPhone / iPad (incl. iPadOS that reports itself as a Mac with touch). R1 warning applies there. */
export function isIOS(nav: { userAgent: string; maxTouchPoints?: number } | undefined = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  if (!nav) return false
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1)
}

/** Open the link without giving the other site a handle on this page. */
export function openNav(url: string, open: (u: string, t: string, f: string) => unknown = (u, t, f) => window.open(u, t, f)) {
  open(url, '_blank', 'noopener,noreferrer')
}
