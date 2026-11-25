/**
 * POST /functions/v1/payments-webhook   (called by Moyasar; deploy with --no-verify-jwt)
 * The body's secret_token must equal MOYASAR_WEBHOOK_SECRET; the payment is then
 * re-fetched from Moyasar (the body itself is never trusted) and applied through
 * record_provider_payment, which is idempotent for retried deliveries.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { json } from '../_shared/http.ts'
import { handleWebhook } from '../_shared/payments/handlers.ts'
import { createPaymentsDb } from '../_shared/payments/db.ts'
import { getProvider } from '../_shared/payments/registry.ts'

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  const env = (k: string) => Deno.env.get(k)
  const providerName = (env('PAYMENT_PROVIDER') ?? 'mock') as 'mock' | 'moyasar'
  const admin = createClient(env('SUPABASE_URL') ?? '', env('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  try {
    const result = await handleWebhook(await req.json().catch(() => null), {
      provider: getProvider(providerName, env, (u, i) => fetch(u, i)),
      db: createPaymentsDb(admin, providerName),
    })
    return json(result.status, result.body)
  } catch {
    return json(500, { error: 'webhook_failed' }) // provider retries later
  }
})
