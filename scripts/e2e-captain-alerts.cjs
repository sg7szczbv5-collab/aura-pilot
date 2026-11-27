/**
 * A2.1 — captain new-trip alert in a real browser (demo build, #/ecosystem: rider + captain side by side).
 *   npm run dev   then   npm run e2e:captain-alerts
 * The autoplay policy (sound only after a user gesture) is EMULATED in the AudioContext wrapper, because
 * headless Chromium under Playwright treats pages as already activated. AudioContext and navigator.vibrate
 * are wrapped to COUNT audible beeps and vibrations; the real Web Audio graph still runs.
 * This proves the app logic; it does not replace a check on a real phone (speaker, silent switch).
 */
const { chromium } = require('playwright')
const BASE = process.argv[2] || process.env.AURA_E2E_URL || 'http://localhost:5180'
let fails = 0
const check = (ok, label) => { console.log(`${ok ? '✔' : '✘'} ${label}`); if (!ok) fails++ }

async function open(browser, { iphone = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await ctx.addInitScript((noVibrate) => {
    window.__beeps = 0; window.__vib = []
    let gesture = false
    addEventListener('pointerdown', (e) => { if (e.isTrusted) gesture = true }, true)
    // Autoplay policy, emulated: headless Chromium under Playwright treats every page as already
    // activated, so the real policy cannot be reproduced. Here the context stays 'suspended' until
    // resume() is called after a TRUSTED tap on this page (as a phone browser does).
    const R = window.AudioContext
    window.AudioContext = class extends R {
      constructor(...a) { super(...a); this.__unlocked = false }
      get state() { return this.__unlocked ? super.state : 'suspended' }
      resume() { if (gesture) this.__unlocked = true; return super.resume() }
      createOscillator() { const o = super.createOscillator(); const s = o.start.bind(o); o.start = (...a) => { if (this.state === 'running') window.__beeps++; return s(...a) }; return o }
    }
    if (noVibrate) Object.defineProperty(Navigator.prototype, 'vibrate', { value: undefined, configurable: true })
    // Android Chrome also ignores vibrate() until the user has tapped the page (sticky activation).
    else Object.defineProperty(Navigator.prototype, 'vibrate', { value: (p) => { if (!gesture) return false; window.__vib.push(p); return true }, configurable: true })
  }, iphone)
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(`${BASE}/#/ecosystem`); await p.waitForTimeout(3000)
  await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(3500)
  const col = (t) => p.locator(`xpath=//span[normalize-space()="${t}"]/parent::p/parent::div`)
  const rider = col('AURA Passenger'), captain = col('AURA Driver')
  for (const c of [rider, captain]) {
    const boxes = c.locator('[role=checkbox]')
    for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).click({ force: true })
    await c.getByText('موافقة ومتابعة').click(); await p.waitForTimeout(1000)
  }
  return { ctx, p, rider, captain, errors }
}
const counts = (p) => p.evaluate(() => ({ beeps: window.__beeps, vib: window.__vib.filter((v) => v[0] !== 0).length, cancels: window.__vib.filter((v) => v[0] === 0).length }))
async function requestRide(s) {
  await s.rider.getByText('العمل', { exact: true }).click(); await s.p.waitForTimeout(1300)
  await s.rider.getByText('Aura Go', { exact: true }).first().click()
  await s.rider.getByRole('button', { name: /^اختيار/ }).first().click(); await s.p.waitForTimeout(1000)
  await s.rider.getByRole('button', { name: 'تأكيد الرحلة' }).click(); await s.p.waitForTimeout(2500)
}
const hasOffer = async (s) => (await s.captain.innerText()).includes('طلب جديد')

