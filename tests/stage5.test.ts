/**
 * Stage 5 unit tests: BigInt money, cards, Moyasar/mock providers, payment
 * handlers (actions, webhook, worker) and card authorization in request-ride.
 */
import { describe, expect, it, vi } from 'vitest'
import { allocate, applyBps, ceilToRiyal, formatSar, MoneyError, parseSar, settlementLines, splitFare, sumHalalas, toHalalas, toSafeNumber } from '../src/money/halalas'
import { DEFAULT_PRICING, quoteFare } from '../src/core/pricing'
import { cardBrand, expiryValid, luhnValid, tokenizeCard, validateCard } from '../src/payments/cards'
import { MoyasarProvider, mapMoyasarPayment } from '../supabase/functions/_shared/payments/moyasar'
import { MockProvider } from '../supabase/functions/_shared/payments/mock'
import { ProviderError, type PaymentProvider } from '../supabase/functions/_shared/payments/provider'
import { getProvider } from '../supabase/functions/_shared/payments/registry'
import { handlePaymentAction, handleWebhook, runPaymentWorker, type PaymentRow, type PaymentsDb } from '../supabase/functions/_shared/payments/handlers'
import { handleRequestRide, type Deps } from '../supabase/functions/_shared/requestRide'
import { estimateRoute } from '../supabase/functions/_shared/routing'

const RIDE = '11111111-1111-4111-8111-111111111111'
const PAY = '22222222-2222-4222-8222-222222222222'
const CARD = '33333333-3333-4333-8333-333333333333'

describe('BigInt halalas', () => {
  it('parses SAR exactly (incl. Arabic digits) and rejects anything ambiguous', () => {
    expect(parseSar('12')).toBe(1200n)
    expect(parseSar('12.5')).toBe(1250n)
    expect(parseSar('1,234.05')).toBe(123405n)
    expect(parseSar('١٢٫٥٠')).toBe(1250n)
    expect(parseSar('0.1')).toBe(10n)
    for (const bad of ['12.345', '1e3', 'abc', '', '.5', '12.']) expect(() => parseSar(bad)).toThrow(MoneyError)
    expect(() => parseSar('-5')).toThrow('negative_amount')
    expect(parseSar('-5', { allowNegative: true })).toBe(-500n)
  })

  it('never goes through unsafe JS numbers', () => {
    expect(toHalalas('900719925474099300')).toBe(900719925474099300n) // > 2^53
    expect(() => toHalalas(2 ** 53 + 2)).toThrow('unsafe_number')
    expect(() => toHalalas(12.5)).toThrow('unsafe_number')
    expect(() => toSafeNumber(10n ** 20n)).toThrow('amount_too_large')
    expect(formatSar(10n ** 20n + 5n)).toBe('1,000,000,000,000,000,000.05')
    expect(formatSar(-123456n)).toBe('-1,234.56')
    expect(formatSar(5n)).toBe('0.05')
  })

  it('rounds basis points half away from zero, exactly like PostgreSQL round()', () => {
    expect(applyBps(1210n, 1500)).toBe(182n) // 181.5 → 182
    expect(applyBps(-1210n, 1500)).toBe(-182n) // half away from zero (Math.round would give −181)
    expect(applyBps(1n, 5000)).toBe(1n) // 0.5 → 1
    expect(applyBps(10n ** 18n + 1n, 1500)).toBe(150000000000000000n) // exact far beyond 2^53
    expect(applyBps(2900n, 2000)).toBe(580n)
    expect(ceilToRiyal(2850n)).toBe(2900n)
    expect(ceilToRiyal(2900n)).toBe(2900n)
  })

  it('allocate never loses or creates a halala', () => {
    for (const [total, w] of [[100n, [1, 1, 1]], [1001n, [3, 7]], [-100n, [1, 2]], [10n ** 18n + 7n, [5, 3, 2]]] as const) {
      const parts = allocate(total, [...w])
      expect(sumHalalas(parts)).toBe(total)
    }
    expect(allocate(100n, [1, 1, 1])).toEqual([34n, 33n, 33n])
    expect(() => allocate(1n, [0, 0])).toThrow('zero_weights')
  })

  it('fare split matches the pricing engine and settlements always balance', () => {
    for (const km of [3, 10, 27.35]) {
      const q = quoteFare({ config: DEFAULT_PRICING, cityId: 'riyadh', classId: 'go', distanceKm: km, durationMin: km * 2 })
      const s = splitFare({ subtotal: BigInt(q.subtotal), commissionBps: 2000, vatBps: 1500 })
      expect({ vat: Number(s.vat), total: Number(s.total), commission: Number(s.commission), net: Number(s.driverNet) }).toEqual({
        vat: q.vat,
        total: q.total,
        commission: q.commission,
        net: q.driverNet,
      })
    }
    const f = splitFare({ subtotal: 2900n, discount: 290n, commissionBps: 2000, vatBps: 1500 })
    expect(f).toMatchObject({ vat: 392n, total: 3002n, commission: 580n, driverNet: 2320n })
    for (const m of ['card', 'wallet', 'cash'] as const) expect(sumHalalas(settlementLines(m, f).map((l) => l.amount))).toBe(0n)
    // Cash: the captain ends at earnings − cash collected = −(commission + VAT − discount)
    const cash = settlementLines('cash', f).filter((l) => l.account === 'driver_wallet')
    expect(sumHalalas(cash.map((l) => l.amount))).toBe(f.driverNet - f.total)
    expect(() => splitFare({ subtotal: 100n, discount: 200n, commissionBps: 0, vatBps: 0 })).toThrow('invalid_fare')
  })
})

