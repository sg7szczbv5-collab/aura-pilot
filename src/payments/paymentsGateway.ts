/**
 * Payments for the rider and captain apps.
 *   mock     : the demo store (wallet credit, tips inside ratings) + cards kept in this browser
 *   supabase : payments Edge Function (cards, top-ups, card tips, 3-D Secure sync) and
 *              RPCs (wallet tips, statements, payouts). All money is BigInt halalas.
 */
import { AUTH_MODE } from '../auth/config'
import { getSupabase } from '../auth/supabaseClient'
import { actions, store } from '../core/store'
import { toHalalas, type Halalas } from '../money/halalas'
import { invokeFunction } from '../data/tripGateway'
import { refreshRide } from '../data/serverMirror'
import { tokenizeCard, type CardInput } from './cards'

export type CardView = { id: string; brand: string; last4: string; month: number; year: number; isDefault: boolean; methodType: 'mada' | 'card' }
export type WalletEntry = { id: string; at: number; type: string; amount: Halalas; description?: string }
export type WalletView = { balance: Halalas; entries: WalletEntry[] }
export type PayResult = { ok: true; status: string; transactionUrl?: string; paymentId?: string } | { ok: false; error: string }
export type Statement = {
  rides: number
  gross: Halalas
  commission: Halalas
  earnings: Halalas
  tips: Halalas
  cashCollected: Halalas
  cashDeposited: Halalas
  paidOut: Halalas
  balance: Halalas
  openPayout: { status: string; amount: Halalas } | null
}

export interface PaymentsGateway {
  readonly mode: 'mock' | 'supabase'
  listCards(riderId: string): Promise<CardView[]>
  addCard(riderId: string, card: CardInput): Promise<{ ok: true; card: CardView } | { ok: false; error: string; verificationUrl?: string; token?: string }>
  confirmCard(riderId: string, token: string): Promise<{ ok: true; card: CardView } | { ok: false; error: string }>
  setDefaultCard(riderId: string, id: string): Promise<void>
  removeCard(riderId: string, id: string): Promise<void>
  wallet(ownerId: string, type: 'rider_wallet' | 'driver_wallet'): Promise<WalletView>
  topUp(riderId: string, amount: Halalas, cardId: string): Promise<PayResult>
  tip(rideId: string, amount: Halalas, via: { wallet: true } | { cardId: string }): Promise<PayResult>
  sync(paymentId: string): Promise<PayResult>
  driverStatement(from: Date): Promise<Statement | null>
  requestPayout(amount: Halalas): Promise<PayResult>
}

export const callbackUrl = () =>
  typeof window === 'undefined' ? 'http://localhost:5180/#/passenger' : `${window.location.origin}${window.location.pathname}#/passenger`

const errText = (e?: string) => (e ?? 'network').replace(/^AURA:\s*/, '')

/* ============================== MOCK ============================== */

const CARDS_KEY = 'aura.cards.v1'
const readCards = (): Record<string, CardView[]> => {
  try {
    return JSON.parse(localStorage.getItem(CARDS_KEY) ?? '{}')
  } catch {
    return {}
  }
}
const writeCards = (v: Record<string, CardView[]>) => {
  try {
    localStorage.setItem(CARDS_KEY, JSON.stringify(v))
  } catch {
    /* noop */
  }
}

const mockGateway: PaymentsGateway = {
  mode: 'mock',
  async listCards(riderId) {
    return readCards()[riderId] ?? []
  },
  async addCard(riderId, card) {
    const t = await tokenizeCard(card, callbackUrl())
    if (!t.ok) return { ok: false, error: t.error }
    return this.confirmCard(riderId, t.token)
  },
  async confirmCard(riderId, token) {
    const all = readCards()
    const mine = all[riderId] ?? []
    const last4 = /(\d{4})$/.exec(token)?.[1] ?? '0000'
    const view: CardView = {
      id: `card-${Date.now().toString(36)}`,
      brand: last4.startsWith('4') ? 'visa' : last4.startsWith('5') ? 'mastercard' : 'mada',
      last4,
      month: 12,
      year: new Date().getFullYear() + 3,
      isDefault: mine.length === 0,
      methodType: 'card',
    }
    all[riderId] = [...mine, view]
    writeCards(all)
    return { ok: true, card: view }
  },
  async setDefaultCard(riderId, id) {
    const all = readCards()
    all[riderId] = (all[riderId] ?? []).map((c) => ({ ...c, isDefault: c.id === id }))
    writeCards(all)
  },
  async removeCard(riderId, id) {
    const all = readCards()
    const left = (all[riderId] ?? []).filter((c) => c.id !== id)
    if (left.length && !left.some((c) => c.isDefault)) left[0].isDefault = true
    all[riderId] = left
    writeCards(all)
  },
  async wallet(ownerId) {
    const c = store.state.customers.find((x) => x.id === ownerId)
    return { balance: toHalalas(Math.round(c?.walletBalance ?? 0)), entries: [] }
  },
  async topUp(riderId, amount) {
    actions.topUpWallet(riderId, Number(amount))
    return { ok: true, status: 'paid' }
  },
  async tip() {
    return { ok: true, status: 'paid' } // demo: tips are recorded with the rating
  },
  async sync() {
    return { ok: true, status: 'paid' }
  },
  async driverStatement() {
    return null // demo: the Earnings tab keeps its local summary (earningsFor)
  },
  async requestPayout() {
    return { ok: false, error: 'demo' }
  },
}