;(async () => {
  const browser = await chromium.launch()
  try {
    // 1. Online tap unlocks sound; offer rings until ACCEPT; then silence.
    let s = await open(browser)
    check((await s.captain.locator('[data-testid=alert-status]').count()) === 0, 'offline: no alert status row')
    await s.captain.getByRole('button', { name: 'اتصل الآن' }).click(); await s.p.waitForTimeout(1500)
    check((await s.captain.locator('[data-testid=alert-sound]').getAttribute('data-state')) === 'ready', 'online tap → request sound ready (autoplay unlocked by the gesture)')
    check((await counts(s.p)).beeps === 0, 'no sound before any request')
    await requestRide(s)
    check(await hasOffer(s), 'captain receives the offer')
    await s.p.waitForTimeout(3000)
    const ringing = await counts(s.p)
    check(ringing.beeps >= 4 && ringing.vib >= 2, `offer rings and vibrates repeatedly (${ringing.beeps} beeps, ${ringing.vib} vibrations)`)
    await s.captain.getByRole('button', { name: 'قبول' }).click(); await s.p.waitForTimeout(400)
    const atAccept = await counts(s.p)
    await s.p.waitForTimeout(4000)
    const later = await counts(s.p)
    check(later.beeps === atAccept.beeps && later.vib === atAccept.vib, `accept → silence (${atAccept.beeps} → ${later.beeps} beeps)`)
    check(atAccept.cancels >= 1, 'accept → ongoing vibration cancelled')
    check(s.errors.length === 0, `no JavaScript errors (${s.errors.join(' | ')})`)
    await s.ctx.close()

    // 2. DECLINE stops it too; the same offer never rings again.
    s = await open(browser)
    await s.captain.getByRole('button', { name: 'اتصل الآن' }).click(); await s.p.waitForTimeout(1200)
    await requestRide(s)
    check(await hasOffer(s), 'offer shown')
    await s.captain.getByRole('button', { name: 'رفض' }).click(); await s.p.waitForTimeout(400)
    const atDecline = await counts(s.p)
    await s.p.waitForTimeout(4000)
    const afterDecline = await counts(s.p)
    check(afterDecline.beeps === atDecline.beeps, `decline → silence (${atDecline.beeps} → ${afterDecline.beeps})`)
    await s.ctx.close()

    // 3. EXPIRY: nobody answers → the ringing stops when the offer times out.
    s = await open(browser)
    await s.captain.getByRole('button', { name: 'اتصل الآن' }).click(); await s.p.waitForTimeout(1200)
    const ttl = await s.p.evaluate(async () => (await import('/src/core/store.ts')).store.state.settings.offerSeconds)
    await requestRide(s)
    check(await hasOffer(s), `offer shown (TTL ${ttl} s)`)
    await s.p.waitForTimeout(ttl * 1000 + 1500)
    const atExpiry = await counts(s.p)
    await s.p.waitForTimeout(4000)
    const afterExpiry = await counts(s.p)
    check(afterExpiry.beeps === atExpiry.beeps, `expiry → silence (${atExpiry.beeps} → ${afterExpiry.beeps})`)
    await s.ctx.close()

    // 4. Reload while online: no gesture yet → sound LOCKED (vibration only), the row says so; a tap enables it.
    s = await open(browser)
    await s.captain.getByRole('button', { name: 'اتصل الآن' }).click(); await s.p.waitForTimeout(1200)
    await s.p.reload(); await s.p.waitForTimeout(3500)
    const state = await s.captain.locator('[data-testid=alert-sound]').getAttribute('data-state').catch(() => null)
    check(state === 'locked', `after reload, before any tap: sound locked and shown as such (${state})`)
    // The request comes from another device in real life: create it WITHOUT a click on this page
    // (a click anywhere here would itself count as the gesture that unlocks audio).
    await s.p.evaluate(async () => {
      const m = await import('/src/core/store.ts'); const g = await import('/src/core/geo.ts')
      const r = m.actions.requestTrip({ passengerId: m.store.state.customers[0].id, pickup: g.DEMO_CURRENT, dropoff: g.PLACES[1], classId: 'go', payment: 'cash' })
      if (!r.ok) throw new Error('request failed: ' + r.error)
    })
    await s.p.waitForTimeout(3500)
    check(await hasOffer(s), 'offer shown (requested without any gesture on this page)')
    const locked = await counts(s.p)
    check(locked.beeps === 0 && locked.vib === 0, `locked (no tap since reload): no sound and no vibration — the browser blocks both, and the row says so (${locked.beeps} beeps, ${locked.vib} vibrations)`)
    await s.captain.getByRole('button', { name: 'رفض' }).click().catch(() => {})
    await s.captain.locator('[data-testid=alert-sound]').click(); await s.p.waitForTimeout(500)
    check((await s.captain.locator('[data-testid=alert-sound]').getAttribute('data-state')) === 'ready', 'tap on the row → sound ready')
    await s.ctx.close()

    // 5. iPhone-like browser (no Vibration API): told, no errors, sound still rings.
    s = await open(browser, { iphone: true })
    await s.captain.getByRole('button', { name: 'اتصل الآن' }).click(); await s.p.waitForTimeout(1200)
    check((await s.captain.locator('[data-testid=alert-no-vibration]').count()) === 1, 'no Vibration API → "vibration not supported" shown')
    await requestRide(s); await s.p.waitForTimeout(2500)
    check((await counts(s.p)).beeps >= 2, 'no Vibration API → sound still rings')
    check(s.errors.length === 0, `no JavaScript errors (${s.errors.join(' | ')})`)
    // Test button and mute
    await s.captain.getByRole('button', { name: 'قبول' }).click(); await s.p.waitForTimeout(1500)
    await s.ctx.close()
    s = await open(browser)
    await s.captain.getByRole('button', { name: 'اتصل الآن' }).click(); await s.p.waitForTimeout(1200)
    await s.captain.locator('[data-testid=alert-test]').click(); await s.p.waitForTimeout(600)
    check((await counts(s.p)).beeps === 2, '"Test alert" plays exactly one cycle')
    await s.captain.getByRole('button', { name: 'كتم' }).click(); await s.p.waitForTimeout(300)
    check((await s.captain.locator('[data-testid=alert-sound]').getAttribute('data-state')) === 'muted', 'mute → status muted')
    await requestRide(s); await s.p.waitForTimeout(2500)
    const m = await counts(s.p)
    check(m.beeps === 2 && m.vib >= 1, `muted offer: no new beeps, vibration kept (${m.beeps} beeps, ${m.vib} vibrations)`)
    await s.ctx.close()
  } finally {
    await browser.close()
  }
  console.log(fails ? `${fails} step(s) failed` : 'All steps passed')
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
