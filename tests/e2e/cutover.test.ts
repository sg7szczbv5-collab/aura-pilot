/**
 * Cutover rehearsal: one full operating day through the production code paths
 * (Edge Function handlers + shared wiring + every migration), with the offline
 * payment and Wasl providers. Each step depends on the previous one.
 *
 *   npm run test:e2e
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { FakeStorage, FakeSupabase, ageLastFix, createDb, newUser, runAs } from './harness'
import { handleRequestRide } from '../../supabase/functions/_shared/requestRide'
import { buildRequestRideDeps } from '../../supabase/functions/_shared/requestRideDeps'
import { handlePaymentAction, runPaymentWorker } from '../../supabase/functions/_shared/payments/handlers'
import { createPaymentsDb, type SupabaseLike } from '../../supabase/functions/_shared/payments/db'
import { getProvider } from '../../supabase/functions/_shared/payments/registry'
import { MockWasl } from '../../supabase/functions/_shared/wasl/mock'
import { runWaslWorker } from '../../supabase/functions/_shared/wasl/worker'
import { createWaslDb } from '../../supabase/functions/_shared/wasl/db'
import { createCleanupDeps, runPrivacyCleanup, type StorageAdminLike } from '../../supabase/functions/_shared/privacy/cleanup'
import { healthResponse, type Readiness } from '../../supabase/functions/_shared/ops/health'
import { saudiIdCheckDigit } from '../../supabase/functions/_shared/validators'
import { CONSENT_VERSIONS, REQUIRED_CONSENTS } from '../../src/privacy/consents'

let db: PGlite
let storage: FakeStorage
let service: FakeSupabase
let anon: FakeSupabase
let riderId: string
let rider: FakeSupabase
let captainId: string
let captain: FakeSupabase
let ops: FakeSupabase // driver manager
let finance: FakeSupabase
let superAdmin: FakeSupabase
let rideId: string
let chargeId: string
let cardId: string

const env = (k: string) => ({ PAYMENT_PROVIDER: 'mock', PAYMENT_CALLBACK_URL: 'https://aura.example/#/passenger' })[k]
const noFetch = async () => Promise.reject(new Error('no network in tests'))
const ok = async <T>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> => {
  const r = await p
  if (r.error) throw new Error(r.error.message)
  return r.data as T
}
const paymentsDb = () => createPaymentsDb(service as unknown as SupabaseLike, 'mock')
const payDeps = (userId: string) => ({ userId, provider: getProvider('mock', env, noFetch), db: paymentsDb(), callbackUrl: 'https://aura.example/#/passenger' })
const balance = async (owner: string, type: string) =>
  BigInt((await db.query<{ b: string }>(`select balance_halalas::text b from wallet_accounts where owner_id = $1 and account_type = $2`, [owner, type])).rows[0].b)
const admin = async (phone: string, role: string) => {
  const id = await newUser(db, phone, `Staff ${role}`)
  await db.query(`select private.grant_admin($1, $2)`, [id, role])
  return new FakeSupabase(db, { role: 'authenticated', sub: id, aal: 'aal2' })
}
const acceptConsents = (client: FakeSupabase, app: 'rider' | 'driver') =>
  Promise.all(REQUIRED_CONSENTS[app].map((p) => ok(client.rpc('record_consent', { p_purpose: p, p_granted: true, p_policy_version: CONSENT_VERSIONS[p], p_source: `${app}_app` }))))

const PICKUP = { lat: 24.7136, lng: 46.6753, address: 'Olaya, King Fahd Rd' }
const DROPOFF = { lat: 24.7633, lng: 46.6407, address: 'KAFD' }

beforeAll(async () => {
  db = await createDb()
  storage = new FakeStorage()
  service = new FakeSupabase(db, { role: 'service' }, storage)
  anon = new FakeSupabase(db, { role: 'anon' })
  superAdmin = await admin('966590000001', 'super_admin')
  ops = await admin('966590000002', 'driver_manager')
  finance = await admin('966590000003', 'finance_manager')
}, 180_000)

describe('cutover rehearsal', () => {
  it('0 · the empty production database passes every readiness blocker', async () => {
    const r = await ok<Readiness>(service.rpc('ops_readiness'))
    expect(r.checks.filter((c) => c.severity === 'blocker' && !c.ok)).toEqual([])
  })

  it('1 · a captain onboards with documents, is cleared by Wasl and approved by ops', async () => {
    captainId = await newUser(db, '966591000001', 'Khalid Captain')
    captain = new FakeSupabase(db, { role: 'authenticated', sub: captainId })
    await acceptConsents(captain, 'driver')
    const id9 = '10500' + '0123'
    const nationalId = id9 + saudiIdCheckDigit(id9)
    let vehicleId = ''
    await runAs(db, { role: 'authenticated', sub: captainId }, async (tx) => {
      await tx.query(`insert into drivers (id, city_id, national_id, date_of_birth, iban) values ($1, (select id from cities where code = 'riyadh'), $2, '1988-02-02', 'SA0380000000608010167519')`, [captainId, nationalId])
      vehicleId = (await tx.query<{ id: string }>(
        `insert into vehicles (driver_id, vehicle_class, make, model, year, color, plate_letters, plate_number, sequence_number, seats)
         values ($1, 'go', 'Toyota', 'Camry', 2024, 'White', 'ABJ', '2025', '880011223', 4) returning id`, [captainId])).rows[0].id
      await tx.query(`update drivers set current_vehicle_id = $2 where id = $1`, [captainId, vehicleId])
      for (const [t, veh, exp] of [['national_id', false, '2030-01-01'], ['driving_license', false, '2030-01-01'], ['profile_photo', false, null], ['vehicle_registration', true, '2030-01-01'], ['vehicle_insurance', true, '2027-06-30']] as const) {
        const path = `${captainId}/${t}-1.jpg`
        storage.put('driver-documents', path)
        await tx.query(`insert into driver_documents (driver_id, vehicle_id, doc_type, storage_path, expires_at) values ($1::uuid, $2::uuid, $3::document_type, $4, $5)`,
          [captainId, veh ? vehicleId : null, t, path, exp])
      }
    })
    expect((await ok<{ status: string }>(captain.rpc('submit_driver_application').single())).status).toBe('pending_review')

    // Wasl worker (production wiring) registers captain + vehicle.
    const wdb = createWaslDb(service as unknown as SupabaseLike)
    expect(await runWaslWorker({ provider: new MockWasl(), queue: () => wdb.queue(), record: (r) => wdb.record(r) })).toMatchObject({ accepted: 2, errors: 0 })

    const docs = await ok<{ id: string }[]>(ops.from('driver_documents').select('id').eq('driver_id', captainId))
    for (const d of docs) await ok(ops.rpc('admin_review_document', { p_document_id: d.id, p_approve: true }))
    await ok(ops.rpc('admin_review_vehicle', { p_vehicle_id: vehicleId, p_approve: true }))
    expect((await ok<{ status: string }>(ops.rpc('admin_set_driver_status', { p_driver_id: captainId, p_status: 'approved' }).single())).status).toBe('approved')

    await runAs(db, { role: 'authenticated', sub: captainId }, (tx) => tx.query(`update drivers set is_online = true where id = $1`, [captainId]))
    expect(await ok(captain.rpc('update_driver_location', { p_lat: 24.716, p_lng: 46.672, p_heading: 90, p_speed_kmh: 0, p_accuracy_m: 6 }))).toBe(true)
  })

  it('2 · a rider signs up, accepts the terms and saves a card', async () => {
    riderId = await newUser(db, '966592000001', 'Noura Rider')
    rider = new FakeSupabase(db, { role: 'authenticated', sub: riderId })
    storage.put('avatars', `${riderId}/avatar.png`)
    await acceptConsents(rider, 'rider')
    const r = await handlePaymentAction({ action: 'save_card', token: 'tok_mock_4111' }, payDeps(riderId))
    expect(r.status).toBe(201)
    cardId = r.body.paymentMethodId as string
  })

  it('3 · quote is binding; card fare is authorized and only then dispatched', async () => {
    const deps = buildRequestRideDeps({ userId: riderId, userClient: rider as unknown as SupabaseLike, admin: service as unknown as SupabaseLike, env, fetch: noFetch })
    const quote = await handleRequestRide({ pickup: PICKUP, dropoff: DROPOFF, vehicleClass: 'go', paymentMethod: 'mada', dryRun: true }, deps)
    expect(quote.status).toBe(200)
    const quoted = (quote.body.quotes as Record<string, { fare_total_halalas: number }>).go.fare_total_halalas

    const req = await handleRequestRide({ pickup: PICKUP, dropoff: DROPOFF, vehicleClass: 'go', paymentMethod: 'mada', paymentMethodId: cardId }, deps)
    expect(req).toMatchObject({ status: 201, body: { paymentStatus: 'authorized', dispatched: true, fareTotal: quoted } })
    rideId = req.body.rideId as string
    chargeId = req.body.paymentId as string
    const ride = await ok<{ offered_driver_id: string }>(service.from('rides').select('offered_driver_id').eq('id', rideId).maybeSingle())
    expect(ride.offered_driver_id).toBe(captainId)
  })

  it('4 · trip: accept, live share link, PIN, GPS breadcrumbs, completion', async () => {
    await ok(captain.rpc('accept_ride', { p_ride_id: rideId }).single())
    await ok(captain.rpc('transition_ride', { p_ride_id: rideId, p_to: 'driver_arriving' }).single())
    const share = await ok<{ token: string }>(rider.rpc('create_trip_share', { p_ride_id: rideId }).single())
    const view = await ok<{ status: string; captain: { first_name: string }; location: unknown }>(anon.rpc('trip_share_view', { p_token: share.token }))
    expect(view).toMatchObject({ status: 'driver_arriving', captain: { first_name: 'Khalid' } })
    expect(view.location).not.toBeNull()

    await ok(captain.rpc('transition_ride', { p_ride_id: rideId, p_to: 'driver_arrived' }).single())
    const code = await ok<string>(rider.rpc('issue_ride_verification_code', { p_ride_id: rideId }))
    expect(await ok(captain.rpc('start_ride', { p_ride_id: rideId, p_code: code }))).toBe(true)

    for (const [lat, lng] of [[24.7136, 46.6753], [24.7300, 46.6650], [24.7460, 46.6540], [24.7633, 46.6407]]) {
      await ageLastFix(db, captainId, 60)
      expect(await ok(captain.rpc('update_driver_location', { p_lat: lat, p_lng: lng, p_heading: 320, p_speed_kmh: 40, p_accuracy_m: 5 }))).toBe(true)
    }
    await ok(captain.rpc('transition_ride', { p_ride_id: rideId, p_to: 'completed' }).single())
    const done = await ok<{ status: string; actual_distance_m: number; settled_at: string | null }>(
      service.from('rides').select('status, actual_distance_m, settled_at').eq('id', rideId).maybeSingle())
    expect(done.status).toBe('completed')
    expect(done.actual_distance_m).toBeGreaterThan(5000)
    expect(done.settled_at).toBeNull() // card: waits for capture
  })

  it('5 · Wasl receives the trip at start and the update at completion', async () => {
    const wdb = createWaslDb(service as unknown as SupabaseLike)
    const run = () => runWaslWorker({ provider: new MockWasl(), queue: () => wdb.queue(), record: (r) => wdb.record(r) })
    expect((await run()).accepted).toBeGreaterThanOrEqual(1) // trip_registration
    expect((await run()).accepted).toBeGreaterThanOrEqual(1) // trip_update
    const r = await ok<{ wasl_trip_reference: string; wasl_reported_at: string }>(service.from('rides').select('wasl_trip_reference, wasl_reported_at').eq('id', rideId).maybeSingle())
    expect(r.wasl_trip_reference).toMatch(/^MOCK-T-/)
    expect(r.wasl_reported_at).not.toBeNull()
  })

  it('6 · payments worker captures, the ride settles, the captain is credited', async () => {
    const out = await runPaymentWorker({ queue: () => paymentsDb().queue(), provider: (n) => getProvider(n, env, noFetch), db: paymentsDb() })
    expect(out).toMatchObject({ failed: 0 })
    const ride = await ok<{ settled_at: string | null; driver_net_halalas: number }>(service.from('rides').select('settled_at, driver_net_halalas').eq('id', rideId).maybeSingle())
    expect(ride.settled_at).not.toBeNull()
    expect(await balance(captainId, 'driver_wallet')).toBe(BigInt(ride.driver_net_halalas))
  })

  it('7 · rider tips by card; finance refunds part of the fare through the gateway', async () => {
    const before = await balance(captainId, 'driver_wallet')
    const tip = await handlePaymentAction({ action: 'tip', rideId, amountHalalas: '1500', paymentMethodId: cardId }, payDeps(riderId))
    expect(tip.body).toMatchObject({ status: 'paid' })
    expect(await balance(captainId, 'driver_wallet')).toBe(before + 1500n)

    const refund = await ok<{ id: string }>(finance.rpc('admin_refund_payment', { p_payment_id: chargeId, p_amount_halalas: '1000', p_reason: 'Detour' }).single())
    await runPaymentWorker({ queue: () => paymentsDb().queue(), provider: (n) => getProvider(n, env, noFetch), db: paymentsDb() })
    expect((await ok<{ status: string }>(service.from('payments').select('status').eq('id', refund.id).maybeSingle())).status).toBe('paid')
  })

  it('8 · weekly payout pays the captain to zero', async () => {
    const owed = await balance(captainId, 'driver_wallet')
    expect(owed > 0n).toBe(true)
    expect(await ok<number>(finance.rpc('create_payout_batch', { p_min_halalas: '1000' }))).toBeGreaterThanOrEqual(1)
    const p = await ok<{ id: string; amount_halalas: string }>(service.from('payouts').select('id, amount_halalas').eq('driver_id', captainId).maybeSingle())
    expect(BigInt(p.amount_halalas)).toBe(owed)
    await ok(finance.rpc('admin_set_payout_status', { p_payout_id: p.id, p_status: 'approved' }).single())
    await ok(finance.rpc('admin_set_payout_status', { p_payout_id: p.id, p_status: 'processing' }).single())
    await ok(service.rpc('complete_payout', { p_payout_id: p.id, p_success: true, p_provider_payout_id: 'bank-001' }).single())
    expect(await balance(captainId, 'driver_wallet')).toBe(0n)
  })

  it('9 · the rider exports their data, then is erased (Storage + login cleaned up)', async () => {
    const data = await ok<{ format: string; rides_as_rider: { route_points: unknown[] }[]; payments: unknown[] }>(rider.rpc('export_my_data'))
    expect(data.format).toBe('aura.personal-data.v2')
    expect(data.rides_as_rider[0].route_points.length).toBeGreaterThanOrEqual(3)
    expect(data.payments.length).toBeGreaterThanOrEqual(3) // charge, tip, refund

    const req = await ok<{ id: string }>(rider.rpc('submit_privacy_request', { p_type: 'deletion', p_details: 'Close my account' }).single())
    await ok(superAdmin.rpc('admin_update_privacy_request', { p_request_id: req.id, p_status: 'completed', p_note: 'Erased' }).single())
    const out = await runPrivacyCleanup(createCleanupDeps(service as unknown as StorageAdminLike))
    expect(out).toMatchObject({ processed: 1, failed: 0 })
    expect(storage.paths('avatars')).toEqual([])
    expect(service.bans.get(riderId)).toMatchObject({ ban_duration: '876000h' })
    const p = await db.query(`select full_name, phone, is_blocked from profiles where id = $1`, [riderId])
    expect(p.rows[0]).toEqual({ full_name: null, phone: null, is_blocked: true })
    // Trip, payment and ledger records remain for tax/TGA (anonymised).
    expect((await db.query(`select 1 from rides where id = $1`, [rideId])).rows).toHaveLength(1)
  })

  it('10 · after a full operating day: books balance, readiness green, health 200', async () => {
    const ledger = await ok<{ ok: boolean; ledger_sum_halalas: string }>(service.rpc('ledger_health'))
    expect(ledger).toMatchObject({ ok: true, ledger_sum_halalas: '0' })
    const r = await ok<Readiness>(service.rpc('ops_readiness'))
    expect(r.checks.filter((c) => c.severity === 'blocker' && !c.ok)).toEqual([])
    const h = healthResponse(r, { detailed: true, version: 'rehearsal' })
    expect(h.status).toBe(200)
    expect((h.body.failing as { id: string }[]).map((f) => f.id)).toEqual(expect.arrayContaining(['no_mock_payments', 'no_mock_wasl']))
  })
})
