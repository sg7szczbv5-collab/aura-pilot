/**
 * Rider GPS in LIVE mode, in a real browser, against a fully mocked Supabase (no network):
 *   npm run e2e:rider-gps-live [-- out-dir]
 *
 * Starts the dev server in LIVE mode (VITE_SUPABASE_URL = a placeholder project). Playwright answers
 * every Auth / REST / RPC / Functions / Realtime request from this file (page.route + routeWebSocket),
 * so nothing ever leaves the browser. The real UI code runs: OTP sign-in, consent gate, booking,
 * request-ride, ride_view, trip completion. Covers the A1 review fixes:
 *   F1 a late GPS result never replaces a manual pin (incl. on the screens that price the pickup)
 *   F2 the next ride never reuses the previous ride's pickup; a stale GPS pickup is refused
 *   F3 demo zones never block a LIVE pin; the server's refusal is shown
 *   F4 destination chosen ON THE MAP still requires a valid pickup first
 *   F5 the nearby-cars query is coarse (~100 m); the ride request keeps full precision
 *   L1 a fix is as old as its reading (Position.timestamp): an old cached or future reading is refused
 *   L2 "Use my location" works while an automatic request is pending; the latest request wins
 */
const { chromium } = require('playwright')
const { spawn } = require('node:child_process')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const PORT = 5182
const BASE = `http://localhost:${PORT}`
const REF = 'livemocklivemocklive'
const API = `https://${REF}.supabase.co`
const OUT = process.argv[2] || '/tmp'
const UID = '11111111-1111-4111-8111-111111111111'
const RIYADH = { latitude: 24.774312, longitude: 46.738621 } // full precision on purpose (F5)
const JEDDAH = { latitude: 21.543333, longitude: 39.172779 } // in KSA, outside every demo zone (F3)

