/**
 * Rider GPS in a real browser (Chromium, phone viewport 390×844), against the dev server (demo build):
 *   npm run dev   (port 5180)   then   npm run e2e:rider-gps [-- out-dir]
 * Geolocation and permissions are emulated by Playwright; no network location service is used.
 * LIVE-only rules (pickup starts unset, request blocked) are unit-tested in tests/riderLocation.test.ts.
 */
const { chromium } = require('playwright')
const BASE = process.env.AURA_E2E_URL || 'http://localhost:5180'
const OUT = process.argv[2] || '/tmp'
const RIYADH = { latitude: 24.7743, longitude: 46.7386 }
let fails = 0
const check = (ok, label) => { console.log(`${ok ? '✔' : '✘'} ${label}`); if (!ok) fails++ }

async function open(browser, { grant = false, geo = RIYADH, accuracy = 20, mode = 'real' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ar-SA' })
  if (grant) await ctx.grantPermissions(['geolocation'], { origin: BASE })
  await ctx.setGeolocation({ ...geo, accuracy })
  await ctx.addInitScript((m) => {
    window.__geoCalls = 0
    if (m === 'unsupported') { Object.defineProperty(Navigator.prototype, 'geolocation', { get: () => undefined }); return }
    const g = navigator.geolocation
    const orig = g.getCurrentPosition.bind(g)
    g.getCurrentPosition = (ok, err, opts) => {
      window.__geoCalls++
      if (m === 'unavailable' || m === 'timeout') return setTimeout(() => err && err({ code: m === 'timeout' ? 3 : 2, message: m }), 80)
      return orig(ok, err, opts)
    }
  }, mode)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${BASE}/#/passenger`); await page.waitForTimeout(2500)
  await page.evaluate(async () => {
    localStorage.clear()
    const m = await import('/src/core/store.ts')
    m.setSession({ passengerId: m.store.state.customers[0].id })
  })
  await page.reload(); await page.waitForTimeout(2500)
  const boxes = page.locator('[role=checkbox]'); for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).click({ force: true })
  const go = page.getByText('موافقة ومتابعة'); if (await go.count()) { await go.first().click(); await page.waitForTimeout(1200) }
  await page.locator('[data-testid=pickup-location]').waitFor({ timeout: 8000 })
  await page.waitForTimeout(800)
  return { ctx, page, errors }
}
const status = (page) => page.locator('[data-testid=pickup-status]').innerText()
const name = (page) => page.locator('[data-testid=pickup-name]').innerText()
const calls = (page) => page.evaluate(() => window.__geoCalls)