describe('card entry', () => {
  it('validates numbers, brands and expiry', () => {
    expect(luhnValid('4111 1111 1111 1111')).toBe(true)
    expect(luhnValid('4111 1111 1111 1112')).toBe(false)
    expect(cardBrand('4406 4700 0000 0000')).toBe('mada')
    expect(cardBrand('4111111111111111')).toBe('visa')
    expect(cardBrand('5500000000000004')).toBe('mastercard')
    const now = new Date(2026, 10, 28)
    expect(expiryValid(11, 26, now)).toBe(true)
    expect(expiryValid(10, 26, now)).toBe(false)
    expect(expiryValid(13, 30, now)).toBe(false)
    expect(validateCard({ name: 'A', number: '4111111111111111', month: 12, year: 2030, cvc: '123' })).toEqual({ ok: false, field: 'name' })
    expect(validateCard({ name: 'Sara', number: '4111111111111111', month: 12, year: 2030, cvc: '12' })).toEqual({ ok: false, field: 'cvc' })
  })

  it('mock tokenizer: success, decline and 3-D Secure test cards', async () => {
    const c = { name: 'Sara Test', month: 12, year: 2030, cvc: '123' }
    expect(await tokenizeCard({ ...c, number: '4111111111111111' }, 'cb')).toEqual({ ok: true, token: 'tok_mock_1111' })
    expect(await tokenizeCard({ ...c, number: '4000000000000002' }, 'cb')).toEqual({ ok: false, error: 'declined' })
    expect(await tokenizeCard({ ...c, number: '4000000000003220' }, 'cb')).toEqual({ ok: true, token: 'tok_mock_3ds_3220' })
    expect(await tokenizeCard({ ...c, number: '1234' }, 'cb')).toEqual({ ok: false, error: 'invalid_card' })
  })
})

