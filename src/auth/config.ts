/**
 * Auth configuration. AURA runs in one of two modes:
 *   supabase : VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY are set → real Supabase Auth
 *              (phone OTP for riders/captains, email + password + TOTP MFA for staff).
 *   mock     : no keys → the existing demo accounts and codes, with the same
 *              lockout/session rules, so the whole flow is testable offline.
 */
const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}

export type AuthMode = 'supabase' | 'mock'

export const SUPABASE_URL = env.VITE_SUPABASE_URL?.trim() || undefined
export const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY?.trim() || undefined

const placeholder = (v?: string) => !v || v.includes('your-project-ref') || v.includes('your-anon')

export const AUTH_MODE: AuthMode = !placeholder(SUPABASE_URL) && !placeholder(SUPABASE_ANON_KEY) ? 'supabase' : 'mock'

/** Supabase SMS OTP length (Auth → Providers → Phone). Demo codes are 4 digits. */
export const OTP_LENGTH = AUTH_MODE === 'supabase' ? Number(env.VITE_AUTH_OTP_LENGTH ?? 6) : 4

export const AUTH_POLICY = {
  /** Wrong OTP / password attempts before a temporary lock. */
  maxAttempts: 5,
  /** Lock duration after too many failures. */
  lockMs: 10 * 60_000,
  /** Failures older than this are forgotten. */
  windowMs: 15 * 60_000,
  /** Minimum gap between two SMS codes to the same number. */
  resendMs: 30_000,
}

export const ADMIN_SESSION_POLICY = {
  /** Absolute lifetime of a staff session, regardless of activity. */
  maxAgeMs: 12 * 60 * 60_000,
  /** Warning shown before an idle sign-out. */
  warnBeforeMs: 60_000,
  /** Fallback idle limit when settings are unavailable (Settings → Security → session minutes). */
  defaultIdleMinutes: 30,
}
