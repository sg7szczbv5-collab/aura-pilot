/**
 * A2.4 — captain in the background, real browser (demo build, #/ecosystem).
 *   npm run dev   then   npm run e2e:captain-background
 * SIMULATION: navigator.wakeLock is replaced by a recorder (so acquire / release can be observed and the
 * system's "release on hide" reproduced), and page visibility is faked (document.visibilityState +
 * visibilitychange). A headless browser cannot lock a screen or suspend a page the way iOS / Android do:
 * this proves the app's rules, NOT the phone's behaviour — see docs/a2/background-capabilities.md.
 */
const { chromium } = require('playwright')
const BASE = process.argv[2] || process.env.AURA_E2E_URL || 'http://localhost:5180'
let fails = 0
const check = (ok, label) => { console.log(`${ok ? '✔' : '✘'} ${label}`); if (!ok) fails++ }

async function open(browser, mode = 'ok') {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await ctx.addInitScript((m) => {
    window.__vis = 'visible'
    Object.defineProperty(document, 'visibilityState', { get: () => window.__vis, configurable: true })
    Object.defineProperty(document, 'hidden', { get: () => window.__vis !== 'visible', configurable: true })
    window.__wl = { requests: 0, active: [] }
    if (m === 'none') { Object.defineProperty(Navigator.prototype, 'wakeLock', { get: () => undefined, configurable: true }); return }
    const api = {
      request: async () => {
        window.__wl.requests++
        if (m === 'refuse') throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' })
        const ls = []
        const s = { released: false, release: async () => { if (!s.released) { s.released = true; window.__wl.active = window.__wl.active.filter((x) => x !== s); ls.forEach((f) => f()) } }, addEventListener: (_, f) => ls.push(f) }
        window.__wl.active.push(s)
        return s
      },
    }
    Object.defineProperty(Navigator.prototype, 'wakeLock', { get: () => api, configurable: true })
    // The system releases screen locks when the page is hidden.
    window.__setVisible = (v) => {
      window.__vis = v ? 'visible' : 'hidden'
      if (!v) [...window.__wl.active].forEach((s) => s.release())
      document.dispatchEvent(new Event('visibilitychange'))
    }
  }, mode)
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
const wl = (p) => p.evaluate(() => ({ requests: window.__wl.requests, active: window.__wl.active.length }))
const wake = (s) => s.captain.locator('[data-testid=wake-status]').getAttribute('data-state').catch(() => null)
const setVisible = (p, v) => p.evaluate((x) => window.__setVisible(x), v)

;(async () => {
  const browser = await chromium.launch()
  try {
    // 1. Wake lock follows "online"
    let s = await open(browser)
    check((await wl(s.p)).requests === 0, 'offline captain: no wake lock requested')
    await s.captain.getByRole('button', { name: 'اتصل الآن' }).click(); await s.p.waitForTimeout(1200)
    let w = await wl(s.p)
    check(w.active === 1 && (await wake(s)) === 'on', `online → screen kept on (${JSON.stringify(w)}, ${await wake(s)})`)
    // 2. Background (system releases) → re-acquired on return
    await setVisible(s.p, false); await s.p.waitForTimeout(300)
    check((await wl(s.p)).active === 0, 'page hidden → the system released the lock')
    await setVisible(s.p, true); await s.p.waitForTimeout(600)
    w = await wl(s.p)
    check(w.active === 1 && w.requests === 2 && (await wake(s)) === 'on', `back in front while online → re-acquired (${JSON.stringify(w)})`)
    // 3. Offline → released, and not re-acquired on return
    await s.captain.getByRole('button', { name: 'إنهاء الاتصال' }).click(); await s.p.waitForTimeout(1200)
    check((await wl(s.p)).active === 0, 'offline → released')
    await setVisible(s.p, false); await setVisible(s.p, true); await s.p.waitForTimeout(500)
    check((await wl(s.p)).requests === 2 && (await wl(s.p)).active === 0, 'offline: not re-acquired when the page returns')
    // 4. Kept on during an active trip (captain is online), released after going offline
    await s.captain.getByRole('button', { name: 'اتصل الآن' }).click(); await s.p.waitForTimeout(1200)
    await s.rider.getByText('العمل', { exact: true }).click(); await s.p.waitForTimeout(1300)
    await s.rider.getByText('Aura Go', { exact: true }).first().click()
    await s.rider.getByRole('button', { name: /^اختيار/ }).first().click(); await s.p.waitForTimeout(1000)
    await s.rider.getByRole('button', { name: 'تأكيد الرحلة' }).click(); await s.p.waitForTimeout(2500)
    await s.captain.getByRole('button', { name: 'قبول' }).click(); await s.p.waitForTimeout(2000)
    check((await wl(s.p)).active === 1, 'active trip → screen still kept on')
    check(/تجريبي: إظهار رمز الراكب|وصلت إلى موقع الراكب/.test(await s.captain.innerText()), 'demo build keeps its demo-only helpers')
    check(s.errors.length === 0, `no JavaScript errors (${s.errors.join(' | ')})`)
    await s.ctx.close()

    // 5. Background notice: short absence ignored; 45 s reported; 3 min → "no requests were sent to you"
    s = await open(browser)
    await s.p.clock.install()
    await s.captain.getByRole('button', { name: 'اتصل الآن' }).click(); await s.p.waitForTimeout(1200)
    await setVisible(s.p, false); await s.p.clock.fastForward(5_000); await setVisible(s.p, true); await s.p.waitForTimeout(400)
    check((await s.captain.locator('[data-testid=background-notice]').count()) === 0, 'short absence (5 s) → no notice')
    await setVisible(s.p, false); await s.p.clock.fastForward(45_000); await setVisible(s.p, true); await s.p.waitForTimeout(400)
    const n1 = s.captain.locator('[data-testid=background-notice]')
    check((await n1.count()) === 1 && (await n1.getAttribute('data-out')) === '0' && /قد تكون فاتتك طلبات/.test(await n1.innerText()), '45 s in the background while online → "you may have missed requests"')
    await n1.getByRole('button', { name: 'حسناً' }).click(); await s.p.waitForTimeout(300)
    await setVisible(s.p, false); await s.p.clock.fastForward(180_000); await setVisible(s.p, true); await s.p.waitForTimeout(400)
    const n2 = s.captain.locator('[data-testid=background-notice]')
    check((await n2.count()) === 1 && (await n2.getAttribute('data-out')) === '1' && /لم تُرسل إليك طلبات جديدة/.test(await n2.innerText()), '3 min in the background → "no new requests were sent to you" (server 2-min freshness)')
    await n2.getByRole('button', { name: 'حسناً' }).click(); await s.p.waitForTimeout(300)
    await s.captain.getByRole('button', { name: 'إنهاء الاتصال' }).click(); await s.p.waitForTimeout(1200)
    await setVisible(s.p, false); await s.p.clock.fastForward(180_000); await setVisible(s.p, true); await s.p.waitForTimeout(400)
    check((await s.captain.locator('[data-testid=background-notice]').count()) === 0, 'offline captain in the background → no notice')
    await s.ctx.close()

    // 6. Browser without the API, and a refused lock: told, nothing breaks
    s = await open(browser, 'none')
    await s.captain.getByRole('button', { name: 'اتصل الآن' }).click(); await s.p.waitForTimeout(1200)
    check((await wake(s)) === 'unsupported' && /عطّل القفل التلقائي/.test(await s.captain.innerText()), 'no Wake Lock API (older iPhone) → explained, with what to do')
    check(s.errors.length === 0, 'no JavaScript errors')
    await s.ctx.close()
    s = await open(browser, 'refuse')
    await s.captain.getByRole('button', { name: 'اتصل الآن' }).click(); await s.p.waitForTimeout(1200)
    check((await wake(s)) === 'failed' && /توفير الطاقة/.test(await s.captain.innerText()), 'lock refused (battery saver) → explained')
    check(/أنت متصل الآن|متصل · تستقبل الطلبات/.test(await s.captain.innerText()), '…and the captain is still online')
    await s.ctx.close()
  } catch (e) {
    check(false, `unexpected: ${e.message.split('\n')[0]}`)
  } finally {
    await browser.close()
  }
  console.log(fails ? `${fails} step(s) failed` : 'All steps passed')
  process.exit(fails ? 1 : 0)
})()
