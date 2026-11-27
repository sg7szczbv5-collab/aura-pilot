/**
 * A2.2 — Google Maps / Waze from the captain's active trip, in a real browser (demo build, #/ecosystem).
 *   npm run dev   then   npm run e2e:captain-nav
 * window.open is recorded (nothing is opened, no request leaves the browser). Checks the target follows
 * the ride (pickup → none on arrival → drop-off), the URL carries coordinates only, opens with
 * noopener/noreferrer, and on an iPhone user agent the R1 warning is shown first.
 * Whether the phone actually hands over to the installed app is a REAL-DEVICE check.
 */
const { chromium } = require('playwright')
const BASE = process.argv[2] || process.env.AURA_E2E_URL || 'http://localhost:5180'
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
let fails = 0
const check = (ok, label) => { console.log(`${ok ? '✔' : '✘'} ${label}`); if (!ok) fails++ }

async function toActiveTrip(browser, { ios = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, ...(ios ? { userAgent: IPHONE_UA } : {}) })
  await ctx.addInitScript(() => { window.__opened = []; window.open = (u, t, f) => { window.__opened.push({ u, t, f }); return null } })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  const external = []
  p.on('request', (r) => { const u = r.url(); if (!u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u) })
  await p.goto(`${BASE}/#/ecosystem`); await p.waitForTimeout(3000)
  await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(3500)
  const col = (t) => p.locator(`xpath=//span[normalize-space()="${t}"]/parent::p/parent::div`)
  const rider = col('AURA Passenger'), captain = col('AURA Driver')
  for (const c of [rider, captain]) {
    const boxes = c.locator('[role=checkbox]')
    for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).click({ force: true })
    await c.getByText('موافقة ومتابعة').click(); await p.waitForTimeout(1000)
  }
  await captain.getByRole('button', { name: 'اتصل الآن' }).click(); await p.waitForTimeout(1200)
  await rider.getByText('العمل', { exact: true }).click(); await p.waitForTimeout(1300)
  await rider.getByText('Aura Go', { exact: true }).first().click()
  await rider.getByRole('button', { name: /^اختيار/ }).first().click(); await p.waitForTimeout(1000)
  await rider.getByRole('button', { name: 'تأكيد الرحلة' }).click(); await p.waitForTimeout(2500)
  await captain.getByRole('button', { name: 'قبول' }).click(); await p.waitForTimeout(2500)
  const trip = () => p.evaluate(async () => {
    const m = await import('/src/core/store.ts')
    const t = m.store.state.trips.filter((x) => x.driverId && !['completed', 'cancelled'].includes(x.status)).sort((a, b) => b.createdAt - a.createdAt)[0]
    return t && { status: t.status, pickup: t.pickup.pos, dropoff: t.dropoff.pos, otp: t.otp }
  })
  return { ctx, p, rider, captain, errors, external, trip }
}
const opened = (p) => p.evaluate(() => window.__opened)
const ll = (pos) => `${Number(pos.lat.toFixed(6))},${Number(pos.lng.toFixed(6))}`

;(async () => {
  const browser = await chromium.launch()
  try {
    // Android / desktop: opens directly.
    let s = await toActiveTrip(browser)
    let t = await s.trip()
    const nav = s.captain.locator('[data-testid=nav-buttons]')
    check((await nav.count()) === 1 && (await nav.getAttribute('data-leg')) === 'pickup', `heading to the rider (${t.status}) → navigate to PICKUP`)
    await s.captain.locator('[data-testid=nav-google]').click(); await s.p.waitForTimeout(300)
    await s.captain.locator('[data-testid=nav-waze]').click(); await s.p.waitForTimeout(300)
    let o = await opened(s.p)
    const g = o[0] && new URL(o[0].u), w = o[1] && new URL(o[1].u)
    check(!!g && g.hostname === 'www.google.com' && g.searchParams.get('destination') === ll(t.pickup), `Google Maps → pickup coordinates (${g && g.searchParams.get('destination')})`)
    check(!!w && w.hostname === 'waze.com' && w.searchParams.get('ll') === ll(t.pickup) && w.searchParams.get('navigate') === 'yes', `Waze → pickup coordinates (${w && w.searchParams.get('ll')})`)
    check(o.every((x) => x.t === '_blank' && x.f === 'noopener,noreferrer'), 'opened with _blank + noopener,noreferrer')
    const riderName = (await s.p.evaluate(async () => { const m = await import('/src/core/store.ts'); return m.store.state.customers[0].name.ar })) || 'zzz'
    check(o.every((x) => !decodeURIComponent(x.u).includes(riderName.split(' ')[0]) && !/ride|trip|name|phone/i.test(new URL(x.u).search)), 'links carry coordinates only (no rider name, ride id or phone)')
    check((await s.captain.locator('[data-testid=nav-ios-warning]').count()) === 0, 'no iPhone warning on Android / desktop')

    await s.captain.getByRole('button', { name: 'وصلت إلى موقع الراكب' }).click(); await s.p.waitForTimeout(1500)
    check((await s.captain.locator('[data-testid=nav-buttons]').count()) === 0, 'arrived → no navigation buttons')
    const pin = (await s.rider.innerText()).split('\n').map((x) => x.trim()).find((x) => /^\d{4}$/.test(x) && x !== '1234')
    await s.captain.locator('input').first().click(); await s.p.keyboard.type(pin, { delay: 60 }); await s.p.waitForTimeout(1800)
    t = await s.trip()
    check(t.status === 'in_progress' && (await s.captain.locator('[data-testid=nav-buttons]').getAttribute('data-leg')) === 'dropoff', 'rider on board → navigate to DROP-OFF')
    await s.captain.locator('[data-testid=nav-waze]').click(); await s.p.waitForTimeout(300)
    o = await opened(s.p)
    check(new URL(o.at(-1).u).searchParams.get('ll') === ll(t.dropoff), `Waze → drop-off coordinates (${new URL(o.at(-1).u).searchParams.get('ll')})`)
    check(s.external.length === 0, `no request left the browser (${s.external.slice(0, 3).join(', ')})`)
    check(s.errors.length === 0, `no JavaScript errors (${s.errors.join(' | ')})`)
    await s.ctx.close()

    // iPhone: R1 warning first; nothing opens until the captain continues.
    s = await toActiveTrip(browser, { ios: true })
    await s.captain.locator('[data-testid=nav-google]').click(); await s.p.waitForTimeout(600)
    check((await s.captain.locator('[data-testid=nav-ios-warning]').count()) === 1, 'iPhone → R1 warning shown before leaving')
    check((await opened(s.p)).length === 0, 'iPhone → nothing opened before "Continue"')
    await s.captain.getByRole('button', { name: 'متابعة إلى الملاحة' }).click(); await s.p.waitForTimeout(400)
    o = await opened(s.p)
    check(o.length === 1 && new URL(o[0].u).hostname === 'www.google.com', 'iPhone → "Continue" opens Google Maps')
    check(s.errors.length === 0, `no JavaScript errors (${s.errors.join(' | ')})`)
    await s.ctx.close()
  } catch (e) {
    check(false, `unexpected: ${e.message.split('\n')[0]}`)
  } finally {
    await browser.close()
  }
  console.log(fails ? `${fails} step(s) failed` : 'All steps passed')
  process.exit(fails ? 1 : 0)
})()
