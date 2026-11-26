/**
 * BETA security (migration 021) on the real migrations (PGlite + PostGIS).
 * A1–A6, A9–A11 of the approved test plan, plus one test per sensitive writer from the
 * inventory, the privilege matrix, and fail-closed behaviour for a missing / corrupt marker.
 * (A7, A8 and A12 are unit tests in tests/betaSecurity.test.ts.)
 *
 * PGlite is not Supabase: PostgREST, GoTrue, Auth hooks and pg_cron are NOT exercised here.
 * Those are the Manual Required checks M1–M6 in docs/beta/BETA_SECURITY.md.
 *
 *   npm run test:db
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { postgis } from '@electric-sql/pglite-postgis'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONSENT_VERSIONS, REQUIRED_CONSENTS } from '../../src/privacy/consents'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const BETA_REF = 'betatestprojectref01'
const PROD_REF = 'prodtestprojectref01'
const TABLES = ['payments', 'payment_methods', 'payouts', 'wasl_sync_log'] as const
const API_ROLES = ['anon', 'authenticated', 'service_role'] as const

/** Every function that writes one of the four tables (inventory, proven from pg_proc below). */
const WRITERS = [
  'admin_refund_payment', 'admin_set_payout_status', 'complete_payout', 'create_payment_intent', 'create_payout_batch',
  'record_provider_payment', 'record_wasl_result', 'remove_payment_method', 'request_payout', 'save_payment_method',
  'set_default_payment_method',
] as const
/** Privacy / retention writers: deliberately not gated (PDPL duties must run in every environment). */
const PRIVACY_WRITERS = ['erase_user', 'redact_wasl_payloads'] as const

let db: PGlite
const MFA = new Set<string>()

class Rollback extends Error {}

async function setClaims(tx: Transaction, who: string) {
  const role = who === 'service' ? 'service_role' : who === 'anon' ? 'anon' : 'authenticated'
  const sub = who === 'service' || who === 'anon' ? '' : who
  const claims = sub ? JSON.stringify({ sub, role, aal: MFA.has(who) ? 'aal2' : 'aal1' }) : JSON.stringify({ role })
  await tx.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [sub, claims])
  await tx.exec(`set local role ${role}`)
}

/** Classify a database error into the guard layer that produced it. */
function classify(msg: string): string {
  if (/AURA_GUARD: live operations are not allowed/.test(msg)) return 'live_refused'
  const m = /AURA_GUARD: environment marker (\w+)/.exec(msg)
  if (m) return `marker_${m[1]}`
  if (/AURA_GUARD: integrity check failed/.test(msg)) return 'integrity_refused'
  if (/AURA_GUARD: TRUNCATE/.test(msg)) return 'truncate_refused'
  if (/AURA_GUARD/.test(msg)) return 'guard:' + msg
  if (/permission denied/.test(msg)) return 'permission_denied'
  return 'error:' + msg
}

/**
 * Run `sql` as `who` ('owner' = the postgres superuser that owns everything) after optional
 * owner `setup` statements, then ALWAYS roll back. Returns 'ok' or the classified error.
 */
async function attempt(who: string, sql: string, params: unknown[] = [], setup: string[] = []): Promise<string> {
  let outcome = 'unset'
  try {
    await db.transaction(async (tx) => {
      for (const s of setup) await tx.exec(s)
      if (who !== 'owner') await setClaims(tx, who)
      try {
        await tx.query(sql, params)
        outcome = 'ok'
      } catch (e) {
        outcome = classify((e as Error).message)
      }
      throw new Rollback()
    })
  } catch (e) {
    if (!(e instanceof Rollback)) throw e
  }
  return outcome
}

/** Like attempt() but returns the first row (still rolled back). */
async function peek<T>(who: string, sql: string, params: unknown[] = [], setup: string[] = []): Promise<T> {
  let row: T | undefined
  try {
    await db.transaction(async (tx) => {
      for (const s of setup) await tx.exec(s)
      if (who !== 'owner') await setClaims(tx, who)
      row = (await tx.query<T>(sql, params)).rows[0]
      throw new Rollback()
    })
  } catch (e) {
    if (!(e instanceof Rollback)) throw e
  }
  return row as T
}

async function asUser<T>(who: string, sql: string, params: unknown[] = []): Promise<T> {
  return db.transaction(async (tx) => {
    await setClaims(tx, who)
    return (await tx.query<T>(sql, params)).rows[0]
  })
}

async function newUser(phone: string): Promise<string> {
  await db.query(`select ops_guard.allow_tester($1, 'security test')`, [phone])
  return (await db.query<{ id: string }>(`insert into auth.users (phone) values ($1) returning id`, [phone])).rows[0].id
}

// Owner-side tampering used to simulate a broken environment (always inside a rolled-back transaction).
const UNLOCK_MARKER = [
  `alter table ops_guard.environment disable trigger environment_no_update`,
  `alter table ops_guard.environment disable trigger environment_no_truncate`,
]
const MARKER_MISSING = [...UNLOCK_MARKER, `delete from ops_guard.environment`]
const MARKER_CORRUPT = [...UNLOCK_MARKER, `update ops_guard.environment set project_ref = 'zzzzzzzzzzzzzzzzzzzz'`]
const MARKER_TWO_ROWS = [...UNLOCK_MARKER, `alter table ops_guard.environment drop constraint environment_pkey`,
  `insert into ops_guard.environment (id, mode, project_ref, digest) values (true, 'beta', '${BETA_REF}', ops_guard.marker_digest('beta', '${BETA_REF}'))`]
/** A verified production project in a rolled-back transaction: the only path where live is allowed. */
const PRODUCTION = [
  ...MARKER_MISSING,
  `create or replace function ops_guard.prod_project_ref() returns text language sql immutable set search_path = '' as $$ select '${PROD_REF}'::text $$`,
  `select ops_guard.set_environment('production', '${PROD_REF}')`,
  `alter table ops_guard.environment enable always trigger environment_no_update`,
  `alter table ops_guard.environment enable always trigger environment_no_truncate`,
  `select ops_guard.integrity_check()`,
]

let rider: string
let rider2: string
let captain: string
let finance: string
let mockPayment: string
let mockCard: string
let mockPayout: string

beforeAll(async () => {
  db = new PGlite({ extensions: { postgis } })
  await db.exec(readFileSync(join(ROOT, 'tests', 'db', 'supabase-shim.sql'), 'utf8'))
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
  }
  await db.exec(readFileSync(join(ROOT, 'supabase', 'seed.sql'), 'utf8'))
}, 180_000)

