import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Minimal Supabase stand-in: records calls; driver_save_vehicle is "not deployed". */
type Call = { op: string; table?: string; args?: unknown }
const calls: Call[] = []
const state = { vehicles: [] as { id: string; driver_id: string; plate_letters: string; plate_number: string; status: string }[], docs: [] as { doc_type: string; vehicle_id: string | null; status: string }[], rpcMissing: true }

function query(table: string) {
  const filters: Record<string, unknown> = {}
  let mode: 'select' | 'insert' | 'update' = 'select'
  let payload: Record<string, unknown> = {}
  const rows = () => {
    if (table === 'vehicles') return state.vehicles.filter((v) => Object.entries(filters).every(([k, x]) => (v as Record<string, unknown>)[k] === x))
    if (table === 'driver_documents') return state.docs.filter((d) => d.doc_type === filters.doc_type && d.vehicle_id === (filters.vehicle_id ?? null) && ['uploaded', 'approved'].includes(d.status))
    return [{ current_vehicle_id: 'veh-old' }]
  }
  const run = () => {
    if (mode === 'insert') {
      calls.push({ op: 'insert', table, args: payload })
      if (table === 'vehicles') {
        const v = { id: `veh-${state.vehicles.length + 1}`, status: 'pending_review', ...(payload as { driver_id: string; plate_letters: string; plate_number: string }) }
        state.vehicles.push(v)
        return { data: v, error: null }
      }
      state.docs.push({ doc_type: payload.doc_type as string, vehicle_id: (payload.vehicle_id as string) ?? null, status: 'uploaded' })
      return { data: null, error: null }
    }
    if (mode === 'update') {
      calls.push({ op: 'update', table, args: payload })
      return { data: null, error: null }
    }
    return { data: rows(), error: null }
  }
  const b = {
    select: () => b,
    insert: (p: Record<string, unknown>) => ((mode = 'insert'), (payload = p), b),
    update: (p: Record<string, unknown>) => ((mode = 'update'), (payload = p), b),
    eq: (k: string, v: unknown) => ((filters[k] = v), b),
    is: (k: string, v: unknown) => ((filters[k] = v), b),
    in: () => b,
    limit: () => Promise.resolve(run()),
    maybeSingle: () => Promise.resolve({ ...run(), data: (run().data as unknown[])?.[0] ?? null }),
    single: () => Promise.resolve(run()),
    then: (r: (x: unknown) => unknown) => Promise.resolve(run()).then(r),
  }
  return b
}
const client = {
  from: (t: string) => query(t),
  rpc: (name: string) => {
    calls.push({ op: 'rpc', args: name })
    const res = name === 'driver_save_vehicle' && state.rpcMissing
      ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.driver_save_vehicle(...) in the schema cache' } }
      : { data: null, error: null }
    return { single: () => Promise.resolve(res), then: (r: (x: unknown) => unknown) => Promise.resolve(res).then(r) }
  },
  storage: { from: () => ({ upload: () => (calls.push({ op: 'upload' }), Promise.resolve({ error: null })) }) },
}
vi.mock('../src/auth/supabaseClient', () => ({ getSupabase: () => client }))

const { resubmitServer } = await import('../src/captain/resubmit')
const file = () => new File(['x'], 'a.jpg', { type: 'image/jpeg' })
const input = (mode: 'new' | 'edit') => ({
  uid: 'u1',
  driverStatus: 'rejected' as const,
  mode,
  vehicleId: mode === 'edit' ? 'veh-old' : undefined,
  vehicle: { classId: 'go', make: 'Toyota', model: 'Yaris', year: 2025, color: 'white', plateLetters: 'BJR', plateDigits: '4321', sequenceNumber: '123456789', seats: 4 },
  required: ['registration', 'insurance'] as ('registration' | 'insurance')[],
  docs: { registration: { file: file(), expiresAt: '2099-01-01' }, insurance: { file: file(), expiresAt: '2099-01-01' } },
})

describe('resubmitServer when migration 017 is not deployed yet', () => {
  beforeEach(() => {
    calls.length = 0
    state.vehicles = []
    state.docs = []
  })

  it('«مركبة أخرى» still works: inserts the vehicle, makes it current, uploads, resubmits', async () => {
    expect(await resubmitServer(input('new'))).toEqual({ ok: true })
    expect(calls.filter((c) => c.op === 'insert' && c.table === 'vehicles')).toHaveLength(1)
    expect(calls).toContainEqual({ op: 'update', table: 'drivers', args: { current_vehicle_id: 'veh-1' } })
    expect(state.docs.map((d) => `${d.doc_type}@${d.vehicle_id}`)).toEqual(['vehicle_registration@veh-1', 'vehicle_insurance@veh-1'])
    expect(calls.at(-1)).toEqual({ op: 'rpc', args: 'submit_driver_application' })
  })

  it('a retry after a half-failed attempt reuses the vehicle and the uploaded document', async () => {
    state.vehicles.push({ id: 'veh-9', driver_id: 'u1', plate_letters: 'BJR', plate_number: '4321', status: 'pending_review' })
    state.docs.push({ doc_type: 'vehicle_registration', vehicle_id: 'veh-9', status: 'uploaded' })
    expect(await resubmitServer(input('new'))).toEqual({ ok: true })
    expect(calls.filter((c) => c.op === 'insert' && c.table === 'vehicles')).toHaveLength(0)
    expect(calls.filter((c) => c.op === 'upload')).toHaveLength(1) // only insurance
  })

  it('correcting the same vehicle needs the server update: clear error', async () => {
    expect(await resubmitServer(input('edit'))).toEqual({ ok: false, step: 'vehicle', error: 'server_outdated' })
  })
})
