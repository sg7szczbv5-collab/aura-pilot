/**
 * A2.1 — captain new-trip alert. Behaviour with fake browser APIs: autoplay lock, repeat until
 * resolved, stop on accept/decline/expiry, no double ring, iOS without vibration, mute.
 */
import { describe, expect, it, vi } from 'vitest'
import { CYCLE_MS, MAX_RING_MS, VIBRATION, createOfferAlert, type AlertEnv, type AudioCtxLike } from '../src/captain/offerAlert'

function fakeEnv(opts: { audio?: boolean; vibrate?: boolean; resumeFails?: boolean } = {}) {
  let t = 1_000_000
  const timers: { id: number; at: number; every?: number; fn: () => void }[] = []
  let next = 1
  const beeps: number[] = []
  const vib: number[][] = []
  const ctx: AudioCtxLike = {
    state: 'suspended',
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => {
      if (opts.resumeFails) throw new Error('NotAllowedError')
      ctx.state = 'running'
    }),
    createOscillator: () => ({ type: '', frequency: { value: 0 }, connect: () => undefined, start: () => beeps.push(t), stop: () => undefined }),
    createGain: () => ({ gain: { value: 0, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined }, connect: () => undefined }),
  }
  const env: AlertEnv = {
    createAudio: opts.audio === false ? undefined : () => ctx,
    vibrate: opts.vibrate === false ? undefined : (p) => (vib.push(p), true),
    setInterval: (fn, ms) => (timers.push({ id: next, at: t + ms, every: ms, fn }), next++),
    clearInterval: (id) => void timers.splice(timers.findIndex((x) => x.id === id) >>> 0, timers.some((x) => x.id === id) ? 1 : 0),
    setTimeout: (fn, ms) => (timers.push({ id: next, at: t + ms, fn }), next++),
    clearTimeout: (id) => void timers.splice(timers.findIndex((x) => x.id === id) >>> 0, timers.some((x) => x.id === id) ? 1 : 0),
    now: () => t,
  }
  const advance = (ms: number) => {
    const end = t + ms
    for (;;) {
      const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      t = due.at
      if (due.every) due.at += due.every
      else timers.splice(timers.indexOf(due), 1)
      due.fn()
    }
    t = end
  }
  return { env, ctx, beeps, vib, advance, timers, now: () => t }
}

describe('A2.1 sound needs a user gesture (autoplay policy)', () => {
  it('before unlock: status locked, an offer vibrates but makes no sound', () => {
    const f = fakeEnv()
    const a = createOfferAlert(f.env)
    expect(a.status().sound).toBe('locked')
    a.start('o1', f.now() + 20_000)
    expect(f.beeps.length).toBe(0)
    expect(f.vib[0]).toEqual(VIBRATION)
    expect(a.status().sound).toBe('locked')
  })
  it('unlock (from a tap) → ready, and the offer plays two beeps per cycle', async () => {
    const f = fakeEnv()
    const a = createOfferAlert(f.env)
    expect(await a.unlock()).toBe('ready')
    a.start('o1', f.now() + 20_000)
    expect(f.beeps.length).toBe(2)
  })
  it('a refused resume stays locked (never throws)', async () => {
    const f = fakeEnv({ resumeFails: true })
    const a = createOfferAlert(f.env)
    expect(await a.unlock()).toBe('locked')
  })
  it('no Web Audio → unsupported; the alert still vibrates', async () => {
    const f = fakeEnv({ audio: false })
    const a = createOfferAlert(f.env)
    expect(await a.unlock()).toBe('unsupported')
    a.start('o1', f.now() + 20_000)
    expect(f.vib.length).toBe(1)
  })
})

