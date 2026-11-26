/**
 * Production identity binding for preflight / Deploy (mirrors supabase/functions/_shared/ops/runtimeGuard.ts;
 * a test keeps the two constants equal).
 *
 * UNVERIFIED on purpose: null until a human confirms the production project ref in the Supabase
 * dashboard (never from supabase/.temp). While null, `--target production` is a blocker, so a
 * production deploy cannot start. It is a constant in reviewed code, never an environment
 * variable, so BETA settings cannot switch production on.
 */
export const PROD_PROJECT_REF: string | null = null

/** `https://<ref>.supabase.co` → ref; anything else → null. */
export function projectRefFromUrl(url: string | undefined): string | null {
  if (!url) return null
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url.trim())
  return m ? m[1] : null
}