let fails = 0
const check = (ok, label) => { console.log(`${ok ? '✔' : '✘'} ${label}`); if (!ok) fails++ }
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (p) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(p)}.c2ln`
const ANON = jwt({ role: 'anon', iss: 'supabase', ref: REF })

/** In-memory backend shared by all routes of one browser context. */
function backend() {
  const now = () => new Date().toISOString()
  const user = { id: UID, aud: 'authenticated', role: 'authenticated', phone: '966551112222', app_metadata: {}, user_metadata: {}, created_at: now() }
  const session = () => ({ access_token: jwt({ sub: UID, role: 'authenticated', aud: 'authenticated', aal: 'aal1', exp: Math.floor(Date.now() / 1000) + 3600 }), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'rt', user })
  const s = { requests: [], nearby: [], rides: [], ride: null, refuseNext: null }
  const quote = (t) => ({ fare_base_halalas: 500, fare_distance_halalas: 1500, fare_time_halalas: 300, fare_surge_halalas: 0, fare_min_topup_halalas: 0, fare_subtotal_halalas: 2300, fare_discount_halalas: 0, fare_vat_halalas: 345, fare_total_halalas: t, commission_halalas: 460, driver_net_halalas: 1840, commission_bps: 2000, vat_bps: 1500, surge_multiplier: 1 })
  const view = (r) => ({ id: r.id, ride_number: r.n, viewer: 'rider', status: r.status, vehicle_class: r.cls, city: 'riyadh', rider_id: UID, driver_id: null, offered_driver_id: null, offer_expires_at: null,
    pickup: r.pickup, dropoff: r.dropoff, route_polyline: null, estimated_distance_m: 8000, estimated_duration_s: 900, actual_distance_m: null, actual_duration_s: null,
    fare: { base: 500, distance: 1500, time: 300, surge: 0, min_topup: 0, subtotal: 2300, discount: 0, vat: 345, total: 2645, commission: 460, driver_net: 1840, tip: 0, surge_multiplier: 1, commission_bps: 2000, vat_bps: 1500, promo_code: null },
    payment_method: 'cash', requested_at: r.at, updated_at: now(), cancelled_at: r.status === 'cancelled' ? now() : null, cancelled_by: r.status === 'cancelled' ? 'system' : null, cancellation_reason: null,
    rating_by_rider: null, rating_by_driver: null, events: [{ status: 'searching', actor: 'rider', at: r.at, note: null }], driver: null, rider: { id: UID, first_name: 'Sara', rating: 5 } })
  async function handle(route) {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    const body = req.postData() ? (() => { try { return JSON.parse(req.postData()) } catch { return req.postData() } })() : null
    s.requests.push(`${req.method()} ${path}`)
    const json = (status, data, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', ...headers }, body: data === undefined ? '' : JSON.stringify(data) })
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
    const one = (req.headers()['accept'] || '').includes('vnd.pgrst.object')
    if (path === '/auth/v1/otp') return json(200, {})
    if (path === '/auth/v1/verify' || path === '/auth/v1/token') return json(200, session())
    if (path === '/auth/v1/user') return json(200, user)
    if (path === '/auth/v1/logout') return json(204)
    if (path === '/rest/v1/rpc/my_identity') return json(200, [{ user_id: UID, app_role: 'rider', admin_role: null, is_blocked: false, aal: 'aal1', full_name: 'Sara Tester', phone: '966551112222', email: null, driver_status: null, missing_rider_consents: [], missing_driver_consents: [] }])
    // maybeSingle() on GET asks for an array and keeps the first row.
    const row = (o) => json(200, one ? o : [o])
    if (path === '/rest/v1/profiles') return row({ full_name: 'Sara Tester', phone: '966551112222', created_at: now(), is_blocked: false })
    if (path === '/rest/v1/riders') return row({ rating: 5 })
    if (path === '/rest/v1/wallet_accounts') return row({ balance_halalas: 0 })
    if (path === '/rest/v1/user_consents') return json(200, ['terms_of_service', 'privacy_policy'].map((p) => ({ purpose: p, granted: true, policy_version: '2026-11-26', created_at: now() })))
    if (path === '/rest/v1/rides') return json(200, s.rides.map((r) => ({ id: r.id })))
    if (path === '/rest/v1/rpc/nearby_vehicle_markers') { s.nearby.push(body); return json(200, []) }
    if (path === '/rest/v1/rpc/ride_view') { const r = s.rides.find((x) => x.id === body.p_ride_id); return json(200, r ? view(r) : null) }
    if (path === '/rest/v1/rpc/issue_ride_verification_code') return json(200, '4821')
    if (path === '/functions/v1/request-ride') {
      if (body.dryRun) return json(200, { route: { distanceM: 8000, durationS: 900 }, quotes: { go: quote(2645), comfort: quote(3200), black: quote(5200), xl: quote(4100) } })
      if (s.refuseNext) { const m = s.refuseNext; s.refuseNext = null; return json(400, { error: m }) }
      const r = { id: `22222222-2222-4222-8222-00000000000${s.rides.length + 1}`, n: 1000 + s.rides.length, status: 'searching', cls: body.vehicleClass, pickup: body.pickup, dropoff: body.dropoff, at: now() }
      s.rides.unshift(r); s.ride = r
      return json(200, { rideId: r.id, fareTotal: 2645 })
    }
    if (path.startsWith('/rest/v1/rpc/')) return json(200, null)
    if (path.startsWith('/rest/v1/')) return json(200, one ? null : [])
    if (path.startsWith('/storage/')) return json(200, [])
    return json(404, { error: 'not mocked' })
  }
  return { s, handle }
}

let CURRENT = null
async function open(browser, { grant = false, geo = RIYADH, delayExplicitMs = 0, plan = null, label }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ar-SA' })
  if (grant) await ctx.grantPermissions(['geolocation'], { origin: BASE })
  await ctx.setGeolocation({ ...geo, accuracy: 15 })
  await ctx.addInitScript(({ d, plan }) => {
    const g = navigator.geolocation, o = g.getCurrentPosition.bind(g); let n = 0
    window.__geoCalls = 0
    window.__setGeo = null
    g.getCurrentPosition = (ok, err, opt) => {
      n++; window.__geoCalls++
      // plan[i]: the i-th call answers after ms with these coordinates and a reading ageMs old (L1/L2).
      const step = plan && plan[n - 1]
      if (step) return setTimeout(() => ok({ coords: { latitude: step.lat, longitude: step.lng, accuracy: 15 }, timestamp: Date.now() - (step.ageMs || 0) }), step.ms || 0)
      if (d && n > 1) return setTimeout(() => o(ok, err, opt), d)
      return o(ok, err, opt)
    }
  }, { d: delayExplicitMs, plan })
  const be = backend()
  await ctx.route(`${API}/**`, be.handle)
  await ctx.routeWebSocket(new RegExp(`${REF}\\.supabase\\.co`), (ws) => { ws.onMessage(() => {}) }) // Realtime: answered locally, silent
  // Fail loudly if anything tries to reach a real host other than the dev server.
  const leaks = []
  await ctx.route(/^https?:\/\/(?!localhost)/, (route) => { const u = route.request().url(); if (!u.startsWith(API)) { leaks.push(u); return route.abort() } return route.fallback() })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${BASE}/#/passenger`)
  await page.waitForTimeout(1800)
  const splash = page.locator('div.bg-ink').first(); if (await splash.count()) await splash.click().catch(() => {})
  await page.waitForTimeout(800)
  // Real sign-in path: phone → OTP → server identity (mocked) → home.
  await page.locator('input').first().fill('551112222')
  await page.getByRole('button', { name: 'متابعة', exact: true }).click(); await page.waitForTimeout(800)
  await page.keyboard.type('123456', { delay: 40 }); await page.waitForTimeout(2500)
  try {
    await page.locator('[data-testid=pickup-location]').waitFor({ timeout: 10000 })
  } catch (e) {
    console.log('--- sign-in did not reach home. Page text:\n' + (await page.locator('body').innerText()).slice(0, 600))
    console.log('--- last mocked requests:', be.s.requests.slice(-15).join(' | '))
    console.log('--- page errors:', errors.join(' | '))
    await page.screenshot({ path: `${OUT}/live-debug.png` })
    throw e
  }
  await page.waitForTimeout(900)
  CURRENT = { page, label }
  return { ctx, page, be, errors, leaks, label }
}
const name = (p) => p.locator('[data-testid=pickup-name]').innerText()
const status = (p) => p.locator('[data-testid=pickup-status]').innerText()
const body = (p) => p.locator('body').innerText()
async function pinHere(p, dx = 0, dy = 0) {
  if (dx || dy) { await p.mouse.move(195, 300); await p.mouse.down(); await p.mouse.move(195 + dx, 300 + dy, { steps: 6 }); await p.mouse.up(); await p.waitForTimeout(400) }
  await p.getByRole('button', { name: 'تأكيد موقع الانطلاق' }).click(); await p.waitForTimeout(700)
}
async function chooseDestinationBySearch(p, q = 'الرياض بارك') {
  const input = p.locator('input[aria-label="الوجهة"]:visible')
  if (await input.count()) { await input.fill(q); await p.waitForTimeout(700) }
  await p.locator(`text=${q} >> visible=true`).first().click(); await p.waitForTimeout(900)
}
async function payCashAndConfirm(p) {
  // Choose cash once (the choice is kept for the next ride).
  if (!(await p.locator('text=نقداً >> visible=true').count())) {
    await p.locator('text=/مدى|mada/ >> visible=true').first().click(); await p.waitForTimeout(600)
    await p.locator('text=نقداً >> visible=true').last().click(); await p.waitForTimeout(600)
  }
  await p.getByRole('button', { name: 'تأكيد الرحلة' }).click(); await p.waitForTimeout(1500)
}
/** The pickup's coordinates as the pin screen shows them (opens and closes the pin screen). */
async function pickupCoords(p) {
  await p.getByRole('button', { name: 'ضبط الدبوس' }).click(); await p.waitForTimeout(700)
  const m = (await body(p)).match(/(\d{2}\.\d{4}), (\d{2}\.\d{4})/)
  await p.getByRole('button', { name: /رجوع/ }).first().click(); await p.waitForTimeout(500)
  return m ? `${m[1]}, ${m[2]}` : '?'
}
async function toConfirm(p) {
  await p.getByRole('button', { name: /^اختيار/ }).first().click(); await p.waitForTimeout(800)
}