describe('Moyasar adapter', () => {
  const fakeFetch = (status: number, body: unknown) =>
    vi.fn(async (_url: string, _init: { method: string; headers: Record<string, string>; body?: string }) => ({ ok: status < 300, status, json: async () => body }))

  it('creates an authorize-only payment with the secret key, amount in halalas and our id', async () => {
    const f = fakeFetch(201, { id: 'pay_1', status: 'authorized', amount: 3335, metadata: { aura_payment_id: PAY } })
    const p = new MoyasarProvider('sk_test_x', f, 'whsec')
    const r = await p.createPayment({ paymentId: PAY, amountHalalas: 3335n, description: 'ride', source: { type: 'token', token: 'token_1' }, manual: true, callbackUrl: 'https://app/cb', metadata: { kind: 'charge' } })
    expect(r).toMatchObject({ id: 'pay_1', status: 'authorized', amountHalalas: 3335n })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://api.moyasar.com/v1/payments')
    expect(init.headers.Authorization).toBe(`Basic ${btoa('sk_test_x:')}`)
    const body = JSON.parse(init.body!)
    expect(body).toMatchObject({ given_id: PAY, amount: 3335, currency: 'SAR', source: { type: 'token', token: 'token_1', manual: true }, metadata: { aura_payment_id: PAY } })
  })

  it('maps statuses and surfaces API errors', async () => {
    expect(mapMoyasarPayment({ id: 'x', status: 'captured', amount: 100, captured: 100 }).status).toBe('paid')
    expect(mapMoyasarPayment({ id: 'x', status: 'refunded', amount: 100, refunded: 40 }).refundedHalalas).toBe(40n)
    expect(mapMoyasarPayment({ id: 'x', status: 'weird', amount: 1 }).status).toBe('failed')
    const p = new MoyasarProvider('sk', fakeFetch(422, { message: 'Card declined', type: 'invalid_request_error' }))
    await expect(p.capture('pay_1', 100n)).rejects.toMatchObject({ message: 'Card declined', status: 422 })
    expect(() => new MoyasarProvider('', fakeFetch(200, {}))).toThrow(ProviderError)
  })

  it('verifies webhooks by secret token and maps saved-card tokens', async () => {
    const p = new MoyasarProvider('sk', fakeFetch(200, { id: 'token_9', status: 'verified', brand: 'mada', last_four: '4821', month: '09', year: '2029', name: 'SARA' }), 'whsec')
    expect(p.verifyWebhook({ secret_token: 'whsec', type: 'payment_paid', data: { id: 'pay_2' } })).toEqual({ ok: true, providerPaymentId: 'pay_2', event: 'payment_paid' })
    expect(p.verifyWebhook({ secret_token: 'nope', data: { id: 'pay_2' } })).toEqual({ ok: false })
    expect(await p.fetchToken('token_9')).toEqual({ id: 'token_9', status: 'verified', brand: 'mada', last4: '4821', month: 9, year: 2029, name: 'SARA' })
  })

  it('registry picks the configured provider', () => {
    const env = (k: string) => ({ MOYASAR_SECRET_KEY: 'sk_test' })[k]
    expect(getProvider('moyasar', env, fakeFetch(200, {})).name).toBe('moyasar')
    expect(getProvider(undefined, env, fakeFetch(200, {})).name).toBe('mock')
    expect(() => getProvider('paypal', env, fakeFetch(200, {}))).toThrow('payment_provider_not_supported')
  })
})

describe('mock provider (stateless)', () => {
  const base = { paymentId: PAY, amountHalalas: 2000n, description: 'x', callbackUrl: 'https://app/#/passenger?payment=p', metadata: {} }
  it('authorize → capture → refund, with guards', async () => {
    const m = new MockProvider()
    const a = await m.createPayment({ ...base, source: { type: 'token', token: 'tok_mock_1111' }, manual: true })
    expect(a.status).toBe('authorized')
    const c = await m.capture(a.id, 2000n)
    expect(c).toMatchObject({ status: 'paid', capturedHalalas: 2000n })
    expect((await m.refund(a.id, 500n)).status).toBe('refunded')
    expect((await m.refund(a.id, 5000n)).status).toBe('failed')
    expect((await m.capture(c.id, 2000n)).status).toBe('failed') // already captured
  })
  it('declines and 3-D Secure', async () => {
    const m = new MockProvider()
    expect((await m.createPayment({ ...base, source: { type: 'token', token: 'tok_mock_decline_0002' }, manual: false })).status).toBe('failed')
    const s = await m.createPayment({ ...base, source: { type: 'token', token: 'tok_mock_3ds_3220' }, manual: false })
    expect(s.status).toBe('initiated')
    expect(s.transactionUrl).toBe('https://app/#/passenger?payment=p&mock_3ds=1')
    expect((await m.fetchPayment(s.id)).status).toBe('paid')
  })
})

