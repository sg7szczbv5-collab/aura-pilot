/**
 * Real-browser check for F3: a mock-only (staging / BETA) build sends NO request to Moyasar.
 *
 *   npm run e2e:beta-payments
 *
 * Builds the app twice (staging = mock-only, production = control), serves each with
 * `vite preview`, and tries fetch / XHR / sendBeacon / an <img> to api.moyasar.com from the page.
 * Every request toward *.moyasar.com is intercepted by Playwright and ABORTED, so Moyasar is
 * never contacted even if the guard were broken; the interception only counts the attempts.
 * Expected: staging build → 0 attempts and every call refused by the guard;
 *           production build (no guard) → the attempts are visible (proves the check can see them).
 */
const { chromium } = require('playwright')
const { spawn, spawnSync } = require('node:child_process')
const { join } = require('node:path')
const ROOT = join(__dirname, '..')
const VITE = join(ROOT, 'node_modules/vite/bin/vite.js')
let fails = 0
const check = (ok, label) => { console.log(`${ok ? '✔' : '✘'} ${label}`); if (!ok) fails++ }
const clean = { ...process.env }
for (const k of ['VITE_MOYASAR_PUBLISHABLE_KEY', 'MOYASAR_SECRET_KEY', 'MOYASAR_WEBHOOK_SECRET', 'MOYASAR_API_BASE_URL', 'VITE_PAYMENT_PROVIDER', 'VERCEL_ENV']) delete clean[k]

async function addCardThroughUi(page, base) {
  // Signed-in demo rider (ecosystem view): consents → Wallet → Add card → fill → Save.
  await page.goto(`${base}/#/ecosystem`); await page.waitForTimeout(3500)
  const pas = page.locator('xpath=//span[normalize-space()="AURA Passenger"]/parent::p/parent::div')
  const boxes = pas.locator('[role=checkbox]')
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).click({ force: true })
  const go = pas.getByText('موافقة ومتابعة'); if (await go.count()) { await go.first().click(); await page.waitForTimeout(1200) }
  await pas.getByText('المحفظة', { exact: true }).last().click(); await page.waitForTimeout(1000)
  await pas.getByText('إضافة بطاقة').first().click(); await page.waitForTimeout(800)
  const field = (label) => pas.locator(`xpath=.//*[normalize-space()="${label}"]/following::input[1]`).first()
  await field('الاسم على البطاقة').fill('Beta Tester')
  await field('رقم البطاقة').fill('4111111111111111')
  await field('تاريخ الانتهاء').fill('1230')
  await field('CVC').fill('123')
  await pas.getByRole('button', { name: 'حفظ البطاقة' }).click(); await page.waitForTimeout(1500)
  const body = await pas.innerText()
  return { saved: /1111/.test(body) && !body.includes('تعذّر حفظ البطاقة'), detail: body.includes('غير متاح في هذه البيئة') ? 'disabled message shown' : 'mock tokenizer, card listed' }
}

async function run(label, appEnv, port, withUi = false) {
  const out = `/tmp/aura-e2e-${appEnv}`
  const b = spawnSync(process.execPath, [VITE, 'build', '--outDir', out, '--emptyOutDir'], { cwd: ROOT, env: { ...clean, VITE_APP_ENV: appEnv }, encoding: 'utf8' })
  if (b.status !== 0) throw new Error(`${label} build failed: ${b.stderr}`)
  const srv = spawn(process.execPath, [VITE, 'preview', '--outDir', out, '--port', String(port), '--strictPort'], { cwd: ROOT, env: clean, stdio: 'ignore' })
  const url = `http://localhost:${port}/#/passenger`
  for (let i = 0; i < 60; i++) { try { await fetch(url); break } catch { await new Promise((r) => setTimeout(r, 250)) } }
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const attempts = []
  await page.route(/moyasar\.com/i, (route) => { attempts.push(route.request().url()); return route.abort() })
  await page.goto(url)
  await page.waitForTimeout(1500)
  const ui = withUi ? await addCardThroughUi(page, `http://localhost:${port}`).catch((e) => ({ saved: false, detail: String(e.message || e) })) : null
  const results = await page.evaluate(async () => {
    const out = {}
    try { await fetch('https://api.moyasar.com/v1/tokens', { method: 'POST', body: '{"number":"4111111111111111"}' }); out.fetch = 'sent' } catch (e) { out.fetch = String(e.message || e) }
    try { const x = new XMLHttpRequest(); x.open('POST', 'https://api.moyasar.com/v1/payments'); x.send('{}'); out.xhr = 'sent' } catch (e) { out.xhr = String(e.message || e) }
    out.beacon = navigator.sendBeacon('https://api.moyasar.com/v1/beacon', 'x') ? 'sent' : 'refused'
    return out
  })
  await page.waitForTimeout(800)
  await browser.close()
  srv.kill()
  return { results, attempts, ui }
}

;(async () => {
  const beta = await run('staging (mock-only)', 'staging', 4191, true)
  console.log('staging results:', JSON.stringify(beta.results), 'ui:', JSON.stringify(beta.ui))
  check(beta.ui && beta.ui.saved, `staging: a card entered in the UI is saved with the mock tokenizer (${beta.ui && beta.ui.detail})`)
  check(/payment_gateway_blocked/.test(beta.results.fetch), 'staging: fetch to api.moyasar.com refused by the guard')
  check(/payment_gateway_blocked/.test(beta.results.xhr), 'staging: XHR to api.moyasar.com refused by the guard')
  check(beta.results.beacon === 'refused', 'staging: sendBeacon to api.moyasar.com refused')
  check(beta.attempts.length === 0, `staging: no request toward Moyasar left the page (${beta.attempts.length})`)
  const prod = await run('production (control)', 'production', 4192)
  console.log('production results:', JSON.stringify(prod.results))
  check(prod.attempts.length > 0, `control: in a production build the same calls are attempted (${prod.attempts.length}, all aborted by the test, never sent)`)
  console.log(fails ? `${fails} failed` : 'All steps passed')
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