// ────────────────────────────────────────────────────────────────────────────
describe('before the marker exists (fresh project): everything sensitive fails closed', () => {
  it('no marker: sign-ups, sessions and live operations are all refused', async () => {
    expect((await db.query<{ s: string }>(`select ops_guard.marker_state() s`)).rows[0].s).toBe('missing')
    await expect(db.query(`insert into auth.users (phone) values ('966511110000')`)).rejects.toThrow(/sign-ups are closed/)
    const hook = (await db.query<{ r: Record<string, unknown> }>(`select ops_guard.hook_before_user_created('{"user":{"phone":"966511110000"}}') r`)).rows[0].r
    expect(hook).toMatchObject({ error: { http_code: 403 } })
    expect((await db.query<{ l: boolean }>(`select ops_guard.live_allowed() l`)).rows[0].l).toBe(false)
  })

  it('a BETA project cannot write a production marker (production needs the verified ref, which is NULL)', async () => {
    await expect(db.query(`select ops_guard.set_environment('production', $1)`, [BETA_REF])).rejects.toThrow(/verified production project ref/)
    await expect(db.query(`select ops_guard.set_environment('production', $1)`, [PROD_REF])).rejects.toThrow(/verified production project ref/)
    expect((await db.query<{ r: string | null }>(`select ops_guard.prod_project_ref() r`)).rows[0].r).toBeNull()
  })

  it('the marker is written once; then fixtures and the first integrity check', async () => {
    await db.query(`select ops_guard.set_environment('beta', $1)`, [BETA_REF])
    await expect(db.query(`select ops_guard.set_environment('beta', $1)`, [BETA_REF])).rejects.toThrow(/duplicate key/)
    expect((await db.query<{ s: string }>(`select ops_guard.marker_state() s`)).rows[0].s).toBe('ok')

    rider = await newUser('966551000001')
    rider2 = await newUser('966551000002')
    captain = await newUser('966551000003')
    finance = await newUser('966500000009')
    await db.query(`select private.grant_admin($1, 'finance_manager')`, [finance])
    MFA.add(finance)
    await db.query(
      `insert into drivers (id, status, city_id, national_id, date_of_birth, iban, approved_at, wasl_status)
       values ($1, 'approved', (select id from cities where code = 'riyadh'), '1070000001', '1991-02-03', 'SA0380000000608010167519', now(), 'eligible')`, [captain])
    mockPayment = (await db.query<{ id: string }>(
      `insert into payments (kind, rider_id, provider, method_type, amount_halalas, status, idempotency_key)
       values ('wallet_topup', $1, 'mock', 'card', 5000, 'paid', 'sec-topup-1') returning id`, [rider])).rows[0].id
    mockCard = (await db.query<{ id: string }>(
      `select (save_payment_method($1, 'mock', 'card', 'tok_sec_1', 'visa', '4242', 12, 2030)).id`, [rider])).rows[0].id
    mockPayout = (await db.query<{ id: string }>(
      `insert into payouts (driver_id, amount_halalas, iban, idempotency_key) values ($1, 1000, 'SA0380000000608010167519', 'sec-payout-1') returning id`, [captain])).rows[0].id
    const r = (await db.query<{ r: { ok: boolean; failures: string[] } }>(`select ops_guard.integrity_check() r`)).rows[0].r
    expect(r).toEqual({ ok: true, failures: [], failing_since: null })
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('inventory: what writes payments, payment_methods, payouts and wasl_sync_log', () => {
  it('exactly the 13 known functions reference the four tables in a write statement, all postgres-owned SECURITY DEFINER with an empty search_path', async () => {
    const r = await db.query<{ proname: string; definer: boolean; owner: string; cfg: string[] | null }>(
      `select p.proname, p.prosecdef definer, pg_get_userbyid(p.proowner) owner, p.proconfig cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private')
          and p.prosrc ~* '(insert\\s+into|update|delete\\s+from)\\s+public\\.(payments|payment_methods|payouts|wasl_sync_log)\\M'
        order by 1`)
    expect(r.rows.map((x) => x.proname)).toEqual([...WRITERS, ...PRIVACY_WRITERS].sort())
    for (const f of r.rows) {
      expect(f.definer, f.proname).toBe(true)
      expect(f.cfg, f.proname).toContain('search_path=""')
      expect(f.owner, f.proname).toBe((await db.query<{ o: string }>(`select pg_get_userbyid(nspowner) o from pg_namespace where nspname = 'ops_guard'`)).rows[0].o)
    }
  })

  it('P2 is present in all 11 sensitive writers (and only the privacy writers are ungated)', async () => {
    const r = await db.query<{ proname: string }>(
      `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and prosrc like '%ops_guard.assert_environment%' order by 1`)
    expect(r.rows.map((x) => x.proname)).toEqual([...WRITERS])
  })

  it('no Edge Function or app code writes the four tables through REST (only RPC)', () => {
    const files = [
      'supabase/functions/_shared/payments/db.ts', 'supabase/functions/_shared/payments/handlers.ts',
      'supabase/functions/_shared/wasl/db.ts', 'supabase/functions/_shared/wasl/worker.ts',
      'supabase/functions/_shared/privacy/cleanup.ts', 'supabase/functions/_shared/requestRideDeps.ts',
      'src/payments/paymentsGateway.ts', 'src/apps/admin/live/adminApi.ts',
    ]
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf8')
      expect(src, f).not.toMatch(/from\(\s*['"](payments|payment_methods|payouts|wasl_sync_log)['"]\s*\)\s*\.\s*(insert|update|upsert|delete)/)
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('A1 · P1 — no direct writes, even with the guard trigger disabled', () => {
  for (const t of TABLES) {
    it(`service_role / authenticated / anon cannot insert, update, delete or truncate ${t} (trigger disabled first)`, async () => {
      const off = [`alter table public.${t} disable trigger aa_ops_guard_write`, `alter table public.${t} disable trigger aa_ops_guard_truncate`]
      for (const who of ['service', rider, 'anon']) {
        expect(await attempt(who, `update public.${t} set created_at = created_at`, [], off), `${who} update ${t}`).toBe('permission_denied')
        expect(await attempt(who, `delete from public.${t}`, [], off), `${who} delete ${t}`).toBe('permission_denied')
        expect(await attempt(who, `truncate public.${t}`, [], off), `${who} truncate ${t}`).toBe('permission_denied')
      }
      const insert: Record<string, string> = {
        payments: `insert into public.payments (kind, rider_id, provider, method_type, amount_halalas, idempotency_key) values ('wallet_topup', '${rider}', 'moyasar', 'card', 100, 'p1-direct-1')`,
        payment_methods: `insert into public.payment_methods (rider_id, provider, method_type, brand, last4, exp_month, exp_year) values ('${rider}', 'moyasar', 'card', 'visa', '4242', 12, 2030)`,
        payouts: `insert into public.payouts (driver_id, amount_halalas, iban, idempotency_key, provider) values ('${captain}', 100, 'SA0380000000608010167519', 'p1-direct-1', 'bank')`,
        wasl_sync_log: `insert into public.wasl_sync_log (entity_type, entity_id, operation, provider) values ('driver', '${captain}', 'eligibility_check', 'wasl')`,
      }
      for (const who of ['service', rider, 'anon']) expect(await attempt(who, insert[t], [], off), `${who} insert ${t}`).toBe('permission_denied')
    })
  }
})

describe('A10 · privileges on the four tables never regress', () => {
  it('API roles hold SELECT at most (anon nothing), no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER', async () => {
    const r = await db.query<{ grantee: string; table_name: string; privilege_type: string }>(
      `select grantee, table_name, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = any ($1) and grantee = any ($2) order by 1, 2, 3`, [TABLES, API_ROLES])
    const got = r.rows.map((x) => `${x.grantee}:${x.table_name}:${x.privilege_type}`)
    expect(got).toEqual(TABLES.flatMap((t) => [`authenticated:${t}:SELECT`]).concat(TABLES.map((t) => `service_role:${t}:SELECT`)).sort())
  })

  it('no API role holds any privilege on the ops_guard schema or its tables; supabase_auth_admin only USAGE', async () => {
    for (const role of API_ROLES) {
      expect((await db.query<{ u: boolean }>(`select has_schema_privilege($1, 'ops_guard', 'USAGE') u`, [role])).rows[0].u, role).toBe(false)
    }
    expect((await db.query<{ u: boolean }>(`select has_schema_privilege('supabase_auth_admin', 'ops_guard', 'USAGE') u`)).rows[0].u).toBe(true)
    const t = await db.query<{ n: number }>(
      `select count(*)::int n from information_schema.role_table_grants where table_schema = 'ops_guard' and grantee = any ($1)`,
      [[...API_ROLES, 'supabase_auth_admin', 'PUBLIC']])
    expect(t.rows[0].n).toBe(0)
  })

  it('a broad re-grant is detected by the integrity check (D1) and blocks every sensitive write until fixed', async () => {
    const grant = [`grant insert on all tables in schema public to service_role`, `select ops_guard.integrity_check()`]
    const r = await peek<{ r: { ok: boolean; failures: string[] } }>('owner', `select ops_guard.integrity_check() r`, [], grant)
    expect(r.r.ok).toBe(false)
    expect(r.r.failures).toEqual(expect.arrayContaining(TABLES.map((t) => `direct_write:service_role:INSERT:public.${t}`)))
    expect(await attempt(rider, `select set_default_payment_method($1)`, [mockCard], grant)).toBe('integrity_refused')
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('A2 · P2 — the function refuses on its own (guard trigger disabled)', () => {
  const offAll = TABLES.flatMap((t) => [`alter table public.${t} disable trigger aa_ops_guard_write`])
  it('create_payment_intent / save_payment_method with moyasar are refused', async () => {
    expect(await attempt('service', `select create_payment_intent($1, 'wallet_topup', null, 5000, 'card', 'moyasar', null)`, [rider], offAll)).toBe('live_refused')
    expect(await attempt('service', `select save_payment_method($1, 'moyasar', 'card', 'tok_live', 'visa', '4242', 12, 2030)`, [rider], offAll)).toBe('live_refused')
  })
  it('record_provider_payment / admin_refund_payment on a live payment are refused', async () => {
    const live = [...offAll, `insert into public.payments (id, kind, rider_id, provider, method_type, amount_halalas, status, idempotency_key)
                              values ('00000000-0000-4000-8000-0000000000a1', 'wallet_topup', '${rider}', 'moyasar', 'card', 5000, 'initiated', 'live-a2-1')`]
    expect(await attempt('service', `select record_provider_payment('00000000-0000-4000-8000-0000000000a1', 'paid', 'pay_live', 5000)`, [], live)).toBe('live_refused')
    expect(await attempt(finance, `select admin_refund_payment('00000000-0000-4000-8000-0000000000a1', 1000, 'test')`, [], live)).toBe('live_refused')
  })
  it('complete_payout(…, true) / admin_set_payout_status on a bank payout are refused', async () => {
    const live = [...offAll, `update public.payouts set provider = 'bank', status = 'approved', approved_at = now() where id = '${mockPayout}'`,
                  `update public.payouts set status = 'processing' where id = '${mockPayout}'`]
    expect(await attempt('service', `select complete_payout($1, true, 'bank_ref')`, [mockPayout], live)).toBe('live_refused')
    expect(await attempt(finance, `select admin_set_payout_status($1, 'cancelled', 'test')`, [mockPayout], live)).toBe('live_refused')
  })
  it("record_wasl_result(…, 'wasl') is refused", async () => {
    expect(await attempt('service', `select record_wasl_result('driver', $1, 'eligibility_check', 'wasl', true)`, [captain], offAll)).toBe('live_refused')
  })
})

describe('A3 · P3 — the trigger alone refuses (no function in the path), also under replica', () => {
  const rows: Record<string, string> = {
    payments: `insert into public.payments (kind, rider_id, provider, method_type, amount_halalas, idempotency_key) values ('wallet_topup', '__R__', 'moyasar', 'card', 100, 'p3-1')`,
    payment_methods: `insert into public.payment_methods (rider_id, provider, method_type, brand, last4, exp_month, exp_year) values ('__R__', 'hyperpay', 'card', 'visa', '4242', 12, 2030)`,
    payouts: `insert into public.payouts (driver_id, amount_halalas, iban, idempotency_key, provider) values ('__C__', 100, 'SA0380000000608010167519', 'p3-1', 'bank')`,
    wasl_sync_log: `insert into public.wasl_sync_log (entity_type, entity_id, operation, provider) values ('driver', '__C__', 'eligibility_check', 'wasl')`,
  }
  for (const t of TABLES) {
    it(`owner insert of a live ${t} row is refused; with session_replication_role = replica too`, async () => {
      const sql = rows[t].replace('__R__', rider).replace('__C__', captain)
      expect(await attempt('owner', sql)).toBe('live_refused')
      expect(await attempt('owner', sql, [], [`set local session_replication_role = replica`])).toBe('live_refused')
    })
  }
  it('owner update of an existing mock row to a live provider is refused', async () => {
    expect(await attempt('owner', `update public.payouts set provider = 'bank' where id = $1`, [mockPayout])).toBe('live_refused')
    expect(await attempt('owner', `update public.payments set provider = 'moyasar' where id = $1`, [mockPayment])).toBe('live_refused')
  })
  it('TRUNCATE is refused for the owner on all four tables', async () => {
    for (const t of TABLES) expect(await attempt('owner', `truncate public.${t} cascade`), t).toBe('truncate_refused')
  })
  it('all eight guard triggers are ENABLE ALWAYS', async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from pg_trigger where tgname in ('aa_ops_guard_write', 'aa_ops_guard_truncate') and tgenabled = 'A'
          and tgrelid = any (array['public.payments', 'public.payment_methods', 'public.payouts', 'public.wasl_sync_log']::regclass[])`)
    expect(r.rows[0].n).toBe(8)
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('A4 · the marker decides, and fails closed', () => {
  const state = (setup: string[]) => peek<{ s: string; live: boolean; signup: boolean }>('owner',
    `select ops_guard.marker_state() s, ops_guard.live_allowed() live, ops_guard.signup_allowed('966551000001', null) signup`, [], setup)

  it('missing / corrupt / two rows / unknown mode → refused; beta → mock only', async () => {
    expect(await state(MARKER_MISSING)).toEqual({ s: 'missing', live: false, signup: false })
    expect(await state(MARKER_CORRUPT)).toEqual({ s: 'corrupt', live: false, signup: false })
    expect(await state(MARKER_TWO_ROWS)).toEqual({ s: 'corrupt', live: false, signup: false })
    expect(await state([...UNLOCK_MARKER, `alter table ops_guard.environment drop constraint environment_mode_check`,
      `update ops_guard.environment set mode = 'prod', digest = ops_guard.marker_digest('prod', project_ref)`])).toEqual({ s: 'corrupt', live: false, signup: false })
    expect(await state([])).toEqual({ s: 'ok', live: false, signup: true })
  })

  it("a production marker for another ref is corrupt; ('production', verified ref) with fresh integrity is the only live path", async () => {
    // Forged production marker on this (BETA) project: the digest is right, the ref is not the verified one.
    expect(await state([...UNLOCK_MARKER, `update ops_guard.environment set mode = 'production', digest = ops_guard.marker_digest('production', project_ref)`]))
      .toEqual({ s: 'corrupt', live: false, signup: false })
    expect((await state(PRODUCTION)).live).toBe(true)
    // Production but stale integrity → not live.
    expect((await state([...PRODUCTION, `update ops_guard.integrity_status set checked_at = now() - interval '4 minutes'`])).live).toBe(false)
  })

  it('every sensitive writer refuses with a missing or corrupt marker (fail closed), before touching data', async () => {
    for (const setup of [MARKER_MISSING, MARKER_CORRUPT]) {
      const tag = setup === MARKER_MISSING ? 'marker_missing' : 'marker_corrupt'
      expect(await attempt('service', `select create_payment_intent($1, 'wallet_topup', null, 5000, 'card', 'mock', null)`, [rider], setup)).toBe(tag)
      expect(await attempt('service', `select save_payment_method($1, 'mock', 'card', 'tok_x', 'visa', '4242', 12, 2030)`, [rider], setup)).toBe(tag)
      expect(await attempt('service', `select record_provider_payment($1, 'paid', 'x', 5000)`, [mockPayment], setup)).toBe(tag)
      expect(await attempt(finance, `select admin_refund_payment($1, 1000, 'test')`, [mockPayment], setup)).toBe(tag)
      expect(await attempt(rider, `select set_default_payment_method($1)`, [mockCard], setup)).toBe(tag)
      expect(await attempt(rider, `select remove_payment_method($1)`, [mockCard], setup)).toBe(tag)
      expect(await attempt(captain, `select request_payout(500)`, [], setup)).toBe(tag)
      expect(await attempt('service', `select create_payout_batch()`, [], setup)).toBe(tag)
      expect(await attempt(finance, `select admin_set_payout_status($1, 'approved', 'test')`, [mockPayout], setup)).toBe(tag)
      expect(await attempt('service', `select complete_payout($1, true)`, [mockPayout], setup)).toBe(tag)
      expect(await attempt('service', `select record_wasl_result('driver', $1, 'eligibility_check', 'mock', true)`, [captain], setup)).toBe(tag)
    }
  })

  it('the runtime config the workers read reflects the marker', async () => {
    const ok = await peek<{ c: Record<string, unknown> }>('service', `select ops_runtime_config() c`)
    expect(ok.c).toMatchObject({ marker_state: 'ok', mode: 'beta', project_ref: BETA_REF, prod_project_ref: null, live_allowed: false, integrity_ok: true })
    const missing = await peek<{ c: Record<string, unknown> }>('service', `select ops_runtime_config() c`, [], MARKER_MISSING)
    expect(missing.c).toMatchObject({ marker_state: 'missing', mode: null, live_allowed: false })
  })
})

describe('per sensitive writer: mock works in BETA, live is refused, production (verified) allows live', () => {
  // 'ok' or a business error proves the guard let the call through; guard errors are classified.
  const passed = (o: string) => o === 'ok' || (o.startsWith('error:') && !o.includes('AURA_GUARD'))

  it('create_payment_intent', async () => {
    expect(await attempt('service', `select create_payment_intent($1, 'wallet_topup', null, 5000, 'card', 'mock', null)`, [rider])).toBe('ok')
    expect(await attempt('service', `select create_payment_intent($1, 'wallet_topup', null, 5000, 'card', 'moyasar', null)`, [rider])).toBe('live_refused')
    expect(await attempt('service', `select create_payment_intent($1, 'wallet_topup', null, 5000, 'card', 'moyasar', null)`, [rider], PRODUCTION)).toBe('ok')
  })
  it('save_payment_method', async () => {
    expect(await attempt('service', `select save_payment_method($1, 'mock', 'card', 'tok_2', 'visa', '4242', 12, 2030)`, [rider2])).toBe('ok')
    expect(await attempt('service', `select save_payment_method($1, 'moyasar', 'card', 'tok_2', 'visa', '4242', 12, 2030)`, [rider2])).toBe('live_refused')
    expect(await attempt('service', `select save_payment_method($1, 'moyasar', 'card', 'tok_2', 'visa', '4242', 12, 2030)`, [rider2], PRODUCTION)).toBe('ok')
  })
  it('record_provider_payment', async () => {
    expect(passed(await attempt('service', `select record_provider_payment($1, 'paid', 'mock_ref', 5000)`, [mockPayment]))).toBe(true)
  })
  it('admin_refund_payment', async () => {
    expect(await attempt(finance, `select admin_refund_payment($1, 1000, 'customer request')`, [mockPayment])).toBe('ok')
  })
  it('set_default_payment_method / remove_payment_method (rider, no external effect)', async () => {
    expect(await attempt(rider, `select set_default_payment_method($1)`, [mockCard])).toBe('ok')
    expect(await attempt(rider, `select remove_payment_method($1)`, [mockCard])).toBe('ok')
  })
  it('request_payout / create_payout_batch create mock payouts only', async () => {
    expect(passed(await attempt(captain, `select request_payout(500)`))).toBe(true)
    expect(await attempt('service', `select create_payout_batch()`)).toBe('ok')
  })
  it('admin_set_payout_status → complete_payout on a mock payout', async () => {
    const flow = [`update public.payouts set status = 'approved', approved_at = now() where id = '${mockPayout}'`,
                  `update public.payouts set status = 'processing' where id = '${mockPayout}'`]
    expect(await attempt(finance, `select admin_set_payout_status($1, 'approved', 'ok')`, [mockPayout])).toBe('ok')
    expect(passed(await attempt('service', `select complete_payout($1, false, null, 'bank rejected')`, [mockPayout], flow))).toBe(true)
  })
  it('record_wasl_result', async () => {
    expect(await attempt('service', `select record_wasl_result('driver', $1, 'eligibility_check', 'mock', true)`, [captain])).toBe('ok')
    expect(await attempt('service', `select record_wasl_result('driver', $1, 'eligibility_check', 'wasl', true)`, [captain])).toBe('live_refused')
    expect(await attempt('service', `select record_wasl_result('driver', $1, 'eligibility_check', 'wasl', true)`, [captain], PRODUCTION)).toBe('ok')
  })
  it('erase_user / redact_wasl_payloads (PDPL) still run, even with a missing marker', async () => {
    expect(await attempt('owner', `select private.redact_wasl_payloads(365)`, [], MARKER_MISSING)).toBe('ok')
    expect(passed(await attempt('owner', `select private.erase_user($1)`, [rider2], MARKER_MISSING))).toBe(true)
  })
  it('clients cannot call the service-only writers at all', async () => {
    for (const sql of [`select create_payment_intent('${rider}', 'wallet_topup', null, 5000, 'card', 'mock', null)`,
      `select save_payment_method('${rider}', 'mock', 'card', 't', 'visa', '4242', 12, 2030)`, `select record_provider_payment('${mockPayment}', 'paid')`,
      `select complete_payout('${mockPayout}', true)`, `select record_wasl_result('driver', '${captain}', 'eligibility_check', 'mock', true)`]) {
      expect(await attempt(rider, sql), sql).toBe('permission_denied')
      expect(await attempt('anon', sql), sql).toBe('permission_denied')
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('A5 · the marker and the allowlist are protected', () => {
  it('owner UPDATE / DELETE / TRUNCATE on the marker are refused', async () => {
    for (const sql of [`update ops_guard.environment set mode = 'production'`, `delete from ops_guard.environment`, `truncate ops_guard.environment`]) {
      expect(await attempt('owner', sql), sql).toMatch(/guard:.*immutable/)
    }
  })
  it('the allowlist changes only through allow_tester / revoke_tester (owner direct writes refused), and every change is logged', async () => {
    for (const sql of [`insert into ops_guard.allowlist (identity) values ('966559999999')`, `delete from ops_guard.allowlist`,
      `update ops_guard.allowlist set note = 'x'`, `truncate ops_guard.allowlist`]) {
      expect(await attempt('owner', sql), sql).toMatch(/guard:.*allowlist changes only/)
    }
    const log = await db.query<{ n: number }>(`select count(*)::int n from ops_guard.allowlist_log where action = 'allow'`)
    expect(log.rows[0].n).toBeGreaterThanOrEqual(4)
    expect(await attempt('owner', `delete from ops_guard.allowlist_log`)).toMatch(/append-only/)
  })
  it('service_role, anon, a rider and finance staff have no access to ops_guard at all', async () => {
    for (const who of ['service', 'anon', rider, finance]) {
      for (const sql of [`select * from ops_guard.environment`, `select * from ops_guard.allowlist`, `select ops_guard.allow_tester('966500000000')`,
        `select ops_guard.revoke_tester('966551000001')`, `select ops_guard.set_environment('beta', '${BETA_REF}')`]) {
        expect(await attempt(who, sql), `${who}: ${sql}`).toBe('permission_denied')
      }
    }
  })
})

describe('A6 · D1 integrity check records each failure with its reason', () => {
  const run = (setup: string[]) => peek<{ r: { ok: boolean; failures: string[] } }>('owner', `select ops_guard.integrity_check() r`, [], setup)
  it('a disabled guard trigger', async () => {
    const r = await run([`alter table public.payouts disable trigger aa_ops_guard_write`])
    expect(r.r.failures).toContain('trigger_not_always:public.payouts.aa_ops_guard_write')
  })
  it('a guard trigger downgraded from ALWAYS to ORIGIN', async () => {
    const r = await run([`alter table public.payments enable trigger aa_ops_guard_write`])
    expect(r.r.failures).toContain('trigger_not_always:public.payments.aa_ops_guard_write')
  })
  it('a forbidden live row inserted by the owner (trigger bypassed)', async () => {
    const r = await run([`alter table public.wasl_sync_log disable trigger aa_ops_guard_write`,
      `insert into public.wasl_sync_log (entity_type, entity_id, operation, provider) values ('driver', '${captain}', 'eligibility_check', 'wasl')`,
      `alter table public.wasl_sync_log enable always trigger aa_ops_guard_write`])
    expect(r.r.failures).toEqual(['beta_live_wasl'])
  })
  it('a P2 guard removed from a function', async () => {
    const r = await run([`create or replace function public.remove_payment_method(p_payment_method_id uuid) returns void language plpgsql security definer set search_path = '' as $$ begin null; end $$`])
    expect(r.r.failures).toContain('p2_missing:remove_payment_method')
  })
  it('an account outside the allowlist (sign-up gate bypassed)', async () => {
    const r = await run([`alter table auth.users disable trigger aa_ops_guard_signup`, `insert into auth.users (phone) values ('966512345678')`])
    expect(r.r.failures).toEqual(expect.arrayContaining(['trigger_disabled:auth.users.aa_ops_guard_signup', 'beta_unlisted_accounts']))
  })
  it('a failure is appended to the history (alert source) and refuses writes; the clean state is restored', async () => {
    const setup = [`alter table public.payouts disable trigger aa_ops_guard_write`, `select ops_guard.integrity_check()`]
    const ev = await peek<{ ok: boolean }>('owner', `select ok from ops_guard.integrity_events order by id desc limit 1`, [], setup)
    expect(ev.ok).toBe(false)
    expect(await attempt('service', `select create_payout_batch()`, [], setup)).toBe('integrity_refused')
    const now = (await db.query<{ r: { ok: boolean } }>(`select ops_guard.integrity_check() r`)).rows[0].r
    expect(now.ok).toBe(true)
  })
})

describe('A9 · SECURITY DEFINER + empty search_path: shadow objects in public change nothing', () => {
  it('fake public tables / functions with guard names do not alter the result', async () => {
    const shadow = [
      `create table public.environment (id boolean, mode text, project_ref text, digest text)`,
      `insert into public.environment values (true, 'production', '${PROD_REF}', 'x')`,
      `create function public.marker_state() returns text language sql as $$ select 'ok' $$`,
      `create function public.prod_project_ref() returns text language sql as $$ select '${BETA_REF}' $$`,
      `create function public.live_allowed() returns boolean language sql as $$ select true $$`,
      `set local search_path = public, ops_guard`,
    ]
    const c = await peek<{ c: Record<string, unknown> }>('service', `select public.ops_runtime_config() c`, [], shadow)
    expect(c.c).toMatchObject({ marker_state: 'ok', mode: 'beta', live_allowed: false, prod_project_ref: null })
    expect(await attempt('service', `select create_payment_intent($1, 'wallet_topup', null, 5000, 'card', 'moyasar', null)`, [rider], shadow)).toBe('live_refused')
  })
  it('service_role can execute only ops_runtime_config and the integrity check; anon/authenticated neither', async () => {
    const r = await db.query<{ fn: string; svc: boolean; auth: boolean; anon: boolean; hook: boolean }>(
      `select p.oid::regprocedure::text fn, has_function_privilege('service_role', p.oid, 'EXECUTE') svc,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') auth, has_function_privilege('anon', p.oid, 'EXECUTE') anon,
              has_function_privilege('supabase_auth_admin', p.oid, 'EXECUTE') hook
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'ops_guard' or (n.nspname = 'public' and p.proname in ('ops_runtime_config', 'ops_integrity_check')) order by 1`)
    expect(r.rows.filter((x) => x.svc).map((x) => x.fn).sort()).toEqual(['ops_guard.integrity_check()', 'ops_integrity_check()', 'ops_runtime_config()'])
    expect(r.rows.filter((x) => x.auth || x.anon)).toEqual([])
    expect(r.rows.filter((x) => x.hook).map((x) => x.fn).sort()).toEqual(['ops_guard.hook_before_user_created(jsonb)', 'ops_guard.hook_custom_access_token(jsonb)'])
  })
})

// ────────────────────────────────────────────────────────────────────────────
describe('A11 · closed sign-ups, Auth hooks and tester revocation', () => {
  it('the backup trigger refuses an account outside the allowlist; an allowlisted number is accepted', async () => {
    await expect(db.query(`insert into auth.users (phone) values ('966512340000')`)).rejects.toThrow(/sign-ups are closed/)
    await expect(db.query(`insert into auth.users (email) values ('stranger@example.org')`)).rejects.toThrow(/sign-ups are closed/)
    expect(await attempt('owner', `insert into auth.users (phone) values ('966551000099')`, [], [`select ops_guard.allow_tester('966551000099')`])).toBe('ok')
  })

  it('the trigger fires for the auth admin role too (Admin API path), and is ENABLE ALWAYS here', async () => {
    const asAuthAdmin = [`grant usage on schema auth to supabase_auth_admin`, `grant insert, select on auth.users to supabase_auth_admin`, `set local role supabase_auth_admin`]
    expect(await attempt('owner', `insert into auth.users (phone) values ('966512340001')`, [], asAuthAdmin)).toMatch(/sign-ups are closed/)
    expect(await attempt('owner', `insert into auth.users (phone) values ('966512340001')`, [], [`set local session_replication_role = replica`])).toMatch(/sign-ups are closed/)
    const t = await db.query<{ e: string }>(`select tgenabled e from pg_trigger where tgname = 'aa_ops_guard_signup'`)
    expect(t.rows[0].e).toBe('A')
  })

  it('hook "Before User Created": allowlisted → {}, others → 403', async () => {
    const hook = async (u: object) => (await db.query<{ r: Record<string, unknown> }>(`select ops_guard.hook_before_user_created($1) r`, [JSON.stringify({ user: u })])).rows[0].r
    expect(await hook({ phone: '966551000001' })).toEqual({})
    expect(await hook({ phone: '+966551000001' })).toEqual({})
    expect(await hook({ phone: '966512349999' })).toEqual({ error: { http_code: 403, message: 'Sign-ups are closed' } })
    expect(await hook({ email: 'someone@example.org' })).toMatchObject({ error: { http_code: 403 } })
    expect(await hook({})).toMatchObject({ error: { http_code: 403 } })
  })

  it('hook "Custom Access Token" passes claims through for testers and refuses unknown users', async () => {
    const claims = { sub: rider, role: 'authenticated', aal: 'aal1' }
    const tok = async (uid: string) => (await db.query<{ r: Record<string, unknown> }>(`select ops_guard.hook_custom_access_token($1) r`,
      [JSON.stringify({ user_id: uid, claims })])).rows[0].r
    expect(await tok(rider)).toEqual({ claims })
    expect(await tok('00000000-0000-4000-8000-000000000000')).toMatchObject({ error: { http_code: 403 } })
  })

  it('revoke_tester: off the allowlist, blocked, sessions gone; token refresh, create_ride and admin_can refuse at once', async () => {
    const staff = await newUser('966500000077')
    await db.query(`select private.grant_admin($1, 'finance_manager')`, [staff])
    MFA.add(staff)
    expect((await asUser<{ ok: boolean }>(staff, `select private.admin_can('finance.settle') ok`)).ok).toBe(true)

    expect((await db.query<{ r: Record<string, unknown> }>(`select ops_guard.revoke_tester('966551000001') r`)).rows[0].r)
      .toMatchObject({ users: 1, allowlist_removed: true, blocked: 1 })
    expect((await db.query<{ r: Record<string, unknown> }>(`select ops_guard.revoke_tester('966500000077') r`)).rows[0].r)
      .toMatchObject({ users: 1, allowlist_removed: true, blocked: 1 })
    expect((await db.query<{ b: boolean }>(`select is_blocked b from profiles where id = $1`, [rider])).rows[0].b).toBe(true)
    const tok = (await db.query<{ r: Record<string, unknown> }>(`select ops_guard.hook_custom_access_token($1) r`,
      [JSON.stringify({ user_id: rider, claims: { sub: rider } })])).rows[0].r
    expect(tok).toMatchObject({ error: { http_code: 403 } })
    expect(await attempt('service', `select create_ride($1, 'riyadh', 'go', 24.7136, 46.6753, 'Olaya', 24.7633, 46.6407, 'KAFD', 10000, 1200, 'cash')`, [rider]))
      .toMatch(/account is blocked/)
    expect((await asUser<{ ok: boolean }>(staff, `select private.admin_can('finance.settle') ok`)).ok).toBe(false)
    // A blocked account stays acceptable to the integrity check (it is revoked, not unlisted).
    expect((await db.query<{ r: { ok: boolean } }>(`select ops_guard.integrity_check() r`)).rows[0].r.ok).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Migration 022 — review fixes F1, F2, F4, F5, F6
// ════════════════════════════════════════════════════════════════════════════

/** Run owner `setup`, then `fn` in the same transaction, then ALWAYS roll back; returns fn's value. */
async function inTx<T>(setup: string[], fn: (tx: Transaction) => Promise<T>): Promise<T> {
  let out: T | undefined
  try {
    await db.transaction(async (tx) => {
      for (const s of setup) await tx.exec(s)
      out = await fn(tx)
      throw new Rollback()
    })
  } catch (e) {
    if (!(e instanceof Rollback)) throw e
  }
  return out as T
}
const val = async <T>(tx: Transaction, sql: string, p: unknown[] = []) => (await tx.query<{ v: T }>(sql, p)).rows[0].v
// Breaks a control unrelated to the money tables, so the money triggers themselves stay active.
const INTEGRITY_FAILED = [`alter table ops_guard.allowlist disable trigger allowlist_no_truncate`, `select ops_guard.integrity_check()`]
const TRIGGERS_DISABLED = [`alter table public.payment_methods disable trigger aa_ops_guard_write`, `alter table public.wasl_sync_log disable trigger aa_ops_guard_write`]

describe('F1 · privacy (erase_user, apply_retention, redaction) is never blocked — and is not a way around the money guard', () => {
  let subject: string
  beforeAll(async () => {
    subject = await newUser('966552000001')
    await db.query(`update auth.users set email = 'subject@example.org' where id = $1`, [subject])
    await db.query(`select save_payment_method($1, 'mock', 'card', 'tok_s1', 'visa', '4242', 12, 2030, 'Subject Holder')`, [subject])
    await db.query(`select save_payment_method($1, 'mock', 'mada', 'tok_s2', 'mada', '1111', 10, 2031, 'Subject Holder')`, [subject])
    for (const days of [400, 10]) {
      await db.query(
        `insert into public.wasl_sync_log (entity_type, entity_id, operation, provider, status, request_payload, response_payload, created_at, completed_at)
         values ('driver', $1, 'eligibility_check', 'mock', 'success', '{"national_id":"1070000001"}', '{"ok":true}', now() - make_interval(days => $2), now() - make_interval(days => $2))`,
        [subject, days])
    }
    expect((await db.query<{ r: { ok: boolean } }>(`select ops_guard.integrity_check() r`)).rows[0].r.ok).toBe(true)
  })

  const scenarios: [string, string[]][] = [
    ['healthy, triggers enabled', []],
    ['marker missing', MARKER_MISSING],
    ['marker corrupt', MARKER_CORRUPT],
    ['integrity failed', INTEGRITY_FAILED],
    ['guard triggers disabled', TRIGGERS_DISABLED],
  ]
  for (const [name, setup] of scenarios) {
    it(`erase_user + apply_retention succeed and redact real data — ${name}`, async () => {
      const r = await inTx(setup, async (tx) => {
        const before = await val<string>(tx, `select (select count(*) from payments) || '/' || (select count(*) from payouts) || '/' || (select count(*) from wasl_sync_log) v`)
        await tx.query(`select private.erase_user($1)`, [subject])
        await tx.query(`select private.apply_retention()`)
        const cards = (await tx.query<{ provider: string; deleted: boolean; holder: string | null; def: boolean; last4: string }>(
          `select provider, deleted_at is not null deleted, holder_name holder, is_default def, last4 from payment_methods where rider_id = $1 order by last4`, [subject])).rows
        const wasl = (await tx.query<{ old: boolean; req: unknown; provider: string }>(
          `select created_at < now() - interval '365 days' old, request_payload req, provider from wasl_sync_log where entity_id = $1 order by created_at`, [subject])).rows
        const after = await val<string>(tx, `select (select count(*) from payments) || '/' || (select count(*) from payouts) || '/' || (select count(*) from wasl_sync_log) v`)
        const live = await val<number>(tx, `select ((select count(*) from payments where provider::text in ('moyasar','hyperpay')) + (select count(*) from payouts where provider <> 'mock') + (select count(*) from wasl_sync_log where provider <> 'mock'))::int v`)
        const exemptions = await val<number>(tx, `select count(*)::int v from ops_guard.guard_exemptions`)
        return { before, after, cards, wasl, live, exemptions }
      })
      // Card data redacted, nothing financial changed.
      expect(r.cards).toEqual([
        { provider: 'mock', deleted: true, holder: null, def: false, last4: '1111' },
        { provider: 'mock', deleted: true, holder: null, def: false, last4: '4242' },
      ])
      // Retention redacted only the payload past retention (365 days); the recent one stays.
      expect(r.wasl).toEqual([{ old: true, req: null, provider: 'mock' }, { old: false, req: { national_id: '1070000001' }, provider: 'mock' }])
      // No payment, payout or Wasl submission was created; nothing live exists.
      expect(r.after).toBe(r.before)
      expect(r.live).toBe(0)
      // Redactions in a degraded environment are recorded for investigation; none when healthy or when the trigger did not run.
      const degraded = name === 'marker missing' || name === 'marker corrupt' || name === 'integrity failed'
      expect(r.exemptions > 0, `exemptions logged: ${name}`).toBe(degraded)
    })
  }

  it('a live-provider card is redacted too (no provider change, no payment, no external call possible from SQL)', async () => {
    const r = await inTx([`alter table public.payment_methods disable trigger aa_ops_guard_write`,
      `insert into public.payment_methods (rider_id, provider, method_type, brand, last4, exp_month, exp_year, holder_name) values ('${subject}', 'moyasar', 'card', 'visa', '9999', 1, 2030, 'Live Holder')`,
      `alter table public.payment_methods enable always trigger aa_ops_guard_write`, ...INTEGRITY_FAILED], async (tx) => {
      await tx.query(`select private.erase_user($1)`, [subject])
      return (await tx.query(`select provider, deleted_at is not null deleted, holder_name from payment_methods where rider_id = $1 and last4 = '9999'`, [subject])).rows[0]
    })
    expect(r).toEqual({ provider: 'moyasar', deleted: true, holder_name: null })
  })

  // The exemption is a SHAPE, not a bypass: anything that is not a pure redaction is still refused.
  const abuse: [string, string][] = [
    ['switch provider to moyasar', `update public.payment_methods set provider = 'moyasar' where rider_id = '__S__'`],
    ['redaction + provider change in one statement', `update public.payment_methods set holder_name = null, provider = 'moyasar' where rider_id = '__S__'`],
    ['un-delete a card', `update public.payment_methods set deleted_at = null where rider_id = '__S__' and last4 = '4242'`],
    ['change card digits', `update public.payment_methods set last4 = '0000' where rider_id = '__S__'`],
    ['set (not clear) the holder', `update public.payment_methods set holder_name = 'Someone' where rider_id = '__S__'`],
    ['make a card default', `update public.payment_methods set is_default = true where rider_id = '__S__' and last4 = '1111'`],
    ['insert a mock card', `insert into public.payment_methods (rider_id, provider, method_type) values ('__S__', 'mock', 'card')`],
    ['write a Wasl payload', `update public.wasl_sync_log set request_payload = '{"x":1}' where entity_id = '__S__'`],
    ['switch Wasl provider', `update public.wasl_sync_log set provider = 'wasl' where entity_id = '__S__'`],
    ['change Wasl status', `update public.wasl_sync_log set status = 'failed' where entity_id = '__S__'`],
    ['no-op update on payments (no redaction shape for money)', `update public.payments set status = status`],
    ['no-op update on payouts (no redaction shape for money)', `update public.payouts set status = status`],
  ]
  for (const [label, sql] of abuse) {
    it(`refused in a degraded environment: ${label}`, async () => {
      for (const setup of [MARKER_MISSING, INTEGRITY_FAILED]) {
        // Start from an erased subject (deleted cards, redacted payloads), so "un-delete" has rows to act on.
        const o = await attempt('owner', sql.replace('__S__', subject), [], [`select private.erase_user('${subject}')`, ...setup])
        expect(o, `${label}`).toMatch(/^(marker_missing|integrity_refused|live_refused)$/)
      }
    })
  }

  it('in a healthy BETA a non-redaction live change is still refused (live check unchanged)', async () => {
    expect(await attempt('owner', `update public.payment_methods set holder_name = null, provider = 'moyasar' where rider_id = '${subject}'`)).toBe('live_refused')
    expect(await attempt('owner', `update public.wasl_sync_log set request_payload = null, provider = 'wasl' where entity_id = '${subject}'`)).toBe('live_refused')
  })

  it('privacy functions keep their access control: only the service role (privacy worker) may call them; Wasl live stays refused', async () => {
    expect(await attempt('service', `select private.erase_user($1)`, [subject])).toBe('ok') // the authorised caller, unchanged
    for (const who of ['anon', rider2]) {
      expect(await attempt(who, `select private.erase_user($1)`, [subject]), who).toBe('permission_denied')
      expect(await attempt(who, `select private.apply_retention()`), who).toBe('permission_denied')
    }
    expect(await attempt('service', `select record_wasl_result('driver', $1, 'eligibility_check', 'wasl', true)`, [subject], INTEGRITY_FAILED)).toBe('integrity_refused')
  })

  it('the exemption log is append-only and unreadable by API roles', async () => {
    const row = [`insert into ops_guard.guard_exemptions (table_name, marker_state) values ('payment_methods', 'missing')`]
    expect(await attempt('owner', `delete from ops_guard.guard_exemptions`, [], row)).toMatch(/append-only/)
    expect(await attempt('owner', `update ops_guard.guard_exemptions set actor = 'x'`, [], row)).toMatch(/append-only/)
    expect(await attempt('service', `select * from ops_guard.guard_exemptions`)).toBe('permission_denied')
  })
})

describe('F2 · revoke_tester: allowlist + block always, sessions best-effort and reported truthfully', () => {
  const AUTH_TABLES = [
    `create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null)`,
    `create table auth.refresh_tokens (id bigserial primary key, user_id varchar(255), token text)`,
  ]
  const seed = (uid: string) => [`insert into auth.sessions (user_id) values ('${uid}'), ('${uid}')`, `insert into auth.refresh_tokens (user_id, token) values ('${uid}', 't1')`]

  it('deletes sessions and refresh tokens when it can, and says how many', async () => {
    const u = await newUser('966553000001')
    const r = await inTx([...AUTH_TABLES, ...seed(u)], async (tx) => ({
      res: await val<Record<string, unknown>>(tx, `select ops_guard.revoke_tester('966553000001') v`),
      left: await val<number>(tx, `select ((select count(*) from auth.sessions) + (select count(*) from auth.refresh_tokens))::int v`),
    }))
    expect(r.res).toMatchObject({ users: 1, allowlist_removed: true, blocked: 1, sessions: 'deleted:2', refresh_tokens: 'deleted:1' })
    expect(r.left).toBe(0)
  })

  it('a failing session delete does NOT undo the allowlist removal or the block, and is reported as failed', async () => {
    const u = await newUser('966553000002')
    const deny = [`create function auth.deny_delete() returns trigger language plpgsql as $$ begin raise exception 'permission denied for table sessions' using errcode = '42501'; end $$`,
      `create trigger deny before delete on auth.sessions for each row execute function auth.deny_delete()`]
    const r = await inTx([...AUTH_TABLES, ...seed(u), ...deny], async (tx) => ({
      res: await val<Record<string, unknown>>(tx, `select ops_guard.revoke_tester('966553000002') v`),
      listed: await val<boolean>(tx, `select exists (select 1 from ops_guard.allowlist where identity = '966553000002') v`),
      blocked: await val<boolean>(tx, `select is_blocked v from profiles where id = $1`, [u]),
      sessionsLeft: await val<number>(tx, `select count(*)::int v from auth.sessions`),
      log: (await tx.query(`select users, allowlist_removed, blocked, sessions, refresh_tokens from ops_guard.revocation_log order by id desc limit 1`)).rows[0],
      payment: await tx.query(`select create_payment_intent($1, 'wallet_topup', null, 5000, 'card', 'mock', null)`, [u]).then(() => 'ok', (e: Error) => e.message),
    }))
    expect(r.res).toMatchObject({ allowlist_removed: true, blocked: 1, sessions: 'failed:42501', refresh_tokens: 'deleted:1' })
    expect(r.listed).toBe(false)
    expect(r.blocked).toBe(true)
    expect(r.sessionsLeft).toBe(2) // not claimed as revoked
    expect(r.log).toEqual({ users: 1, allowlist_removed: true, blocked: 1, sessions: 'failed:42501', refresh_tokens: 'deleted:1' })
    expect(r.payment).toMatch(/account is blocked/) // sensitive RPCs refuse at once via is_blocked
  })

  it('without the auth tables it reports "absent"; an unknown identity still leaves a log entry', async () => {
    const u = await newUser('966553000003')
    expect((await db.query<{ r: Record<string, unknown> }>(`select ops_guard.revoke_tester('966553000003') r`)).rows[0].r)
      .toMatchObject({ users: 1, allowlist_removed: true, blocked: 1, sessions: 'absent', refresh_tokens: 'absent' })
    expect((await db.query<{ b: boolean }>(`select is_blocked b from profiles where id = $1`, [u])).rows[0].b).toBe(true)
    expect((await db.query<{ r: Record<string, unknown> }>(`select ops_guard.revoke_tester('966559999999') r`)).rows[0].r)
      .toMatchObject({ users: 0, allowlist_removed: false, blocked: 0 })
    await expect(db.query(`select ops_guard.revoke_tester('')`)).rejects.toThrow(/identity required/)
    expect((await db.query<{ r: { ok: boolean } }>(`select ops_guard.integrity_check() r`)).rows[0].r.ok).toBe(true)
  })
})

describe('F4 · staff (e-mail) and testers (phone) on the same allowlist', () => {
  it('an allowlisted staff e-mail (any case / spaces) can be created, made admin, and integrity stays green', async () => {
    await db.query(`select ops_guard.allow_tester('  Ops.Lead@Aura.SA ', 'staff')`)
    expect((await db.query<{ i: string }>(`select identity i from ops_guard.allowlist where identity like '%@%' order by added_at desc limit 1`)).rows[0].i).toBe('ops.lead@aura.sa')
    const staff = (await db.query<{ id: string }>(`insert into auth.users (email) values ('ops.lead@aura.sa') returning id`)).rows[0].id
    await db.query(`select private.grant_admin($1, 'customer_support')`, [staff])
    expect((await db.query<{ r: Record<string, unknown> }>(`select ops_guard.hook_before_user_created('{"user":{"email":"OPS.LEAD@aura.sa"}}') r`)).rows[0].r).toEqual({})
    expect((await db.query<{ r: Record<string, unknown> }>(`select ops_guard.hook_custom_access_token($1) r`, [JSON.stringify({ user_id: staff, claims: { sub: staff, aal: 'aal2' } })])).rows[0].r)
      .toEqual({ claims: { sub: staff, aal: 'aal2' } })
    expect((await db.query<{ r: { ok: boolean } }>(`select ops_guard.integrity_check() r`)).rows[0].r.ok).toBe(true)
  })

  it('a staff account with both e-mail and phone is accepted when either is allowlisted', async () => {
    await db.query(`select ops_guard.allow_tester('finance.two@aura.sa')`)
    await db.query(`insert into auth.users (email, phone) values ('finance.two@aura.sa', '966554000002')`)
    await db.query(`select ops_guard.allow_tester('+966 55 400 0003')`)
    await db.query(`insert into auth.users (email, phone) values ('unlisted.mail@aura.sa', '966554000003')`)
    expect((await db.query<{ r: { ok: boolean } }>(`select ops_guard.integrity_check() r`)).rows[0].r.ok).toBe(true)
  })

  it('an unlisted staff account is refused at creation, so it can never turn integrity red', async () => {
    await expect(db.query(`insert into auth.users (email) values ('not.listed@aura.sa')`)).rejects.toThrow(/sign-ups are closed/)
    expect((await db.query<{ r: Record<string, unknown> }>(`select ops_guard.hook_before_user_created('{"user":{"email":"not.listed@aura.sa"}}') r`)).rows[0].r)
      .toMatchObject({ error: { http_code: 403 } })
    expect((await db.query<{ r: { ok: boolean } }>(`select ops_guard.integrity_check() r`)).rows[0].r.ok).toBe(true)
  })

  it('a revoked staff e-mail is blocked and loses admin rights; integrity stays green (revoked ≠ unlisted)', async () => {
    const staff = (await db.query<{ id: string }>(`select id from auth.users where email = 'ops.lead@aura.sa'`)).rows[0].id
    MFA.add(staff)
    expect((await asUser<{ ok: boolean }>(staff, `select private.admin_can('support.view') ok`)).ok).toBe(true)
    expect((await db.query<{ r: Record<string, unknown> }>(`select ops_guard.revoke_tester('OPS.LEAD@aura.sa') r`)).rows[0].r).toMatchObject({ users: 1, blocked: 1 })
    expect((await asUser<{ ok: boolean }>(staff, `select private.admin_can('support.view') ok`)).ok).toBe(false)
    expect((await db.query<{ r: { ok: boolean } }>(`select ops_guard.integrity_check() r`)).rows[0].r.ok).toBe(true)
  })
})

describe('F5 · integrity history: one row per change, failing_since, retention ≥ 365 days', () => {
  const events = (tx: Transaction) => val<number>(tx, `select count(*)::int v from ops_guard.integrity_events`)

  it('repeated healthy checks add no rows', async () => {
    const r = await inTx([], async (tx) => {
      const a = await events(tx)
      for (let i = 0; i < 5; i++) await tx.query(`select ops_guard.integrity_check()`)
      return (await events(tx)) - a
    })
    expect(r).toBe(0)
  })

  it('a lasting failure is one row (failing_since stays put); a new failure set is one more; recovery is one more', async () => {
    const r = await inTx([], async (tx) => {
      const a = await events(tx)
      await tx.exec(`alter table public.payouts disable trigger aa_ops_guard_write`)
      await tx.query(`select ops_guard.integrity_check()`)
      const since1 = await val<string>(tx, `select failing_since::text v from ops_guard.integrity_status`)
      await tx.exec(`select pg_sleep(0.01)`)
      for (let i = 0; i < 4; i++) await tx.query(`select ops_guard.integrity_check()`)
      const afterSame = (await events(tx)) - a
      const since2 = await val<string>(tx, `select failing_since::text v from ops_guard.integrity_status`)
      await tx.exec(`alter table public.payments disable trigger aa_ops_guard_write`)
      await tx.query(`select ops_guard.integrity_check()`)
      const afterNew = (await events(tx)) - a
      await tx.exec(`alter table public.payouts enable always trigger aa_ops_guard_write`)
      await tx.exec(`alter table public.payments enable always trigger aa_ops_guard_write`)
      const rec = await val<{ ok: boolean; failing_since: string | null }>(tx, `select ops_guard.integrity_check() v`)
      const last = (await tx.query<{ ok: boolean }>(`select ok from ops_guard.integrity_events order by id desc limit 1`)).rows[0]
      return { afterSame, afterNew, same: since1 === since2 && since1 !== null, rec, total: (await events(tx)) - a, last }
    })
    expect(r).toEqual({ afterSame: 1, afterNew: 2, same: true, rec: { ok: true, failures: [], failing_since: null }, total: 3, last: { ok: true } })
  })

  it('purge keeps ≥ 365 days, deletes only older rows; nobody can delete recent history; audit logs are never purged', async () => {
    const r = await inTx([
      `insert into ops_guard.integrity_events (ok, failures, created_at) values (false, '["old"]', now() - interval '500 days'), (false, '["recent"]', now() - interval '200 days')`,
    ], async (tx) => {
      await tx.query(`savepoint p`)
      const tooShort = await tx.query(`select ops_guard.purge_integrity_events(100)`).then(() => 'ok', async (e: Error) => { await tx.query(`rollback to savepoint p`); return e.message })
      const purged = await val<number>(tx, `select ops_guard.purge_integrity_events(400) v`)
      const left = (await tx.query<{ f: string[] }>(`select failures f from ops_guard.integrity_events where created_at < now() - interval '100 days'`)).rows.map((x) => x.f)
      return { tooShort, purged, left }
    })
    expect(r.tooShort).toMatch(/at least 365 days/)
    expect(r.purged).toBe(1)
    expect(r.left).toEqual([['recent']])
    expect(await attempt('owner', `delete from ops_guard.integrity_events`)).toMatch(/append-only/)
    // Even with the purge flag forged, a recent row cannot be deleted.
    expect(await attempt('owner', `delete from ops_guard.integrity_events where created_at > now() - interval '1 day'`, [],
      [`insert into ops_guard.integrity_events (ok, failures) values (false, '["x"]')`, `select set_config('ops_guard.history_purge', 'on', true)`])).toMatch(/append-only/)
    const rowsIn = [`insert into ops_guard.guard_exemptions (table_name, marker_state) values ('payment_methods', 'missing')`]
    for (const t of ['allowlist_log', 'guard_exemptions', 'revocation_log']) {
      expect(await attempt('owner', `select count(*) from ops_guard.${t}`, [], rowsIn), t).toBe('ok')
      expect(await attempt('owner', `delete from ops_guard.${t}`, [], rowsIn), t).toMatch(/append-only/)
      expect(await attempt('owner', `truncate ops_guard.${t}`), t).toMatch(/append-only/)
    }
  })

  it('the integrity check watches the audit triggers too', async () => {
    const r = await peek<{ r: { failures: string[] } }>('owner', `select ops_guard.integrity_check() r`, [], [`alter table ops_guard.revocation_log disable trigger revocation_log_append_only`])
    expect(r.r.failures).toContain('audit_trigger_not_always:ops_guard.revocation_log')
  })
})

describe('F6 · fail closed on integrity failure, automatic recovery when the check is green again', () => {
  it('what stops and what continues while integrity is failed (database layer)', async () => {
    const cashRider = await newUser('966556000001')
    await asUser(cashRider, `select 1`)
    for (const [purpose, version] of Object.entries(CONSENT_VERSIONS).filter(([k]) => (REQUIRED_CONSENTS.rider as readonly string[]).includes(k))) {
      await asUser(cashRider, `select record_consent($1, true, $2, 'rider_app')`, [purpose, version])
    }
    const r = await inTx(INTEGRITY_FAILED, async (tx) => {
      const run = (sql: string, p: unknown[] = []) => tx.query(`savepoint s`).then(() => tx.query(sql, p)).then(
        async () => { await tx.query(`release savepoint s`); return 'runs' },
        async (e: Error) => { await tx.query(`rollback to savepoint s`); return /AURA_GUARD/.test(e.message) ? 'stops' : 'error:' + e.message })
      return {
        card_payment: await run(`select create_payment_intent($1, 'wallet_topup', null, 5000, 'card', 'mock', null)`, [rider2]),
        payout_batch: await run(`select create_payout_batch()`),
        wasl_result: await run(`select record_wasl_result('driver', $1, 'eligibility_check', 'mock', true)`, [captain]),
        save_card: await run(`select save_payment_method($1, 'mock', 'card', 't', 'visa', '4242', 12, 2030)`, [rider2]),
        cash_ride_in_db: await run(`select create_ride($1, 'riyadh', 'go', 24.7136, 46.6753, 'Olaya', 24.7633, 46.6407, 'KAFD', 10000, 1200, 'cash')`, [cashRider]),
        erasure: await run(`select private.apply_retention()`),
      }
    })
    expect(r).toEqual({ card_payment: 'stops', payout_batch: 'stops', wasl_result: 'stops', save_card: 'stops', cash_ride_in_db: 'runs', erasure: 'runs' })
  })

  it('once the cause is fixed and the scheduled check is green, sensitive writes work again with no manual reset', async () => {
    const r = await inTx(INTEGRITY_FAILED, async (tx) => {
      const refused = await tx.query(`savepoint a`).then(() => tx.query(`select create_payout_batch()`)).then(() => 'ok', async (e: Error) => { await tx.query(`rollback to savepoint a`); return e.message })
      await tx.exec(`alter table ops_guard.allowlist enable always trigger allowlist_no_truncate`) // the fix
      await tx.query(`select ops_guard.integrity_check()`) // the next scheduled run
      const ok = await tx.query(`select create_payout_batch()`).then(() => 'ok', (e: Error) => e.message)
      return { refused, ok }
    })
    expect(r.refused).toMatch(/integrity check failed/)
    expect(r.ok).toBe('ok')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Migration 023 — F2 closed: a blocked account is refused at the operation itself
// ════════════════════════════════════════════════════════════════════════════
describe('F2 (migration 023) · a token issued before the block is refused at the operation', () => {
  const V = '2026-11-26'
  let seq = 0
  const consent = async (uid: string, app: 'rider' | 'driver') => {
    const req = app === 'rider' ? ['terms_of_service', 'privacy_policy'] : ['terms_of_service', 'privacy_policy', 'location_tracking', 'regulatory_data_sharing']
    for (const k of req) await asUser(uid, `select record_consent($1, true, $2, $3)`, [k, V, app === 'rider' ? 'rider_app' : 'driver_app'])
  }
  const mkRider = async (phone: string) => { const id = await newUser(phone); await consent(id, 'rider'); return id }
  const mkCaptain = async (phone: string, lat: number, lng: number) => {
    seq += 1
    const id = await newUser(phone)
    await db.query(`insert into drivers (id, status, city_id, national_id, date_of_birth, iban, approved_at, wasl_status)
      values ($1, 'approved', (select id from cities where code = 'riyadh'), $2, '1991-02-03', 'SA0380000000608010167519', now(), 'eligible')`, [id, `10${80000000 + seq}`])
    const v = (await db.query<{ id: string }>(`insert into vehicles (driver_id, vehicle_class, make, model, year, color, plate_letters, plate_number, sequence_number, seats, status, wasl_status)
      values ($1, 'go', 'Hyundai', 'Elantra', 2024, 'Silver', 'KSA', $2, $3, 4, 'approved', 'eligible') returning id`, [id, String(5000 + seq), String(800000000 + seq)])).rows[0].id
    await db.query(`update drivers set current_vehicle_id = $2 where id = $1`, [id, v])
    await db.query(`insert into driver_documents (driver_id, vehicle_id, doc_type, storage_path, status, expires_at)
      select $1::uuid, case when t in ('vehicle_registration', 'vehicle_insurance') then $2::uuid end, t, $1::text || '/' || t::text || '.jpg', 'approved', '2030-06-30'
        from unnest(array['national_id', 'driving_license', 'profile_photo', 'vehicle_registration', 'vehicle_insurance']::document_type[]) t`, [id, v])
    await consent(id, 'driver')
    await db.query(`update drivers set is_online = true where id = $1`, [id])
    await asUser(id, `select update_driver_location($1, $2, 90, 0, 8)`, [lat, lng])
    return id
  }
  const credit = (kind: string, owner: string, amt: number) => db.query(
    `with t as (select gen_random_uuid() id) insert into wallet_ledger (transaction_id, account_id, entry_type, amount_halalas)
     select t.id, a.id, 'adjustment', v.amt from t, (values ($1::account_type, $3::bigint), ('adjustments'::account_type, -$3::bigint)) v(kind, amt)
       join wallet_accounts a on a.account_type = v.kind and (a.owner_id = $2 or (a.owner_id is null and v.kind = 'adjustments'))`, [kind, owner, amt])
  const ride = async (r: string, c: string, lat: number, lng: number) => {
    const id = (await asUser<{ id: string }>('service', `select (create_ride($1, 'riyadh', 'go', $2, $3, 'A', 24.7633, 46.6407, 'B', 10000, 1200, 'cash')).id`, [r, lat, lng])).id
    expect((await asUser<{ d: string }>('service', `select dispatch_ride($1) d`, [id])).d).toBe(c)
    await asUser(c, `select accept_ride($1)`, [id])
    return id
  }
  const toStarted = async (id: string, r: string, c: string) => {
    await asUser(c, `select transition_ride($1, 'driver_arriving')`, [id])
    await asUser(c, `select transition_ride($1, 'driver_arrived')`, [id])
    const code = (await asUser<{ c: string }>(r, `select issue_ride_verification_code($1) c`, [id])).c
    await asUser(c, `select start_ride($1, $2)`, [id, code])
  }
  const blocked = (o: string) => o === 'error:AURA: account is blocked' || o === 'permission_denied'

  let rB: string, cB: string, rOK: string, cOK: string, doneRide: string, liveRide: string, cardB: string, cardOK: string
  // Each sensitive operation, written once, run for the blocked pair and for an unaffected pair.
  const ops = (r: string, c: string, card: string, ride0: string) => [
    ['add_wallet_tip (wallet money)', r, `select add_wallet_tip('${ride0}', 500)`],
    ['request_payout (money)', c, `select request_payout(10000)`],
    ['set_default_payment_method', r, `select set_default_payment_method('${card}')`],
    ['remove_payment_method', r, `select remove_payment_method('${card}')`],
    ['save_payment_method (service, for the rider)', 'service', `select save_payment_method('${r}', 'mock', 'card', 'tok_f2', 'visa', '4242', 12, 2030)`],
    ['create_payment_intent (service, top-up)', 'service', `select create_payment_intent('${r}', 'wallet_topup', null, 5000, 'card', 'mock', null)`],
    ['create_ride (new trip)', 'service', `select create_ride('${r}', 'riyadh', 'go', 24.7136, 46.6753, 'A', 24.76, 46.64, 'B', 10000, 1200, 'cash')`],
    ['rate_ride', r, `select rate_ride('${ride0}', 4)`],
    ['RLS: change IBAN', c, `update drivers set iban = 'SA4420000001234567891234' where id = '${c}' returning id`],
    ['RLS: change bank / city', c, `update drivers set bank_name = 'X' where id = '${c}' returning id`],
    ['RLS: go online', c, `update drivers set is_online = true where id = '${c}' returning id`],
    ['RLS: profile name', r, `update profiles set full_name = 'Changed' where id = '${r}' returning id`],
    ['RLS: rider emergency contact', r, `update riders set emergency_contact_name = 'X', emergency_contact_phone = '966500000000' where id = '${r}' returning id`],
    ['RLS: rider default card', r, `update riders set default_payment_method_id = null where id = '${r}' returning id`],
    ['RLS: add vehicle', c, `insert into vehicles (driver_id, vehicle_class, make, model, year, color, plate_letters, plate_number, sequence_number, seats) values ('${c}', 'go', 'Kia', 'K5', 2024, 'Black', 'ABC', '9${seq}1', '7${seq}0000001', 4) returning id`],
    ['RLS: upload document row', c, `insert into driver_documents (driver_id, doc_type, storage_path) values ('${c}', 'profile_photo', '${c}/x.jpg') returning id`],
    ['RLS: raw location write', c, `update driver_locations set heading = 1 where driver_id = '${c}' returning driver_id`],
  ] as const

  beforeAll(async () => {
    rB = await mkRider('966557000001'); cB = await mkCaptain('966557000002', 24.7136, 46.6753)
    rOK = await mkRider('966557000003'); cOK = await mkCaptain('966557000004', 24.80, 46.70)
    // Blocked pair: one finished trip (for tip / rating) and one trip in progress at block time.
    doneRide = await ride(rB, cB, 24.7136, 46.6753); await toStarted(doneRide, rB, cB)
    await asUser(cB, `select transition_ride($1, 'completed')`, [doneRide])
    liveRide = await ride(rB, cB, 24.7136, 46.6753); await toStarted(liveRide, rB, cB)
    const okRide = await ride(rOK, cOK, 24.80, 46.70); await toStarted(okRide, rOK, cOK)
    await asUser(cOK, `select transition_ride($1, 'completed')`, [okRide])
    for (const [k, id] of [['rider_wallet', rB], ['rider_wallet', rOK], ['driver_wallet', cB], ['driver_wallet', cOK]] as const) await credit(k, id, 60000)
    cardB = (await db.query<{ id: string }>(`select (save_payment_method($1, 'mock', 'card', 'tok_b', 'visa', '4242', 12, 2030)).id`, [rB])).rows[0].id
    cardOK = (await db.query<{ id: string }>(`select (save_payment_method($1, 'mock', 'card', 'tok_ok', 'visa', '4242', 12, 2030)).id`, [rOK])).rows[0].id
    ;(globalThis as Record<string, unknown>).__okRide = okRide
  })

  it('before the block, the same tokens can do every operation (proves the token is valid)', async () => {
    for (const [label, who, sql] of ops(rB, cB, cardB, doneRide)) {
      if (label.startsWith('create_ride')) continue // the rider has a trip in progress (one active ride rule)
      const o = await attempt(who, sql)
      expect(o === 'ok' || (o.startsWith('error:') && !blocked(o)), `${label}: ${o}`).toBe(true)
    }
  })

  it('after revoke_tester, each one is refused with the same token — and nothing was written', async () => {
    const res = (await db.query<{ r: Record<string, unknown> }>(`select ops_guard.revoke_tester('966557000001') r`)).rows[0].r
    expect(res).toMatchObject({ blocked: 1, allowlist_removed: true })
    expect((await db.query<{ r: Record<string, unknown> }>(`select ops_guard.revoke_tester('966557000002') r`)).rows[0].r).toMatchObject({ blocked: 1 })
    // revoke_tester took the captain offline at once.
    expect((await db.query<{ o: boolean }>(`select is_online o from drivers where id = $1`, [cB])).rows[0].o).toBe(false)
    const before = (await db.query(`select (select count(*) from payouts)::int po, (select count(*) from wallet_ledger)::int l, (select iban from drivers where id = '${cB}') iban`)).rows[0]
    for (const [label, who, sql] of ops(rB, cB, cardB, doneRide)) {
      const o = await attempt(who, sql)
      expect(blocked(o), `${label}: ${o}`).toBe(true)
    }
    // Committed (not rolled back) attempts too: still nothing changes.
    await expect(asUser(cB, `select request_payout(10000)`)).rejects.toThrow(/account is blocked/)
    await expect(asUser(rB, `select add_wallet_tip($1, 500)`, [doneRide])).rejects.toThrow(/account is blocked/)
    await expect(asUser(cB, `update drivers set iban = 'SA4420000001234567891234' where id = $1`, [cB])).rejects.toThrow(/account is blocked/)
    expect((await db.query(`select (select count(*) from payouts)::int po, (select count(*) from wallet_ledger)::int l, (select iban from drivers where id = '${cB}') iban`)).rows[0]).toEqual(before)
  })

  it('a blocked user cannot unblock or re-allowlist themselves', async () => {
    expect(blocked(await attempt(rB, `update profiles set is_blocked = false where id = '${rB}'`))).toBe(true)
    expect(await attempt(rB, `select ops_guard.allow_tester('966557000001')`)).toBe('permission_denied')
    expect((await asUser<{ s: Record<string, unknown> }>('service', `select ops_runtime_config() s`)).s).toBeTruthy()
    expect((await db.query<{ r: Record<string, unknown> }>(`select ops_guard.hook_custom_access_token($1) r`, [JSON.stringify({ user_id: rB, claims: { sub: rB } })])).rows[0].r)
      .toMatchObject({ error: { http_code: 403 } }) // and the token is not refreshed
  })

  it('the trip already in progress can still be finished safely (chat, share, going offline, completion)', async () => {
    expect(await attempt(rB, `insert into ride_messages (ride_id, body) values ('${liveRide}', 'arriving soon')`)).toBe('ok')
    expect(await attempt(rB, `select create_trip_share('${liveRide}')`)).toMatch(/^(ok|error:(?!AURA: account is blocked))/)
    expect(await attempt(cB, `update drivers set is_online = false where id = '${cB}' returning id`)).toBe('ok')
    const mixed = await attempt(cB, `update drivers set is_online = false, iban = 'SA4420000001234567891234' where id = '${cB}'`)
    expect(blocked(mixed), mixed).toBe(true)
    const done = await asUser<{ s: string }>(cB, `select (transition_ride($1, 'completed')).status s`, [liveRide])
    expect(done.s).toBe('completed')
    // …but no new trip: a new offer cannot be accepted and no new ride can be created.
    expect(blocked(await attempt('service', `select create_ride('${rB}', 'riyadh', 'go', 24.7136, 46.6753, 'A', 24.76, 46.64, 'B', 10000, 1200, 'cash')`))).toBe(true)
  })

  it('an account that is not blocked is not affected at all', async () => {
    const okRide = (globalThis as Record<string, unknown>).__okRide as string
    for (const [label, who, sql] of ops(rOK, cOK, cardOK, okRide)) {
      const o = await attempt(who, sql)
      expect(o === 'ok' || (o.startsWith('error:') && !blocked(o)), `${label}: ${o}`).toBe(true)
    }
  })

  it('session and refresh-token deletion failing separately never weakens the block', async () => {
    for (const deny of ['sessions', 'refresh_tokens'] as const) {
      const phone = deny === 'sessions' ? '966557100001' : '966557100002'
      const u = await mkRider(phone)
      const out = await inTx([
        `create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null)`,
        `create table auth.refresh_tokens (id bigserial primary key, user_id varchar(255), token text)`,
        `insert into auth.sessions (user_id) values ('${u}')`, `insert into auth.refresh_tokens (user_id, token) values ('${u}', 't')`,
        `create function auth.deny_delete() returns trigger language plpgsql as $$ begin raise exception 'permission denied' using errcode = '42501'; end $$`,
        `create trigger deny before delete on auth.${deny} for each row execute function auth.deny_delete()`,
      ], async (tx) => {
        const r = await val<Record<string, string>>(tx, `select ops_guard.revoke_tester('${phone}') v`)
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [u, JSON.stringify({ sub: u, role: 'authenticated' })])
        await tx.exec(`set local role authenticated`)
        const op = await tx.query(`select set_default_payment_method(gen_random_uuid())`).then(() => 'ok', (e: Error) => e.message)
        return { r, op }
      })
      expect(out.r[deny], deny).toBe('failed:42501')
      expect(out.r[deny === 'sessions' ? 'refresh_tokens' : 'sessions'], deny).toBe('deleted:1')
      expect(out.op, deny).toMatch(/account is blocked/)
    }
  })

  // Regression guard: any future user-callable function or RLS-writable table must be classified.
  it('every user-callable writer checks the block or is on the reviewed "finish safely / legal right" list', async () => {
    const ALLOWED_WHILE_BLOCKED = new Set(['cancel_privacy_request', 'create_trip_share', 'decline_ride', 'export_my_data', 'issue_ride_verification_code',
      'record_consent', 'report_safety_incident', 'revoke_trip_share', 'start_ride', 'submit_privacy_request', 'trip_share_view'])
    const r = await db.query<{ proname: string; src: string }>(
      `select p.proname, p.prosrc src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
          and (p.prosrc ~* '(insert\\s+into|update|delete\\s+from)\\s+public\\.' or p.prosrc ~* 'post_entry')`)
    const unguarded = r.rows.filter((x) => !/assert_not_blocked|is_blocked|admin_can|is_admin|is_approved_driver/.test(x.src) && !ALLOWED_WHILE_BLOCKED.has(x.proname))
    expect(unguarded.map((x) => x.proname)).toEqual([])
    const t = await db.query<{ t: string }>(
      `select distinct tablename t from pg_policies where schemaname = 'public' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
          and 'authenticated' = any (roles)
          and not exists (select 1 from pg_trigger g where g.tgrelid = ('public.' || tablename)::regclass and g.tgname = 'aa_blocked_actor' and g.tgenabled = 'A')
          and coalesce(qual, '') || coalesce(with_check, '') !~ '(admin_can|is_admin)' order by 1`)
    // Support, safety and in-trip chat stay open to a blocked account on purpose.
    expect(t.rows.map((x) => x.t)).toEqual(['ride_messages', 'tickets'])
  })

  it('the integrity check watches the F2 controls', async () => {
    const a = await peek<{ r: { failures: string[] } }>('owner', `select ops_guard.integrity_check() r`, [], [`alter table public.drivers disable trigger aa_blocked_actor`])
    expect(a.r.failures).toContain('trigger_not_always:public.drivers.aa_blocked_actor')
    const b = await peek<{ r: { failures: string[] } }>('owner', `select ops_guard.integrity_check() r`, [],
      [`create or replace function public.rate_ride(p_ride_id uuid, p_stars integer, p_feedback text default null) returns void language plpgsql security definer set search_path = '' as $$ begin perform ops_guard.assert_environment('x'); end $$`])
    expect(b.r.failures).toContain('blocked_check_missing:rate_ride')
  })
})