/* ---------- handlers with an in-memory database ---------- */
function memDb(over: Partial<PaymentsDb> = {}) {
  const rows = new Map<string, PaymentRow>()
  const calls: { fn: string; args: unknown }[] = []
  const db: PaymentsDb = {
    async createIntent(a) {
      calls.push({ fn: 'createIntent', args: a })
      const row: PaymentRow = { id: PAY, kind: a.kind, status: 'initiated', amount_halalas: a.amountHalalas?.toString() ?? '3335', provider_payment_id: null, ride_id: a.rideId, rider_id: a.userId }
      rows.set(row.id, row)
      return row
    },
    async record(a) {
      calls.push({ fn: 'record', args: a })
      const r = rows.get(a.paymentId) ?? ({ id: a.paymentId, kind: 'charge', status: 'initiated', amount_halalas: '0', provider_payment_id: null, ride_id: null, rider_id: 'u1' } as PaymentRow)
      const next = { ...r, status: a.status, provider_payment_id: r.provider_payment_id ?? a.providerPaymentId ?? null }
      rows.set(r.id, next)
      return next
    },
    async savedToken(id, user) {
      calls.push({ fn: 'savedToken', args: { id, user } })
      return id === CARD ? 'tok_mock_4821' : null
    },
    async saveCard(a) {
      calls.push({ fn: 'saveCard', args: a })
      return { id: CARD }
    },
    async getPayment(id) {
      return rows.get(id) ?? null
    },
    ...over,
  }
  return { db, rows, calls }
}

