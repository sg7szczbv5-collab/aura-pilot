/**
 * End-to-end UI test of a full trip in the demo build (#/ecosystem shows the rider,
 * captain and admin side by side on the same data):
 *
 *   consents → captain online → rider picks destination → Aura Go → confirm →
 *   captain receives and accepts the offer → in-trip chat → arrival → rider PIN →
 *   start → end → fare / commission / captain net → rider rates 5★ → admin log.
 *
 *   npm run dev   (or npm run build && npm run preview)
 *   npm run e2e:ui -- [base-url]          default http://localhost:5180
 *
 * Uses the preinstalled Playwright Chromium. Exits non-zero on any failed step.
 */
const { chromium } = require('playwright')

const BASE = process.argv[2] || process.env.AURA_E2E_URL || 'http://localhost:5180'
let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? '✔' : '✘'} ${label}`)
  if (!ok) failures++
}

;(async () => {
  const browser = await chromium.launch()
  const p = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  try {
    await p.goto(`${BASE}/#/ecosystem`)
    await p.waitForTimeout(4000)
    // Fresh demo data for a repeatable run.
    await p.evaluate(() => localStorage.clear())
    await p.reload()
    await p.waitForTimeout(4000)

    const col = (t) => p.locator(`xpath=//span[normalize-space()="${t}"]/parent::p/parent::div`)
    const rider = col('AURA Passenger')
    const captain = col('AURA Driver')
    const admin = col('AURA Admin')
    const text = async (c) => (await c.innerText()).split('\n').map((x) => x.trim()).filter(Boolean)
    const has = async (c, s) => (await c.innerText()).includes(s)
    const closeSheet = async (c) => {
      await c.locator('.bg-ink\\/40').first().click({ position: { x: 20, y: 60 } }).catch(() => {})
      await p.waitForTimeout(600)
    }

    for (const c of [rider, captain]) {
      const boxes = c.locator('[role=checkbox]')
      for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).click({ force: true })
      await c.getByText('موافقة ومتابعة').click()
      await p.waitForTimeout(1200)
    }
    check(await has(rider, 'إلى أين اليوم؟'), 'rider home after consents')

    await captain.getByRole('button', { name: 'اتصل الآن' }).click()
    await p.waitForTimeout(1500)
    check(await has(captain, 'أنت متصل الآن'), 'captain online')

    await rider.getByText('العمل', { exact: true }).click()
    await p.waitForTimeout(1500)
    check(await has(rider, 'Aura Go') && await has(rider, 'Aura XL'), 'classes with prices shown')
    await rider.getByText('Aura Go', { exact: true }).first().click()
    await rider.getByRole('button', { name: /^اختيار/ }).first().click()
    await p.waitForTimeout(1200)
    await rider.getByRole('button', { name: 'تأكيد الرحلة' }).click()
    await p.waitForTimeout(3000)
    check(await has(rider, 'نبحث عن أقرب كابتن'), 'rider is searching')
    check(await has(captain, 'طلب جديد'), 'captain receives the offer')

    await captain.getByRole('button', { name: 'قبول' }).click()
    await p.waitForTimeout(2500)
    check(await has(rider, 'رمز التحقق للرحلة'), 'rider sees captain card and PIN')
    const pin = (await text(rider)).find((x) => /^\d{4}$/.test(x) && x !== '1234')
    check(!!pin, `PIN shown to the rider (${pin})`)

    await rider.getByRole('button', { name: 'رسالة' }).first().click()
    await p.waitForTimeout(500)
    await rider.getByText('أنتظرك عند المدخل').click()
    await p.waitForTimeout(600)
    await closeSheet(rider)
    await captain.getByRole('button', { name: 'رسالة' }).first().click()
    await p.waitForTimeout(500)
    check(await has(captain, 'أنتظرك عند المدخل'), 'chat message delivered to the captain')
    await closeSheet(captain)

    await captain.getByRole('button', { name: 'وصلت إلى موقع الراكب' }).click()
    await p.waitForTimeout(1500)
    check(await has(captain, 'تحقق من الراكب'), 'captain asked for the rider PIN')
    await captain.locator('input').first().click()
    await p.keyboard.type(pin, { delay: 60 })
    await p.waitForTimeout(1500)
    check(await has(captain, 'الرحلة بدأت'), 'trip started with the PIN')

    await captain.getByRole('button', { name: 'إنهاء الرحلة' }).first().click()
    await p.waitForTimeout(1000)
    const early = captain.getByRole('button', { name: 'نعم، إنهاء الرحلة' })
    if (await early.count()) await early.click()
    await p.waitForTimeout(2500)
    check(await has(captain, 'صافي الكابتن'), 'captain sees the trip summary')

    const trip = await p.evaluate(async () => {
      const m = await import('/src/core/store.ts')
      const t = m.store.state.trips.filter((x) => x.status === 'completed').sort((a, b) => b.createdAt - a.createdAt)[0]
      return t && { total: t.fare.total, commission: t.fare.commission, driverNet: t.fare.driverNet, vat: t.fare.vat }
    }).catch(() => null)
    if (trip) {
      check(trip.total > 0 && trip.driverNet > 0, `fare ${trip.total} = captain ${trip.driverNet} + commission ${trip.commission} + VAT ${trip.vat}`)
      check(trip.total === trip.driverNet + trip.commission + trip.vat, 'fare = captain net + commission + VAT')
    } else check(false, 'completed trip in the store')

    await rider.locator('button[aria-label="5"]').first().click()
    await rider.getByRole('button', { name: 'إرسال التقييم' }).click()
    await p.waitForTimeout(1500)
    check(await has(rider, 'شكراً لتقييمك'), 'rider rated the captain')
    check(await has(admin, 'completed'), 'admin log shows the completed trip')
  } catch (e) {
    check(false, `unexpected: ${e.message.split('\n')[0]}`)
  } finally {
    check(errors.length === 0, `no JavaScript errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
    await browser.close()
    console.log(failures ? `\n${failures} step(s) failed` : '\nAll steps passed')
    process.exit(failures ? 1 : 0)
  }
})()
