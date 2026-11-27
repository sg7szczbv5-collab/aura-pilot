/**
 * Demo isolation in a real browser, on real production builds (vite build + vite preview).
 *   npm run e2e:demo-isolation [-- <checkout-root>]      (default: this repository)
 *
 * DEMO — a clean Vercel Preview build (no Supabase at all):
 *   · the DEMO flows run with ZERO requests to any Supabase host;
 *   · deliberate attempts from inside the page (fetch, Request, XMLHttpRequest, sendBeacon,
 *     WebSocket, EventSource) to a Supabase project are refused before leaving the page.
 * LIVE — a production-like build of the SAME code (VITE_SUPABASE_URL = a probe project):
 *   · the app starts in LIVE mode and its own sign-in request reaches "Supabase";
 *   · the same deliberate fetch also goes through (the DEMO guard is not installed in Production).
 * Every *.supabase.co request is answered locally by Playwright (route), so nothing leaves the
 * machine and no real project is contacted. The probe project id is fake.
 */
const { chromium } = require('playwright')
const { spawn, spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')

const ROOT = resolve(process.argv[2] || join(__dirname, '..'))
const VITE = join(ROOT, 'node_modules/vite/bin/vite.js')
const PROBE = 'probeprodprobeprodpr'
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const ANON = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'anon', ref: PROBE })}.cHJvYmVzaWc`
let fails = 0
const check = (ok, label) => { console.log(`${ok ? '✔' : '✘'} ${label}`); if (!ok) fails++ }

function build(env) {
  const out = mkdtempSync(join(tmpdir(), 'aura-e2e-iso-'))
  const r = spawnSync(process.execPath, [VITE, 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: '1', ...env }, encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`build failed: ${(r.stderr || r.stdout).slice(0, 400)}`)
  return out
}
async function serve(dir, port) {
  const p = spawn(process.execPath, [VITE, 'preview', '--outDir', dir, '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore' })
  for (let i = 0; i < 80; i++) { try { await fetch(`http://localhost:${port}`); break } catch { await new Promise((r) => setTimeout(r, 250)) } }
  return p
}
async function context(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const supa = []
  const other = []
  // Answer every Supabase request locally: counted, never sent.
  await ctx.route(/supabase\.(co|in|com)/, (route) => { supa.push(route.request().url()); return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"probe":true}' }) })
  await ctx.routeWebSocket(/supabase\.(co|in|com)/, (ws) => { supa.push(`ws:${ws.url()}`); ws.close() })
  ctx.on('request', (r) => { const u = r.url(); if (!u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:') && !/supabase\./.test(u)) other.push(u) })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  return { ctx, page, supa, other, errors }
}
/** Deliberate attempts from inside the page. Each entry: 'blocked' (refused in the page) or 'sent'. */
const attempt = (page) => page.evaluate(async (ref) => {
  const target = `https://${ref}.supabase.co`
  const out = {}
  const blocked = (e) => /supabase_blocked_in_demo/.test(String(e && e.message))
  try { await fetch(`${target}/rest/v1/rides?select=*`); out.fetch = 'sent' } catch (e) { out.fetch = blocked(e) ? 'blocked' : `error:${e.message}` }
  try { await fetch(new Request(`${target}/auth/v1/otp`, { method: 'POST', body: '{}' })); out.request = 'sent' } catch (e) { out.request = blocked(e) ? 'blocked' : `error:${e.message}` }
  try { const x = new XMLHttpRequest(); x.open('GET', `${target}/rest/v1/profiles`); x.send(); out.xhr = 'sent' } catch (e) { out.xhr = blocked(e) ? 'blocked' : `error:${e.message}` }
  try { out.beacon = navigator.sendBeacon(`${target}/rest/v1/audit`, 'x') ? 'sent' : 'blocked' } catch (e) { out.beacon = `error:${e.message}` }
  try { new WebSocket(`wss://${ref}.supabase.co/realtime/v1/websocket`); out.websocket = 'sent' } catch (e) { out.websocket = blocked(e) ? 'blocked' : `error:${e.message}` }
  try { new EventSource(`${target}/functions/v1/stream`); out.eventsource = 'sent' } catch (e) { out.eventsource = blocked(e) ? 'blocked' : `error:${e.message}` }
  await new Promise((r) => setTimeout(r, 800))
  return out
}, PROBE)

;(async () => {
  console.log(`checkout: ${ROOT}`)
  const browser = await chromium.launch()
  const dirs = []
  const procs = []
  try {
    // ── DEMO: clean Vercel Preview build ───────────────────────────────────────────────────────
    const demoDir = build({ VERCEL: '1', VERCEL_ENV: 'preview', VITE_MAPS_PROVIDER: 'mock' })
    dirs.push(demoDir)
    procs.push(await serve(demoDir, 5191))
    let t = await context(browser, 'http://localhost:5191')
    for (const r of ['#/passenger', '#/driver', '#/admin']) { await t.page.goto(`http://localhost:5191/${r}`); await t.page.waitForTimeout(2500) }
    // A full DEMO booking in the side-by-side view (rider requests, captain accepts).
    await t.page.goto('http://localhost:5191/#/ecosystem'); await t.page.waitForTimeout(3000)
    await t.page.evaluate(() => localStorage.clear()); await t.page.reload(); await t.page.waitForTimeout(3500)
    const col = (x) => t.page.locator(`xpath=//span[normalize-space()="${x}"]/parent::p/parent::div`)
    const rider = col('AURA Passenger'), captain = col('AURA Driver')
    for (const c of [rider, captain]) {
      const boxes = c.locator('[role=checkbox]')
      for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).click({ force: true })
      await c.getByText('موافقة ومتابعة').click(); await t.page.waitForTimeout(1000)
    }
    await captain.getByRole('button', { name: 'اتصل الآن' }).click(); await t.page.waitForTimeout(1200)
    await rider.getByText('العمل', { exact: true }).click(); await t.page.waitForTimeout(1300)
    await rider.getByText('Aura Go', { exact: true }).first().click()
    await rider.getByRole('button', { name: /^اختيار/ }).first().click(); await t.page.waitForTimeout(1000)
    await rider.getByRole('button', { name: 'تأكيد الرحلة' }).click(); await t.page.waitForTimeout(2500)
    await captain.getByRole('button', { name: 'قبول' }).click(); await t.page.waitForTimeout(2000)
    check((await rider.innerText()).includes('رمز التحقق للرحلة'), 'DEMO: full booking works (rider requests, captain accepts)')
    check(t.supa.length === 0, `DEMO flows: zero requests to Supabase (${t.supa.length})`)
    check(t.other.length === 0, `DEMO flows: zero requests to any external host (${[...new Set(t.other.map((u) => new URL(u).host))].join(', ')})`)
    const demo = await attempt(t.page)
    for (const [k, v] of Object.entries(demo)) check(v === 'blocked', `DEMO deliberate ${k} to a Supabase project → ${v}`)
    check(t.supa.length === 0, `…and nothing reached the network (${t.supa.length} Supabase requests)`)
    check(t.errors.length === 0, `DEMO: no JavaScript errors (${t.errors.join(' | ')})`)
    await t.ctx.close()

    // ── LIVE: production-like build of the same code ───────────────────────────────────────────
    const liveDir = build({ VERCEL: '1', VERCEL_ENV: 'production', VITE_SUPABASE_URL: `https://${PROBE}.supabase.co`, VITE_SUPABASE_ANON_KEY: ANON, VITE_APP_ENV: 'production', VITE_MAPS_PROVIDER: 'mock' })
    dirs.push(liveDir)
    procs.push(await serve(liveDir, 5192))
    t = await context(browser, 'http://localhost:5192')
    await t.page.goto('http://localhost:5192/#/passenger'); await t.page.waitForTimeout(2500)
    const splash = t.page.locator('div.bg-ink').first(); if (await splash.count()) await splash.click().catch(() => {})
    await t.page.waitForTimeout(800)
    await t.page.locator('input').first().fill('551112222')
    await t.page.getByRole('button', { name: 'متابعة', exact: true }).click(); await t.page.waitForTimeout(2000)
    check(t.supa.some((u) => u.includes(`${PROBE}.supabase.co/auth/v1/otp`)), 'LIVE (production build): the app\'s own sign-in request goes to its Supabase project')
    const before = t.supa.length
    const live = await attempt(t.page)
    check(live.fetch === 'sent' && live.request === 'sent' && live.websocket === 'sent', `LIVE: the DEMO guard is NOT installed — requests go through (${JSON.stringify(live)})`)
    check(t.supa.length > before, `LIVE: they reached the (local, stubbed) Supabase host (${before} → ${t.supa.length})`)
    await t.ctx.close()
  } catch (e) {
    check(false, `unexpected: ${e.message.split('\n')[0]}`)
  } finally {
    await browser.close()
    procs.forEach((p) => p.kill())
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }))
  }
  console.log(fails ? `${fails} step(s) failed` : 'All steps passed')
  process.exit(fails ? 1 : 0)
})()