describe('payment actions', () => {
  const deps = (db: PaymentsDb, provider: PaymentProvider = new MockProvider()) => ({ userId: 'u1', provider, db, callbackUrl: 'https://app/#/passenger' })

  it('requires a user and a known action', async () => {
    const { db } = memDb()
    expect((await handlePaymentAction({ action: 'topup' }, { ...deps(db), userId: null })).status).toBe(401)
    expect((await handlePaymentAction({ action: 'steal' }, deps(db))).body).toEqual({ error: 'unknown_action' })
    expect((await handlePaymentAction({ action: 'topup', paymentMethodId: CARD, amountHalalas: '12.5' }, deps(db))).body).toEqual({ error: 'invalid_amount' })
    expect((await handlePaymentAction({ action: 'authorize_ride', rideId: 'nope', token: 'tok_mock_1' }, deps(db))).body).toEqual({ error: 'invalid_ride' })
  })

  it('saves a tokenized card', async () => {
    const { db, calls } = memDb()
    const r = await handlePaymentAction({ action: 'save_card', token: 'tok_mock_4821' }, deps(db))
    expect(r).toEqual({ status: 201, body: { paymentMethodId: CARD, brand: 'visa', last4: '4821', methodType: 'card' } })
    expect(calls.find((c) => c.fn === 'saveCard')?.args).toMatchObject({ userId: 'u1', token: 'tok_mock_4821', last4: '4821' })
  })

  it('authorizes a ride fare with a saved card; the server decides the amount', async () => {
    const { db, calls } = memDb()
    const r = await handlePaymentAction({ action: 'authorize_ride', rideId: RIDE, paymentMethodId: CARD }, deps(db))
    expect(r).toEqual({ status: 200, body: { paymentId: PAY, status: 'authorized' } })
    expect(calls[0]).toEqual({ fn: 'createIntent', args: expect.objectContaining({ kind: 'charge', rideId: RIDE, amountHalalas: null }) })
    expect(calls.find((c) => c.fn === 'record')?.args).toMatchObject({ status: 'authorized', amountHalalas: 3335n })
  })

  it('top-up with BigInt-string amount is captured immediately; decline returns 402', async () => {
    const { db } = memDb()
    expect((await handlePaymentAction({ action: 'topup', paymentMethodId: CARD, amountHalalas: '5000' }, deps(db))).body).toMatchObject({ status: 'paid' })
    const { db: db2 } = memDb()
    const r = await handlePaymentAction({ action: 'topup', token: 'tok_mock_decline_0002', amountHalalas: '5000' }, deps(db2))
    expect(r.status).toBe(402)
  })

  it('records provider outages as failures and never calls the provider twice', async () => {
    const boom: PaymentProvider = { ...new MockProvider(), name: 'mock', createPayment: async () => Promise.reject(new Error('timeout')) } as PaymentProvider
    const { db, calls } = memDb()
    expect((await handlePaymentAction({ action: 'tip', rideId: RIDE, token: 'tok_mock_1', amountHalalas: '1000' }, deps(db, boom))).status).toBe(402)
    expect(calls.find((c) => c.fn === 'record')?.args).toMatchObject({ status: 'failed', failureCode: 'provider_error' })

    const create = vi.fn()
    const { db: db2 } = memDb({ createIntent: async () => ({ id: PAY, kind: 'charge', status: 'authorized', amount_halalas: '3335', provider_payment_id: 'mock_x', ride_id: RIDE, rider_id: 'u1' }) })
    const r = await handlePaymentAction({ action: 'authorize_ride', rideId: RIDE, paymentMethodId: CARD }, deps(db2, { ...new MockProvider(), name: 'mock', createPayment: create } as unknown as PaymentProvider))
    expect(r.body).toEqual({ paymentId: PAY, status: 'authorized' })
    expect(create).not.toHaveBeenCalled()
  })

  it('3-D Secure: returns the bank URL, then sync completes it (own payments only)', async () => {
    const { db, rows } = memDb()
    const r = await handlePaymentAction({ action: 'topup', token: 'tok_mock_3ds_3220', amountHalalas: '5000' }, deps(db))
    expect(r.body).toMatchObject({ status: 'initiated', transactionUrl: expect.stringContaining('payment=') })
    expect((await handlePaymentAction({ action: 'sync', paymentId: PAY }, { ...deps(db), userId: 'someone-else' })).status).toBe(404)
    expect((await handlePaymentAction({ action: 'sync', paymentId: PAY }, deps(db))).body).toEqual({ paymentId: PAY, status: 'paid' })
    expect(rows.get(PAY)?.status).toBe('paid')
  })
})

