/**
 * Server-side routing for pricing. Pure TypeScript (no Deno globals) so it is
 * unit-tested with vitest and imported by the Edge Functions.
 *
 * Google Routes API (computeRoutes) when GOOGLE_MAPS_SERVER_KEY is set;
 * otherwise a conservative straight-line estimate (mock mode).
 */
export type LatLng = { lat: number; lng: number }
export type RouteResult = {
  distanceM: number
  durationS: number
  polyline: string
  source: 'google' | 'estimate'
}

const R = 6371008.8 // mean Earth radius, metres

export function haversineM(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Google encoded polyline algorithm (precision 5). */
export function encodePolyline(points: LatLng[]): string {
  let out = ''
  let pLat = 0
  let pLng = 0
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1
    let s = ''
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63)
      n >>= 5
    }
    return s + String.fromCharCode(n + 63)
  }
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5)
    const lng = Math.round(p.lng * 1e5)
    out += enc(lat - pLat) + enc(lng - pLng)
    pLat = lat
    pLng = lng
  }
  return out
}

export function decodePolyline(str: string): LatLng[] {
  const pts: LatLng[] = []
  let i = 0
  let lat = 0
  let lng = 0
  const next = () => {
    let result = 0
    let shift = 0
    let b: number
    do {
      b = str.charCodeAt(i++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20 && i <= str.length)
    return result & 1 ? ~(result >> 1) : result >> 1
  }
  while (i < str.length) {
    lat += next()
    lng += next()
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 })
  }
  return pts
}

/** City driving without a routing provider: road factor 1.3, 30 km/h average. */
export function estimateRoute(a: LatLng, b: LatLng): RouteResult {
  const distanceM = Math.round(haversineM(a, b) * 1.3)
  return { distanceM, durationS: Math.round(distanceM / (30 / 3.6)), polyline: encodePolyline([a, b]), source: 'estimate' }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

/** Google Routes API v2 computeRoutes (traffic-aware driving). */
export async function googleRoute(a: LatLng, b: LatLng, key: string, fetchFn: FetchLike): Promise<RouteResult> {
  const res = await fetchFn('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: a.lat, longitude: a.lng } } },
      destination: { location: { latLng: { latitude: b.lat, longitude: b.lng } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      languageCode: 'ar',
      regionCode: 'SA',
      units: 'METRIC',
    }),
  })
  if (!res.ok) throw new Error(`routes_api_${res.status}`)
  const data = (await res.json()) as { routes?: { distanceMeters?: number; duration?: string; polyline?: { encodedPolyline?: string } }[] }
  const r = data.routes?.[0]
  if (!r || typeof r.distanceMeters !== 'number') throw new Error('routes_api_no_route')
  return {
    distanceM: r.distanceMeters,
    durationS: Math.round(parseFloat(String(r.duration ?? '0').replace('s', '')) || 0),
    polyline: r.polyline?.encodedPolyline ?? encodePolyline([a, b]),
    source: 'google',
  }
}

/** Google when configured; the estimate otherwise or if Google fails (pricing must not block). */
export async function routeBetween(a: LatLng, b: LatLng, opts: { googleKey?: string; fetch?: FetchLike }): Promise<RouteResult> {
  if (opts.googleKey && opts.fetch) {
    try {
      return await googleRoute(a, b, opts.googleKey, opts.fetch)
    } catch {
      /* fall through to estimate */
    }
  }
  return estimateRoute(a, b)
}
