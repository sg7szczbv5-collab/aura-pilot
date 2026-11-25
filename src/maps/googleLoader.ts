import { GOOGLE_MAPS_KEY } from './config'

let loading: Promise<typeof google> | null = null

/**
 * Loads the Google Maps JavaScript API once (marker, places and geocoding libraries).
 * The browser key must be restricted to your domains (HTTP referrers) and to the
 * Maps JavaScript + Places APIs in Google Cloud Console.
 */
export function loadGoogleMaps(lang: 'ar' | 'en' = 'ar'): Promise<typeof google> {
  if (typeof window === 'undefined' || !GOOGLE_MAPS_KEY) return Promise.reject(new Error('google_maps_not_configured'))
  const w = window as Window & { google?: typeof google; __auraGmapsReady?: () => void }
  if (w.google?.maps?.Map) return Promise.resolve(w.google)
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      w.__auraGmapsReady = () => (w.google ? resolve(w.google) : reject(new Error('google_maps_missing')))
      const s = document.createElement('script')
      const q = new URLSearchParams({
        key: GOOGLE_MAPS_KEY,
        v: 'weekly',
        loading: 'async',
        libraries: 'marker,places,geocoding',
        language: lang,
        region: 'SA',
        callback: '__auraGmapsReady',
      })
      s.src = `https://maps.googleapis.com/maps/api/js?${q.toString()}`
      s.async = true
      s.onerror = () => {
        loading = null
        reject(new Error('google_maps_load_failed'))
      }
      document.head.appendChild(s)
    })
  }
  return loading
}