/* ============================== SUPABASE ============================== */

type PayBody = { paymentId?: string; status?: string; transactionUrl?: string; error?: string }
const toPay = (r: { data?: PayBody; error?: string }): PayResult =>
  r.data && !r.error ? { ok: true, status: r.data.status ?? 'initiated', transactionUrl: r.data.transactionUrl, paymentId: r.data.paymentId } : { ok: false, error: errText(r.error) }

const serverGateway: PaymentsGateway = {
  mode: 'supabase',
  async listCards() {
    const { data } = await getSupabase()
      .from('payment_methods')
      .select('id, brand, last4, exp_month, exp_year, is_default, method_type')
      .is('deleted_at', null)
      .order('created_at')
    return ((data ?? []) as { id: string; brand: string | null; last4: string | null; exp_month: number | null; exp_year: number | null; is_default: boolean; method_type: 'mada' | 'card' }[]).map((c) => ({
      id: c.id,
      brand: c.brand ?? 'card',
      last4: c.last4 ?? '••••',
      month: c.exp_month ?? 0,
      year: c.exp_year ?? 0,
      isDefault: c.is_default,
      methodType: c.method_type,
    }))
  },
  async addCard(riderId, card) {
    const t = await tokenizeCard(card, callbackUrl())
    if (!t.ok) return { ok: false, error: t.error }
    if (t.verificationUrl) return { ok: false, error: 'verification_required', verificationUrl: t.verificationUrl, token: t.token }
    return this.confirmCard(riderId, t.token)
  },
  async confirmCard(riderId, token) {
    const r = await invokeFunction<{ paymentMethodId: string }>('payments', { action: 'save_card', token })
    if (r.error || !r.data) return { ok: false, error: errText(r.error) }
    const card = (await this.listCards(riderId)).find((c) => c.id === r.data!.paymentMethodId)
    return card ? { ok: true, card } : { ok: false, error: 'network' }
  },
  async setDefaultCard(_r, id) {
    await getSupabase().rpc('set_default_payment_method', { p_payment_method_id: id })
  },
  async removeCard(_r, id) {
    await getSupabase().rpc('remove_payment_method', { p_payment_method_id: id })
  },
  async wallet(_o, type) {
    const { data } = await getSupabase().rpc('my_wallet', { p_account: type, p_limit: 50 })
    const w = data as { balance_halalas: string; entries: { id: string; at: string; type: string; amount_halalas: string; description: string | null }[] } | null
    if (!w) return { balance: 0n, entries: [] }
    return {
      balance: toHalalas(w.balance_halalas),
      entries: w.entries.map((e) => ({ id: e.id, at: Date.parse(e.at), type: e.type, amount: toHalalas(e.amount_halalas), description: e.description ?? undefined })),
    }
  },
  async topUp(_r, amount, cardId) {
    return toPay(await invokeFunction<PayBody>('payments', { action: 'topup', amountHalalas: amount.toString(), paymentMethodId: cardId }))
  },
  async tip(rideId, amount, via) {
    let r: PayResult
    if ('wallet' in via) {
      const { error } = await getSupabase().rpc('add_wallet_tip', { p_ride_id: rideId, p_amount_halalas: amount.toString() })
      r = error ? { ok: false, error: errText(error.message) } : { ok: true, status: 'paid' }
    } else {
      r = toPay(await invokeFunction<PayBody>('payments', { action: 'tip', rideId, amountHalalas: amount.toString(), paymentMethodId: via.cardId }))
    }
    await refreshRide(rideId)
    return r
  },
  async sync(paymentId) {
    return toPay(await invokeFunction<PayBody>('payments', { action: 'sync', paymentId }))
  },
  async driverStatement(from) {
    const { data, error } = await getSupabase().rpc('driver_earnings', { p_from: from.toISOString() })
    if (error || !data) return null
    const s = data as Record<string, string | number | null | { status: string; amount_halalas: string }>
    const h = (k: string) => toHalalas(String(s[k] ?? '0'))
    const open = s.open_payout as { status: string; amount_halalas: string } | null
    return {
      rides: Number(s.rides ?? 0),
      gross: h('gross_halalas'),
      commission: h('commission_halalas'),
      earnings: h('earnings_halalas'),
      tips: h('tips_halalas'),
      cashCollected: h('cash_collected_halalas'),
      cashDeposited: h('cash_deposited_halalas'),
      paidOut: h('paid_out_halalas'),
      balance: h('balance_halalas'),
      openPayout: open ? { status: open.status, amount: toHalalas(open.amount_halalas) } : null,
    }
  },
  async requestPayout(amount) {
    const { data, error } = await getSupabase().rpc('request_payout', { p_amount_halalas: Number(amount) })
    return error ? { ok: false, error: errText(error.message) } : { ok: true, status: 'pending', paymentId: (data as { id?: string } | null)?.id }
  },
}

export const payments: PaymentsGateway = AUTH_MODE === 'supabase' ? serverGateway : mockGateway
