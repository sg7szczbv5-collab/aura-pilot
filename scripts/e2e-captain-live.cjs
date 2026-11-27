/**
 * A2.3 — captain app in LIVE mode, real browser, fully mocked Supabase (nothing leaves the browser):
 *   npm run e2e:captain-live [-- out-dir]
 * The mock applies the server's own ride rules (accept only while searching and offered to me; the
 * transition matrix with same-state no-ops; start_ride only from 'arrived' with the right code) and
 * can break the network per call:
 *   lost — the server APPLIES the operation, then the connection drops before the answer arrives
 *   down — the request never reaches the server
 * Browser offline mode (context.setOffline) drives the "no connection" banner and the resync.
 * This proves the app's handling; real networks (tunnels, captive Wi-Fi, 3G handover) still need a phone.
 */
const { chromium } = require('playwright')
const { spawn } = require('node:child_process')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const PORT = 5184
const BASE = `http://localhost:${PORT}`
const REF = 'livemocklivemocklive'
const API = `https://${REF}.supabase.co`
const OUT = process.argv[2] || '/tmp'
const UID = '33333333-3333-4333-8333-333333333333'
const RIDER = '44444444-4444-4444-8444-444444444444'
let fails = 0
const check = (ok, label) => { console.log(`${ok ? '✔' : '✘'} ${label}`); if (!ok) fails++ }
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (p) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(p)}.c2ln`
const ANON = jwt({ role: 'anon', iss: 'supabase', ref: REF })
const ALLOWED = { searching: ['driver_assigned', 'cancelled'], driver_assigned: ['driver_arriving', 'cancelled'], driver_arriving: ['driver_arrived', 'cancelled'], driver_arrived: ['in_progress', 'cancelled'], in_progress: ['completed'] }

function backend() {
  const now = () => new Date().toISOString()
  const user = { id: UID, aud: 'authenticated', role: 'authenticated', phone: '966553334444', app_metadata: {}, user_metadata: {}, created_at: now() }
  const session = () => ({ access_token: jwt({ sub: UID, role: 'authenticated', aud: 'authenticated', aal: 'aal1', exp: Math.floor(Date.now() / 1000) + 3600 }), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'rt', user })
  const s = { online: false, rides: [], calls: [], fault: {}, gps: 0, netDown: false }
  const view = (r) => ({ id: r.id, ride_number: r.n, viewer: r.driver_id === UID ? 'driver' : 'offered', status: r.status, vehicle_class: 'go', city: 'riyadh', rider_id: RIDER,
    driver_id: r.driver_id, offered_driver_id: r.offered, offer_expires_at: r.status === 'searching' ? new Date(r.expires).toISOString() : null,
    pickup: { lat: 24.774312, lng: 46.738621, address: 'غرناطة مول' }, dropoff: { lat: 24.693511, lng: 46.669802, address: 'الرياض بارك' }, route_polyline: null,
    estimated_distance_m: 8000, estimated_duration_s: 900, actual_distance_m: null, actual_duration_s: null,
    fare: { base: 500, distance: 1500, time: 300, surge: 0, min_topup: 0, subtotal: 2300, discount: 0, vat: 345, total: 2645, commission: 460, driver_net: 1840, tip: 0, surge_multiplier: 1, commission_bps: 2000, vat_bps: 1500, promo_code: null },
    payment_method: 'cash', requested_at: r.at, updated_at: now(), cancelled_at: null, cancelled_by: null, cancellation_reason: null,
    rating_by_rider: null, rating_by_driver: null, events: [{ status: 'searching', actor: 'rider', at: r.at, note: null }],
    driver: r.driver_id ? { id: UID, first_name: 'Khalid', rating: 4.9 } : null, rider: { id: RIDER, first_name: 'Sara', rating: 4.8 } })
  const dbErr = (code, message) => ({ status: 400, body: { code, message, details: null, hint: null } })
  function apply(name, b) {
    const r = s.rides.find((x) => x.id === b.p_ride_id)
    if (!r) return dbErr('P0002', 'AURA: ride not found')
    if (name === 'accept_ride') {
      if (r.status !== 'searching' || r.offered !== UID || r.expires <= Date.now()) return dbErr('55000', 'AURA: this offer is no longer available')
      Object.assign(r, { status: 'driver_assigned', driver_id: UID }); return { status: 200, body: { id: r.id } }
    }
    if (name === 'transition_ride') {
      if (b.p_to !== r.status && !(ALLOWED[r.status] || []).includes(b.p_to)) return dbErr('23514', `AURA: illegal ride transition ${r.status} -> ${b.p_to} by driver`)
      r.status = b.p_to; return { status: 200, body: { id: r.id } }
    }
    if (name === 'start_ride') {
      if (r.status !== 'driver_arrived') return dbErr('55000', 'AURA: mark yourself as arrived first')
      if (b.p_code !== '4821') return { status: 200, body: false }
      r.status = 'in_progress'; return { status: 200, body: true }
    }
    if (name === 'decline_ride') { r.offered = null; return { status: 200, body: null } }
    return { status: 200, body: null }
  }
  async function handle(route) {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    const body = req.postData() ? (() => { try { return JSON.parse(req.postData()) } catch { return req.postData() } })() : null
    const json = (status, data) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: data === undefined ? '' : JSON.stringify(data) })
    // Playwright's offline mode does not stop requests answered by a route handler: the mock drops them.
    if (s.netDown) { s.calls.push(`(offline) ${path.replace('/rest/v1/rpc/', '')}`); return route.abort('internetdisconnected') }
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
    const one = (req.headers()['accept'] || '').includes('vnd.pgrst.object')
    const row = (o) => json(200, one ? o : [o])
    if (path === '/auth/v1/otp') return json(200, {})
    if (path === '/auth/v1/verify' || path === '/auth/v1/token') return json(200, session())
    if (path === '/auth/v1/user') return json(200, user)
    if (path === '/auth/v1/logout') return json(204)
    if (path === '/rest/v1/rpc/my_identity') return json(200, [{ user_id: UID, app_role: 'driver', admin_role: null, is_blocked: false, aal: 'aal1', full_name: 'Khalid Captain', phone: '966553334444', email: null, driver_status: 'approved', missing_rider_consents: [], missing_driver_consents: [] }])
    if (path === '/rest/v1/drivers') {
      if (req.method() === 'PATCH') { s.online = !!body.is_online; s.calls.push(`online:${s.online}`); return json(204) }
      return row({ status: 'approved', is_online: s.online, rating: 4.9, ratings_count: 120, acceptance_rate: 95, current_vehicle_id: 'veh-1', created_at: now(), status_reason: null, cities: { code: 'riyadh' } })
    }
    if (path === '/rest/v1/profiles') return row({ full_name: 'Khalid Captain', phone: '966553334444', email: null, created_at: now(), is_blocked: false })
    if (path === '/rest/v1/vehicles') return row({ id: 'veh-1', vehicle_class: 'go', make: 'Toyota', model: 'Camry', year: 2024, color: 'white', plate_letters: 'ABJ', plate_number: '1234', status: 'approved', status_reason: null })
    if (path === '/rest/v1/driver_documents') return json(200, [])
    if (path === '/rest/v1/user_consents') return json(200, ['terms_of_service', 'privacy_policy', 'location_tracking', 'regulatory_data_sharing'].map((p) => ({ purpose: p, granted: true, policy_version: '2026-11-26', created_at: now() })))
    if (path === '/rest/v1/rides') return json(200, s.rides.map((r) => ({ id: r.id })))
    if (path === '/rest/v1/ride_messages') return json(200, [])
    if (path === '/rest/v1/rpc/ride_view') { const r = s.rides.find((x) => x.id === body.p_ride_id); return json(200, r ? view(r) : null) }
    if (path === '/rest/v1/rpc/update_driver_location') { s.gps++; return json(200, null) }
    if (path.startsWith('/rest/v1/rpc/')) {
      const name = path.slice('/rest/v1/rpc/'.length)
      const tag = name === 'transition_ride' ? `transition_ride:${body.p_to}` : name
      const f = (s.fault[tag] || []).shift()
      if (f === 'down') { s.calls.push(`${tag}(down)`); return route.abort('internetdisconnected') }
      const out = apply(name, body)
      s.calls.push(f === 'lost' ? `${tag}(lost)` : tag)
      if (f === 'lost') return route.abort('connectionreset') // applied on the server; the answer is lost
      return json(out.status, out.body)
    }
    if (path.startsWith('/rest/v1/')) return json(200, one ? null : [])
    return json(404, { error: 'not mocked' })
  }
  const offer = (n) => { const r = { id: `55555555-5555-4555-8555-00000000000${n}`, n: 2000 + n, status: 'searching', driver_id: null, offered: UID, expires: Date.now() + 60_000, at: now() }; s.rides.unshift(r); return r }
  return { s, handle, offer }
}

async function open(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ar-SA' })
  await ctx.grantPermissions(['geolocation'], { origin: BASE })
  await ctx.setGeolocation({ latitude: 24.7601, longitude: 46.7012, accuracy: 10 })
  const be = backend()
  await ctx.route(`${API}/**`, be.handle)
  await ctx.routeWebSocket(new RegExp(`${REF}\\.supabase\\.co`), (ws) => { ws.onMessage(() => {}) })
  const leaks = []
  await ctx.route(/^https?:\/\/(?!localhost)/, (route) => { const u = route.request().url(); if (!u.startsWith(API)) { leaks.push(u); return route.abort() } return route.fallback() })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${BASE}/#/driver`); await page.waitForTimeout(1800)
  const splash = page.locator('div.bg-ink').first(); if (await splash.count()) await splash.click().catch(() => {})
  await page.waitForTimeout(800)
  await page.locator('input').first().fill('553334444')
  await page.getByRole('button', { name: /متابعة|إرسال الرمز/ }).first().click(); await page.waitForTimeout(800)
  await page.keyboard.type('123456', { delay: 40 }); await page.waitForTimeout(3000)
  return { ctx, page, be, errors, leaks }
}
const body = (p) => p.locator('body').innerText()
const count = (be, tag) => be.s.calls.filter((c) => c === tag || c.startsWith(`${tag}(`)).length
async function setNet(t, up) { t.be.s.netDown = !up; await t.ctx.setOffline(!up) }
const resync = (p) => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))) // "back in front"

;(async () => {
  const dev = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: API, VITE_SUPABASE_ANON_KEY: ANON, VITE_APP_ENV: 'development', VITE_MAPS_PROVIDER: 'mock' },
  })
  for (let i = 0; i < 80; i++) { try { await fetch(BASE); break } catch { await new Promise((r) => setTimeout(r, 250)) } }
  const browser = await chromium.launch()
  let t
  try {
    t = await open(browser)
    const { page, be } = t
    check(/اتصل الآن/.test(await body(page)), 'LIVE captain signed in (home, offline)')
    await page.getByRole('button', { name: 'اتصل الآن' }).click(); await page.waitForTimeout(2500)
    check(be.s.online && be.s.gps > 0, `online on the server and GPS streaming (${be.s.gps} fixes)`)

    // ── accept: the server applied it, the answer was lost ─────────────────────────────────────
    be.offer(1)
    be.s.fault['accept_ride'] = ['lost']
    await resync(page); await page.waitForTimeout(2500)
    check(/طلب جديد/.test(await body(page)), 'offer arrives (resync when the app comes back to the front)')
    await page.locator('[data-testid=offer-accept]').click(); await page.waitForTimeout(3500)
    const afterAccept = await body(page)
    check(!/انتهت صلاحية الطلب/.test(afterAccept), 'lost accept answer → NOT shown as "expired"')
    check(count(be, 'accept_ride') === 1, `exactly one accept_ride sent (${be.s.calls.filter((c) => c.startsWith('accept')).join(', ')})`)
    check(be.s.rides[0].status === 'driver_arriving' && /وصلت إلى موقع الراكب/.test(afterAccept), `server-confirmed: trip active and on the way (${be.s.rides[0].status})`)
    await page.screenshot({ path: `${OUT}/captain-1-accepted.png` })

    // ── offline: banner, operations not claimed, resync on return ──────────────────────────────
    await setNet(t, false); await page.waitForTimeout(800)
    check((await page.locator('[data-testid=offline-banner]').count()) === 1, 'offline → "no connection" banner')
    await page.locator('[data-testid=mark-arrived]').click(); await page.waitForTimeout(5000)
    const off = await body(page)
    check(/لم يتأكد الخادم/.test(off), 'arrived while offline → "not confirmed by the server" (no false success)')
    check(be.s.rides[0].status === 'driver_arriving' && /وصلت إلى موقع الراكب/.test(off), 'screen still shows the last server-confirmed state (on the way)')
    await setNet(t, true); const back = Date.now()
    await page.waitForFunction(() => !document.querySelector('[data-testid=offline-banner]'), null, { timeout: 5000 }).catch(() => {})
    check((await page.locator('[data-testid=offline-banner]').count()) === 0, `back online → banner gone (${Date.now() - back} ms)`)
    await page.waitForTimeout(1500)
    await page.locator('[data-testid=mark-arrived]').click(); await page.waitForTimeout(2500)
    check(be.s.rides[0].status === 'driver_arrived' && /تحقق من الراكب/.test(await body(page)), 'arrived after reconnecting → confirmed')
    check(be.s.calls.filter((c) => c === 'transition_ride:driver_arrived').length === 1, `one arrived transition reached the server (${be.s.calls.filter((c) => c.includes('driver_arrived')).join(', ')})`)

    // ── start: the server started it, the answer was lost ──────────────────────────────────────
    be.s.fault['start_ride'] = ['lost']
    await page.locator('input').first().click(); await page.keyboard.type('4821', { delay: 60 }); await page.waitForTimeout(3500)
    const afterStart = await body(page)
    check(!/الرمز غير مطابق/.test(afterStart), 'lost start answer → NOT shown as "wrong code"')
    check(be.s.rides[0].status === 'in_progress' && /إنهاء الرحلة/.test(afterStart), 'server-confirmed: trip in progress')
    check(count(be, 'start_ride') === 1, `exactly one start_ride sent (${count(be, 'start_ride')})`)

    // ── double tap on "End trip" ───────────────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'إنهاء الرحلة' }).first().click(); await page.waitForTimeout(800)
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('نعم، إنهاء الرحلة')); b.click(); b.click() })
    await page.waitForTimeout(3000)
    check(count(be, 'transition_ride:completed') === 1, `double tap → one "completed" request (${count(be, 'transition_ride:completed')})`)
    check(be.s.rides[0].status === 'completed' && /صافي الكابتن|اكتملت الرحلة/.test(await body(page)), 'trip completed → summary')
    await page.getByRole('button', { name: 'تم' }).click().catch(() => {}); await page.waitForTimeout(1200)

    // ── an offer that arrives while offline is shown within 3 s of reconnecting ────────────────
    await setNet(t, false); await page.waitForTimeout(600)
    be.offer(2)
    await page.waitForTimeout(1500)
    check(!/طلب جديد/.test(await body(page)), 'offline: the new offer cannot arrive')
    await setNet(t, true); const t0 = Date.now()
    await page.waitForFunction(() => document.body.innerText.includes('طلب جديد'), null, { timeout: 6000 }).catch(() => {})
    const ms = Date.now() - t0
    check(/طلب جديد/.test(await body(page)) && ms <= 3000, `back online → the server's state (new offer) is shown in ${ms} ms (≤ 3 s)`)

    // ── accept when the request never reached the server (retried), and a taken offer ──────────
    be.s.fault['accept_ride'] = ['down']
    await page.locator('[data-testid=offer-accept]').click(); await page.waitForTimeout(4000)
    check(be.s.rides[0].status === 'driver_arriving' && count(be, 'accept_ride') === 3, `request lost on the way → retried and accepted (${be.s.calls.filter((c) => c.startsWith('accept')).join(', ')})`)
    // ── "connected" but no internet (captive Wi-Fi / dead mobile data): navigator.onLine stays true ──
    // (Run without Playwright's offline mode: after it, Chromium's emulated geolocation stops answering.)
    be.s.netDown = true
    await t.ctx.setGeolocation({ latitude: 24.7702, longitude: 46.7203, accuracy: 10 }); await page.waitForTimeout(2500)
    check(await page.evaluate(() => navigator.onLine) && (await page.locator('[data-testid=offline-banner]').count()) === 1, 'a GPS upload that gets no answer → "no connection" banner, although the browser says online')
    const gpsBefore = be.s.gps
    be.s.netDown = false
    await page.evaluate(() => window.dispatchEvent(new Event('online'))); await page.waitForTimeout(2500)
    check(be.s.gps > gpsBefore && (await page.locator('[data-testid=offline-banner]').count()) === 0, `connection back → a FRESH position is sent at once and the banner clears (${gpsBefore} → ${be.s.gps})`)
    check(t.leaks.length === 0, `no request left the browser (${t.leaks.slice(0, 3).join(', ')})`)
    check(t.errors.length === 0, `no JavaScript errors (${t.errors.join(' | ')})`)
    await page.screenshot({ path: `${OUT}/captain-2-end.png` })
  } catch (e) {
    check(false, `unexpected: ${e.message.split('\n')[0]}`)
    if (t) { console.log('--- page:\n' + (await t.page.locator('body').innerText().catch(() => '')).slice(0, 600)); console.log('--- calls:', t.be.s.calls.join(' | ')); await t.page.screenshot({ path: `${OUT}/captain-fail.png` }).catch(() => {}) }
  } finally {
    await browser.close()
    dev.kill()
  }
  console.log(fails ? `${fails} step(s) failed` : 'All steps passed')
  process.exit(fails ? 1 : 0)
})()
