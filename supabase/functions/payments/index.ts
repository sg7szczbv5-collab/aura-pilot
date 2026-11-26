/**
 * POST /functions/v1/payments   (Authorization: Bearer <rider JWT>)
 *   { action: 'save_card', token }                                  → save a tokenized card
 *   { action: 'authorize_ride', rideId, paymentMethodId | token }    → authorize the ride fare
 *   { action: 'topup', amountHalalas: "5000", paymentMethodId | token }
 *   { action: 'tip', rideId, amountHalalas: "1000", paymentMethodId | token }
 *   { action: 'sync', paymentId }                                    → after the 3-D Secure redirect
 * Amounts are strings of halalas (BigInt-safe). Raw card numbers never reach AURA:
 * the app tokenizes with Moyasar using the publishable key.
 *
 * Secrets: PAYMENT_PROVIDER (mock|moyasar), MOYASAR_SECRET_KEY, PAYMENT_CALLBACK_URL.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { corsHeaders, json } from '../_shared/http.ts'
import { handlePaymentAction } from '../_shared/payments/handlers.ts'
import { createPaymentsDb } from '../_shared/payments/db.ts'
import { getProvider } from '../_shared/payments/registry.ts'
import { guardedFetch, refusal, runtimeGuard } from '../_shared/ops/runtimeGuard.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  const env = (k: string) => Deno.env.get(k)
  const providerName = (env('PAYMENT_PROVIDER') ?? 'mock') as 'mock' | 'moyasar'

  const userClient = createClient(env('SUPABASE_URL') ?? '', env('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const admin = createClient(env('SUPABASE_URL') ?? '', env('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  // BETA / production guard (D3, C1): refuse before any provider call when the environment is not safe.
  const guard = await runtimeGuard(admin, env)
  if (!guard.ok) {
    const r = refusal(guard)
    return json(r.status, r.body)
  }
  const liveFetch = guardedFetch(guard, (u: string, i: { method: string; headers: Record<string, string>; body?: string }) => fetch(u, i))
  const { data } = await userClient.auth.getUser()

  const result = await handlePaymentAction(await req.json().catch(() => null), {
    userId: data.user?.id ?? null,
    provider: getProvider(providerName, env, liveFetch),
    db: createPaymentsDb(admin, providerName),
    callbackUrl: env('PAYMENT_CALLBACK_URL') ?? 'http://localhost:5180/#/passenger',
  })
  return json(result.status, result.body)
})
