/**
 * POST /functions/v1/privacy-worker   (header x-cron-secret: <PRIVACY_CRON_SECRET>)
 * Finishes PDPL erasures: removes the person's files from Storage and disables
 * their login. Schedule hourly.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { corsHeaders, json, safeEqual } from '../_shared/http.ts'
import { createCleanupDeps, runPrivacyCleanup, type StorageAdminLike } from '../_shared/privacy/cleanup.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const env = (k: string) => Deno.env.get(k)
  const secret = env('PRIVACY_CRON_SECRET') ?? ''
  if (!secret || !safeEqual(req.headers.get('x-cron-secret') ?? '', secret)) return json(401, { error: 'unauthorized' })

  const admin = createClient(env('SUPABASE_URL') ?? '', env('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return json(200, await runPrivacyCleanup(createCleanupDeps(admin as unknown as StorageAdminLike)))
})