describe('A2.1 rings until resolved, then stops', () => {
  it('repeats every cycle while the offer is open', async () => {
    const f = fakeEnv()
    const a = createOfferAlert(f.env)
    await a.unlock()
    a.start('o1', f.now() + 20_000)
    f.advance(CYCLE_MS * 3 + 10)
    expect(f.beeps.length).toBe(8) // 4 cycles × 2 beeps
    expect(f.vib.length).toBe(4)
  })
  it('stops by itself when the offer expires', async () => {
    const f = fakeEnv()
    const a = createOfferAlert(f.env)
    await a.unlock()
    a.start('o1', f.now() + 5_000)
    f.advance(30_000)
    expect(a.status().ringing).toBeNull()
    expect(f.beeps.length).toBe(2 * 3) // t=0, 2 s, 4 s
    expect(f.timers.length).toBe(0)
  })
  it('accept / decline → stop at once, and the vibration is cancelled', async () => {
    const f = fakeEnv()
    const a = createOfferAlert(f.env)
    await a.unlock()
    a.start('o1', f.now() + 20_000)
    a.resolve('o1')
    const before = f.beeps.length
    f.advance(10_000)
    expect(f.beeps.length).toBe(before)
    expect(f.vib.at(-1)).toEqual([0])
    expect(a.status().ringing).toBeNull()
  })
  it('stop for another offer id does not silence the ringing one', async () => {
    const f = fakeEnv()
    const a = createOfferAlert(f.env)
    a.start('o1', f.now() + 20_000)
    a.stop('o2')
    expect(a.status().ringing).toBe('o1')
  })
  it('never rings beyond MAX_RING_MS even with a bad expiry', () => {
    const f = fakeEnv()
    const a = createOfferAlert(f.env)
    a.start('o1', f.now() + 10 * MAX_RING_MS)
    f.advance(MAX_RING_MS + 1)
    expect(a.status().ringing).toBeNull()
  })
})

describe('A2.1 no duplicate alerts', () => {
  it('the same offer never rings twice at once (re-render calls start again)', () => {
    const f = fakeEnv()
    const a = createOfferAlert(f.env)
    expect(a.start('o1', f.now() + 20_000)).toBe(true)
    expect(a.start('o1', f.now() + 20_000)).toBe(false)
    expect(f.vib.filter((v) => v === VIBRATION).length).toBe(1)
    expect(f.timers.length).toBe(2)
  })
  it('a card that re-mounts (StrictMode, tab switch) resumes the still-open offer', () => {
    const f = fakeEnv()
    const a = createOfferAlert(f.env)
    a.start('o1', f.now() + 20_000)
    a.stop('o1') // unmount
    expect(a.start('o1', f.now() + 20_000)).toBe(true) // mount again
    f.advance(CYCLE_MS * 2 + 10)
    expect(a.status().ringing).toBe('o1')
  })
  it('once answered (accept / decline) or expired, the offer never rings again', () => {
    const f = fakeEnv()
    const a = createOfferAlert(f.env)
    a.start('o1', f.now() + 20_000)
    a.resolve('o1')
    expect(a.start('o1', f.now() + 20_000)).toBe(false)
    a.start('o2', f.now() + 1_000)
    f.advance(2_000) // o2 expires
    expect(a.start('o2', f.now() + 20_000)).toBe(false)
  })
  it('an already-expired offer does not ring', () => {
    const f = fakeEnv()
    const a = createOfferAlert(f.env)
    expect(a.start('o1', f.now() - 1)).toBe(false)
    expect(f.vib.length).toBe(0)
  })
  it('a new offer replaces the previous ringing one (one alert at a time)', () => {
    const f = fakeEnv()
    const a = createOfferAlert(f.env)
    a.start('o1', f.now() + 20_000)
    a.start('o2', f.now() + 20_000)
    expect(a.status().ringing).toBe('o2')
    expect(f.timers.length).toBe(2) // only o2's cycle + deadline
  })
})

describe('A2.1 device differences and preferences', () => {
  it('iPhone (no Vibration API): vibration false, sound still works, nothing throws', async () => {
    const f = fakeEnv({ vibrate: false })
    const a = createOfferAlert(f.env)
    expect(a.status().vibration).toBe(false)
    await a.unlock()
    expect(() => a.start('o1', f.now() + 20_000)).not.toThrow()
    expect(f.beeps.length).toBe(2)
  })
  it('mute silences the tone but keeps the vibration, and is saved', async () => {
    const f = fakeEnv()
    const saved: boolean[] = []
    const a = createOfferAlert({ ...f.env, saveMuted: (m) => saved.push(m) })
    await a.unlock()
    a.setMuted(true)
    expect(a.status().sound).toBe('muted')
    a.start('o1', f.now() + 20_000)
    expect(f.beeps.length).toBe(0)
    expect(f.vib.length).toBe(1)
    expect(saved).toEqual([true])
  })
  it('"Test alert" plays one cycle and does not start ringing', async () => {
    const f = fakeEnv()
    const a = createOfferAlert(f.env)
    expect(await a.test()).toBe('ready')
    expect(f.beeps.length).toBe(2)
    expect(a.status().ringing).toBeNull()
  })
  it('subscribers are told about status changes', async () => {
    const f = fakeEnv()
    const a = createOfferAlert(f.env)
    const seen: string[] = []
    a.subscribe(() => seen.push(a.status().sound))
    await a.unlock()
    a.setMuted(true)
    expect(seen).toEqual(['ready', 'muted'])
  })
})
