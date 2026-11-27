/**
 * The ONLY place that reads build-time environment variables in browser code (C1, demo isolation).
 *
 * Each variable is read by its explicit name: `import.meta.env.VITE_X`. Vite replaces each such
 * reference with that one value. Reading the whole `import.meta.env` object instead would inline
 * EVERY exposed variable into the bundle, used or not. That is how a Supabase integration's
 * NEXT_PUBLIC_SUPABASE_URL / anon key ended up in DEMO bundles.
 *
 * Adding a variable: add it here and to PUBLIC_ENV_KEYS in ./publicEnvKeys.ts (tests/demoIsolation.test.ts
 * fails otherwise), and only if it is meant to be public. Anything here is visible to every visitor.
 * NEXT_PUBLIC_* variables reach the bundle only through vite.config.ts `define` (C2).
 */
export const PUBLIC_ENV = {
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
  VITE_AUTH_OTP_LENGTH: import.meta.env.VITE_AUTH_OTP_LENGTH as string | undefined,
  VITE_APP_ENV: import.meta.env.VITE_APP_ENV as string | undefined,
  VITE_AURA_PAYMENTS_MOCK_ONLY: import.meta.env.VITE_AURA_PAYMENTS_MOCK_ONLY as string | undefined,
  VITE_PAYMENT_PROVIDER: import.meta.env.VITE_PAYMENT_PROVIDER as string | undefined,
  VITE_MOYASAR_PUBLISHABLE_KEY: import.meta.env.VITE_MOYASAR_PUBLISHABLE_KEY as string | undefined,
  VITE_MAPS_PROVIDER: import.meta.env.VITE_MAPS_PROVIDER as string | undefined,
  VITE_GOOGLE_MAPS_API_KEY: import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined,
  VITE_GOOGLE_MAPS_MAP_ID: import.meta.env.VITE_GOOGLE_MAPS_MAP_ID as string | undefined,
  VITE_MAPBOX_ACCESS_TOKEN: import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string | undefined,
  NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN: import.meta.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN as string | undefined,
}

export type PublicEnvKey = keyof typeof PUBLIC_ENV
export { PUBLIC_ENV_KEYS } from './publicEnvKeys'
