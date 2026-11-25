/**
 * Place search + reverse geocoding.
 *   google : Places API (New) autocomplete with a session token, Geocoder for pins
 *   mock   : the curated Riyadh places in src/core/geo.ts
 * Google suggestions have no coordinates until resolved (one billed details call
 * per chosen place, ending the autocomplete session).
 */
import { PLACES, pinPlace } from '../core/geo'
import type { LatLng, Place } from '../core/types'
import { MAPS_PROVIDER } from './config'
import { loadGoogleMaps } from './googleLoader'

export const GOOGLE_PLACE_PREFIX = 'gplace:'
export const isUnresolved = (p: Place) => p.id.startsWith(GOOGLE_PLACE_PREFIX) && !Number.isFinite(p.pos.lat)

/** Offline search over curated places (+ extra places such as saved home/work). */
export function searchLocal(q: string, extra: Place[] = []): Place[] {
  const raw = q.trim()
  const s = raw.toLowerCase()
  if (!s) return []
  return [...PLACES, ...extra].filter(
    (p) => p.name.ar.includes(raw) || p.name.en.toLowerCase().includes(s) || p.sub.en.toLowerCase().includes(s) || p.sub.ar.includes(raw),
  )
}

let session: google.maps.places.AutocompleteSessionToken | null = null

export async function searchPlaces(q: string, near: LatLng, lang: 'ar' | 'en', extra: Place[] = []): Promise<Place[]> {
  if (MAPS_PROVIDER !== 'google' || q.trim().length < 2) return searchLocal(q, extra)
  const g = await loadGoogleMaps(lang)
  const { AutocompleteSuggestion, AutocompleteSessionToken } = (await g.maps.importLibrary('places')) as google.maps.PlacesLibrary
  session ??= new AutocompleteSessionToken()
  const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
    input: q.trim(),
    sessionToken: session,
    language: lang,
    region: 'sa',
    includedRegionCodes: ['sa'],
    locationBias: { center: near, radius: 30_000 },
  })
  const saved = searchLocal(q, extra).filter((p) => extra.includes(p))
  const remote = suggestions
    .map((s) => s.placePrediction)
    .filter((p): p is google.maps.places.PlacePrediction => !!p)
    .slice(0, 8)
    .map<Place>((p) => {
      const main = p.mainText?.text ?? p.text.text
      const sub = p.secondaryText?.text ?? ''
      return { id: `${GOOGLE_PLACE_PREFIX}${p.placeId}`, name: { ar: main, en: main }, sub: { ar: sub, en: sub }, pos: { lat: NaN, lng: NaN }, kind: 'pin' }
    })
  return [...saved, ...remote]
}

/** Fill in coordinates for a Google suggestion (no-op for local places). */
export async function resolvePlace(p: Place, lang: 'ar' | 'en'): Promise<Place> {
  if (!isUnresolved(p)) return p
  const g = await loadGoogleMaps(lang)
  const { Place: GPlace } = (await g.maps.importLibrary('places')) as google.maps.PlacesLibrary
  const place = new GPlace({ id: p.id.slice(GOOGLE_PLACE_PREFIX.length), requestedLanguage: lang })
  await place.fetchFields({ fields: ['location', 'displayName', 'formattedAddress'] })
  session = null // a details call ends the autocomplete session
  const loc = place.location
  if (!loc) throw new Error('place_has_no_location')
  const name = place.displayName ?? p.name.ar
  const sub = place.formattedAddress ?? p.sub.ar
  return { ...p, name: { ar: name, en: name }, sub: { ar: sub, en: sub }, pos: { lat: loc.lat(), lng: loc.lng() } }
}

/** Name a dropped pin. */
export async function reverseGeocode(pos: LatLng, lang: 'ar' | 'en'): Promise<Place> {
  const fallback = pinPlace(pos)
  if (MAPS_PROVIDER !== 'google') return fallback
  try {
    const g = await loadGoogleMaps(lang)
    const { Geocoder } = (await g.maps.importLibrary('geocoding')) as google.maps.GeocodingLibrary
    const { results } = await new Geocoder().geocode({ location: pos, language: lang, region: 'SA' })
    const r = results[0]
    if (!r) return fallback
    const short = r.address_components.slice(0, 2).map((c) => c.long_name).join('، ')
    return { ...fallback, name: { ar: short || r.formatted_address, en: short || r.formatted_address }, sub: { ar: r.formatted_address, en: r.formatted_address } }
  } catch {
    return fallback
  }
}
