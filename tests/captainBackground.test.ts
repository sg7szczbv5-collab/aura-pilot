/** A2.4 — wake lock only while online (re-acquired after the system drops it), background notice. */
import { describe, expect, it, vi } from 'vitest'
import { createWakeLock, type WakeEnv } from '../src/captain/wakeLock'
import { DISPATCH_STALE_MS, NOTICE_AFTER_MS, createBackgroundWatch } from '../src/captain/backgroundWatch'

function fakeEnv(opts: { supported?: boolean; refuse?: boolean } = {}) {
  let visible = true
  const vis: (() => void)[] = []
  const held: { released: boolean; onRelease: (() => void)[] }[] = []
  const request = vi.fn(async () => {
    if (opts.refuse) throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' })
    const s = { released: false, onRelease: [] as (() => void)[] }
    held.push(s)
    return {
      get released() { return s.released },
      release: async () => { if (!s.released) { s.released = true; s.onRelease.forEach((f) => f()) } },
      addEventListener: (_: 'release', f: () => void) => void s.onRelease.push(f),
    }
  })
  const env: WakeEnv = {
    request: opts.supported === false ? undefined : request,
    visible: () => visible,
    onVisibility: (f) => (vis.push(f), () => undefined),
  }
  return {
    env, request, held,
    active: () => held.filter((s) => !s.released).length,
    hide: () => { visible = false; held.filter((s) => !s.released).forEach((s) => { s.released = true; s.onRelease.forEach((f) => f()) }); vis.forEach((f) => f()) },
    show: () => { visible = true; vis.forEach((f) => f()) },
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('A2.4 wake lock: only while the captain is online', () => {
  it('online → screen kept on; offline → released', async () => {
    const f = fakeEnv()
    const w = createWakeLock(f.env)
    expect(w.status()).toBe('off')
    await w.want(true)
    expect(w.status()).toBe('on')
    expect(f.active()).toBe(1)
    await w.want(false)
    expect(w.status()).toBe('off')
    expect(f.active()).toBe(0)
  })
  it('never requested while offline', async () => {
    const f = fakeEnv()
    const w = createWakeLock(f.env)
    await w.want(false)
    f.show()
    await flush()
    expect(f.request).not.toHaveBeenCalled()
  })
  it('the system drops it when the page is hidden; re-acquired on return while still online', async () => {
    const f = fakeEnv()
    const w = createWakeLock(f.env)
    await w.want(true)
    f.hide()
    expect(w.status()).toBe('released')
    f.show()
    await flush()
    expect(w.status()).toBe('on')
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(f.active()).toBe(1)
  })
  it('not re-acquired on return once the captain went offline in between', async () => {
    const f = fakeEnv()
    const w = createWakeLock(f.env)
    await w.want(true)
    f.hide()
    await w.want(false)
    f.show()
    await flush()
    expect(f.request).toHaveBeenCalledTimes(1)
    expect(w.status()).toBe('off')
  })
  it('going online while hidden waits for the page to be visible', async () => {
    const f = fakeEnv()
    const w = createWakeLock(f.env)
    f.hide()
    await w.want(true)
    expect(f.request).not.toHaveBeenCalled()
    f.show()
    await flush()
    expect(w.status()).toBe('on')
  })
  it('offline while the request is still pending → the late lock is released at once', async () => {
    const f = fakeEnv()
    const w = createWakeLock(f.env)
    const p = w.want(true)
    await w.want(false)
    await p
    await flush()
    expect(f.active()).toBe(0)
    expect(w.status()).toBe('off')
  })
  it('no API (older iPhone) → unsupported, nothing thrown', async () => {
    const f = fakeEnv({ supported: false })
    const w = createWakeLock(f.env)
    await expect(w.want(true)).resolves.toBeUndefined()
    expect(w.status()).toBe('unsupported')
    await w.want(false)
    expect(w.status()).toBe('unsupported')
  })
  it('refused (battery saver / policy) → failed, nothing thrown', async () => {
    const f = fakeEnv({ refuse: true })
    const w = createWakeLock(f.env)
    await w.want(true)
    expect(w.status()).toBe('failed')
  })
  it('one lock at most, however often "online" is repeated', async () => {
    const f = fakeEnv()
    const w = createWakeLock(f.env)
    await w.want(true)
    await w.want(true)
    f.show()
    await flush()
    expect(f.request).toHaveBeenCalledTimes(1)
  })
})

describe('A2.4 background watch', () => {
  const clock = () => { let t = 0; return { now: () => t, add: (ms: number) => (t += ms) } }
  it('short absences are not reported', () => {
    const c = clock()
    const w = createBackgroundWatch(c.now)
    w.hidden(true)
    c.add(NOTICE_AFTER_MS - 1)
    expect(w.visible(true)).toBeNull()
  })
  it('a longer absence while online is reported; beyond 2 min the captain was out of dispatch', () => {
    const c = clock()
    const w = createBackgroundWatch(c.now)
    w.hidden(true)
    c.add(45_000)
    expect(w.visible(true)).toEqual({ awayMs: 45_000, outOfDispatch: false })
    w.hidden(true)
    c.add(DISPATCH_STALE_MS + 1)
    expect(w.visible(true)).toEqual({ awayMs: DISPATCH_STALE_MS + 1, outOfDispatch: true })
  })
  it('nothing to report when the captain was offline, or went offline meanwhile', () => {
    const c = clock()
    const w = createBackgroundWatch(c.now)
    w.hidden(false)
    c.add(300_000)
    expect(w.visible(true)).toBeNull()
    w.hidden(true)
    c.add(300_000)
    expect(w.visible(false)).toBeNull()
  })
  it('a visible event without a hidden one reports nothing', () => {
    const w = createBackgroundWatch(() => 1e9)
    expect(w.visible(true)).toBeNull()
  })
})