;(async () => {
  const dev = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: API, VITE_SUPABASE_ANON_KEY: ANON, VITE_APP_ENV: 'development', VITE_MAPS_PROVIDER: 'mock' },
  })
  for (let i = 0; i < 80; i++) { try { await fetch(BASE); break } catch { await new Promise((r) => setTimeout(r, 250)) } }
  const browser = await chromium.launch()
  try {
    // ── LIVE start: no demo point; F4 destination ON THE MAP requires a pickup first ──────────
    let t = await open(browser, { label: 'start' })
    check(/غير محددة/.test(await name(t.page)), `LIVE starts with no pickup (${await name(t.page)})`)
    check(!/موقع تجريبي|موقعك الحالي/.test(await name(t.page)), 'LIVE never shows the demo point')
    await t.page.screenshot({ path: `${OUT}/live-1-unset.png` })
    await t.page.getByText('إلى أين اليوم؟').click(); await t.page.waitForTimeout(800)
    await t.page.getByText('اختيار من الخريطة').click(); await t.page.waitForTimeout(900)
    check(/حرّك الخريطة لتحديد الوجهة/.test(await body(t.page)), 'F4: destination pin screen opened')
    await t.page.getByRole('button', { name: 'تأكيد الوجهة' }).click(); await t.page.waitForTimeout(900)
    check(/حرّك الخريطة لضبط نقطة الالتقاء/.test(await body(t.page)), 'F4: destination on the map → pickup pin is asked first (not vehicles)')
    await pinHere(t.page, -40, -40)
    check(/^اختيار|اختيار Aura/.test(await body(t.page)) || (await t.page.getByRole('button', { name: /^اختيار/ }).count()) > 0, 'F4: after the pickup, the rider reaches vehicle selection')
    check(t.leaks.length === 0, `no request left the browser (${t.leaks.join(', ')})`)
    // A2.3: the rider sees the same "no connection" banner
    await t.ctx.setOffline(true); await t.page.waitForTimeout(600)
    check((await t.page.locator('[data-testid=offline-banner]').count()) === 1, 'A2.3 rider: offline → "no connection" banner')
    await t.ctx.setOffline(false); await t.page.waitForTimeout(600)
    check((await t.page.locator('[data-testid=offline-banner]').count()) === 0, 'A2.3 rider: back online → banner gone')
    await t.ctx.close()

    // ── F1: a late GPS result never replaces a manual pin ────────────────────────────────────
    t = await open(browser, { grant: true, delayExplicitMs: 3000, label: 'race' })
    check(/تم تحديد موقعك/.test(await status(t.page)), 'granted: one automatic fix sets the GPS pickup')
    await t.page.getByRole('button', { name: 'ضبط الدبوس' }).click(); await t.page.waitForTimeout(800)
    await pinHere(t.page, -60, -60)
    await t.page.getByRole('button', { name: /رجوع/ }).first().click(); await t.page.waitForTimeout(600)
    await t.page.getByRole('button', { name: 'استخدام موقعي' }).click(); await t.page.waitForTimeout(200) // slow (3 s)
    await t.page.getByRole('button', { name: 'ضبط الدبوس' }).click(); await t.page.waitForTimeout(700)
    await pinHere(t.page, 60, 60)
    await t.page.getByRole('button', { name: /رجوع/ }).first().click(); await t.page.waitForTimeout(400)
    const manual = await name(t.page)
    await t.page.waitForTimeout(3600)
    check(/موقع محدد/.test(manual) && (await name(t.page)) === manual, `F1: manual pin kept after the late GPS result (${manual} → ${await name(t.page)})`)
    // Same on the pricing screens: tap, go to vehicles/confirm, late result must not move the pickup.
    await t.page.getByRole('button', { name: 'استخدام موقعي' }).click(); await t.page.waitForTimeout(200)
    await t.page.getByText('إلى أين اليوم؟').click(); await t.page.waitForTimeout(700)
    await chooseDestinationBySearch(t.page)
    await toConfirm(t.page)
    const onConfirm = (await body(t.page)).match(/موقع الانطلاق\s*\n?\s*([^\n]+)/)?.[1]
    await t.page.waitForTimeout(3600)
    const after = (await body(t.page)).match(/موقع الانطلاق\s*\n?\s*([^\n]+)/)?.[1]
    check(!!onConfirm && onConfirm === after && /موقع محدد/.test(after), `F1: pickup frozen on the confirm screen (${onConfirm} → ${after})`)
    check(t.errors.length === 0, `no JavaScript errors (${t.errors.join(' | ')})`)
    await t.ctx.close()

    // ── F3 + F5 + F2 on one ride lifecycle ─────────────────────────────────────────────────────
    t = await open(browser, { grant: true, geo: JEDDAH, label: 'zones' })
    check(/تم تحديد موقعك/.test(await status(t.page)), 'F3: a GPS fix outside every demo zone is accepted in LIVE (server decides)')
    await t.page.getByRole('button', { name: 'ضبط الدبوس' }).click(); await t.page.waitForTimeout(800)
    check(!/خارج نطاق الخدمة|الالتقاء غير متاح/.test(await body(t.page)), 'F3: the LIVE pin screen shows no demo-zone verdict')
    check(await t.page.getByRole('button', { name: 'تأكيد موقع الانطلاق' }).isEnabled(), 'F3: "Confirm pickup" stays enabled outside the demo zones')
    await t.page.screenshot({ path: `${OUT}/live-2-pin-outside-demo-zones.png` })
    await t.page.getByRole('button', { name: /رجوع/ }).first().click(); await t.page.waitForTimeout(500)
    // Server refusal is shown clearly.
    t.be.s.refuseNext = 'AURA: pickup is outside the service area'
    await t.page.getByText('إلى أين اليوم؟').click(); await t.page.waitForTimeout(700)
    await chooseDestinationBySearch(t.page)
    await toConfirm(t.page)
    await payCashAndConfirm(t.page)
    check(/خارج نطاق الخدمة/.test(await body(t.page)), 'F3: the server refusal (outside the service area) is shown to the rider')
    await t.page.screenshot({ path: `${OUT}/live-3-server-refusal.png` })
    await t.ctx.close()

    t = await open(browser, { grant: true, label: 'lifecycle' })
    const near = t.be.s.nearby.at(-1)
    check(!!near && String(near.p_lat).split('.')[1].length <= 3 && String(near.p_lng).split('.')[1].length <= 3, `F5: nearby-cars query is coarse (${near && near.p_lat}, ${near && near.p_lng})`)
    await t.page.getByText('إلى أين اليوم؟').click(); await t.page.waitForTimeout(700)
    await chooseDestinationBySearch(t.page)
    await toConfirm(t.page)
    await payCashAndConfirm(t.page)
    const first = t.be.s.rides[0]?.pickup
    check(!!first && first.lat === RIYADH.latitude && first.lng === RIYADH.longitude, `F5: the ride request keeps full precision (${first && first.lat}, ${first && first.lng})`)
    check(/نبحث|جارٍ البحث|البحث عن/.test(await body(t.page)), 'ride 1 requested: searching screen')
    // The ride is cancelled by the system; the rider closes the notice.
    t.be.s.rides[0].status = 'cancelled'
    await t.page.waitForTimeout(16500) // the mirror's 15 s poll refreshes the ride
    const close = t.page.getByRole('button', { name: /حسناً|إغلاق|طلب رحلة جديدة|العودة/ }).first(); if (await close.count()) { await close.click(); await t.page.waitForTimeout(900) }
    check(/غير محددة/.test(await name(t.page)), `F2: after the ride, the pickup is unset again (${await name(t.page)})`)
    await t.page.screenshot({ path: `${OUT}/live-4-after-ride.png` })
    // Ride 2: the rider must choose a pickup; a manual pin far from ride 1.
    await t.page.getByRole('button', { name: /على الخريطة|ضبط الدبوس/ }).first().click(); await t.page.waitForTimeout(800)
    await pinHere(t.page, 90, 140)
    await t.page.getByRole('button', { name: /رجوع/ }).first().click().catch(() => {}); await t.page.waitForTimeout(500)
    if (!(await t.page.locator('[data-testid=pickup-location]').count())) { await t.page.getByRole('button', { name: /رجوع/ }).first().click().catch(() => {}); await t.page.waitForTimeout(500) }
    await t.page.getByText('إلى أين اليوم؟').click(); await t.page.waitForTimeout(700)
    await chooseDestinationBySearch(t.page)
    await toConfirm(t.page)
    await payCashAndConfirm(t.page)
    const second = t.be.s.rides[0]?.pickup
    check(t.be.s.rides.length === 2 && !!second && (second.lat !== first.lat || second.lng !== first.lng), `F2: ride 2 does not reuse ride 1's pickup (${first.lat},${first.lng} → ${second && second.lat},${second && second.lng})`)
    check(t.leaks.length === 0, `no request left the browser (${t.leaks.join(', ')})`)
    check(t.errors.length === 0, `no JavaScript errors (${t.errors.join(' | ')})`)
    await t.ctx.close()

    // ── F2: a stale GPS pickup is refused before sending ────────────────────────────────────────
    t = await open(browser, { grant: true, label: 'stale' })
    await t.page.clock.install()
    await t.page.waitForTimeout(1500) // automatic fix lands
    // (a) the rider lingers on the home screen: the GPS pickup expires and is flagged there
    await t.page.clock.fastForward('06:00')
    await t.page.getByText('إلى أين اليوم؟').click(); await t.page.waitForTimeout(700)
    await t.page.keyboard.press('Escape').catch(() => {})
    await chooseDestinationBySearch(t.page)
    check(/تأكيد موقع الانطلاق/.test(await body(t.page)), 'F2: a GPS pickup older than 5 minutes is not priced — the rider is sent to choose a pickup')
    check(t.be.s.rides.length === 0, 'F2: no request was sent for the stale pickup')
    await t.ctx.close()

    // (b) the pickup expires while the rider sits on the confirm screen: the tap is refused
    t = await open(browser, { grant: true, label: 'stale-confirm' })
    await t.page.clock.install()
    await t.page.waitForTimeout(1500)
    await t.page.getByText('إلى أين اليوم؟').click(); await t.page.waitForTimeout(700)
    await chooseDestinationBySearch(t.page)
    await toConfirm(t.page)
    check(await t.page.getByRole('button', { name: 'تأكيد الرحلة' }).isEnabled(), 'F2: a fresh GPS pickup can be confirmed')
    await t.page.clock.fastForward('06:00'); await t.page.waitForTimeout(800)
    check(/GPS قديم/.test(await body(t.page)), 'F2: after 6 minutes on the confirm screen the GPS pickup is flagged as stale')
    check(!(await t.page.getByRole('button', { name: 'تأكيد الرحلة' }).isEnabled()), 'F2: confirm is disabled once the GPS pickup is stale')
    check(t.be.s.rides.length === 0, 'F2: no request was sent')
    await t.page.screenshot({ path: `${OUT}/live-5-stale.png` })
    await t.ctx.close()

    // ── L2: "Use my location" during a pending AUTOMATIC request — latest request wins ─────────
    const A = { lat: 24.7001, lng: 46.6001 }, B = { lat: 24.8002, lng: 46.7002 }
    // (a) the automatic reading lands AFTER the tap's: discarded
    t = await open(browser, { grant: true, plan: [{ ms: 6000, ...A }, { ms: 500, ...B }], label: 'L2a' })
    check(/جارٍ تحديد/.test(await status(t.page)), 'L2: automatic request pending')
    const tapBtn = t.page.getByRole('button', { name: 'استخدام موقعي' })
    check((await tapBtn.count()) === 1, 'L2: "Use my location" is offered while the automatic request is pending')
    await tapBtn.click(); await t.page.waitForTimeout(1500)
    check(/موقعك الحالي/.test(await name(t.page)), 'L2: the tap\'s reading sets the pickup')
    check((await t.page.getByRole('button', { name: 'استخدام موقعي' }).count()) === 0, 'L2: no second button once a fresh GPS pickup is set')
    await t.page.waitForTimeout(5500) // the automatic reading (A) arrives now
    const ca = await pickupCoords(t.page)
    check(ca === '24.8002, 46.7002', `L2: the late automatic reading is discarded — pickup stays the tap's (${ca})`)
    check(t.errors.length === 0, `no JavaScript errors (${t.errors.join(' | ')})`)
    await t.ctx.close()
    // (b) the automatic reading lands FIRST: still discarded, the pickup waits for the tap
    t = await open(browser, { grant: true, plan: [{ ms: 4000, ...A }, { ms: 5000, ...B }], label: 'L2b' })
    await t.page.getByRole('button', { name: 'استخدام موقعي' }).click(); await t.page.waitForTimeout(3800) // A has landed, B not yet
    check(/غير محددة/.test(await name(t.page)) && /جارٍ تحديد/.test(await status(t.page)), `L2: the earlier automatic reading is not applied; still waiting for the tap (${await name(t.page)})`)
    await t.page.waitForTimeout(2500)
    const cb = await pickupCoords(t.page)
    check(cb === '24.8002, 46.7002', `L2: the tap's reading wins (${cb})`)
    await t.ctx.close()
    // (c) tap during the automatic request, then a manual pin before both land: the pin is kept
    t = await open(browser, { grant: true, plan: [{ ms: 5000, ...A }, { ms: 5000, ...B }], label: 'L2c' })
    await t.page.getByRole('button', { name: 'استخدام موقعي' }).click(); await t.page.waitForTimeout(300)
    await t.page.getByRole('button', { name: 'على الخريطة' }).click(); await t.page.waitForTimeout(800)
    await pinHere(t.page, 40, -40)
    await t.page.getByRole('button', { name: /رجوع/ }).first().click(); await t.page.waitForTimeout(400)
    const pinned = await name(t.page)
    await t.page.waitForTimeout(5500)
    check(/موقع محدد/.test(pinned) && (await name(t.page)) === pinned, `L2 + F1: both late readings dropped, manual pin kept (${pinned} → ${await name(t.page)})`)
    await t.ctx.close()

    // ── L1: the age of a fix is the age of its reading ────────────────────────────────────────
    t = await open(browser, { grant: true, plan: [{ ms: 0, ...B, ageMs: 10 * 60_000 }], label: 'L1-old' })
    check(/GPS قديم/.test(await status(t.page)), `L1: an old cached reading (10 min) is flagged at once (${await status(t.page)})`)
    check((await t.page.getByRole('button', { name: 'تحديث موقعي' }).count()) === 1, 'L1: "Refresh location" is offered')
    await t.page.getByText('إلى أين اليوم؟').click(); await t.page.waitForTimeout(700)
    await chooseDestinationBySearch(t.page)
    check(/تأكيد موقع الانطلاق/.test(await body(t.page)), 'L1: the old reading is not priced — the rider is sent to choose a pickup')
    check(t.be.s.rides.length === 0, 'L1: no request was sent')
    await t.ctx.close()
    t = await open(browser, { grant: true, plan: [{ ms: 0, ...B, ageMs: -10 * 60_000 }], label: 'L1-future' })
    check(/GPS قديم/.test(await status(t.page)), 'L1: a reading from the future (bad clock) is refused too')
    await t.ctx.close()
    t = await open(browser, { grant: true, plan: [{ ms: 0, ...B, ageMs: 60_000 }], label: 'L1-fresh' })
    check(/تم تحديد موقعك/.test(await status(t.page)), 'L1: a 1-minute-old reading is accepted')
    await t.page.getByText('إلى أين اليوم؟').click(); await t.page.waitForTimeout(700)
    await chooseDestinationBySearch(t.page)
    await toConfirm(t.page)
    check(await t.page.getByRole('button', { name: 'تأكيد الرحلة' }).isEnabled(), 'L1: …and can be confirmed')
    check(t.leaks.length === 0 && t.errors.length === 0, 'no leaks, no JavaScript errors')
    await t.ctx.close()
  } catch (e) {
    if (CURRENT) {
      try {
        console.log(`--- failing scenario: ${CURRENT.label}. Page text:\n` + (await CURRENT.page.locator('body').innerText()).slice(0, 700))
        await CURRENT.page.screenshot({ path: `${OUT}/live-fail.png` })
      } catch {}
    }
    throw e
  } finally {
    await browser.close()
    dev.kill()
  }
  console.log(fails ? `${fails} failed` : 'All steps passed')
  process.exit(fails ? 1 : 0)
})().catch(async (e) => {
  console.error(e.message.split('\n')[0])
  if (CURRENT) {
    try {
      console.log(`--- failing scenario: ${CURRENT.label}. Page text:\n` + (await CURRENT.page.locator('body').innerText()).slice(0, 700))
      await CURRENT.page.screenshot({ path: `${OUT}/live-fail.png` })
    } catch {}
  }
  process.exit(1)
})
