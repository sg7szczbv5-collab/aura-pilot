/**
 * Allowlist of build-time variables the browser may see (C1/C2, demo isolation). Plain data, so
 * vite.config.ts (Node) and src/config/publicEnv.ts (browser) share it; a test keeps the two equal.
 * Only VITE_* reach the bundle by prefix; the NEXT_PUBLIC_* names below are passed explicitly via
 * `define`, so an integration's NEXT_PUBLIC_SUPABASE_* (or any other NEXT_PUBLIC_*) never does.
 */
export const PUBLIC_ENV_KEYS = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_AUTH_OTP_LENGTH',
  'VITE_APP_ENV',
  'VITE_AURA_PAYMENTS_MOCK_ONLY',
  'VITE_PAYMENT_PROVIDER',
  'VITE_MOYASAR_PUBLISHABLE_KEY',
  'VITE_MAPS_PROVIDER',
  'VITE_GOOGLE_MAPS_API_KEY',
  'VITE_GOOGLE_MAPS_MAP_ID',
  'VITE_MAPBOX_ACCESS_TOKEN',
  'NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN',
] as const

/** NEXT_PUBLIC_* the browser may see. Everything else with that prefix stays out of the bundle. */
export const NEXT_PUBLIC_ALLOWED = PUBLIC_ENV_KEYS.filter((k) => k.startsWith('NEXT_PUBLIC_'))

/** vite `define` entries for the allowed NEXT_PUBLIC_* (absent → undefined, never the whole env). */
export function nextPublicDefines(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(NEXT_PUBLIC_ALLOWED.map((k) => [`import.meta.env.${k}`, env[k] === undefined ? 'undefined' : JSON.stringify(env[k])]))
}
