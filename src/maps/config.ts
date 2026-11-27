/**
 * Maps configuration.
 *   google : VITE_MAPS_PROVIDER=google and VITE_GOOGLE_MAPS_API_KEY set → Google Maps
 *            JavaScript API (map, Places autocomplete, reverse geocoding).
 *   mock   : the built-in offline vector map of Riyadh (src/map/CityMap.tsx).
 * Server-side routing/pricing uses GOOGLE_MAPS_SERVER_KEY in the Edge Functions.
 */
import { PUBLIC_ENV } from '../config/publicEnv'

// C1: explicit, allowlisted variables only (src/config/publicEnv.ts) — never the whole import.meta.env.
const env: Record<string, string | undefined> = PUBLIC_ENV

export const GOOGLE_MAPS_KEY = env.VITE_GOOGLE_MAPS_API_KEY?.trim() || undefined
/** Vector map id (Cloud Console → Map Management). DEMO_MAP_ID works for development. */
export const GOOGLE_MAP_ID = env.VITE_GOOGLE_MAPS_MAP_ID?.trim() || 'DEMO_MAP_ID'
export type MapsProvider = 'google' | 'mock'
export const MAPS_PROVIDER: MapsProvider = env.VITE_MAPS_PROVIDER === 'google' && GOOGLE_MAPS_KEY ? 'google' : 'mock'

/**
 * CityMap expresses zoom as pixels per kilometre; Google uses zoom levels.
 * At zoom z a 256-px world tile covers the equator, so px/km = 256·2^z / (C·cos φ).
 */
const EARTH_CIRCUMFERENCE_KM = 40075.016
export function pxPerKmToGoogleZoom(pxPerKm: number, lat: number): number {
  const z = Math.log2((pxPerKm * EARTH_CIRCUMFERENCE_KM * Math.cos((lat * Math.PI) / 180)) / 256)
  return Math.min(21, Math.max(3, Math.round(z * 10) / 10))
}
export function googleZoomToPxPerKm(zoom: number, lat: number): number {
  return (256 * 2 ** zoom) / (EARTH_CIRCUMFERENCE_KM * Math.cos((lat * Math.PI) / 180))
}