describe('webhook and worker', () => {
  it('webhook: rejects bad secrets, re-fetches the payment instead of trusting the body', async () => {
    const fetched = { id: 'pay_9', status: 'paid' as const, amountHalalas: 5000n, capturedHalalas: 5000n, refundedHalalas: 0n, metadata: { aura_payment_id: PAY }, raw: {} }
    const provider = { name: 'moyasar', verifyWebhook: (b: { secret_token?: string; data?: { id?: string } }) => (b.secret_token === 's' ? { ok: true, providerPaymentId: b.data?.id } : { ok: false }), fetchPayment: vi.fn(async () => fetched) } as unknown as PaymentProvider
    const { db, calls } = memDb()
    await db.createIntent({ userId: 'u1', kind: 'wallet_topup', rideId: null, amountHalalas: 5000n, methodType: 'mada', paymentMethodId: null })
    expect((await handleWebhook({ secret_token: 'x', data: { id: 'pay_9', status: 'paid', amount: 999999 } }, { provider, db })).status).toBe(401)
    const r = await handleWebhook({ secret_token: 's', data: { id: 'pay_9', status: 'paid', amount: 999999 } }, { provider, db })
    expect(r.status).toBe(200)
    expect(calls.at(-1)?.args).toMatchObject({ paymentId: PAY, status: 'paid', amountHalalas: 5000n }) // the provider's amount, not the body's
  })

  it('worker: capture, void, refund, sync — one failure never blocks the rest', async () => {
    const m = new MockProvider()
    const auth = await m.createPayment({ paymentId: PAY, amountHalalas: 3000n, description: '', source: { type: 'token', token: 'tok_mock_1' }, manual: true, callbackUrl: 'x', metadata: {} })
    const { db, calls } = memDb()
    const out = await runPaymentWorker({
      queue: async () => [
        { payment_id: 'p1', action: 'capture', provider: 'mock', provider_payment_id: auth.id, amount_halalas: '3000' },
        { payment_id: 'p2', action: 'void', provider: 'mock', provider_payment_id: auth.id, amount_halalas: 3000 },
        { payment_id: 'p3', action: 'refund', provider: 'mock', provider_payment_id: auth.id, amount_halalas: '1000' },
        { payment_id: 'p4', action: 'sync', provider: 'mock', provider_payment_id: null, amount_halalas: '1' },
      ],
      provider: () => m,
      db,
    })
    expect(out).toMatchObject({ processed: 3, failed: 1 })
    const rec = calls.filter((c) => c.fn === 'record').map((c) => c.args as { paymentId: string; status: string; providerPaymentId?: string })
    expect(rec.map((r) => [r.paymentId, r.status])).toEqual([['p1', 'paid'], ['p2', 'voided'], ['p3', 'paid']])
    expect(rec[2].providerPaymentId).toBe(`${auth.id}:refund:p3`)
  })
})

describe('request-ride: card rides are authorized before dispatch', () => {
  const A = { lat: 24.7136, lng: 46.6753, address: 'Olaya' }
  const B = { lat: 24.7633, lng: 46.6407, address: 'KAFD' }
  const deps = (over: Partial<Deps> = {}): Deps => ({
    userId: 'u1',
    route: async (a, b) => estimateRoute(a, b),
    quote: async () => ({ fare_total_halalas: 3335 }),
    createRide: async () => ({ id: RIDE, fare_total_halalas: 3335 }),
    dispatch: vi.fn(async () => 'cap'),
    ...over,
  })

  it('needs a card for card payments', async () => {
    expect((await handleRequestRide({ pickup: A, dropoff: B, paymentMethod: 'mada' }, deps())).body).toEqual({ error: 'payment_method_required' })
  })

  it('authorized → created and left for the database to dispatch', async () => {
    const d = deps({ authorize: async () => ({ status: 'authorized', paymentId: PAY }) })
    const r = await handleRequestRide({ pickup: A, dropoff: B, paymentMethod: 'mada', paymentMethodId: CARD }, d)
    expect(r).toMatchObject({ status: 201, body: { rideId: RIDE, paymentStatus: 'authorized', dispatched: true } })
    expect(d.dispatch).not.toHaveBeenCalled()
  })

  it('3-D Secure → returns the bank URL; declined → 402', async () => {
    const r = await handleRequestRide({ pickup: A, dropoff: B, paymentMethod: 'card', paymentToken: 'tok_mock_3ds_3220' }, deps({ authorize: async () => ({ status: 'initiated', paymentId: PAY, transactionUrl: 'https://bank/3ds' }) }))
    expect(r.body).toMatchObject({ dispatched: false, transactionUrl: 'https://bank/3ds' })
    const f = await handleRequestRide({ pickup: A, dropoff: B, paymentMethod: 'card', paymentToken: 'tok_mock_decline_2' }, deps({ authorize: async () => ({ status: 'failed', error: 'payment_failed' }) }))
    expect(f).toMatchObject({ status: 402, body: { error: 'payment_failed', rideId: RIDE } })
  })

  it('cash rides are dispatched immediately as before', async () => {
    const d = deps()
    expect((await handleRequestRide({ pickup: A, dropoff: B, paymentMethod: 'cash' }, d)).body).toMatchObject({ dispatched: true })
    expect(d.dispatch).toHaveBeenCalledWith(RIDE)
  })
})