;(async () => {
  const browser = await chromium.launch()

  // 1. Permission not granted yet: no prompt without a gesture; demo pickup unchanged.
  let s = await open(browser)
  check(await calls(s.page) === 0, 'no location request before the rider asks (permission not granted yet)')
  check(await s.page.getByRole('button', { name: 'استخدام موقعي' }).count() === 1, '"Use my location" offered')
  check((await name(s.page)).includes('موقع تجريبي'), `demo pickup kept by default and labelled as demo (${await name(s.page)})`)
  await s.page.screenshot({ path: `${OUT}/gps-1-ask.png` })
  // 1b. The rider asks; the browser refuses (headless Chromium denies an ungranted request).
  await s.page.getByRole('button', { name: 'استخدام موقعي' }).click(); await s.page.waitForTimeout(1200)
  check(/مرفوض/.test(await status(s.page)), `denied → explained (${await status(s.page)})`)
  check(await s.page.getByRole('button', { name: /استخدام موقعي|إعادة المحاولة/ }).count() === 0, 'denied → no button that would ask again')
  check(await s.page.getByRole('button', { name: 'على الخريطة' }).count() + await s.page.getByRole('button', { name: 'ضبط الدبوس' }).count() === 1 && await s.page.getByRole('button', { name: 'بحث بالعنوان' }).count() === 1, 'denied → map pin and address search still offered')
  await s.page.screenshot({ path: `${OUT}/gps-2-denied.png` })
  // Manual pin after a refusal: the app keeps working.
  await s.page.getByRole('button', { name: /على الخريطة|ضبط الدبوس/ }).click(); await s.page.waitForTimeout(1000)
  await s.page.getByRole('button', { name: 'تأكيد موقع الانطلاق' }).click(); await s.page.waitForTimeout(800)
  check((await s.page.locator('body').innerText()).includes('وجهتك'), 'pin confirmed → continues to the destination step')
  await s.page.getByRole('button', { name: /رجوع/ }).first().click(); await s.page.waitForTimeout(800)
  check(/موقع محدد|Dropped pin/.test(await name(s.page)), `pickup is now the manual pin (${await name(s.page)})`)
  check(s.errors.length === 0, `no JavaScript errors (${s.errors.join(' | ')})`)
  await s.ctx.close()

  // 2. Permission already granted: one silent fix, pickup = GPS, "me" on the real position.
  s = await open(browser, { grant: true })
  check(await calls(s.page) === 1, `granted → exactly one automatic fix (${await calls(s.page)})`)
  check(/تم تحديد موقعك/.test(await status(s.page)), `located (${await status(s.page)})`)
  check((await name(s.page)).includes('موقعك الحالي'), 'pickup = current GPS location')
  const pos = await s.page.evaluate(async () => (await import('/src/core/store.ts')) && null)
  await s.page.screenshot({ path: `${OUT}/gps-3-located.png` })
  // An automatic fix never overwrites a manual pin (new page load, permission granted).
  // An explicit "Use my location" tap does: set a pin, then tap.
  await s.page.getByRole('button', { name: 'ضبط الدبوس' }).click(); await s.page.waitForTimeout(900)
  await s.page.mouse.move(195, 300); await s.page.mouse.down(); await s.page.mouse.move(160, 260, { steps: 6 }); await s.page.mouse.up(); await s.page.waitForTimeout(500)
  await s.page.getByRole('button', { name: 'تأكيد موقع الانطلاق' }).click(); await s.page.waitForTimeout(700)
  await s.page.getByRole('button', { name: /رجوع/ }).first().click(); await s.page.waitForTimeout(700)
  const manual = await name(s.page)
  check(!/موقعك الحالي/.test(manual) && (await calls(s.page)) === 1, `manual pin set, no extra automatic fix (${manual})`)
  await s.page.getByRole('button', { name: 'استخدام موقعي' }).click(); await s.page.waitForTimeout(1200)
  check((await name(s.page)).includes('موقعك الحالي'), 'explicit "Use my location" replaces the manual pin with GPS')
  check(s.errors.length === 0, 'no JavaScript errors')
  await s.ctx.close()

  // 3. Approximate fix → invite to adjust.
  s = await open(browser, { grant: true, accuracy: 600 })
  check(/تقريبي/.test(await status(s.page)), `approximate accuracy flagged (${await status(s.page)})`)
  await s.page.screenshot({ path: `${OUT}/gps-4-approximate.png` })
  await s.ctx.close()

  // 4. Position unavailable / timeout → retry offered, manual still possible.
  for (const mode of ['unavailable', 'timeout']) {
    s = await open(browser, { grant: true, mode })
    check(/تعذّر تحديد موقعك/.test(await status(s.page)), `${mode} → explained (${await status(s.page)})`)
    check(await s.page.getByRole('button', { name: 'إعادة المحاولة' }).count() === 1, `${mode} → "Try again" offered`)
    if (mode === 'unavailable') await s.page.screenshot({ path: `${OUT}/gps-5-unavailable.png` })
    await s.ctx.close()
  }

  // 5. No Geolocation API at all.
  s = await open(browser, { mode: 'unsupported' })
  check(/غير متاح/.test(await status(s.page)), `unsupported → explained (${await status(s.page)})`)
  await s.ctx.close()

  // 6. Address search for the pickup.
  s = await open(browser)
  await s.page.getByRole('button', { name: 'بحث بالعنوان' }).click(); await s.page.waitForTimeout(800)
  await s.page.locator('input').first().fill('المملكة'); await s.page.waitForTimeout(900)
  const first = s.page.locator('main button, [class*=overflow] button').filter({ hasText: /المملكة/ }).first()
  if (await first.count()) await first.click(); await s.page.waitForTimeout(700)
  await s.page.getByRole('button', { name: /رجوع/ }).first().click(); await s.page.waitForTimeout(700)
  check(/المملكة/.test(await name(s.page)), `pickup set from address search (${await name(s.page)})`)
  await s.page.screenshot({ path: `${OUT}/gps-6-search.png` })
  await s.ctx.close()

  // 7. A fix outside the demo service area does not replace the demo pickup (demo stays usable).
  s = await open(browser, { grant: true, geo: { latitude: 51.5072, longitude: -0.1276 } })
  check((await name(s.page)).includes('موقع تجريبي') && !/تم تحديد موقعك/.test(await status(s.page)), 'demo: a fix outside the demo city keeps the demo pickup')
  await s.ctx.close()

  await browser.close()
  console.log(fails ? `${fails} failed` : 'All steps passed')
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
