/**
 * AURA database tests — run the real Supabase migrations on PostgreSQL + PostGIS
 * (PGlite, in-process, no Docker) and verify schema, RLS, the trip state machine,
 * fare parity with src/core/pricing.ts and the double-entry ledger.
 *
 *   npm run test:db
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { postgis } from '@electric-sql/pglite-postgis'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PRICING, quoteFare } from '../../src/core/pricing'
import type { AdminRole, VehicleClassId } from '../../src/core/types'
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '../../src/core/seed'
import { haversineKm } from '../../src/core/geo'
import { isValidSaudiIban, isValidSaudiId, saudiIdCheckDigit } from '../../src/compliance/validators'
import { CONSENT_VERSIONS, REQUIRED_CONSENTS, type ConsentApp } from '../../src/privacy/consents'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')

const EXPECTED_TABLES = [
  'audit_log', 'cities', 'driver_documents', 'driver_locations', 'drivers', 'payment_methods',
  'payments', 'payouts', 'privacy_requests', 'profiles', 'promos', 'ride_events', 'ride_offers', 'ride_route_points', 'riders', 'rides', 'tariffs',
  'ticket_messages', 'tickets', 'trip_shares', 'user_consents', 'vehicles', 'wallet_accounts', 'wallet_ledger', 'wasl_sync_log', 'zones',
]

let db: PGlite

/** Users whose JWT carries aal2 (MFA verified). Admins are added by newAdmin(). */
const MFA_USERS = new Set<string>()

/**
 * Run `fn` inside a transaction as a Supabase role. `who` = user id, 'service' or 'anon'.
 * The JWT claims mimic Supabase: sub + role + aal (aal2 for MFA users unless overridden).
 */
function as<T>(who: string, fn: (tx: Transaction) => Promise<T>, opts: { aal?: 'aal1' | 'aal2' } = {}): Promise<T> {
  return db.transaction(async (tx) => {
    const role = who === 'service' ? 'service_role' : who === 'anon' ? 'anon' : 'authenticated'
    const sub = who === 'service' || who === 'anon' ? '' : who
    const aal = opts.aal ?? (MFA_USERS.has(who) ? 'aal2' : 'aal1')
    const claims = sub ? JSON.stringify({ sub, role, aal }) : JSON.stringify({ role })
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [sub, claims])
    await tx.exec(`set local role ${role}`)
    return fn(tx)
  })
}

async function one<T = Record<string, unknown>>(who: string, sql: string, params: unknown[] = []): Promise<T> {
  return as(who, async (tx) => (await tx.query<T>(sql, params)).rows[0])
}

async function rows<T = Record<string, unknown>>(who: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return as(who, async (tx) => (await tx.query<T>(sql, params)).rows)
}

