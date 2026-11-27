/**
 * A2.3 — captain operations over a bad network. Part 1: the runner (lock, retries, server decides).
 * Part 2: the REAL serverGateway against a scripted Supabase that applies the server's own rules
 * (accept only while searching, the transition matrix with same-state no-ops, start_ride only once)
 * and can lose answers: 'lost' = the server applied it but the answer never arrived; 'down' = the
 * request never reached the server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createConnectivity } from '../src/data/connectivity'

/* ---------------- scripted server ---------------- */
const ME = 'drv-1'
type Mode = 'ok' | 'lost' | 'down'
const srv = {
  ride: { id: 'ride-1', status: 'searching', driver_id: null as string | null, offered_driver_id: ME as string | null, offer_expires_at: Date.now() + 20_000, code: '4821' },
  script: {} as Record<string, Mode[]>,
  viewDown: false,
  calls: [] as string[],
}
const netErr = { data: null, error: { message: 'TypeError: Failed to fetch', code: '', details: '', hint: '' } }
const dbErr = (code: string, message: string) => ({ data: null, error: { code, message, details: '', hint: '' } })
const ALLOWED: Record<string, string[]> = { searching: ['driver_assigned', 'cancelled'], driver_assigned: ['driver_arriving', 'cancelled'], driver_arriving: ['driver_arrived', 'cancelled'], driver_arrived: ['in_progress', 'cancelled'], in_progress: ['completed'] }
function apply(name: string, args: Record<string, unknown>) {
  const r = srv.ride
  if (name === 'accept_ride') {
    if (r.status !== 'searching' || r.offered_driver_id !== ME || r.offer_expires_at <= Date.now()) return dbErr('55000', 'AURA: this offer is no longer available')
    Object.assign(r, { status: 'driver_assigned', driver_id: ME })
    return { data: { id: r.id }, error: null }
  }
  if (name === 'transition_ride') {
    const to = args.p_to as string
    if (to !== r.status && !(ALLOWED[r.status] ?? []).includes(to)) return dbErr('23514', `AURA: illegal ride transition ${r.status} -> ${to} by driver`)
    r.status = to
    return { data: { id: r.id }, error: null }
  }
  if (name === 'start_ride') {
    if (r.status !== 'driver_arrived') return dbErr('55000', 'AURA: mark yourself as arrived first')
    if (args.p_code !== r.code) return { data: false, error: null }
    r.status = 'in_progress'
    return { data: true, error: null }
  }
  return { data: null, error: null }
}
const view = () => {
  const r = srv.ride
  const now = new Date().toISOString()
  return {
    id: r.id, ride_number: 1, viewer: r.driver_id ? 'driver' : 'offered', status: r.status, vehicle_class: 'go', city: 'riyadh', rider_id: 'rider-1',
    driver_id: r.driver_id, offered_driver_id: r.offered_driver_id, offer_expires_at: r.status === 'searching' ? new Date(r.offer_expires_at).toISOString() : null,
    pickup: { lat: 24.77, lng: 46.73, address: 'A' }, dropoff: { lat: 24.69, lng: 46.66, address: 'B' }, route_polyline: null,
    estimated_distance_m: 8000, estimated_duration_s: 900, actual_distance_m: null, actual_duration_s: null,
    fare: { base: 500, distance: 1500, time: 300, surge: 0, min_topup: 0, subtotal: 2300, discount: 0, vat: 345, total: 2645, commission: 460, driver_net: 1840, tip: 0, surge_multiplier: 1, commission_bps: 2000, vat_bps: 1500, promo_code: null },
    payment_method: 'cash', requested_at: now, updated_at: now, cancelled_at: null, cancelled_by: null, cancellation_reason: null,
    rating_by_rider: null, rating_by_driver: null, events: [{ status: 'searching', actor: 'rider', at: now, note: null }], driver: null, rider: { id: 'rider-1', first_name: 'Sara', rating: 5 },
  }
}
const client = {
  rpc: (name: string, args: Record<string, unknown>) => {
    srv.calls.push(name === 'transition_ride' ? `transition_ride:${args.p_to}` : name)
    let res
    if (name === 'ride_view') res = srv.viewDown ? netErr : { data: view(), error: null }
    else {
      const mode = srv.script[name]?.shift() ?? srv.script[`${name}:${args.p_to}`]?.shift() ?? 'ok'
      if (mode === 'down') res = netErr
      else {
        const out = apply(name, args)
        res = mode === 'lost' ? netErr : out
      }
    }
    return Object.assign(Promise.resolve(res), { single: () => Promise.resolve(res) })
  },
  from: () => {
    const b: Record<string, unknown> = {}
    for (const k of ['select', 'eq', 'order', 'insert', 'update']) b[k] = () => b
    b.limit = () => Promise.resolve({ data: [], error: null })
    b.maybeSingle = () => Promise.resolve({ data: null, error: null })
    b.then = (r: (x: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r)
    return b
  },
  channel: () => ({ on() { return this }, subscribe() { return this } }),
  removeChannel: () => undefined,
}
vi.mock('../src/auth/supabaseClient', () => ({ getSupabase: () => client }))

const { runRideAction, isNetworkError } = await import('../src/captain/rideAction')
const { serverGateway } = await import('../src/data/tripGateway')
const { store } = await import('../src/core/store')

/* ---------------- Part 1: the runner ---------------- */
describe('A2.3 runRideAction', () => {
  const noSleep = { sleep: async () => undefined }
  it('clean success: one attempt, no server read needed', async () => {
    const confirm = vi.fn()
    const r = await runRideAction({ key: 'k1', attempt: async () => ({ ok: true }), confirm, ...noSleep })
    expect(r).toEqual({ ok: true, via: 'response' })
    expect(confirm).not.toHaveBeenCalled()
  })
  it('lost answer but the server says done → success confirmed BY THE SERVER, no second request', async () => {
    const attempt = vi.fn(async () => ({ ok: false as const, network: true }))
    const r = await runRideAction({ key: 'k2', attempt, confirm: async () => 'done', ...noSleep })
    expect(r).toEqual({ ok: true, via: 'server' })
    expect(attempt).toHaveBeenCalledTimes(1)
  })
  it('network failure and not done yet → retried, then succeeds', async () => {
    let n = 0
    const r = await runRideAction({ key: 'k3', attempt: async () => (++n < 3 ? { ok: false, network: true } : { ok: true }), confirm: async () => 'pending', ...noSleep })
    expect(r.ok).toBe(true)
    expect(n).toBe(3)
  })
  it('server refusal that is really "already done" → success', async () => {
    const r = await runRideAction({ key: 'k4', attempt: async () => ({ ok: false, network: false, message: 'no longer available' }), confirm: async () => 'done', ...noSleep })
    expect(r).toEqual({ ok: true, via: 'server' })
  })
  it('business refusal, server reachable, not done → rejected at once, never retried', async () => {
    const attempt = vi.fn(async () => ({ ok: false as const, network: false, message: 'wrong_code' }))
    const r = await runRideAction({ key: 'k5', attempt, confirm: async () => 'pending', ...noSleep })
    expect(r).toEqual({ ok: false, reason: 'rejected', message: 'wrong_code' })
    expect(attempt).toHaveBeenCalledTimes(1)
  })
  it('cannot happen any more (offer taken / expired) → rejected, no retry', async () => {
    const attempt = vi.fn(async () => ({ ok: false as const, network: true }))
    const r = await runRideAction({ key: 'k6', attempt, confirm: async () => 'impossible', ...noSleep })
    expect(r.ok).toBe(false)
    expect(attempt).toHaveBeenCalledTimes(1)
  })
  it('no answer at all → offline after the retries; NEVER reported as success', async () => {
    const attempt = vi.fn(async () => ({ ok: false as const, network: true }))
    const r = await runRideAction({ key: 'k7', attempt, confirm: async () => 'unknown', delays: [1, 1], ...noSleep })
    expect(r).toMatchObject({ ok: false, reason: 'offline' })
    expect(attempt).toHaveBeenCalledTimes(3)
  })
  it('a thrown attempt or confirm is a network failure, not a crash', async () => {
    const r = await runRideAction({ key: 'k8', attempt: async () => { throw new Error('boom') }, confirm: async () => { throw new Error('boom') }, delays: [], ...noSleep })
    expect(r).toMatchObject({ ok: false, reason: 'offline' })
  })
  it('double tap: the second call for the same key is refused while the first runs; the key is free afterwards', async () => {
    let release!: () => void
    const attempt = vi.fn(() => new Promise<{ ok: true }>((r) => (release = () => r({ ok: true }))))
    const first = runRideAction({ key: 'k9', attempt, confirm: async () => 'done' })
    const second = await runRideAction({ key: 'k9', attempt, confirm: async () => 'done' })
    expect(second).toEqual({ ok: false, reason: 'busy' })
    release()
    expect(await first).toEqual({ ok: true, via: 'response' })
    expect(attempt).toHaveBeenCalledTimes(1)
    expect((await runRideAction({ key: 'k9', attempt: async () => ({ ok: true }), confirm: async () => 'done' })).ok).toBe(true)
  })
  it('network errors are told apart from database answers', () => {
    expect(isNetworkError({ message: 'TypeError: Failed to fetch', code: '' })).toBe(true)
    expect(isNetworkError({ message: 'AURA: no', code: '55000' })).toBe(false)
    expect(isNetworkError({ message: 'Bad Request', status: 400 })).toBe(false)
    expect(isNetworkError({ message: 'Bad Gateway', status: 502 })).toBe(true)
    expect(isNetworkError(null)).toBe(false)
  })
})

describe('A2.3 connectivity', () => {
  it('a failed request marks offline, an answered one online; listeners hear each change once', () => {
    const c = createConnectivity(true)
    const seen: boolean[] = []
    c.subscribe((v) => seen.push(v))
    c.requestFailed()
    c.requestFailed()
    c.browser(false)
    c.requestAnswered()
    expect(seen).toEqual([false, true])
    expect(c.isOnline()).toBe(true)
  })
})

/* ---------------- Part 2: the real gateway against the scripted server ---------------- */
function reset(status = 'searching') {
  srv.ride = { id: 'ride-1', status, driver_id: status === 'searching' ? null : ME, offered_driver_id: ME, offer_expires_at: Date.now() + 20_000, code: '4821' }
  srv.script = {}
  srv.viewDown = false
  srv.calls = []
  store.commit((s) => void (s.trips = s.trips.filter((t) => t.id !== 'ride-1')))
}

describe('A2.3 gateway: accept', () => {
  beforeEach(() => reset())
  it('normal accept → assigned and on the way (arriving)', async () => {
    const r = await serverGateway.acceptOffer('ride-1', ME)
    expect(r.ok).toBe(true)
    expect(srv.ride.status).toBe('driver_arriving')
  })
  it('accept SUCCEEDED but the answer was lost → reported as accepted (server-confirmed), not "expired"; one accept sent; continues to arriving', async () => {
    srv.script.accept_ride = ['lost']
    const r = await serverGateway.acceptOffer('ride-1', ME)
    expect(r).toEqual({ ok: true, via: 'server' })
    expect(srv.calls.filter((c) => c === 'accept_ride')).toHaveLength(1)
    expect(srv.ride.status).toBe('driver_arriving')
  })
  it('the follow-up to "arriving" lost after a good accept → completed by the next operation (no stuck "assigned")', async () => {
    srv.script['transition_ride:driver_arriving'] = ['down', 'down', 'down']
    const r = await serverGateway.acceptOffer('ride-1', ME)
    expect(r.ok).toBe(true)
    expect(srv.ride.status).toBe('driver_assigned')
    const a = await serverGateway.markArrived('ride-1')
    expect(a.ok).toBe(true)
    expect(srv.ride.status).toBe('driver_arrived')
  }, 15_000)
  it('the request never reached the server → retried → accepted', async () => {
    srv.script.accept_ride = ['down']
    const r = await serverGateway.acceptOffer('ride-1', ME)
    expect(r.ok).toBe(true)
    expect(srv.calls.filter((c) => c === 'accept_ride')).toHaveLength(2)
  }, 10_000)
  it('offer taken by another captain → rejected (not success, not offline)', async () => {
    srv.ride.offered_driver_id = 'drv-2'
    const r = await serverGateway.acceptOffer('ride-1', ME)
    expect(r).toMatchObject({ ok: false, reason: 'rejected' })
  })
  it('fully offline → "offline", the local ride is NOT shown as accepted', async () => {
    srv.script.accept_ride = ['down', 'down', 'down']
    srv.viewDown = true
    const r = await serverGateway.acceptOffer('ride-1', ME)
    expect(r).toMatchObject({ ok: false, reason: 'offline' })
    expect(store.state.trips.find((t) => t.id === 'ride-1')?.status).not.toBe('driver_assigned')
  }, 15_000)
})

describe('A2.3 gateway: arrived / start / complete', () => {
  it('start SUCCEEDED but the answer was lost → started (server-confirmed), NOT "wrong code"', async () => {
    reset('driver_arrived')
    srv.script.start_ride = ['lost']
    const r = await serverGateway.startTrip('ride-1', '4821')
    expect(r).toEqual({ ok: true, via: 'server' })
    expect(srv.calls.filter((c) => c === 'start_ride')).toHaveLength(1)
  })
  it('wrong code → rejected with wrong_code, never retried', async () => {
    reset('driver_arrived')
    const r = await serverGateway.startTrip('ride-1', '0000')
    expect(r).toMatchObject({ ok: false, reason: 'rejected', message: 'wrong_code' })
    expect(srv.calls.filter((c) => c === 'start_ride')).toHaveLength(1)
  })
  it('arrived / complete with a lost answer → confirmed by the server, no duplicate transition', async () => {
    reset('driver_arriving')
    srv.script['transition_ride:driver_arrived'] = ['lost']
    expect((await serverGateway.markArrived('ride-1')).ok).toBe(true)
    expect(srv.calls.filter((c) => c === 'transition_ride:driver_arrived')).toHaveLength(1)
    srv.ride.status = 'in_progress'
    srv.script['transition_ride:completed'] = ['lost']
    expect((await serverGateway.completeTrip('ride-1')).ok).toBe(true)
    expect(srv.calls.filter((c) => c === 'transition_ride:completed')).toHaveLength(1)
    expect(srv.ride.status).toBe('completed')
  })
  it('double tap on "End trip" → one request', async () => {
    reset('in_progress')
    const [a, b] = await Promise.all([serverGateway.completeTrip('ride-1'), serverGateway.completeTrip('ride-1')])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect([a, b].some((x) => !x.ok && x.reason === 'busy')).toBe(true)
    expect(srv.calls.filter((c) => c === 'transition_ride:completed')).toHaveLength(1)
  })
})
