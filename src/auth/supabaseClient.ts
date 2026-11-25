import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { AUTH_MODE, SUPABASE_ANON_KEY, SUPABASE_URL } from './config'

let client: SupabaseClient | null = null

/**
 * The browser Supabase client (anon key only; RLS protects every table).
 * Sessions persist in localStorage under `aura.auth`, refresh automatically, and
 * sign-out propagates to other tabs. PKCE is used for email links (password reset).
 */
export function getSupabase(): SupabaseClient {
  if (AUTH_MODE !== 'supabase' || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase is not configured (set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY)')
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
        storageKey: 'aura.auth',
      },
    })
  }
  return client
}