async function newUser(phone: string, name: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into auth.users (phone, raw_user_meta_data) values ($1, $2) returning id`,
    [phone, JSON.stringify({ full_name: name })],
  )
  return r.rows[0].id
}

async function newAdmin(phone: string, role: string): Promise<string> {
  const id = await newUser(phone, `Admin ${role}`)
  await db.query(`select private.grant_admin($1, $2)`, [id, role])
  MFA_USERS.add(id)
  return id
}

/** Accept every consent the app requires, at the current versions from src/privacy/consents.ts. */
async function acceptRequiredConsents(uid: string, app: ConsentApp) {
  await as(uid, async (tx) => {
    for (const purpose of REQUIRED_CONSENTS[app]) {
      await tx.query(`select record_consent($1, true, $2, $3)`, [purpose, CONSENT_VERSIONS[purpose], app === 'rider' ? 'rider_app' : 'driver_app'])
    }
  })
}

// ── Shared fixtures (tests below run in order) ──────────────────────────────
let riderA: string
let riderB: string
let driver: string
let driverManager: string
let support: string
let finance: string
let superAdmin: string
let vehicleId: string
let rideId: string

beforeAll(async () => {
  db = new PGlite({ extensions: { postgis } })
  await db.exec(readFileSync(join(ROOT, 'tests', 'db', 'supabase-shim.sql'), 'utf8'))
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
  }
  await db.exec(readFileSync(join(ROOT, 'supabase', 'seed.sql'), 'utf8'))

  riderA = await newUser('966551112222', 'Sara Rider')
  riderB = await newUser('966553334444', 'Omar Rider')
  driver = await newUser('966555556666', 'Faisal Captain')
  driverManager = await newAdmin('966500000001', 'driver_manager')
  support = await newAdmin('966500000002', 'customer_support')
  finance = await newAdmin('966500000003', 'finance_manager')
  superAdmin = await newAdmin('966500000004', 'super_admin')
  await acceptRequiredConsents(riderA, 'rider')
  await acceptRequiredConsents(riderB, 'rider')
  await acceptRequiredConsents(driver, 'driver')
}, 180_000)

// ────────────────────────────────────────────────────────────────────────────
describe('schema', () => {
  it('creates exactly the 26 AURA tables (21 core + 2 privacy + 2 trip tracking + trip shares), all with RLS enabled', async () => {
    const r = await db.query<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename`)
    expect(r.rows.map((x) => x.tablename)).toEqual(EXPECTED_TABLES)
    expect(r.rows.every((x) => x.rowsecurity)).toBe(true)
  })

  it('uses UUID primary keys everywhere', async () => {
    const r = await db.query<{ table_name: string; data_type: string }>(`
      select tc.table_name, c.data_type
      from information_schema.table_constraints tc
      join information_schema.key_column_usage k on k.constraint_name = tc.constraint_name and k.table_schema = tc.table_schema
      join information_schema.columns c on c.table_schema = k.table_schema and c.table_name = k.table_name and c.column_name = k.column_name
      where tc.table_schema = 'public' and tc.constraint_type = 'PRIMARY KEY'`)
    expect(r.rows).toHaveLength(EXPECTED_TABLES.length)
    expect(r.rows.every((x) => x.data_type === 'uuid')).toBe(true)
  })

  it('has PostGIS and spatial indexes', async () => {
    const r = await db.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and indexdef ilike '%using gist%' order by 1`)
    expect(r.rows.map((x) => x.indexname)).toEqual(expect.arrayContaining([
      'cities_service_area_gix', 'driver_locations_available_gix', 'driver_locations_gix', 'rides_pickup_gix', 'zones_area_gix']))
  })

  it('new auth users get profile + rider + wallet, always as rider', async () => {
    const p = await one<{ role: string; phone: string; full_name: string }>(riderA, `select role, phone, full_name from profiles where id = $1`, [riderA])
    expect(p).toEqual({ role: 'rider', phone: '+966551112222', full_name: 'Sara Rider' })
    const w = await one<{ balance_halalas: string }>(riderA, `select balance_halalas from wallet_accounts where owner_id = $1`, [riderA])
    expect(Number(w.balance_halalas)).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('fare engine parity with src/core/pricing.ts', () => {
  const classes: VehicleClassId[] = ['go', 'comfort', 'black', 'xl']
  const trips = [[500, 120], [3200, 540], [10_000, 1200], [27_350, 2280], [64_000, 3600]]
  for (const cls of classes) {
    it(`matches quoteFare() for ${cls}`, async () => {
      for (const [m, s] of trips) {
        const sql = await one<Record<string, number>>(riderA,
          `select * from quote_fare('riyadh', $1, $2, $3)`, [cls, m, s])
        const ts = quoteFare({ config: DEFAULT_PRICING, cityId: 'riyadh', classId: cls, distanceKm: m / 1000, durationMin: s / 60 })
        expect({
          base: sql.fare_base_halalas, distance: sql.fare_distance_halalas, time: sql.fare_time_halalas,
          surge: sql.fare_surge_halalas, minFareTopUp: sql.fare_min_topup_halalas, subtotal: sql.fare_subtotal_halalas,
          vat: sql.fare_vat_halalas, total: sql.fare_total_halalas, commission: sql.commission_halalas, driverNet: sql.driver_net_halalas,
        }).toEqual({
          base: ts.base, distance: ts.distance, time: ts.time, surge: ts.surge, minFareTopUp: ts.minFareTopUp,
          subtotal: ts.subtotal, vat: ts.vat, total: ts.total, commission: ts.commission, driverNet: ts.driverNet,
        })
      }
    })
  }

  it('refuses cities that are not in service', async () => {
    await expect(one(riderA, `select * from quote_fare('madinah', 'go', 1000, 60)`)).rejects.toThrow(/not in service/)
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('RLS: riders', () => {
  it('anon has no table access', async () => {
    await expect(rows('anon', `select * from rides`)).rejects.toThrow(/permission denied/)
  })

  it('a rider sees only their own profile and wallet', async () => {
    expect(await rows(riderB, `select id from profiles`)).toEqual([{ id: riderB }])
    const w = await rows<{ owner_id: string }>(riderB, `select owner_id from wallet_accounts`)
    expect(w.map((x) => x.owner_id)).toEqual([riderB])
  })

  it('a rider can edit their name but cannot escalate their role', async () => {
    await as(riderA, (tx) => tx.query(`update profiles set full_name = 'Sara A.' where id = $1`, [riderA]))
    await expect(as(riderA, (tx) => tx.query(`update profiles set role = 'admin' where id = $1`, [riderA])))
      .rejects.toThrow(/permission denied/)
    await expect(as(riderA, (tx) => tx.query(`update profiles set is_blocked = false where id = $1`, [riderA])))
      .rejects.toThrow(/permission denied/)
  })

  it('promo codes are not listable, and service-only RPCs are not callable', async () => {
    expect(await rows(riderA, `select * from promos`)).toEqual([])
    await expect(rows(riderA, `select public.settle_ride(gen_random_uuid())`)).rejects.toThrow(/permission denied/)
    await expect(rows(riderA, `select private.grant_admin($1, 'super_admin')`, [riderA])).rejects.toThrow(/permission denied/)
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('driver onboarding + admin approval + Wasl gate', () => {
  it('a driver applies with vehicle and documents', async () => {
    await as(driver, async (tx) => {
      await tx.query(
        `insert into drivers (id, city_id, national_id, date_of_birth, iban, bank_name)
         values ($1, (select id from cities where code = 'riyadh'), '1012345672', '1990-05-01', 'SA0380000000608010167519', 'Al Rajhi')`,
        [driver])
      vehicleId = (await tx.query<{ id: string }>(
        `insert into vehicles (driver_id, vehicle_class, make, model, year, color, plate_letters, plate_number, sequence_number, seats)
         values ($1, 'comfort', 'Toyota', 'Camry', 2024, 'White', 'ABJ', '1234', '123456789', 4) returning id`, [driver])).rows[0].id
      await tx.query(`update drivers set current_vehicle_id = $2 where id = $1`, [driver, vehicleId])
      for (const t of ['national_id', 'driving_license', 'profile_photo']) {
        await tx.query(
          `insert into driver_documents (driver_id, doc_type, storage_path, expires_at) values ($1::uuid, $2::document_type, $1::text || '/' || $2::text || '.jpg', $3)`,
          [driver, t, t === 'profile_photo' ? null : '2030-06-30'])
      }
      for (const t of ['vehicle_registration', 'vehicle_insurance']) {
        await tx.query(
          `insert into driver_documents (driver_id, vehicle_id, doc_type, storage_path, expires_at) values ($1::uuid, $2::uuid, $3::document_type, $1::text || '/' || $3::text || '.pdf', '2030-06-30')`,
          [driver, vehicleId, t])
      }
    })
    const d = await one<{ status: string }>(driver, `select (submit_driver_application()).status`)
    expect(d.status).toBe('pending_review')
    expect((await one<{ role: string }>(driver, `select role from profiles where id = $1`, [driver])).role).toBe('driver')
  })

  it('a driver cannot approve themselves or touch another driver', async () => {
    await expect(as(driver, (tx) => tx.query(`update drivers set status = 'approved' where id = $1`, [driver])))
      .rejects.toThrow(/permission denied/)
    await expect(as(driver, (tx) => tx.query(
      `insert into driver_documents (driver_id, doc_type, storage_path) values ($1::uuid, 'national_id', $1::text || '/x.jpg')`, [riderB])))
      .rejects.toThrow(/row-level security|violates/)
  })

  it('documents must be stored in the driver folder', async () => {
    await expect(as(driver, (tx) => tx.query(
      `insert into driver_documents (driver_id, doc_type, storage_path) values ($1, 'driving_license', 'someone-else/x.jpg')`, [driver])))
      .rejects.toThrow()
  })

  it('customer support lacks drivers.approve; driver manager approves only after Wasl', async () => {
    await expect(one(support, `select admin_set_driver_status($1, 'approved')`, [driver])).rejects.toThrow(/drivers.approve/)

    const docs = await rows<{ id: string }>(driverManager, `select id from driver_documents where driver_id = $1`, [driver])
    expect(docs).toHaveLength(5)
    for (const d of docs) await one(driverManager, `select admin_review_document($1, true)`, [d.id])
    await one(driverManager, `select admin_review_vehicle($1, true)`, [vehicleId])

    await expect(one(driverManager, `select admin_set_driver_status($1, 'approved')`, [driver])).rejects.toThrow(/Wasl/)

    await one('service', `select record_wasl_result('driver', $1, 'eligibility_check', 'mock', true, 'WASL-D-1')`, [driver])
    await one('service', `select record_wasl_result('vehicle', $1, 'vehicle_registration', 'mock', true, 'WASL-V-1')`, [vehicleId])
    const d = await one<{ status: string }>(driverManager, `select (admin_set_driver_status($1, 'approved')).status`, [driver])
    expect(d.status).toBe('approved')
  })

  it('every approval is in the audit log, visible only with audit.view', async () => {
    const r = await rows<{ action: string; actor_kind: string }>(superAdmin,
      `select action, actor_kind from audit_log where entity_type = 'drivers' and entity_id = $1 order by created_at`, [driver])
    expect(r.some((x) => x.action === 'drivers.update' && x.actor_kind === 'admin')).toBe(true)
    expect(await rows(driverManager, `select * from audit_log`)).toEqual([])
    expect(await rows(riderA, `select * from audit_log`)).toEqual([])
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('ride lifecycle (state machine, dispatch, PIN, settlement)', () => {
  it('driver goes online and pings location; rider map gets anonymised markers', async () => {
    await as(driver, async (tx) => {
      await tx.query(`update drivers set is_online = true where id = $1`, [driver])
      await tx.query(`insert into driver_locations (driver_id, location, heading) values ($1, 'SRID=4326;POINT(46.6700 24.7150)', 92)`, [driver])
    })
    const m = await rows<{ lat: number; vehicle_class: string }>(riderA, `select * from nearby_vehicle_markers(24.7136, 46.6753)`)
    expect(m).toHaveLength(1)
    expect(m[0]).not.toHaveProperty('driver_id')
    expect(m[0].vehicle_class).toBe('comfort')
  })

  it('a driver cannot write another driver location', async () => {
    await expect(as(driver, (tx) => tx.query(
      `insert into driver_locations (driver_id, location) values ($1, 'SRID=4326;POINT(46.6 24.7)')`, [riderB])))
      .rejects.toThrow()
  })

  it('create_ride is service-only and prices the ride on the server', async () => {
    await expect(rows(riderA, `select create_ride($1, 'riyadh', 'go', 24.7136, 46.6753, 'Olaya', 24.7633, 46.6407, 'KAFD', 10000, 1200, 'cash')`, [riderA]))
      .rejects.toThrow(/permission denied/)
    const r = await one<{ id: string; status: string; fare_total_halalas: number; driver_net_halalas: number }>('service',
      `select * from create_ride($1, 'riyadh', 'go', 24.7136, 46.6753, 'Olaya', 24.7633, 46.6407, 'KAFD', 10000, 1200, 'cash')`, [riderA])
    rideId = r.id
    const ts = quoteFare({ config: DEFAULT_PRICING, cityId: 'riyadh', classId: 'go', distanceKm: 10, durationMin: 20 })
    expect(r.status).toBe('searching')
    expect(r.fare_total_halalas).toBe(ts.total)
    expect(r.driver_net_halalas).toBe(ts.driverNet)
  })

  it('rejects pickups outside the service area', async () => {
    await expect(one('service',
      `select * from create_ride($1, 'riyadh', 'go', 21.5, 39.17, 'Jeddah', 24.76, 46.64, 'KAFD', 1000, 60, 'cash')`, [riderB]))
      .rejects.toThrow(/outside the service area/)
  })

  it('one active ride per rider', async () => {
    await expect(one('service',
      `select * from create_ride($1, 'riyadh', 'go', 24.7136, 46.6753, 'Olaya', 24.7633, 46.6407, 'KAFD', 10000, 1200, 'cash')`, [riderA]))
      .rejects.toThrow(/rides_one_active_per_rider_ix|duplicate key/)
  })

  it('PostGIS dispatch finds the comfort captain for a go ride; only the offered driver sees it', async () => {
    const c = await rows<{ driver_id: string; distance_m: number }>('service', `select * from dispatch_candidates($1)`, [rideId])
    expect(c.map((x) => x.driver_id)).toEqual([driver])
    expect(c[0].distance_m).toBeGreaterThan(400)
    expect(await rows(driver, `select id from rides where id = $1`, [rideId])).toEqual([])
    await one('service', `select offer_ride($1, $2, 30)`, [rideId, driver])
    expect(await rows(driver, `select id from rides where id = $1`, [rideId])).toEqual([{ id: rideId }])
    expect(await rows(riderB, `select id from rides where id = $1`, [rideId])).toEqual([])
  })

  it('enforces the transition matrix from src/core/trip.ts', async () => {
    await expect(one(driver, `select transition_ride($1, 'driver_arrived')`, [rideId])).rejects.toThrow(/not allowed|illegal/)
    const a = await one<{ status: string }>(driver, `select (accept_ride($1)).status`, [rideId])
    expect(a.status).toBe('driver_assigned')
    // rider cannot mark arrival; skipping states is illegal
    await expect(one(riderA, `select transition_ride($1, 'driver_arrived')`, [rideId])).rejects.toThrow(/illegal ride transition/)
    await expect(one(driver, `select transition_ride($1, 'completed')`, [rideId])).rejects.toThrow(/illegal ride transition/)
    await one(driver, `select transition_ride($1, 'driver_arriving')`, [rideId])
    await one(driver, `select transition_ride($1, 'driver_arrived')`, [rideId])
  })

  it('rider can see the captain card and track the captain while active', async () => {
    const c = await one<{ counterpart: string; display_name: string; plate: string }>(riderA, `select * from ride_counterpart($1)`, [rideId])
    expect(c).toMatchObject({ counterpart: 'driver', display_name: 'Faisal Captain', plate: 'ABJ 1234' })
    expect(await rows(riderA, `select driver_id from driver_locations`)).toEqual([{ driver_id: driver }])
    expect(await rows(riderB, `select driver_id from driver_locations`)).toEqual([])
  })

  it('trip starts only with the rider PIN', async () => {
    const code = (await one<{ code: string }>(riderA, `select issue_ride_verification_code($1) as code`, [rideId])).code
    expect(code).toMatch(/^\d{4}$/)
    await expect(rows(driver, `select * from private.ride_verification`)).rejects.toThrow(/permission denied/)
    const wrong = code === '0000' ? '1111' : '0000'
    expect((await one<{ ok: boolean }>(driver, `select start_ride($1, $2) as ok`, [rideId, wrong])).ok).toBe(false)
    expect((await one<{ ok: boolean }>(driver, `select start_ride($1, $2) as ok`, [rideId, code])).ok).toBe(true)
    await expect(one(riderA, `select transition_ride($1, 'cancelled')`, [rideId])).rejects.toThrow(/illegal ride transition/)
    await one(driver, `select transition_ride($1, 'completed', null, 10450, 1260)`, [rideId])
  })

  it('records every step in ride_events', async () => {
    const e = await rows<{ to_status: string; actor: string }>(riderA,
      `select to_status, actor from ride_events where ride_id = $1 order by created_at, to_status`, [rideId])
    expect(e.map((x) => x.to_status)).toEqual(
      ['searching', 'driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress', 'completed'])
    await expect(as('service', (tx) => tx.query(`delete from ride_events where ride_id = $1`, [rideId]))).rejects.toThrow(/append-only/)
  })

  it('settles a cash ride with a balanced double entry, once (automatically on completion since Stage 5)', async () => {
    const ride = await one<{ fare_total_halalas: number; commission_halalas: number; fare_vat_halalas: number; driver_net_halalas: number; settled_at: string | null }>(
      riderA, `select * from rides where id = $1`, [rideId])
    expect(ride.settled_at).not.toBeNull()
    await expect(one('service', `select settle_ride($1)`, [rideId])).rejects.toThrow(/already settled/)

    const sum = await one<{ s: string }>('service', `select sum(amount_halalas) s from wallet_ledger where ride_id = $1`, [rideId])
    expect(Number(sum.s)).toBe(0)
    const w = await one<{ balance_halalas: string }>(driver, `select balance_halalas from wallet_accounts where owner_id = $1 and account_type = 'driver_wallet'`, [driver])
    // Captain collected cash: owes commission + VAT to the platform.
    expect(Number(w.balance_halalas)).toBe(ride.driver_net_halalas - ride.fare_total_halalas)
    expect(Number(w.balance_halalas)).toBe(-(ride.commission_halalas + ride.fare_vat_halalas))
    // Captain sees own ledger, rider sees nothing of it.
    expect((await rows(driver, `select id from wallet_ledger`)).length).toBeGreaterThan(0)
    expect(await rows(riderB, `select id from wallet_ledger`)).toEqual([])
  })

  it('ratings work once per side and update the captain average', async () => {
    await one(riderA, `select rate_ride($1, 5, 'Great')`, [rideId])
    await expect(one(riderA, `select rate_ride($1, 4)`, [rideId])).rejects.toThrow(/already rated/)
    expect((await one<{ rating: string }>(driver, `select rating from drivers where id = $1`, [driver])).rating).toBe('5.00')
  })

  it('a captain with a negative balance cannot request a payout', async () => {
    await expect(one(driver, `select request_payout(1000)`)).rejects.toThrow(/exceeds available balance/)
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('financial constraints', () => {
  it('rejects non-positive payment amounts', async () => {
    await expect(as('service', (tx) => tx.query(
      `insert into payments (kind, rider_id, provider, method_type, amount_halalas, idempotency_key)
       values ('wallet_topup', $1, 'mock', 'mada', -500, 'neg-amount-1')`, [riderB]))).rejects.toThrow(/check constraint/)
  })

  it('refunds can never exceed the original payment', async () => {
    const p = await one<{ id: string }>('service',
      `insert into payments (kind, rider_id, provider, method_type, amount_halalas, status, idempotency_key)
       values ('wallet_topup', $1, 'mock', 'mada', 5000, 'paid', 'topup-ok-1') returning id`, [riderB])
    await one('service',
      `insert into payments (kind, parent_payment_id, rider_id, provider, method_type, amount_halalas, status, idempotency_key)
       values ('refund', $1, $2, 'mock', 'mada', 3000, 'paid', 'refund-1') returning id`, [p.id, riderB])
    await expect(one('service',
      `insert into payments (kind, parent_payment_id, rider_id, provider, method_type, amount_halalas, idempotency_key)
       values ('refund', $1, $2, 'mock', 'mada', 2500, 'refund-2') returning id`, [p.id, riderB])).rejects.toThrow(/exceed/)
  })

  it('paid payments cannot go back to another status, and amounts are immutable', async () => {
    await expect(as('service', (tx) => tx.query(`update payments set status = 'initiated' where idempotency_key = 'topup-ok-1'`)))
      .rejects.toThrow(/illegal payment status/)
    await expect(as('service', (tx) => tx.query(`update payments set amount_halalas = 1 where idempotency_key = 'topup-ok-1'`)))
      .rejects.toThrow(/immutable/)
  })

  it('unbalanced ledger transactions are rejected at commit', async () => {
    await expect(as('service', (tx) => tx.query(
      `insert into wallet_ledger (transaction_id, account_id, entry_type, amount_halalas)
       values (gen_random_uuid(), (select id from wallet_accounts where account_type = 'adjustments'), 'adjustment', 100)`)))
      .rejects.toThrow(/unbalanced/)
  })

  it('rider wallets cannot go negative', async () => {
    await expect(as('service', (tx) => tx.query(`
      with t as (select gen_random_uuid() id)
      insert into wallet_ledger (transaction_id, account_id, entry_type, amount_halalas)
      select t.id, a.id, 'adjustment', v.amt from t,
        (values ('rider_wallet'::account_type, -100), ('adjustments'::account_type, 100)) v(kind, amt)
        join wallet_accounts a on a.account_type = v.kind and (a.owner_id = $1 or (a.owner_id is null and v.kind = 'adjustments'))`,
      [riderB]))).rejects.toThrow(/wallet_accounts_non_negative/)
  })

  it('ledger rows are immutable', async () => {
    await expect(as('service', (tx) => tx.query(`update wallet_ledger set amount_halalas = 1`))).rejects.toThrow(/append-only/)
  })

  it('clients cannot write money tables directly', async () => {
    await expect(as(riderA, (tx) => tx.query(
      `insert into payments (kind, rider_id, provider, method_type, amount_halalas, idempotency_key)
       values ('wallet_topup', $1, 'mock', 'mada', 100000, 'self-credit-1')`, [riderA]))).rejects.toThrow(/permission denied/)
    await expect(as(driver, (tx) => tx.query(`update wallet_accounts set balance_halalas = 999999`))).rejects.toThrow(/permission denied/)
  })

  it('finance sees all wallets; the whole ledger nets to zero', async () => {
    expect((await rows(finance, `select id from wallet_accounts`)).length).toBeGreaterThan(4)
    const s = await one<{ s: string }>('service', `select coalesce(sum(amount_halalas), 0) s from wallet_ledger`)
    expect(Number(s.s)).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('support tickets', () => {
  it('rider opens a ticket on their ride; internal notes stay hidden from them', async () => {
    const t = await one<{ id: string; opener_kind: string }>(riderA,
      `insert into tickets (ride_id, category, subject) values ($1, 'lost_item', 'Left my bag') returning id, opener_kind`, [rideId])
    expect(t.opener_kind).toBe('rider')
    await one(riderA, `insert into ticket_messages (ticket_id, body) values ($1, 'Black bag on back seat') returning id`, [t.id])
    await one(support, `insert into ticket_messages (ticket_id, body, is_internal) values ($1, 'Called captain', true) returning id`, [t.id])
    await one(support, `insert into ticket_messages (ticket_id, body) values ($1, 'We found it') returning id`, [t.id])
    const seen = await rows<{ body: string; author_kind: string }>(riderA, `select body, author_kind from ticket_messages order by created_at`)
    expect(seen.map((x) => x.body)).toEqual(['Black bag on back seat', 'We found it'])
    expect(await rows(riderB, `select id from tickets`)).toEqual([])
    await expect(as(riderB, (tx) => tx.query(
      `insert into tickets (ride_id, category, subject) values ($1, 'complaint', 'Not my ride')`, [rideId]))).rejects.toThrow(/row-level security/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Stage 3 — auth hardening + PDPL
// ════════════════════════════════════════════════════════════════════════════
describe('auth hardening', () => {
  it('an admin without MFA (aal1) has no admin powers at all', async () => {
    expect(await as(superAdmin, async (tx) => (await tx.query(`select * from audit_log`)).rows, { aal: 'aal1' })).toEqual([])
    expect(await as(superAdmin, async (tx) => (await tx.query(`select id from drivers`)).rows, { aal: 'aal1' })).toEqual([])
    await expect(as(driverManager, (tx) => tx.query(`select admin_set_driver_status($1, 'suspended', 'test')`, [driver]), { aal: 'aal1' }))
      .rejects.toThrow(/drivers.suspend/)
  })

  it('SQL admin_can() matches DEFAULT_ROLE_PERMISSIONS for every role × permission', async () => {
    const roles = Object.keys(DEFAULT_ROLE_PERMISSIONS) as AdminRole[]
    for (const [i, role] of roles.entries()) {
      const id = await newAdmin(`96651000000${i}`, role)
      const r = await rows<{ p: string; ok: boolean }>(id, `select p, private.admin_can(p) as ok from unnest($1::text[]) p`, [ALL_PERMISSIONS])
      const sqlAllowed = r.filter((x) => x.ok).map((x) => x.p).sort()
      expect({ role, perms: sqlAllowed }).toEqual({ role, perms: [...DEFAULT_ROLE_PERMISSIONS[role]].sort() })
    }
  })

  it('my_identity() reports role, MFA level and missing consents', async () => {
    const me = await one<{ app_role: string; admin_role: string; aal: string }>(finance, `select * from my_identity()`)
    expect(me).toMatchObject({ app_role: 'admin', admin_role: 'finance_manager', aal: 'aal2' })
    const d = await one<{ app_role: string; driver_status: string; missing_driver_consents: string[] }>(driver, `select * from my_identity()`)
    expect(d).toMatchObject({ app_role: 'driver', driver_status: 'approved', missing_driver_consents: [] })
  })
})

describe('PDPL consents', () => {
  let riderC: string

  it('consent versions and required sets match src/privacy/consents.ts', async () => {
    const v = await db.query<{ purpose: string; version: string }>(
      `select p::text as purpose, private.consent_version(p) as version from unnest(enum_range(null::consent_purpose)) p`)
    expect(Object.fromEntries(v.rows.map((x) => [x.purpose, x.version]))).toEqual(CONSENT_VERSIONS)
    for (const app of ['rider', 'driver'] as const) {
      const r = await db.query<{ req: string[] }>(`select private.required_consents($1)::text[] as req`, [app])
      expect([...r.rows[0].req].sort()).toEqual([...REQUIRED_CONSENTS[app]].sort())
    }
  })

  it('a rider without current consents cannot request a ride', async () => {
    riderC = await newUser('966559998888', 'Huda NoConsent')
    const me = await one<{ missing_rider_consents: string[] }>(riderC, `select * from my_identity()`)
    expect([...me.missing_rider_consents].sort()).toEqual(['privacy_policy', 'terms_of_service'])
    await expect(one('service',
      `select * from create_ride($1, 'riyadh', 'go', 24.7136, 46.6753, 'Olaya', 24.7633, 46.6407, 'KAFD', 3000, 600, 'cash')`, [riderC]))
      .rejects.toThrow(/terms and privacy policy/)
  })

  it('rejects consent to an outdated policy version', async () => {
    await expect(one(riderC, `select record_consent('terms_of_service', true, '2020-01-01', 'rider_app')`))
      .rejects.toThrow(/outdated policy version/)
  })

  it('after accepting, consent history is current, append-only and private', async () => {
    await acceptRequiredConsents(riderC, 'rider')
    await one(riderC, `select record_consent('marketing_communications', false, $1, 'rider_app')`, [CONSENT_VERSIONS.marketing_communications])
    const c = await rows<{ purpose: string; is_current: boolean }>(riderC, `select purpose, is_current from my_consents()`)
    expect(c.filter((x) => x.is_current).map((x) => x.purpose).sort()).toEqual(['privacy_policy', 'terms_of_service'])
    expect(await rows(riderB, `select id from user_consents where user_id = $1`, [riderC])).toEqual([])
    await expect(as('service', (tx) => tx.query(`delete from user_consents where user_id = $1`, [riderC]))).rejects.toThrow(/append-only/)
    expect(await rows(superAdmin, `select id from user_consents where user_id = $1`, [riderC])).toHaveLength(3)
  })

  it('withdrawing location consent takes the captain offline and blocks going online', async () => {
    await as(driver, (tx) => tx.query(`update drivers set is_online = true where id = $1`, [driver]))
    await one(driver, `select record_consent('location_tracking', false, $1, 'driver_app')`, [CONSENT_VERSIONS.location_tracking])
    expect((await one<{ is_online: boolean }>(driver, `select is_online from drivers where id = $1`, [driver])).is_online).toBe(false)
    await expect(as(driver, (tx) => tx.query(`update drivers set is_online = true where id = $1`, [driver])))
      .rejects.toThrow(/location and regulatory/)
    await one(driver, `select record_consent('location_tracking', true, $1, 'driver_app')`, [CONSENT_VERSIONS.location_tracking])
    await as(driver, (tx) => tx.query(`update drivers set is_online = true where id = $1`, [driver]))
  })
})

describe('PDPL data-subject rights', () => {
  it('export_my_data returns only the caller data and logs an access request', async () => {
    const { d } = await one<{ d: Record<string, unknown> }>(riderA, `select export_my_data() as d`)
    expect(d.format).toBe('aura.personal-data.v2')
    expect((d.profile as Record<string, unknown>).phone).toBe('+966551112222')
    expect(d.rides_as_rider).toHaveLength(1)
    expect((d.rides_as_rider as Record<string, unknown>[])[0]).not.toHaveProperty('rating_by_driver')
    expect(JSON.stringify(d)).not.toContain('966553334444') // rider B's phone
    expect(await rows(riderA, `select request_type, status from privacy_requests`)).toEqual([{ request_type: 'access', status: 'completed' }])
  })

  it('deletion: only privacy.manage completes it; personal data is erased, legal records kept', async () => {
    const riderD = await newUser('966557770000', 'Nora ToDelete')
    await acceptRequiredConsents(riderD, 'rider')
    await as(riderD, (tx) => tx.query(
      `update riders set emergency_contact_name = 'Mum', emergency_contact_phone = '+966500001111' where id = $1`, [riderD]))
    const req = await one<{ id: string; due_at: string }>(riderD, `select * from submit_privacy_request('deletion', 'Please delete my account')`)
    expect(new Date(req.due_at).getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000)
    await expect(one(riderD, `select * from submit_privacy_request('deletion')`)).rejects.toThrow(/already have an open/)
    await expect(one(support, `select admin_update_privacy_request($1, 'completed')`, [req.id])).rejects.toThrow(/privacy.manage/)

    await one(superAdmin, `select admin_update_privacy_request($1, 'completed', 'Erased per PDPL request')`, [req.id])
    const p = await db.query(`select full_name, phone, is_blocked from profiles where id = $1`, [riderD])
    expect(p.rows[0]).toEqual({ full_name: null, phone: null, is_blocked: true })
    const r = await db.query(`select emergency_contact_name from riders where id = $1`, [riderD])
    expect(r.rows[0]).toEqual({ emergency_contact_name: null })
    // Consent proof is retained; audit entries for the erasure carry no personal values.
    expect((await db.query(`select id from user_consents where user_id = $1`, [riderD])).rows).toHaveLength(2)
    const audit = await db.query<{ old_data: unknown; new_data: unknown }>(
      `select old_data, new_data from audit_log where entity_id = $1 and action like '%.erase'`, [riderD])
    expect(audit.rows.length).toBeGreaterThan(0)
    expect(audit.rows.every((a) => a.old_data === null && a.new_data === null)).toBe(true)
  })

  it('erasure is refused while money is owed (the wallet must be settled first)', async () => {
    const req = await one<{ id: string }>(driver, `select * from submit_privacy_request('deletion')`)
    await expect(one(superAdmin, `select admin_update_privacy_request($1, 'completed')`, [req.id])).rejects.toThrow(/settle the wallet/)
    await one(driver, `select cancel_privacy_request($1)`, [req.id])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Stage 4 — dispatch, live location, breadcrumbs, ride view
// ════════════════════════════════════════════════════════════════════════════
let captainSeq = 0
/** An approved, consented, online captain with an approved vehicle (set up directly, as ops would). */
async function makeCaptain(phone: string, name: string, cls: VehicleClassId, lat: number, lng: number): Promise<string> {
  captainSeq += 1
  const id = await newUser(phone, name)
  await db.query(
    `insert into drivers (id, status, city_id, national_id, date_of_birth, iban, approved_at, wasl_status)
     values ($1, 'approved', (select id from cities where code = 'riyadh'), $2, '1991-02-03', 'SA0380000000608010167519', now(), 'eligible')`,
    [id, `10${String(70000000 + captainSeq)}`])
  const v = await db.query<{ id: string }>(
    `insert into vehicles (driver_id, vehicle_class, make, model, year, color, plate_letters, plate_number, sequence_number, seats, status, wasl_status)
     values ($1, $2, 'Hyundai', 'Elantra', 2024, 'Silver', 'KSA', $3, $4, 4, 'approved', 'eligible') returning id`,
    [id, cls, String(1000 + captainSeq), String(900000000 + captainSeq)])
  await db.query(`update drivers set current_vehicle_id = $2 where id = $1`, [id, v.rows[0].id])
  // Approved, unexpired documents (required to go online since Stage 6).
  await db.query(
    `insert into driver_documents (driver_id, vehicle_id, doc_type, storage_path, status, expires_at)
     select $1::uuid, case when t in ('vehicle_registration', 'vehicle_insurance') then $2::uuid end, t, $1::text || '/' || t::text || '.jpg', 'approved', '2030-06-30'
       from unnest(array['national_id', 'driving_license', 'profile_photo', 'vehicle_registration', 'vehicle_insurance']::document_type[]) t`,
    [id, v.rows[0].id])
  await acceptRequiredConsents(id, 'driver')
  await db.query(`update drivers set is_online = true where id = $1`, [id])
  await one(id, `select update_driver_location($1, $2, 90, 0, 8) as ok`, [lat, lng])
  return id
}

/** Pretend the last GPS fix is older, so the next fix is not an implausible jump (tests ping instantly). */
async function ageLastFix(driverId: string, seconds: number) {
  await db.exec(`set session_replication_role = replica`)
  await db.query(`update driver_locations set updated_at = now() - make_interval(secs => $2) where driver_id = $1`, [driverId, seconds])
  await db.exec(`set session_replication_role = origin`)
}

describe('Stage 4: dispatch, live location and breadcrumbs', () => {
  let capNear: string
  let capFar: string
  let rider4: string
  let ride1: string
  let ride2: string
  const PICKUP = [24.848, 46.598] as const
  const createRide = (rider: string) =>
    one<{ id: string }>('service',
      `select id from create_ride($1, 'riyadh', 'go', $2, $3, 'Pickup north', 24.80, 46.65, 'Drop', 6000, 900, 'cash')`,
      [rider, PICKUP[0], PICKUP[1]])

  it('captains publish GPS; lat/lng columns are generated for Realtime payloads', async () => {
    capNear = await makeCaptain('966541000001', 'Near Captain', 'go', 24.850, 46.600)
    capFar = await makeCaptain('966541000002', 'Far Captain', 'comfort', 24.862, 46.612)
    const loc = await one<{ lat: number; lng: number; is_available: boolean; vehicle_class: string }>(capNear,
      `select lat, lng, is_available, vehicle_class from driver_locations where driver_id = $1`, [capNear])
    expect(loc.lat).toBeCloseTo(24.85, 6)
    expect(loc.lng).toBeCloseTo(46.6, 6)
    expect(loc).toMatchObject({ is_available: true, vehicle_class: 'go' })
  })

  it('rejects implausible jumps, non-captains, and stops tracking when offline', async () => {
    expect((await one<{ ok: boolean }>(capNear, `select update_driver_location(21.54, 39.17) as ok`)).ok).toBe(false) // Riyadh → Jeddah in ms
    expect((await one<{ lat: number }>(capNear, `select lat from driver_locations where driver_id = $1`, [capNear])).lat).toBeCloseTo(24.85, 6)
    rider4 = await newUser('966541000003', 'Rider Four')
    await acceptRequiredConsents(rider4, 'rider')
    await expect(one(rider4, `select update_driver_location(24.8, 46.6)`)).rejects.toThrow(/approved captains/)
    await as(capFar, (tx) => tx.query(`update drivers set is_online = false where id = $1`, [capFar]))
    expect((await one<{ ok: boolean }>(capFar, `select update_driver_location(24.862, 46.612) as ok`)).ok).toBe(false)
    await as(capFar, (tx) => tx.query(`update drivers set is_online = true where id = $1`, [capFar]))
    await ageLastFix(capFar, 30)
    expect((await one<{ ok: boolean }>(capFar, `select update_driver_location(24.862, 46.612) as ok`)).ok).toBe(true)
  })

  it('dispatch offers the nearest captain, then the next on decline, then nobody', async () => {
    ride1 = (await createRide(rider4)).id
    expect((await one<{ d: string }>('service', `select dispatch_ride($1) as d`, [ride1])).d).toBe(capNear)
    expect(await rows(capFar, `select id from rides where id = $1`, [ride1])).toEqual([])
    expect(await rows(capNear, `select id from rides where id = $1`, [ride1])).toEqual([{ id: ride1 }])

    await one(capNear, `select decline_ride($1)`, [ride1])
    const r = await one<{ offered_driver_id: string }>('service', `select offered_driver_id from rides where id = $1`, [ride1])
    expect(r.offered_driver_id).toBe(capFar)
    expect(Number((await one<{ a: string }>(capNear, `select acceptance_rate a from drivers where id = $1`, [capNear])).a)).toBe(0)

    await db.query(`update rides set offer_expires_at = now() - interval '1 second' where id = $1`, [ride1])
    await one('service', `select expire_ride_offers()`)
    const after = await one<{ offered_driver_id: string | null; status: string }>('service', `select offered_driver_id, status from rides where id = $1`, [ride1])
    expect(after).toEqual({ offered_driver_id: null, status: 'searching' })
    const offers = await rows<{ driver_id: string; response: string }>('service',
      `select driver_id, response from ride_offers where ride_id = $1 order by offered_at`, [ride1])
    expect(offers).toEqual([{ driver_id: capNear, response: 'declined' }, { driver_id: capFar, response: 'expired' }])
    expect(await rows(capNear, `select ride_id from ride_offers where driver_id <> $1`, [capNear])).toEqual([])
  })

  it('quote_trip applies zone surge exactly like create_ride', async () => {
    const kafd = [24.763, 46.641] // inside the 1.2× KAFD zone from seed.sql
    const q = await one<{ surge_multiplier: string; fare_total_halalas: number }>(riderA,
      `select surge_multiplier, fare_total_halalas from quote_trip('riyadh', 'comfort', $1, $2, 8000, 1100)`, kafd)
    expect(Number(q.surge_multiplier)).toBe(1.2)
    const rider5 = await newUser('966541000005', 'Rider Five')
    await acceptRequiredConsents(rider5, 'rider')
    const r = await one<{ fare_total_halalas: number; surge_multiplier: string }>('service',
      `select fare_total_halalas, surge_multiplier from create_ride($1, 'riyadh', 'comfort', $2, $3, 'KAFD', 24.70, 46.68, 'Olaya', 8000, 1100, 'cash')`,
      [rider5, ...kafd])
    expect(r).toEqual({ fare_total_halalas: q.fare_total_halalas, surge_multiplier: q.surge_multiplier })
    await one('service', `select transition_ride(id, 'cancelled', 'test') from rides where rider_id = $1`, [rider5])
  })

  it('gives up after the maximum search time (system cancellation)', async () => {
    await one('service', `select expire_ride_offers(0)`)
    const r = await one<{ status: string; cancelled_by: string; cancellation_reason: string }>('service',
      `select status, cancelled_by, cancellation_reason from rides where id = $1`, [ride1])
    expect(r).toEqual({ status: 'cancelled', cancelled_by: 'system', cancellation_reason: 'no_captain_available' })
  })

  it('accepting marks the offer accepted; rider sees the captain live via ride_view', async () => {
    ride2 = (await createRide(rider4)).id
    expect((await one<{ d: string }>('service', `select dispatch_ride($1) as d`, [ride2])).d).toBe(capNear)
    await one(capNear, `select accept_ride($1)`, [ride2])
    expect((await one<{ response: string }>('service', `select response from ride_offers where ride_id = $1`, [ride2])).response).toBe('accepted')
    await one(capNear, `select transition_ride($1, 'driver_arriving')`, [ride2])

    const v = await one<{ v: { viewer: string; status: string; pickup: { lat: number }; driver: { name: string; vehicle: { plate_letters: string }; location: { lat: number } }; events: unknown[] } }>(
      rider4, `select ride_view($1) as v`, [ride2])
    expect(v.v.viewer).toBe('rider')
    expect(v.v.status).toBe('driver_arriving')
    expect(v.v.pickup.lat).toBeCloseTo(PICKUP[0], 6)
    expect(v.v.driver.name).toBe('Near Captain')
    expect(v.v.driver.vehicle.plate_letters).toBe('KSA')
    expect(v.v.driver.location.lat).toBeCloseTo(24.85, 6)
    expect(v.v.events.length).toBe(3)
    await expect(one(riderB, `select ride_view($1)`, [ride2])).rejects.toThrow(/not a participant/)
  })

  it('breadcrumbs during the trip give the actual distance on completion', async () => {
    await one(capNear, `select transition_ride($1, 'driver_arrived')`, [ride2])
    const code = (await one<{ c: string }>(rider4, `select issue_ride_verification_code($1) as c`, [ride2])).c
    expect((await one<{ ok: boolean }>(capNear, `select start_ride($1, $2) as ok`, [ride2, code])).ok).toBe(true)

    // Drive ~300 m steps south-east, one fix every "30 s".
    const path: [number, number][] = [[24.8480, 46.5980], [24.8457, 46.6000], [24.8434, 46.6020], [24.8411, 46.6040], [24.8388, 46.6060]]
    for (const [lat, lng] of path) {
      await ageLastFix(capNear, 30)
      await db.exec(`set session_replication_role = replica`)
      await db.query(`update ride_route_points set recorded_at = recorded_at - interval '30 seconds' where ride_id = $1`, [ride2])
      await db.exec(`set session_replication_role = origin`)
      expect((await one<{ ok: boolean }>(capNear, `select update_driver_location($1, $2, 135, 36, 6) as ok`, [lat, lng])).ok).toBe(true)
    }
    expect(await rows(riderB, `select id from ride_route_points where ride_id = $1`, [ride2])).toEqual([])
    const pts = await rows(rider4, `select id from ride_route_points where ride_id = $1`, [ride2])
    expect(pts).toHaveLength(5)

    await one(capNear, `select transition_ride($1, 'completed')`, [ride2])
    const done = await one<{ actual_distance_m: number; actual_duration_s: number }>('service',
      `select actual_distance_m, actual_duration_s from rides where id = $1`, [ride2])
    const expected = path.slice(1).reduce((s, p, i) => s + haversineKm({ lat: path[i][0], lng: path[i][1] }, { lat: p[0], lng: p[1] }) * 1000, 0)
    expect(Math.abs(done.actual_distance_m - expected) / expected).toBeLessThan(0.01)
    expect(done.actual_duration_s).toBeGreaterThanOrEqual(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Stage 5: payments, tips, wallet holds, settlement, captain settlements
// ════════════════════════════════════════════════════════════════════════════
describe('Stage 5: payments, wallet and settlements', () => {
  let cap5: string
  let rider6: string
  let rider7: string
  let walletRide: string
  let cardRide: string
  let chargeId: string
  const AT = [24.902, 46.702] as const
  const balance = async (owner: string, type = 'rider_wallet') =>
    BigInt((await one<{ b: string }>('service', `select balance_halalas::text b from wallet_accounts where owner_id = $1 and account_type = $2`, [owner, type])).b)
  const platform = async (type: string) =>
    BigInt((await one<{ b: string }>('service', `select balance_halalas::text b from wallet_accounts where owner_id is null and account_type = $1`, [type])).b)
  const ride = (rider: string, method: string) =>
    one<{ id: string; fare_total_halalas: number; driver_net_halalas: number }>('service',
      `select id, fare_total_halalas, driver_net_halalas from create_ride($1, 'riyadh', 'go', $2, $3, 'North', 24.88, 46.72, 'Drop', 4000, 600, $4)`,
      [rider, AT[0], AT[1], method])
  const topUp = async (rider: string, amount: number) => {
    const p = await one<{ id: string }>('service', `select id from create_payment_intent($1, 'wallet_topup', null, $2, 'mada', 'mock')`, [rider, amount])
    await one('service', `select record_provider_payment($1, 'paid', $2, $3)`, [p.id, `mock_${p.id}`, amount])
    return p.id
  }
  /** Drive an accepted ride to completion as cap5. */
  const driveToEnd = async (id: string, rider: string) => {
    await one(cap5, `select accept_ride($1)`, [id])
    await one(cap5, `select transition_ride($1, 'driver_arriving')`, [id])
    await one(cap5, `select transition_ride($1, 'driver_arrived')`, [id])
    const code = (await one<{ c: string }>(rider, `select issue_ride_verification_code($1) as c`, [id])).c
    expect((await one<{ ok: boolean }>(cap5, `select start_ride($1, $2) as ok`, [id, code])).ok).toBe(true)
    await one(cap5, `select transition_ride($1, 'completed')`, [id])
  }

  it('wallet top-up via card credits the wallet once, even if the webhook is replayed', async () => {
    cap5 = await makeCaptain('966542000001', 'Stage5 Captain', 'go', 24.903, 46.703)
    rider6 = await newUser('966542000002', 'Wallet Rider')
    rider7 = await newUser('966542000003', 'Card Rider')
    await acceptRequiredConsents(rider6, 'rider')
    await acceptRequiredConsents(rider7, 'rider')
    const pay = await topUp(rider6, 20000)
    await one('service', `select record_provider_payment($1, 'paid', $2, 20000)`, [pay, `mock_${pay}`]) // replay
    expect(await balance(rider6)).toBe(20000n)
    await expect(one('service', `select create_payment_intent($1, 'wallet_topup', null, 500, 'mada', 'mock')`, [rider6])).rejects.toThrow(/top-up must be between/)
  })

  it('wallet ride: fare reserved at request and released on cancellation', async () => {
    const holds0 = await platform('wallet_holds')
    const r = await ride(rider6, 'wallet')
    expect(await balance(rider6)).toBe(20000n - BigInt(r.fare_total_halalas))
    expect(await platform('wallet_holds')).toBe(holds0 + BigInt(r.fare_total_halalas))
    await one(rider6, `select transition_ride($1, 'cancelled', 'changed plans')`, [r.id])
    expect(await balance(rider6)).toBe(20000n)
    expect(await platform('wallet_holds')).toBe(holds0)
  })

  it('wallet ride: settled from the hold on completion (captain credited, books balanced)', async () => {
    const r = await ride(rider6, 'wallet')
    walletRide = r.id
    const driver0 = await balance(cap5, 'driver_wallet')
    expect((await one<{ d: string }>('service', `select dispatch_ride($1) as d`, [r.id])).d).toBe(cap5)
    await driveToEnd(r.id, rider6)
    expect(await balance(rider6)).toBe(20000n - BigInt(r.fare_total_halalas))
    expect(await balance(cap5, 'driver_wallet')).toBe(driver0 + BigInt(r.driver_net_halalas))
    const s = await one<{ settled: boolean }>('service', `select settled_at is not null as settled from rides where id = $1`, [r.id])
    expect(s.settled).toBe(true)
  })

  it('wallet tips: limits, 100% to the captain, only once', async () => {
    await expect(one(rider6, `select add_wallet_tip($1, 50)`, [walletRide])).rejects.toThrow(/tip must be between/)
    await expect(one(rider7, `select add_wallet_tip($1, 500)`, [walletRide])).rejects.toThrow(/not your ride/)
    const d0 = await balance(cap5, 'driver_wallet')
    expect((await one<{ t: string }>(rider6, `select add_wallet_tip($1, 500) as t`, [walletRide])).t).toBe('500')
    expect(await balance(cap5, 'driver_wallet')).toBe(d0 + 500n)
    await expect(one(rider6, `select add_wallet_tip($1, 500)`, [walletRide])).rejects.toThrow(/already has a tip/)
  })

  it('card ride: not dispatched until authorized, captured on completion, then settled', async () => {
    const r = await ride(rider7, 'card')
    cardRide = r.id
    expect((await one<{ d: string | null }>('service', `select dispatch_ride($1) as d`, [r.id])).d).toBeNull()
    const intent = await one<{ id: string; amount_halalas: number; status: string }>('service',
      `select * from create_payment_intent($1, 'charge', $2, null, 'card', 'mock')`, [rider7, r.id])
    chargeId = intent.id
    expect(intent).toMatchObject({ amount_halalas: r.fare_total_halalas, status: 'initiated' })
    const again = await one<{ id: string }>('service', `select id from create_payment_intent($1, 'charge', $2, null, 'card', 'mock')`, [rider7, r.id])
    expect(again.id).toBe(chargeId)

    await one('service', `select record_provider_payment($1, 'authorized', 'mock_auth_1', $2)`, [chargeId, r.fare_total_halalas])
    expect((await one<{ o: string }>('service', `select offered_driver_id o from rides where id = $1`, [r.id])).o).toBe(cap5)
    await driveToEnd(r.id, rider7)

    expect((await one<{ s: boolean }>('service', `select settled_at is null s from rides where id = $1`, [r.id])).s).toBe(true)
    const q = await rows<{ payment_id: string; action: string }>('service', `select * from payment_work_queue()`)
    expect(q).toContainEqual(expect.objectContaining({ payment_id: chargeId, action: 'capture' }))

    const gw0 = await platform('gateway_clearing')
    await one('service', `select record_provider_payment($1, 'paid', 'mock_auth_1', $2)`, [chargeId, r.fare_total_halalas])
    expect((await one<{ s: boolean }>('service', `select settled_at is not null s from rides where id = $1`, [r.id])).s).toBe(true)
    expect(await platform('gateway_clearing')).toBe(gw0 - BigInt(r.fare_total_halalas))
  })

  it('card tip is credited to the captain only when the provider confirms payment', async () => {
    const tip = await one<{ id: string }>('service', `select id from create_payment_intent($1, 'tip', $2, 1000, 'card', 'mock')`, [rider7, cardRide])
    const d0 = await balance(cap5, 'driver_wallet')
    await one('service', `select record_provider_payment($1, 'failed', null, null, 'declined')`, [tip.id])
    expect(await balance(cap5, 'driver_wallet')).toBe(d0)
    const tip2 = await one<{ id: string }>('service', `select id from create_payment_intent($1, 'tip', $2, 1000, 'card', 'mock')`, [rider7, cardRide])
    await one('service', `select record_provider_payment($1, 'paid', 'mock_tip', 1000)`, [tip2.id])
    expect(await balance(cap5, 'driver_wallet')).toBe(d0 + 1000n)
    expect((await one<{ t: number }>('service', `select tip_halalas t from rides where id = $1`, [cardRide])).t).toBe(1000)
  })

  it('never accepts a different amount from the provider (tampering) and flags it', async () => {
    const p = await one<{ id: string }>('service', `select id from create_payment_intent($1, 'wallet_topup', null, 5000, 'mada', 'mock')`, [rider7])
    const before = await balance(rider7)
    const r = await one<{ status: string; failure_code: string }>('service',
      `select status, failure_code from record_provider_payment($1, 'paid', 'mock_x', 4000)`, [p.id])
    expect(r).toEqual({ status: 'failed', failure_code: 'amount_mismatch' })
    expect(await balance(rider7)).toBe(before)
    const h = await one<{ h: { amount_mismatch_payments: number } }>('service', `select ledger_health() as h`)
    expect(h.h.amount_mismatch_payments).toBeGreaterThanOrEqual(1)
  })

  it('a failed authorization cancels the unpaid card ride', async () => {
    const r = await ride(rider7, 'card')
    const intent = await one<{ id: string }>('service', `select id from create_payment_intent($1, 'charge', $2, null, 'card', 'mock')`, [rider7, r.id])
    await one('service', `select record_provider_payment($1, 'failed', null, null, 'card_declined', 'Insufficient funds')`, [intent.id])
    const x = await one<{ status: string; cancellation_reason: string }>('service', `select status, cancellation_reason from rides where id = $1`, [r.id])
    expect(x).toEqual({ status: 'cancelled', cancellation_reason: 'payment_failed' })
  })

  it('refunds: card refunds are queued for the provider; wallet rides refund to the wallet', async () => {
    await expect(one(support, `select admin_refund_payment($1, 500, 'x')`, [chargeId])).rejects.toThrow(/finance.settle/)
    const ref = await one<{ id: string; status: string }>(finance, `select id, status from admin_refund_payment($1, 1000, 'Long detour')`, [chargeId])
    expect(ref.status).toBe('initiated')
    const q = await rows<{ payment_id: string; action: string; provider_payment_id: string }>('service', `select * from payment_work_queue()`)
    expect(q).toContainEqual(expect.objectContaining({ payment_id: ref.id, action: 'refund', provider_payment_id: 'mock_auth_1' }))
    const adj0 = await platform('adjustments')
    await one('service', `select record_provider_payment($1, 'paid', 'mock_ref_1', 1000)`, [ref.id])
    expect(await platform('adjustments')).toBe(adj0 - 1000n)
    await expect(one(finance, `select admin_refund_payment($1, 999999, 'too much')`, [chargeId])).rejects.toThrow(/exceed/)

    const w0 = await balance(rider6)
    expect((await one<{ r: string }>(finance, `select admin_refund_wallet_ride($1, 300, 'Detour') as r`, [walletRide])).r).toBe('300')
    expect(await balance(rider6)).toBe(w0 + 300n)
    await expect(one(finance, `select admin_refund_wallet_ride($1, 999999, 'x')`, [walletRide])).rejects.toThrow(/exceeds the fare/)
  })

  it('captain settlements: earnings statement, cash deposit, weekly payout batch, payout', async () => {
    const st = await one<{ s: Record<string, string | number | null> }>(cap5, `select driver_earnings(now() - interval '1 day') as s`)
    expect(st.s.rides).toBe(2)
    expect(st.s.tips_halalas).toBe('1500')
    expect(typeof st.s.balance_halalas).toBe('string')
    expect(BigInt(st.s.balance_halalas as string)).toBe(await balance(cap5, 'driver_wallet'))

    // The Stage 2 captain owes commission + VAT from cash rides: deposit enough to end at 60 SAR.
    const owed = await balance(driver, 'driver_wallet')
    expect(owed < 0n).toBe(true)
    const dep = 6000n - owed
    await expect(one(support, `select admin_record_cash_deposit($1, $2, 'DEP-1')`, [driver, dep.toString()])).rejects.toThrow(/finance.settle/)
    expect((await one<{ b: string }>(finance, `select admin_record_cash_deposit($1, $2, 'DEP-1') as b`, [driver, dep.toString()])).b).toBe('6000')

    expect((await one<{ n: number }>(finance, `select create_payout_batch() as n`)).n).toBeGreaterThanOrEqual(1)
    const p = await one<{ id: string; amount_halalas: string }>('service',
      `select id, amount_halalas::text from payouts where driver_id = $1 and status = 'pending'`, [driver])
    expect(p.amount_halalas).toBe('6000')
    await one(finance, `select admin_set_payout_status($1, 'approved')`, [p.id])
    await one(finance, `select admin_set_payout_status($1, 'processing')`, [p.id])
    await one('service', `select complete_payout($1, true, 'mock_payout_1')`, [p.id])
    expect(await balance(driver, 'driver_wallet')).toBe(0n)
  })

  it('statements are private and money functions are service-only', async () => {
    const w = await one<{ w: { balance_halalas: string; entries: { type: string }[] } }>(rider6, `select my_wallet() as w`)
    expect(BigInt(w.w.balance_halalas)).toBe(await balance(rider6))
    expect(w.w.entries.some((e) => e.type === 'hold')).toBe(true)
    await expect(one(rider6, `select driver_earnings(now() - interval '1 day')`)).rejects.toThrow(/captains only/)
    await expect(one(rider6, `select record_provider_payment($1, 'paid', 'x', 1)`, [chargeId])).rejects.toThrow(/permission denied/)
    await expect(one(rider6, `select create_payment_intent($1, 'wallet_topup', null, 5000, 'mada', 'mock')`, [rider6])).rejects.toThrow(/permission denied/)
    await expect(one(rider6, `select ledger_health()`)).rejects.toThrow(/finance.view/)
  })

  it('the whole ledger is consistent after every flow in this suite', async () => {
    const h = await one<{ h: { ok: boolean; ledger_sum_halalas: string; unbalanced_transactions: number; account_balance_mismatches: number } }>(finance, `select ledger_health() as h`)
    expect(h.h).toMatchObject({ ok: true, ledger_sum_halalas: '0', unbalanced_transactions: 0, account_balance_mismatches: 0 })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Stage 6: Wasl, onboarding rules, document expiry, safety, PDPL completeness
// ════════════════════════════════════════════════════════════════════════════
describe('Stage 6: compliance', () => {
  let applicant: string
  let applicantVehicle: string
  let cap6: string
  let rider9: string
  let ride6: string
  const validId = (n: number) => {
    const first9 = `10${String(9000000 + n)}`
    return first9 + saudiIdCheckDigit(first9)
  }
  const IBAN = 'SA0380000000608010167519'
  const queue = (entity?: string) =>
    rows<{ entity_type: string; entity_id: string; operation: string; attempt: number; payload: Record<string, unknown> }>('service',
      `select * from wasl_work_queue(200)`).then((q) => (entity ? q.filter((x) => x.entity_id === entity) : q))

  it('validators: SQL and TypeScript agree on Saudi IDs and IBANs', async () => {
    const ids = ['1012345672', '1012345678', validId(1), validId(2), '2' + validId(3).slice(1, 9) + '0', '3012345672', '101234567']
    for (const id of ids) {
      const r = await db.query<{ ok: boolean }>(`select private.valid_saudi_id($1) ok`, [id])
      expect({ id, ok: r.rows[0].ok }).toEqual({ id, ok: isValidSaudiId(id) })
    }
    for (const iban of [IBAN, 'SA0380000000608010167518', 'SA44 2000 0001 2345 6789 1234'.replace(/\s/g, ''), 'GB82WEST12345698765432']) {
      const r = await db.query<{ ok: boolean }>(`select private.valid_saudi_iban($1) ok`, [iban])
      expect({ iban, ok: r.rows[0].ok }).toEqual({ iban, ok: isValidSaudiIban(iban) })
    }
  })

  it('application rules: valid ID, valid IBAN, consents, document expiry, vehicle age', async () => {
    const bad = await newUser('966543000001', 'Bad ID')
    await as(bad, (tx) => tx.query(
      `insert into drivers (id, city_id, national_id, date_of_birth, iban) values ($1, (select id from cities where code = 'riyadh'), '1000000001', '1990-01-01', $2)`, [bad, IBAN]))
    await expect(one(bad, `select submit_driver_application()`)).rejects.toThrow(/national ID \/ Iqama number is not valid/)

    applicant = await newUser('966543000002', 'Ahmed Applicant')
    await as(applicant, async (tx) => {
      await tx.query(`insert into drivers (id, city_id, national_id, date_of_birth, iban) values ($1, (select id from cities where code = 'riyadh'), $2, '1992-03-04', 'SA0380000000608010167518')`,
        [applicant, validId(10)])
      applicantVehicle = (await tx.query<{ id: string }>(
        `insert into vehicles (driver_id, vehicle_class, make, model, year, color, plate_letters, plate_number, sequence_number, seats)
         values ($1, 'go', 'Toyota', 'Corolla', 2009, 'White', 'BDR', '4455', '700100200', 4) returning id`, [applicant])).rows[0].id
      await tx.query(`update drivers set current_vehicle_id = $2 where id = $1`, [applicant, applicantVehicle])
      for (const t of ['national_id', 'driving_license', 'profile_photo']) {
        await tx.query(`insert into driver_documents (driver_id, doc_type, storage_path, expires_at) values ($1::uuid, $2::document_type, $1::text || '/' || $2::text || '.jpg', $3)`,
          [applicant, t, t === 'driving_license' ? '2020-01-01' : t === 'profile_photo' ? null : '2031-01-01'])
      }
      for (const t of ['vehicle_registration', 'vehicle_insurance']) {
        await tx.query(`insert into driver_documents (driver_id, vehicle_id, doc_type, storage_path, expires_at) values ($1::uuid, $2::uuid, $3::document_type, $1::text || '/' || $3::text || '.pdf', '2031-01-01')`,
          [applicant, applicantVehicle, t])
      }
    })
    await expect(one(applicant, `select submit_driver_application()`)).rejects.toThrow(/not a valid Saudi IBAN/)
    await as(applicant, (tx) => tx.query(`update drivers set iban = $2 where id = $1`, [applicant, IBAN]))
    await expect(one(applicant, `select submit_driver_application()`)).rejects.toThrow(/accept the captain terms/)
    await acceptRequiredConsents(applicant, 'driver')
    await expect(one(applicant, `select submit_driver_application()`)).rejects.toThrow(/older than 10 years/)
    // Vehicle year is fixed after insert for drivers; ops corrects it (as a re-registration would).
    await db.query(`update vehicles set year = 2023 where id = $1`, [applicantVehicle])
    await expect(one(applicant, `select submit_driver_application()`)).rejects.toThrow(/past expiry date: driving_license/)
    await db.query(`update driver_documents set expires_at = '2031-01-01' where driver_id = $1 and doc_type = 'driving_license'`, [applicant])
    const d = await one<{ status: string; wasl_status: string }>(applicant, `select status, wasl_status from submit_driver_application()`)
    expect(d).toMatchObject({ status: 'pending_review', wasl_status: 'pending' })
  })

  it('Wasl queue: registration with retry backoff, then eligibility', async () => {
    const q = await queue(applicant)
    expect(q.map((x) => [x.operation, x.attempt])).toEqual([['driver_registration', 1]])
    expect(q[0].payload).toMatchObject({ national_id: validId(10), full_name: 'Ahmed Applicant', city: 'riyadh' })
    expect((await queue(applicantVehicle)).map((x) => x.operation)).toEqual(['vehicle_registration'])

    // Technical error → retried later with backoff, never downgrades to ineligible.
    await one('service', `select record_wasl_result('driver', $1, 'driver_registration', 'mock', false, null, null, null, 'timeout')`, [applicant])
    expect(await queue(applicant)).toEqual([])
    expect((await one<{ wasl_status: string }>('service', `select wasl_status from drivers where id = $1`, [applicant])).wasl_status).toBe('error')
    await db.query(`update wasl_sync_log set next_retry_at = now() - interval '1 second' where entity_id = $1`, [applicant])
    expect((await queue(applicant)).map((x) => x.attempt)).toEqual([2])

    await one('service', `select record_wasl_result('driver', $1, 'driver_registration', 'mock', true, 'WASL-D-77')`, [applicant])
    await one('service', `select record_wasl_result('vehicle', $1, 'vehicle_registration', 'mock', true, 'WASL-V-77')`, [applicantVehicle])
    expect(await queue(applicant)).toEqual([])
    const s = await one<{ wasl_status: string; wasl_reference: string }>('service', `select wasl_status, wasl_reference from drivers where id = $1`, [applicant])
    expect(s).toEqual({ wasl_status: 'eligible', wasl_reference: 'WASL-D-77' })
  })

  it('a transient Wasl error never takes an eligible captain off the road; a rejection suspends them', async () => {
    cap6 = await makeCaptain('966543000003', 'Stage6 Captain', 'go', 24.62, 46.72)
    await one('service', `select record_wasl_result('driver', $1, 'eligibility_check', 'mock', false, null, null, null, 'gateway 503')`, [cap6])
    let d = await one<{ wasl_status: string; is_online: boolean }>('service', `select wasl_status, is_online from drivers where id = $1`, [cap6])
    expect(d).toEqual({ wasl_status: 'eligible', is_online: true })

    const other = await makeCaptain('966543000004', 'Ineligible Captain', 'go', 24.63, 46.73)
    await one('service', `select record_wasl_result('driver', $1, 'eligibility_check', 'mock', false, null, null, '{"eligible":false}'::jsonb, null)`, [other])
    d = await one('service', `select wasl_status, is_online from drivers where id = $1`, [other])
    expect(d).toEqual({ wasl_status: 'ineligible', is_online: false })
    expect((await one<{ status: string }>('service', `select status from drivers where id = $1`, [other])).status).toBe('suspended')
    // Business rejections are not retried automatically.
    expect((await queue(other)).filter((x) => x.operation === 'eligibility_check')).toEqual([])
  })

  it('dispatch skips captains whose vehicle lost Wasl eligibility', async () => {
    rider9 = await newUser('966543000005', 'Rider Nine')
    await acceptRequiredConsents(rider9, 'rider')
    const r = await one<{ id: string }>('service',
      `select id from create_ride($1, 'riyadh', 'go', 24.621, 46.721, 'South', 24.60, 46.70, 'Drop', 3000, 500, 'cash')`, [rider9])
    ride6 = r.id
    expect((await rows<{ driver_id: string }>('service', `select driver_id from dispatch_candidates($1)`, [ride6])).map((x) => x.driver_id)).toContain(cap6)
    const v = await one<{ current_vehicle_id: string }>('service', `select current_vehicle_id from drivers where id = $1`, [cap6])
    await db.query(`update vehicles set wasl_status = 'error' where id = $1`, [v.current_vehicle_id])
    expect((await rows<{ driver_id: string }>('service', `select driver_id from dispatch_candidates($1)`, [ride6])).map((x) => x.driver_id)).not.toContain(cap6)
    await db.query(`update vehicles set wasl_status = 'eligible' where id = $1`, [v.current_vehicle_id])
  })

  it('trip hooks: registered with Wasl when the trip starts, updated when it ends', async () => {
    expect((await one<{ d: string }>('service', `select dispatch_ride($1) d`, [ride6])).d).toBe(cap6)
    await one(cap6, `select accept_ride($1)`, [ride6])
    await one(cap6, `select transition_ride($1, 'driver_arriving')`, [ride6])
    await one(cap6, `select transition_ride($1, 'driver_arrived')`, [ride6])
    const code = (await one<{ c: string }>(rider9, `select issue_ride_verification_code($1) c`, [ride6])).c
    await one(cap6, `select start_ride($1, $2)`, [ride6, code])
    const reg = (await queue(ride6))
    expect(reg.map((x) => x.operation)).toEqual(['trip_registration'])
    expect(reg[0].payload).toMatchObject({ vehicle_class: 'go' })
    expect(JSON.stringify(reg[0].payload)).not.toContain('966543000005') // no rider personal data
    await one('service', `select record_wasl_result('ride', $1, 'trip_registration', 'mock', true, 'WASL-T-1')`, [ride6])
    expect(await queue(ride6)).toEqual([])
    await one(cap6, `select transition_ride($1, 'completed')`, [ride6])
    expect((await queue(ride6)).map((x) => x.operation)).toEqual(['trip_update'])
    await one('service', `select record_wasl_result('ride', $1, 'trip_update', 'mock', true)`, [ride6])
    const r = await one<{ wasl_trip_reference: string; reported: boolean }>('service',
      `select wasl_trip_reference, wasl_reported_at is not null reported from rides where id = $1`, [ride6])
    expect(r).toEqual({ wasl_trip_reference: 'WASL-T-1', reported: true })
  })

  it('expired documents take a captain offline and keep them offline', async () => {
    const cap = await makeCaptain('966543000006', 'Expiring Captain', 'go', 24.64, 46.74)
    await db.query(`update driver_documents set expires_at = current_date - 1 where driver_id = $1 and doc_type = 'vehicle_insurance'`, [cap])
    expect((await one<{ n: number }>('service', `select expire_documents() n`)).n).toBeGreaterThanOrEqual(1)
    expect((await one<{ is_online: boolean }>('service', `select is_online from drivers where id = $1`, [cap])).is_online).toBe(false)
    await expect(as(cap, (tx) => tx.query(`update drivers set is_online = true where id = $1`, [cap]))).rejects.toThrow(/missing or expired/)
  })

  it('live trip sharing: anonymous link with minimal data, revocable, expires after the trip', async () => {
    const r = await one<{ id: string }>('service',
      `select id from create_ride($1, 'riyadh', 'go', 24.621, 46.721, 'South', 24.60, 46.70, 'Drop', 3000, 500, 'cash')`, [rider9])
    await one('service', `select dispatch_ride($1)`, [r.id])
    await one(cap6, `select accept_ride($1)`, [r.id])
    await expect(one(riderB, `select * from create_trip_share($1)`, [r.id])).rejects.toThrow(/not your ride/)
    const s = await one<{ share_id: string; token: string }>(rider9, `select * from create_trip_share($1)`, [r.id])
    expect(s.token).toMatch(/^[0-9a-f]{64}$/)

    const v = await one<{ v: Record<string, unknown> }>('anon', `select trip_share_view($1) v`, [s.token])
    expect(v.v).toMatchObject({ status: 'driver_assigned', captain: { first_name: 'Stage6' }, vehicle: { plate: expect.stringMatching(/^KSA /) } })
    expect(v.v.location).not.toBeNull()
    expect(JSON.stringify(v.v)).not.toMatch(/966543000005|rider_id|phone/)
    expect((await one<{ v: unknown }>('anon', `select trip_share_view($1) v`, ['0'.repeat(64)])).v).toBeNull()
    await expect(rows('anon', `select * from trip_shares`)).rejects.toThrow(/permission denied/)

    await one(rider9, `select revoke_trip_share($1)`, [s.share_id])
    expect((await one<{ v: unknown }>('anon', `select trip_share_view($1) v`, [s.token])).v).toBeNull()

    const s2 = await one<{ token: string }>(rider9, `select * from create_trip_share($1)`, [r.id])
    await one(rider9, `select transition_ride($1, 'cancelled', 'test')`, [r.id])
    expect((await one<{ v: { ended: boolean; location: unknown } }>('anon', `select trip_share_view($1) v`, [s2.token])).v).toMatchObject({ ended: true, location: null })
    await db.exec(`set session_replication_role = replica`)
    await db.query(`update rides set cancelled_at = now() - interval '31 minutes' where id = $1`, [r.id])
    await db.exec(`set session_replication_role = origin`)
    expect((await one<{ v: unknown }>('anon', `select trip_share_view($1) v`, [s2.token])).v).toBeNull()
  })

  it('SOS / safety reports open an urgent ticket for the safety team, participants only', async () => {
    await expect(one(riderB, `select report_safety_incident($1, 'sos')`, [ride6])).rejects.toThrow(/not your ride/)
    await expect(one(rider9, `select report_safety_incident($1, 'prank')`, [ride6])).rejects.toThrow(/unknown incident/)
    const t = await one<{ id: string }>(rider9, `select report_safety_incident($1, 'sos', 24.6, 46.7, 'Driver is speeding') as id`, [ride6])
    const ticket = await one<{ category: string; priority: string; status: string }>(support, `select category, priority, status from tickets where id = $1`, [t.id])
    expect(ticket).toEqual({ category: 'safety', priority: 'urgent', status: 'open' })
    const msg = await one<{ body: string }>(support, `select body from ticket_messages where ticket_id = $1`, [t.id])
    expect(msg.body).toContain('Location: 24.600000, 46.700000')
    expect((await rows(superAdmin, `select id from audit_log where action = 'safety.incident' and entity_id = $1`, [ride6])).length).toBe(1)
  })

  it('PDPL: restriction and objection requests take effect; erasure queues storage/login cleanup', async () => {
    const u = await newUser('966543000007', 'Privacy Person')
    await acceptRequiredConsents(u, 'rider')
    await one(u, `select record_consent('marketing_communications', true, $1, 'rider_app')`, [CONSENT_VERSIONS.marketing_communications])
    expect((await db.query<{ ok: boolean }>(`select private.can_contact_for_marketing($1) ok`, [u])).rows[0].ok).toBe(true)

    const rq = await one<{ id: string }>(u, `select id from submit_privacy_request('restriction', 'Pause marketing use')`)
    await one(superAdmin, `select admin_update_privacy_request($1, 'completed', 'Restricted')`, [rq.id])
    expect((await one<{ r: boolean }>(u, `select processing_restricted r from profiles where id = $1`, [u])).r).toBe(true)
    expect((await db.query<{ ok: boolean }>(`select private.can_contact_for_marketing($1) ok`, [u])).rows[0].ok).toBe(false)
    await expect(one(support, `select admin_lift_restriction($1, 'resolved')`, [u])).rejects.toThrow(/privacy.manage/)
    await one(superAdmin, `select admin_lift_restriction($1, 'resolved')`, [u])

    const ob = await one<{ id: string }>(u, `select id from submit_privacy_request('objection', 'No marketing please')`)
    await one(superAdmin, `select admin_update_privacy_request($1, 'completed')`, [ob.id])
    const c = await rows<{ purpose: string; granted: boolean }>(u, `select purpose, granted from my_consents() where purpose in ('marketing_communications', 'analytics')`)
    expect(c.every((x) => !x.granted)).toBe(true)

    const del = await one<{ id: string }>(u, `select id from submit_privacy_request('deletion')`)
    await one(superAdmin, `select admin_update_privacy_request($1, 'completed', 'Erased')`, [del.id])
    expect((await rows<{ user_id: string }>('service', `select * from privacy_cleanup_queue()`)).map((x) => x.user_id)).toContain(u)
    await one('service', `select complete_privacy_cleanup($1, 3, true)`, [del.id])
    expect((await rows<{ user_id: string }>('service', `select * from privacy_cleanup_queue()`)).map((x) => x.user_id)).not.toContain(u)
    expect((await one<{ n: string }>(superAdmin, `select resolution_note n from privacy_requests where id = $1`, [del.id])).n).toContain('Storage files removed: 3')
  })

  it('export v2 includes breadcrumbs of own rides, Wasl submissions and share links', async () => {
    const { d } = await one<{ d: Record<string, unknown> }>(rider9, `select export_my_data() as d`)
    const rides = d.rides_as_rider as { route_points: unknown[] }[]
    expect(rides.length).toBeGreaterThanOrEqual(1)
    expect(rides.every((r) => Array.isArray(r.route_points))).toBe(true)
    expect((d.trip_shares as Record<string, unknown>[]).every((s) => !('token_hash' in s))).toBe(true)
    const cap = await one<{ d: { wasl: { driver_status: string; submissions: unknown[] } } }>(applicant, `select export_my_data() as d`)
    expect(cap.d.wasl.driver_status).toBe('eligible')
    expect(cap.d.wasl.submissions.length).toBeGreaterThanOrEqual(3)
  })

  it('retention redacts old Wasl payloads and removes stale pickup codes', async () => {
    await db.query(`update wasl_sync_log set created_at = now() - interval '400 days', request_payload = '{"national_id":"x"}' where entity_id = $1`, [applicantVehicle])
    const r = await one<{ r: { wasl_payloads: number } }>('service', `select private.apply_retention() as r`)
    expect(r.r.wasl_payloads).toBeGreaterThanOrEqual(1)
    const left = await db.query(`select request_payload from wasl_sync_log where entity_id = $1`, [applicantVehicle])
    expect(left.rows.every((x) => (x as { request_payload: unknown }).request_payload === null)).toBe(true)
    expect((await db.query(`select 1 from private.ride_verification v join rides r on r.id = v.ride_id where r.status in ('completed', 'cancelled')`)).rows).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Stage 7: production readiness
// ════════════════════════════════════════════════════════════════════════════
describe('Stage 7: ops_readiness', () => {
  type Check = { id: string; area: string; severity: 'blocker' | 'warning'; ok: boolean; detail: string }
  type Report = { ok: boolean; summary: { blockers_failed: number; warnings: number; total: number }; checks: Check[] }
  const report = async (who = 'service') => (await one<{ r: Report }>(who, `select ops_readiness() as r`)).r

  it('passes every blocker on the database built by all migrations and test flows', async () => {
    const r = await report()
    const failed = r.checks.filter((c) => c.severity === 'blocker' && !c.ok)
    expect(failed).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.checks.map((c) => c.id)).toEqual(expect.arrayContaining([
      'rls_enabled', 'anon_no_tables', 'anon_functions', 'definer_search_path', 'private_schema_locked', 'super_admin',
      'postgis', 'platform_accounts', 'tariffs', 'consent_versions', 'ledger_balanced', 'online_captains_compliant',
      'privacy_requests_on_time', 'safety_tickets_triaged',
    ]))
    // The test database runs mock providers and has no pg_cron/Storage/Realtime → honest warnings.
    const warnIds = r.checks.filter((c) => !c.ok).map((c) => c.id)
    expect(warnIds).toEqual(expect.arrayContaining(['no_mock_payments', 'no_mock_wasl', 'schedules']))
  })

  it('is staff-only (settings.view) and never callable signed out', async () => {
    expect((await report(superAdmin)).ok).toBe(true)
    await expect(report(support)).rejects.toThrow(/settings.view/)
    await expect(report('anon')).rejects.toThrow(/permission denied/)
  })

  it('turns red when a blocker breaks (RLS disabled, anon grant, non-compliant captain online)', async () => {
    await db.exec(`alter table public.promos disable row level security`)
    await db.exec(`grant select on public.cities to anon`)
    let r = await report()
    expect(r.ok).toBe(false)
    expect(r.checks.find((c) => c.id === 'rls_enabled')).toMatchObject({ ok: false, detail: expect.stringContaining('promos') })
    expect(r.checks.find((c) => c.id === 'anon_no_tables')).toMatchObject({ ok: false, detail: expect.stringContaining('cities') })
    await db.exec(`alter table public.promos enable row level security`)
    await db.exec(`revoke select on public.cities from anon`)

    // A captain whose document expired but who is still online (e.g. the daily job did not run).
    const cap = await makeCaptain('966544000001', 'Readiness Captain', 'go', 24.65, 46.75)
    await db.exec(`set session_replication_role = replica`)
    await db.query(`update driver_documents set status = 'expired' where driver_id = $1 and doc_type = 'driving_license'`, [cap])
    await db.exec(`set session_replication_role = origin`)
    r = await report()
    expect(r.checks.find((c) => c.id === 'online_captains_compliant')).toMatchObject({ ok: false })
    await one('service', `select expire_documents()`)
    await db.query(`update drivers set is_online = false where id = $1`, [cap])
    expect((await report()).ok).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('admin console: direct document rejection (migration 016)', () => {
  let cap: string
  let docId: string
  const reject = (who: string, reason: string | null, reviewer: string | null, opts: { aal?: 'aal1' | 'aal2' } = {}) =>
    as(who, async (tx) => (await tx.query<{ id: string; status: string; rejection_reason: string; reviewed_at: string }>(
      `update driver_documents
          set status = 'rejected', rejection_reason = $2, reviewed_at = now(), updated_at = now(), reviewed_by = $3
        where id = $1 and status = 'uploaded'
        returning id, status, rejection_reason, reviewed_at`, [docId, reason, reviewer])).rows, opts)

  beforeAll(async () => {
    cap = await newUser('966544100001', 'Reject Test Captain')
    await db.query(
      `insert into drivers (id, status, city_id, national_id, date_of_birth, iban)
       values ($1, 'pending_review', (select id from cities where code = 'riyadh'), '1088888881', '1992-01-01', 'SA0380000000608010167519')`, [cap])
    docId = (await db.query<{ id: string }>(
      `insert into driver_documents (driver_id, doc_type, storage_path, expires_at)
       values ($1::uuid, 'driving_license', $1::text || '/driving_license.jpg', '2030-06-30') returning id`, [cap])).rows[0].id
  })

  it('captains, support staff and non-MFA sessions cannot change a document', async () => {
    expect(await reject(cap, 'x', cap)).toEqual([]) // captain: policy USING fails → no row matched
    expect(await reject(support, 'x', support)).toEqual([]) // no drivers.edit → row not matched
    expect(await reject(driverManager, 'x', driverManager, { aal: 'aal1' })).toEqual([])
    await expect(as(driverManager, (tx) => tx.query(`update driver_documents set storage_path = 'x' where id = $1`, [docId])))
      .rejects.toThrow(/permission denied/)
    expect((await db.query<{ status: string }>(`select status from driver_documents where id = $1`, [docId])).rows[0].status).toBe('uploaded')
  })

  it('a reason and reviewed_by = caller are required, and only uploaded → rejected is allowed', async () => {
    await expect(reject(driverManager, '   ', driverManager)).rejects.toThrow(/row-level security/)
    await expect(reject(driverManager, 'x', superAdmin)).rejects.toThrow(/row-level security/)
    await expect(as(driverManager, (tx) => tx.query(`update driver_documents set status = 'approved', reviewed_by = $2 where id = $1`, [docId, driverManager])))
      .rejects.toThrow(/row-level security/)
  })

  it('driver manager rejects with the final reason; a second reject matches nothing', async () => {
    const [r] = await reject(driverManager, 'عدم تطابق البيانات', driverManager)
    expect(r).toMatchObject({ id: docId, status: 'rejected', rejection_reason: 'عدم تطابق البيانات' })
    expect(r.reviewed_at).toBeTruthy()
    expect(await reject(driverManager, 'again', driverManager)).toEqual([])
    const a = await rows<{ action: string }>(superAdmin, `select action from audit_log where entity_id = $1`, [docId])
    expect(a.length).toBeGreaterThan(0)
  })
})

describe('vehicle rejection reason (vehicles.status_reason)', () => {
  it('admin_review_vehicle stores the reason and the captain can read it on their own vehicle', async () => {
    const cap = await newUser('966544100002', 'Vehicle Reject Captain')
    await db.query(
      `insert into drivers (id, status, city_id, national_id, date_of_birth, iban)
       values ($1, 'pending_review', (select id from cities where code = 'riyadh'), '1088888882', '1992-01-01', 'SA0380000000608010167519')`, [cap])
    const vid = (await db.query<{ id: string }>(
      `insert into vehicles (driver_id, vehicle_class, make, model, year, color, plate_letters, plate_number, sequence_number, seats)
       values ($1, 'go', 'Kia', 'K5', 2024, 'Grey', 'RJT', '4321', '555666777', 4) returning id`, [cap])).rows[0].id
    await expect(one(driverManager, `select admin_review_vehicle($1, false, '  ')`, [vid])).rejects.toThrow(/reason is required/)
    await one(driverManager, `select admin_review_vehicle($1, false, 'عدم استيفاء شروط الفئة المطلوبة')`, [vid])
    expect(await one(cap, `select status, status_reason from vehicles where id = $1`, [vid]))
      .toEqual({ status: 'rejected', status_reason: 'عدم استيفاء شروط الفئة المطلوبة' })
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('captain resubmission: driver_save_vehicle + re-upload + submit (migration 017)', () => {
  let cap: string
  let vid: string
  const nid = () => { const f = '108765432'; return f + saudiIdCheckDigit(f) }
  const save = (who: string, id: string | null, plate = '7777', seq = '700000001', make = 'Kia') =>
    one<{ id: string; status: string; status_reason: string | null; plate_number: string; make: string }>(who,
      `select id, status, status_reason, plate_number, make from driver_save_vehicle($1, 'go', $2, 'K5', 2024, 'grey', 'RJT', $3, $4, 4)`,
      [id, make, plate, seq])
  const upload = (types: string[], vehicle: string | null) => as(cap, async (tx) => {
    for (const t of types) await tx.query(
      `insert into driver_documents (driver_id, vehicle_id, doc_type, storage_path, expires_at)
       values ($1::uuid, $2::uuid, $3::document_type, $1::text || '/' || $3::text || '-' || gen_random_uuid()::text || '.jpg', $4)`,
      [cap, vehicle, t, t === 'profile_photo' ? null : '2030-06-30'])
  })

  beforeAll(async () => {
    cap = await newUser('966544100003', 'Resubmit Captain')
    await acceptRequiredConsents(cap, 'driver')
    await as(cap, (tx) => tx.query(
      `insert into drivers (id, city_id, national_id, date_of_birth, iban)
       values ($1, (select id from cities where code = 'riyadh'), $2, '1990-01-01', 'SA0380000000608010167519')`, [cap, nid()]))
    vid = (await save(cap, null)).id
    await upload(['national_id', 'driving_license', 'profile_photo'], null)
    await upload(['vehicle_registration', 'vehicle_insurance'], vid)
    expect((await one<{ status: string }>(cap, `select (submit_driver_application()).status`)).status).toBe('pending_review')
  })

  it('a rejected vehicle can be corrected in place (same plate) and goes back to review', async () => {
    await one(driverManager, `select admin_review_vehicle($1, false, 'عدم تطابق البيانات')`, [vid])
    const v = await save(cap, vid, '7777', '700000001', 'Kia ')
    expect(v).toMatchObject({ id: vid, status: 'pending_review', status_reason: null, make: 'Kia' })
    expect((await one<{ current_vehicle_id: string }>(cap, `select current_vehicle_id from drivers where id = $1`, [cap])).current_vehicle_id).toBe(vid)
  })

  it('another captain cannot edit it; an approved vehicle cannot be edited', async () => {
    await expect(save(driver, vid)).rejects.toThrow(/approved captains|not found/)
    await one(driverManager, `select admin_review_document(id, true) from driver_documents where vehicle_id = $1`, [vid])
    await one(driverManager, `select admin_review_vehicle($1, true)`, [vid])
    await expect(save(cap, vid)).rejects.toThrow(/can no longer be edited/)
  })

  it('rejected application: register another vehicle, re-upload a rejected document, resubmit', async () => {
    const lic = await one<{ id: string }>(cap, `select id from driver_documents where driver_id = $1 and doc_type = 'driving_license'`, [cap])
    await one(driverManager, `select admin_review_document($1, false, 'عدم وضوح الوثيقة أو رداءة التصوير')`, [lic.id])
    await one(driverManager, `select admin_set_driver_status($1, 'rejected', 'نقص في المرفقات أو البيانات المطلوبة')`, [cap])

    await expect(save(cap, null, '7777', '700000009')).rejects.toThrow(/already registered/) // same plate as the first vehicle
    const v2 = await save(cap, null, '8888', '700000002')
    expect(v2.status).toBe('pending_review')
    await expect(one(cap, `select submit_driver_application()`)).rejects.toThrow(/missing documents/)
    await upload(['driving_license'], null)
    await upload(['vehicle_registration', 'vehicle_insurance'], v2.id)
    const d = await one<{ status: string; status_reason: string | null; current_vehicle_id: string }>(cap,
      `select status, status_reason, current_vehicle_id from submit_driver_application()`)
    expect(d).toEqual({ status: 'pending_review', status_reason: null, current_vehicle_id: v2.id })
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('post-merge verification: rejection reasons (PR #1) and resubmission', () => {
  let capP: string, capQ: string, docP: string, vehP: string
  const nid = (n: number) => { const f = `10${String(8700000 + n)}`; return f + saudiIdCheckDigit(f) }

  beforeAll(async () => {
    capP = await newUser('966546000001', 'Verify Captain P')
    capQ = await newUser('966546000002', 'Verify Captain Q')
    for (const [c, n] of [[capP, 1], [capQ, 2]] as const) {
      await acceptRequiredConsents(c, 'driver')
      await as(c, (tx) => tx.query(`insert into drivers (id, city_id, national_id, date_of_birth, iban) values ($1, (select id from cities where code = 'riyadh'), $2, '1990-01-01', 'SA0380000000608010167519')`, [c, nid(n)]))
    }
    vehP = (await one<{ id: string }>(capP, `select id from driver_save_vehicle(null, 'go', 'Toyota', 'Camry', 2024, 'white', 'BJR', '4321', '765432109', 4)`)).id
    await as(capP, async (tx) => {
      for (const [t, v] of [['national_id', null], ['driving_license', null], ['profile_photo', null], ['vehicle_registration', vehP], ['vehicle_insurance', vehP]] as const) {
        await tx.query(`insert into driver_documents (driver_id, vehicle_id, doc_type, storage_path, expires_at) values ($1::uuid, $2::uuid, $3::document_type, $1::text || '/' || $3::text || '-1.jpg', $4)`,
          [capP, v, t, t === 'profile_photo' ? null : '2030-06-30'])
      }
    })
    docP = (await one<{ id: string }>(capP, `select id from driver_documents where driver_id = $1 and doc_type = 'driving_license'`, [capP])).id
    expect((await one<{ status: string }>(capP, `select (submit_driver_application()).status`)).status).toBe('pending_review')
  })

  it('driver_documents structure: reason required for rejected, review columns present, one live document per type', async () => {
    const cols = await rows<{ column_name: string }>('service', `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'driver_documents' order by ordinal_position`)
    expect(cols.map((c) => c.column_name)).toEqual(expect.arrayContaining(['status', 'rejection_reason', 'reviewed_by', 'reviewed_at', 'updated_at']))
    await expect(as('service', (tx) => tx.query(`update driver_documents set status = 'rejected', rejection_reason = null where id = $1`, [docP]))).rejects.toThrow(/driver_documents_rejection_reason/)
    await expect(as(capP, (tx) => tx.query(`insert into driver_documents (driver_id, doc_type, storage_path, expires_at) values ($1::uuid, 'driving_license', $1::text || '/dup.jpg', '2030-06-30')`, [capP]))).rejects.toThrow(/one_live/)
  })

  it('a captain cannot see or change another captain’s documents, nor an admin decision', async () => {
    expect(await rows(capQ, `select id from driver_documents where driver_id = $1`, [capP])).toEqual([])
    expect(await rows(capQ, `select id from vehicles where driver_id = $1`, [capP])).toEqual([])
    // Even with the column grant from migration 016, the policy matches no row for a captain.
    const touched = await as(capP, async (tx) => (await tx.query(`update driver_documents set status = 'rejected', rejection_reason = 'x', reviewed_by = $2 where id = $1 returning id`, [docP, capP])).rows)
    expect(touched).toEqual([])
    expect(await as(capP, async (tx) => (await tx.query(`update driver_documents set status = 'approved' where id = $1 returning id`, [docP])).rows)).toEqual([]) // RLS hides the row → 0 rows changed
    await expect(as(capP, (tx) => tx.query(`update vehicles set status = 'approved' where id = $1`, [vehP]))).rejects.toThrow(/permission denied/)
    await expect(one(capP, `select admin_review_document($1, true)`, [docP])).rejects.toThrow(/drivers.edit/)
    await expect(one(capP, `select admin_review_vehicle($1, true)`, [vehP])).rejects.toThrow(/vehicles.edit/)
    expect((await one<{ status: string }>('service', `select status from driver_documents where id = $1`, [docP])).status).toBe('uploaded')
  })

  it('document rejection (admin page update): reason saved, reviewed_at and updated_at set, captain sees the reason', async () => {
    const before = await one<{ updated_at: string }>('service', `select updated_at from driver_documents where id = $1`, [docP])
    const [r] = await as(driverManager, async (tx) => (await tx.query<{ status: string; rejection_reason: string; reviewed_at: string; updated_at: string; reviewed_by: string }>(
      `update driver_documents set status = 'rejected', rejection_reason = $2, reviewed_at = now(), updated_at = now(), reviewed_by = $3
        where id = $1 and status = 'uploaded' returning status, rejection_reason, reviewed_at, updated_at, reviewed_by`,
      [docP, 'عدم وضوح الوثيقة أو رداءة التصوير', driverManager])).rows)
    expect(r).toMatchObject({ status: 'rejected', rejection_reason: 'عدم وضوح الوثيقة أو رداءة التصوير', reviewed_by: driverManager })
    expect(r.reviewed_at).toBeTruthy()
    expect(Date.parse(r.updated_at)).toBeGreaterThanOrEqual(Date.parse(before.updated_at))
    // What the captain app reads (serverMirror.syncDriverSelf):
    expect(await one(capP, `select status, rejection_reason from driver_documents where id = $1`, [docP]))
      .toEqual({ status: 'rejected', rejection_reason: 'عدم وضوح الوثيقة أو رداءة التصوير' })
    const audit = await rows<{ action: string; actor_id: string }>(superAdmin, `select action, actor_id from audit_log where entity_id = $1 order by created_at`, [docP])
    expect(audit.some((a) => a.actor_id === driverManager)).toBe(true)
  })

  it('vehicle rejection: reason saved in vehicles.status_reason and visible to the captain; approval needs approved documents', async () => {
    await expect(one(driverManager, `select admin_review_vehicle($1, true)`, [vehP])).rejects.toThrow(/documents must be approved/)
    await one(driverManager, `select admin_review_vehicle($1, false, 'عدم تطابق البيانات')`, [vehP])
    expect(await one(capP, `select status, status_reason from vehicles where id = $1`, [vehP])).toEqual({ status: 'rejected', status_reason: 'عدم تطابق البيانات' })
  })

  it('resubmission keeps the review history: rejected document row and the old vehicle decision stay recorded', async () => {
    // Re-upload the rejected licence (new row) and correct the vehicle in place.
    await as(capP, (tx) => tx.query(`insert into driver_documents (driver_id, doc_type, storage_path, expires_at) values ($1::uuid, 'driving_license', $1::text || '/driving_license-2.jpg', '2031-01-31')`, [capP]))
    const v = await one<{ status: string; status_reason: string | null }>(capP, `select status, status_reason from driver_save_vehicle($1, 'go', 'Toyota', 'Camry', 2024, 'white', 'BJR', '4321', '765432109', 4)`, [vehP])
    expect(v).toEqual({ status: 'pending_review', status_reason: null })
    const licences = await rows<{ status: string; rejection_reason: string | null }>(capP, `select status, rejection_reason from driver_documents where driver_id = $1 and doc_type = 'driving_license' order by created_at`, [capP])
    expect(licences).toEqual([
      { status: 'rejected', rejection_reason: 'عدم وضوح الوثيقة أو رداءة التصوير' },
      { status: 'uploaded', rejection_reason: null },
    ])
    // The vehicle row is corrected in place; its previous decision is kept in the audit log.
    const hist = await rows<{ old_reason: string | null; new_status: string | null }>(superAdmin,
      `select old_data ->> 'status_reason' as old_reason, new_data ->> 'status' as new_status from audit_log where entity_id = $1 order by created_at`, [vehP])
    expect(hist.some((h) => h.old_reason === 'عدم تطابق البيانات' && h.new_status === 'pending_review')).toBe(true)
  })

  it('regression: after review the captain is approved only with approved documents, vehicle and Wasl — and can then go online', async () => {
    for (const d of await rows<{ id: string }>(driverManager, `select id from driver_documents where driver_id = $1 and status = 'uploaded'`, [capP])) {
      await one(driverManager, `select admin_review_document($1, true)`, [d.id])
    }
    await one(driverManager, `select admin_review_vehicle($1, true)`, [vehP])
    await expect(one(driverManager, `select admin_set_driver_status($1, 'approved')`, [capP])).rejects.toThrow(/Wasl/)
    await one('service', `select record_wasl_result('driver', $1, 'eligibility_check', 'mock', true, 'WASL-VP')`, [capP])
    await one('service', `select record_wasl_result('vehicle', $1, 'vehicle_registration', 'mock', true, 'WASL-VV')`, [vehP])
    expect((await one<{ status: string }>(driverManager, `select (admin_set_driver_status($1, 'approved')).status`, [capP])).status).toBe('approved')
    await as(capP, (tx) => tx.query(`update drivers set is_online = true where id = $1`, [capP]))
    expect((await one<{ is_online: boolean }>('service', `select is_online from drivers where id = $1`, [capP])).is_online).toBe(true)
    // Once approved, the vehicle can no longer be edited by the captain.
    await expect(one(capP, `select driver_save_vehicle($1, 'go', 'Toyota', 'Camry', 2024, 'white', 'BJR', '4321', '765432109', 4)`, [vehP])).rejects.toThrow(/support|no longer/)
  })
})
