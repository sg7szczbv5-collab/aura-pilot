/**
 * PaymentsDb over a Supabase service-role client. Money crosses PostgREST as
 * text so BigInt values never pass through a JS number.
 */
import type { PaymentRow, PaymentsDb, QueueItem } from './handlers.ts'

type Res = { data: unknown; error: { message: string } | null }
// Minimal structural type of the supabase-js client used here (keeps this file SDK-free and testable).
export type SupabaseLike = {
  // deno-lint-ignore no-explicit-any
  rpc(fn: string, args?: Record<string, unknown>): any
  // deno-lint-ignore no-explicit-any
  from(table: string): any
}

const ok = <T>(r: Res): T => {
  if (r.error) throw new Error(r.error.message)
  return r.data as T
}

const PAYMENT_COLS = 'id, kind, status, amount_halalas, provider_payment_id, ride_id, rider_id'

export function createPaymentsDb(admin: SupabaseLike, provider: 'moyasar' | 'hyperpay' | 'mock'): PaymentsDb & { queue(): Promise<QueueItem[]> } {
  return {
    async createIntent(a) {
      return ok<PaymentRow>(
        await admin
          .rpc('create_payment_intent', {
            p_rider_id: a.userId,
            p_kind: a.kind,
            p_ride_id: a.rideId,
            p_amount_halalas: a.amountHalalas === null ? null : a.amountHalalas.toString(),
            p_method_type: a.methodType,
            p_provider: provider,
            p_payment_method_id: a.paymentMethodId,
          })
          .single(),
      )
    },
    async record(a) {
      return ok<PaymentRow>(
        await admin
          .rpc('record_provider_payment', {
            p_payment_id: a.paymentId,
            p_status: a.status,
            p_provider_payment_id: a.providerPaymentId ?? null,
            p_amount_halalas: a.amountHalalas === undefined ? null : a.amountHalalas.toString(),
            p_failure_code: a.failureCode ?? null,
            p_failure_message: a.failureMessage ?? null,
            p_raw: a.raw ?? null,
          })
          .single(),
      )
    },
    async savedToken(paymentMethodId, userId) {
      return ok<string | null>(await admin.rpc('payment_method_token', { p_payment_method_id: paymentMethodId, p_rider_id: userId }))
    },
    async saveCard(a) {
      return ok<{ id: string }>(
        await admin
          .rpc('save_payment_method', {
            p_rider_id: a.userId,
            p_provider: provider,
            p_method_type: a.methodType,
            p_token: a.token,
            p_brand: a.brand,
            p_last4: a.last4,
            p_exp_month: a.month,
            p_exp_year: a.year,
            p_holder: a.name ?? null,
          })
          .single(),
      )
    },
    async getPayment(id) {
      return ok<PaymentRow | null>(await admin.from('payments').select(PAYMENT_COLS).eq('id', id).maybeSingle())
    },
    async queue() {
      return ok<QueueItem[]>(await admin.rpc('payment_work_queue', { p_limit: 100 }))
    },
  }
}
