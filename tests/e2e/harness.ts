/**
 * End-to-end harness: the real migrations on PostgreSQL + PostGIS (PGlite) and a
 * minimal stand-in for the supabase-js client, so the Edge Functions' production
 * wiring (buildRequestRideDeps, createPaymentsDb, createWaslDb, createCleanupDeps)
 * runs unchanged against the real database, with real roles, JWT claims and RLS.
 */
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { postgis } from '@electric-sql/pglite-postgis'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export async function createDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { postgis } })
  await db.exec(readFileSync(join(ROOT, 'tests', 'db', 'supabase-shim.sql'), 'utf8'))
  const dir = join(ROOT, 'supabase', 'migrations')
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir, f), 'utf8'))
  await db.exec(readFileSync(join(ROOT, 'supabase', 'seed.sql'), 'utf8'))
  // Migration 021: a BETA project carries its environment marker; the integrity check then passes.
  await db.query(`select ops_guard.set_environment('beta', 'betae2eprojectref001')`)
  await db.query(`select ops_guard.integrity_check()`)
  return db
}

export type Who = { role: 'service' | 'authenticated' | 'anon'; sub?: string; aal?: 'aal1' | 'aal2' }

export function runAs<T>(db: PGlite, who: Who, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const role = who.role === 'service' ? 'service_role' : who.role
    const claims = JSON.stringify(who.sub ? { sub: who.sub, role, aal: who.aal ?? 'aal1' } : { role })
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [who.sub ?? '', claims])
    await tx.exec(`set local role ${role}`)
    return fn(tx)
  })
}

export async function newUser(db: PGlite, phone: string, name: string): Promise<string> {
  await db.query(`select ops_guard.allow_tester($1, 'e2e')`, [phone]) // BETA sign-ups are allowlist-only
  const r = await db.query<{ id: string }>(`insert into auth.users (phone, raw_user_meta_data) values ($1, $2) returning id`, [phone, JSON.stringify({ full_name: name })])
  return r.rows[0].id
}

/** In-memory Storage (buckets → path → bytes). */
export class FakeStorage {
  readonly buckets = new Map<string, Map<string, string>>()
  put(bucket: string, path: string, content = 'file') {
    if (!this.buckets.has(bucket)) this.buckets.set(bucket, new Map())
    this.buckets.get(bucket)!.set(path, content)
  }
  paths(bucket: string) {
    return [...(this.buckets.get(bucket)?.keys() ?? [])]
  }
}

type Res = { data: unknown; error: { message: string } | null }
type RpcPromise = Promise<Res> & { single(): Promise<Res>; maybeSingle(): Promise<Res> }

/** The subset of supabase-js the shared Edge Function code uses. */
export class FakeSupabase {
  readonly bans = new Map<string, Record<string, unknown>>()
  private static meta = new Map<string, boolean>()

  constructor(private db: PGlite, private who: Who, private store = new FakeStorage()) {}

  private async retset(fn: string): Promise<boolean> {
    if (!FakeSupabase.meta.has(fn)) {
      const r = await this.db.query<{ proretset: boolean }>(`select proretset from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [fn])
      FakeSupabase.meta.set(fn, r.rows[0]?.proretset ?? false)
    }
    return FakeSupabase.meta.get(fn)!
  }

  rpc(fn: string, args: Record<string, unknown> = {}): RpcPromise {
    const run = async (): Promise<Res> => {
      try {
        const keys = Object.keys(args)
        const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`
        const params = keys.map((k) => {
          const v = args[k]
          return v !== null && typeof v === 'object' ? JSON.stringify(v) : v
        })
        const res = await runAs(this.db, this.who, (tx) => tx.query<Record<string, unknown>>(sql, params))
        const setReturning = await this.retset(fn)
        if (setReturning) return { data: res.rows, error: null }
        if (res.fields.length === 1 && res.fields[0].name === fn) return { data: res.rows[0]?.[fn] ?? null, error: null }
        return { data: res.rows[0] ?? null, error: null }
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e) } }
      }
    }
    const p = run()
    const first = () => p.then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }))
    return Object.assign(p, { single: first, maybeSingle: first })
  }

  from(table: string) {
    const filters: [string, unknown][] = []
    let cols = '*'
    const exec = async (): Promise<Res> => {
      try {
        const where = filters.map(([c], i) => `${c} = $${i + 1}`).join(' and ')
        const res = await runAs(this.db, this.who, (tx) =>
          tx.query<Record<string, unknown>>(`select ${cols} from public.${table}${where ? ` where ${where}` : ''}`, filters.map(([, v]) => v)),
        )
        return { data: res.rows, error: null }
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e) } }
      }
    }
    const builder = {
      select(c: string) {
        cols = c
        return builder
      },
      eq(c: string, v: unknown) {
        filters.push([c, v])
        return builder
      },
      maybeSingle: () => exec().then((r) => ({ ...r, data: (r.data as unknown[] | null)?.[0] ?? null })),
      single: () => exec().then((r) => ({ ...r, data: (r.data as unknown[] | null)?.[0] ?? null })),
      then: (ok: (r: Res) => unknown, err?: (e: unknown) => unknown) => exec().then(ok, err),
    }
    return builder
  }

  get storage() {
    const store = this.store
    return {
      from(bucket: string) {
        return {
          async list(prefix: string) {
            const names = store.paths(bucket).filter((p) => p.startsWith(`${prefix}/`)).map((p) => p.slice(prefix.length + 1))
            return { data: names.map((name) => ({ name })), error: null }
          },
          async remove(paths: string[]) {
            const m = store.buckets.get(bucket)
            const removed = paths.filter((p) => m?.delete(p))
            return { data: removed.map((name) => ({ name })), error: null }
          },
        }
      },
    }
  }

  get auth() {
    const bans = this.bans
    return {
      admin: {
        async updateUserById(id: string, attrs: Record<string, unknown>) {
          bans.set(id, attrs)
          return { error: null }
        },
      },
    }
  }
}

/** Make the last GPS fix look older (tests ping instantly; the server rejects teleporting). */
export async function ageLastFix(db: PGlite, driverId: string, seconds: number) {
  await db.exec(`set session_replication_role = replica`)
  await db.query(`update driver_locations set updated_at = now() - make_interval(secs => $2) where driver_id = $1`, [driverId, seconds])
  await db.query(`update ride_route_points set recorded_at = recorded_at - make_interval(secs => $2) where driver_id = $1`, [driverId, seconds])
  await db.exec(`set session_replication_role = origin`)
}
