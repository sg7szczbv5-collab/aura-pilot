/**
 * Stage 6 unit tests: Saudi validators, Wasl providers/worker, privacy cleanup
 * worker, captain onboarding rules, document mapping, legal documents, safety.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ageOn,
  formatIban,
  isValidPlate,
  isValidSaudiIban,
  isValidSaudiId,
  isValidSequenceNumber,
  saudiIdCheckDigit,
  saudiIdKind,
  vehicleAgeOk,
} from '../src/compliance/validators'
import { MockWasl } from '../supabase/functions/_shared/wasl/mock'
import { DEFAULT_WASL_PATHS, WaslHttpProvider, interpretWaslBody } from '../supabase/functions/_shared/wasl/http'
import { getWaslProvider, runWaslWorker, type WaslQueueItem, type WaslRecord } from '../supabase/functions/_shared/wasl/worker'
import type { WaslProvider } from '../supabase/functions/_shared/wasl/provider'
import { USER_BUCKETS, runPrivacyCleanup } from '../supabase/functions/_shared/privacy/cleanup'
import { DOC_TYPE, NEEDS_EXPIRY, storagePath, validateOnboarding, type OnboardingInput } from '../src/captain/onboarding'
import { docsFromServer } from '../src/data/serverMirror'
import { DOC_FOR_PURPOSE, LEGAL_DOCS } from '../src/legal/documents'
import { CONSENT_PURPOSES, CONSENT_VERSIONS } from '../src/privacy/consents'
import { createShareLink, fetchSharedTrip, trackUrl } from '../src/safety/safety'

describe('Saudi validators', () => {
  it('national ID / Iqama checksum', () => {
    expect(isValidSaudiId('1012345672')).toBe(true)
    expect(isValidSaudiId('1012345678')).toBe(false)
    expect(isValidSaudiId('3012345672')).toBe(false) // must start with 1 or 2
    expect(isValidSaudiId('101234567')).toBe(false)
    const iqama = '20000000' + '1'
    const full = iqama + saudiIdCheckDigit(iqama)
    expect(isValidSaudiId(full)).toBe(true)
    expect(saudiIdKind(full)).toBe('resident')
    expect(saudiIdKind('1012345672')).toBe('citizen')
    expect(() => saudiIdCheckDigit('3000')).toThrow('invalid_prefix')
  })

  it('IBAN mod-97 with BigInt', () => {
    expect(isValidSaudiIban('SA0380000000608010167519')).toBe(true)
    expect(isValidSaudiIban('sa03 8000 0000 6080 1016 7519')).toBe(true)
    expect(isValidSaudiIban('SA0380000000608010167518')).toBe(false)
    expect(isValidSaudiIban('GB82WEST12345698765432')).toBe(false)
    expect(isValidSaudiIban('SA038000000060801016751')).toBe(false) // too short
    expect(formatIban('sa0380000000608010167519')).toBe('SA03 8000 0000 6080 1016 7519')
  })

  it('vehicle, plate, sequence number and age rules', () => {
    const now = new Date(2026, 10, 29)
    expect(vehicleAgeOk(2016, now)).toBe(true)
    expect(vehicleAgeOk(2015, now)).toBe(false)
    expect(vehicleAgeOk(2028, now)).toBe(false)
    expect(isValidPlate('ABJ', '1234')).toBe(true)
    expect(isValidPlate('ABC', '1234')).toBe(false) // C is not used on Saudi plates
    expect(isValidPlate('AB', '1')).toBe(false)
    expect(isValidSequenceNumber('123456789')).toBe(true)
    expect(isValidSequenceNumber('12345')).toBe(false)
    expect(ageOn(new Date(2008, 10, 30), now)).toBe(17)
    expect(ageOn(new Date(2008, 10, 29), now)).toBe(18)
  })
})

describe('Wasl providers', () => {
  it('mock: eligibility rules and trip references', async () => {
    const w = new MockWasl()
    expect(await w.call('driver_registration', { national_id: '1012345672' })).toMatchObject({ success: true, reference: 'MOCK-D-5672' })
    expect(await w.call('eligibility_check', { national_id: '1012345678' })).toMatchObject({ success: false })
    const r1099 = '1099' + '00001'
    expect((await w.call('eligibility_check', { national_id: r1099 + saudiIdCheckDigit(r1099) })).success).toBe(false)
    expect((await w.call('vehicle_registration', { year: 2005, sequence_number: '123456' })).success).toBe(false)
    expect(await w.call('trip_registration', { ride_number: 42 })).toMatchObject({ success: true, reference: 'MOCK-T-42' })
    expect((await w.call('trip_update', {})).success).toBe(true)
    // Business rejections carry no error (so they are not retried).
    expect((await w.call('vehicle_registration', { year: 2005 })).error).toBeUndefined()
  })

  it('HTTP adapter: configurable endpoint, headers and body', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, result: { eligibility: true, referenceNumber: 'W-1' } }) }))
    const p = new WaslHttpProvider({ baseUrl: 'https://wasl.example/api/', appId: 'id', appKey: 'key', clientId: 'cli' }, f)
    expect(await p.call('driver_registration', { national_id: '1012345672' })).toMatchObject({ success: true, reference: 'W-1' })
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe(`https://wasl.example/api${DEFAULT_WASL_PATHS.driver_registration}`)
    expect(init.headers).toMatchObject({ 'app-id': 'id', 'app-key': 'key', 'client-id': 'cli' })
    expect(JSON.parse(init.body)).toEqual({ national_id: '1012345672' })
    expect(() => new WaslHttpProvider({ baseUrl: '', appId: '', appKey: '' }, f)).toThrow('wasl_not_configured')
  })

  it('only an explicit "not eligible" is a rejection; everything else is a retryable error', async () => {
    expect(interpretWaslBody(200, { result: { eligibility: false } })).toEqual({ success: false, response: { result: { eligibility: false } } })
    expect(interpretWaslBody(200, { eligible: false }).error).toBeUndefined()
    expect(interpretWaslBody(500, { resultMsg: 'down' }).error).toBe('http_500: down')
    expect(interpretWaslBody(400, null).error).toBe('http_400')
    expect(interpretWaslBody(200, { success: false, resultMsg: 'bad format' }).error).toBe('bad format')
    expect(interpretWaslBody(200, { referenceNumber: 'R9' })).toMatchObject({ success: true, reference: 'R9' })
    const boom = new WaslHttpProvider({ baseUrl: 'https://x', appId: 'a', appKey: 'b' }, async () => Promise.reject(new Error('ECONNRESET')))
    expect(await boom.call('trip_update', {})).toMatchObject({ success: false, error: 'ECONNRESET' })
  })

  it('provider selection from environment', () => {
    expect(getWaslProvider(() => undefined, vi.fn()).name).toBe('mock')
    expect(() => getWaslProvider((k) => ({ WASL_MODE: 'live' })[k], vi.fn())).toThrow('wasl_not_configured')
    const env = (k: string) => ({ WASL_MODE: 'live', WASL_API_BASE_URL: 'https://w', WASL_APP_ID: 'a', WASL_APP_KEY: 'b', WASL_PATH_TRIP_UPDATE: '/v2/trip' })[k]
    expect(getWaslProvider(env, vi.fn()).name).toBe('wasl')
  })

  it('worker records accepted, rejected and errored items, and survives exceptions', async () => {
    const items: WaslQueueItem[] = [
      { entity_type: 'driver', entity_id: 'd1', operation: 'driver_registration', attempt: 1, payload: { national_id: '1012345672' } },
      { entity_type: 'vehicle', entity_id: 'v1', operation: 'vehicle_registration', attempt: 1, payload: { year: 2001 } },
      { entity_type: 'ride', entity_id: 'r1', operation: 'trip_registration', attempt: 3, payload: { ride_number: 7 } },
    ]
    const provider: WaslProvider = {
      name: 'mock',
      call: async (op, p) => (op === 'trip_registration' ? Promise.reject(new Error('timeout')) : new MockWasl().call(op, p)),
    }
    const recorded: WaslRecord[] = []
    const out = await runWaslWorker({ queue: async () => items, provider, record: async (r) => void recorded.push(r) })
    expect(out).toEqual({ processed: 3, accepted: 1, rejected: 1, errors: 1 })
    expect(recorded.map((r) => [r.entityId, r.success, r.error ?? null])).toEqual([['d1', true, null], ['v1', false, null], ['r1', false, 'timeout']])
    expect(recorded[0].request).toEqual(items[0].payload)
  })
})

describe('privacy cleanup worker', () => {
  it("removes only the person's own files in every bucket, disables login, then completes", async () => {
    const removed: string[][] = []
    const complete = vi.fn(async () => {})
    const out = await runPrivacyCleanup({
      queue: async () => [{ request_id: 'q1', user_id: 'u1' }],
      listFiles: async (bucket) => (bucket === 'driver-documents' ? ['national_id-1.jpg', '../other/evil.jpg'] : ['avatar.png']),
      removeFiles: async (_b, paths) => {
        removed.push(paths)
        return paths.length
      },
      disableLogin: async () => true,
      complete,
    })
    expect(USER_BUCKETS).toEqual(['driver-documents', 'avatars'])
    expect(removed).toEqual([['u1/national_id-1.jpg'], ['u1/avatar.png']])
    expect(complete).toHaveBeenCalledWith('q1', 2, true)
    expect(out).toMatchObject({ processed: 1, failed: 0 })
  })

  it('one failing request never blocks the others', async () => {
    const out = await runPrivacyCleanup({
      queue: async () => [{ request_id: 'a', user_id: 'ua' }, { request_id: 'b', user_id: 'ub' }],
      listFiles: async (_b, prefix) => (prefix === 'ua' ? Promise.reject(new Error('storage down')) : []),
      removeFiles: async () => 0,
      disableLogin: async () => true,
      complete: async () => {},
    })
    expect(out).toMatchObject({ processed: 1, failed: 1 })
  })
})

describe('captain onboarding', () => {
  const file = (name: string, type = 'image/jpeg', size = 1000) => new File([new Uint8Array(size)], name, { type })
  const base = (): OnboardingInput => ({
    uid: 'u1',
    fullName: 'Ahmed Al-Harbi',
    nationalId: '1012345672',
    dateOfBirth: '1990-05-01',
    iban: 'SA03 8000 0000 6080 1016 7519',
    cityCode: 'riyadh',
    vehicle: { classId: 'go', make: 'Toyota', model: 'Camry', year: 2023, color: 'white', plateLetters: 'abj', plateDigits: '1234', sequenceNumber: '123456789', seats: 4 },
    docs: Object.fromEntries((Object.keys(DOC_TYPE) as (keyof typeof DOC_TYPE)[]).map((k) => [k, { file: file(`${k}.jpg`), expiresAt: NEEDS_EXPIRY.includes(k) ? '2030-01-01' : undefined }])),
    consentsAccepted: true,
    locale: 'ar',
  })
  const now = new Date(2026, 10, 29)

  it('accepts a complete application and pinpoints the first problem otherwise', () => {
    expect(validateOnboarding(base(), now)).toEqual({ ok: true })
    expect(validateOnboarding({ ...base(), nationalId: '1012345678' }, now)).toEqual({ ok: false, field: 'nationalId' })
    expect(validateOnboarding({ ...base(), dateOfBirth: '2010-01-01' }, now)).toEqual({ ok: false, field: 'dateOfBirth' })
    expect(validateOnboarding({ ...base(), iban: 'SA0380000000608010167518' }, now)).toEqual({ ok: false, field: 'iban' })
    expect(validateOnboarding({ ...base(), vehicle: { ...base().vehicle, year: 2010 } }, now)).toEqual({ ok: false, field: 'vehicleYear' })
    expect(validateOnboarding({ ...base(), vehicle: { ...base().vehicle, sequenceNumber: '12' } }, now)).toEqual({ ok: false, field: 'sequenceNumber' })
    const noLicence = base()
    delete noLicence.docs.license
    expect(validateOnboarding(noLicence, now)).toEqual({ ok: false, field: 'doc:license' })
    const expired = base()
    expired.docs.insurance = { file: file('ins.pdf', 'application/pdf'), expiresAt: '2026-01-01' }
    expect(validateOnboarding(expired, now)).toEqual({ ok: false, field: 'expiry:insurance' })
    const huge = base()
    huge.docs.photo = { file: file('p.jpg', 'image/jpeg', 11 * 1024 * 1024) }
    expect(validateOnboarding(huge, now)).toEqual({ ok: false, field: 'doc:photo' })
    const exe = base()
    exe.docs.photo = { file: file('p.exe', 'application/x-msdownload') }
    expect(validateOnboarding(exe, now)).toEqual({ ok: false, field: 'doc:photo' })
    expect(validateOnboarding({ ...base(), consentsAccepted: false }, now)).toEqual({ ok: false, field: 'consents' })
  })

  it('stores files only inside the captain folder with a safe extension', () => {
    expect(storagePath('u1', 'license', { name: 'Licence Scan.PDF', type: 'application/pdf' }, 5)).toBe('u1/license-5.pdf')
    expect(storagePath('u1', 'photo', { name: 'image', type: 'image/png' }, 5)).toBe('u1/photo-5.png')
    expect(storagePath('u1', 'photo', { name: '../../x.sh', type: '' }, 5)).toBe('u1/photo-5.jpg')
  })

  it('maps server document review states to the status screen', () => {
    const docs = docsFromServer([
      { doc_type: 'driving_license', status: 'rejected', expires_at: '2030-01-01', rejection_reason: 'Blurry' },
      { doc_type: 'driving_license', status: 'uploaded', expires_at: '2030-01-01', rejection_reason: null },
      { doc_type: 'vehicle_insurance', status: 'expired', expires_at: '2025-01-01', rejection_reason: null },
      { doc_type: 'national_id', status: 'approved', expires_at: '2031-01-01', rejection_reason: null },
    ])
    expect(docs.find((d) => d.id === 'license')).toMatchObject({ status: 'uploaded' }) // newest wins
    expect(docs.find((d) => d.id === 'insurance')).toMatchObject({ status: 'rejected', note: 'expired' })
    expect(docs.find((d) => d.id === 'national_id')).toMatchObject({ status: 'approved', expires: '2031-01-01' })
    expect(docs.find((d) => d.id === 'photo')).toEqual({ id: 'photo', status: 'missing' })
  })
})

describe('legal and safety readiness', () => {
  it('every document is complete in Arabic and English and versioned with the consents', () => {
    for (const doc of Object.values(LEGAL_DOCS)) {
      expect(doc.draft).toBe(true) // until legal sign-off
      expect(doc.title.ar && doc.title.en).toBeTruthy()
      expect(doc.sections.length).toBeGreaterThanOrEqual(3)
      for (const s of doc.sections) {
        expect(s.heading.ar.trim() && s.heading.en.trim()).toBeTruthy()
        for (const p of s.body) expect(p.ar.trim().length > 10 && p.en.trim().length > 10).toBe(true)
      }
      expect(Object.values(CONSENT_VERSIONS)).toContain(doc.version)
      expect(JSON.stringify(doc)).not.toMatch(/@[a-z]/i) // no invented contact addresses
    }
    for (const p of CONSENT_PURPOSES) expect(LEGAL_DOCS[DOC_FOR_PURPOSE[p]]).toBeDefined()
    expect(LEGAL_DOCS.privacy.version).toBe(CONSENT_VERSIONS.privacy_policy)
    expect(LEGAL_DOCS.terms.version).toBe(CONSENT_VERSIONS.terms_of_service)
  })

  it('privacy policy states retention periods that match the database jobs', () => {
    const en = LEGAL_DOCS.privacy.sections.flatMap((s) => s.body.map((b) => b.en)).join(' ')
    expect(en).toContain('180 days') // private.purge_route_points(180)
    expect(en).toContain('one year') // wasl_payload_retention_days = 365
    expect(en).toContain('12 hours') // share_hours = 12
    expect(en).toContain('30 days') // PDPL response time
  })

  it('share links and tracking (mock mode)', async () => {
    expect(trackUrl('ab'.repeat(32))).toMatch(/#\/track\/(ab){32}$/)
    expect(await createShareLink('ride-1')).toEqual({ ok: true, url: 'https://aura.demo/t/ride-1' })
    expect(await fetchSharedTrip('not-a-token')).toBeNull()
  })
})
