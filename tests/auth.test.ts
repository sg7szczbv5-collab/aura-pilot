/**
 * Stage 3 unit tests: auth guards, roles/permissions, staff session policy,
 * consent rules and the mock privacy service.   npm test
 */
import { describe, expect, it } from 'vitest'
import { AttemptGuard, memoryKV } from '../src/auth/attemptGuard'
import { AUTH_POLICY, ADMIN_SESSION_POLICY } from '../src/auth/config'
import { canEnterApp, hasPermission, type Identity } from '../src/auth/permissions'
import { adminSessionState } from '../src/auth/session'
import { createMockAuth, maskPhone, toE164 } from '../src/auth/authService'
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '../src/core/seed'
import type { AdminRole } from '../src/core/types'
import {
  CONSENT_VERSIONS,
  REQUIRED_CONSENTS,
  isConsentCurrent,
  missingRequiredConsents,
  type ConsentRecord,
} from '../src/privacy/consents'
import { MockPrivacy } from '../src/privacy/privacyService'

const MIN = 60_000

describe('attempt guard (OTP / password brute force)', () => {
  const make = () => {
    let now = 1_000_000
    const g = new AttemptGuard('t', memoryKV(), AUTH_POLICY, () => now)
    return { g, tick: (ms: number) => (now += ms) }
  }

  it('locks after the maximum failures and unlocks after the lock period', () => {
    const { g, tick } = make()
    for (let i = 0; i < AUTH_POLICY.maxAttempts - 1; i++) expect(g.recordFailure('555').locked).toBe(false)
    expect(g.status('555').attemptsLeft).toBe(1)
    const s = g.recordFailure('555')
    expect(s.locked).toBe(true)
    expect(g.canSend('555').ok).toBe(false)
    tick(AUTH_POLICY.lockMs + 1)
    expect(g.status('555')).toEqual({ locked: false, attemptsLeft: AUTH_POLICY.maxAttempts })
  })

  it('success clears failures; identifiers are independent and case-insensitive', () => {
    const { g } = make()
    g.recordFailure('Admin@x.sa')
    g.recordFailure('admin@x.sa')
    expect(g.status('ADMIN@X.SA').attemptsLeft).toBe(AUTH_POLICY.maxAttempts - 2)
    expect(g.status('other').attemptsLeft).toBe(AUTH_POLICY.maxAttempts)
    g.recordSuccess('admin@x.sa')
    expect(g.status('admin@x.sa').attemptsLeft).toBe(AUTH_POLICY.maxAttempts)
  })

  it('enforces the SMS resend cooldown', () => {
    const { g, tick } = make()
    expect(g.canSend('555').ok).toBe(true)
    g.markSent('555')
    expect(g.canSend('555')).toEqual({ ok: false, waitMs: AUTH_POLICY.resendMs })
    tick(AUTH_POLICY.resendMs)
    expect(g.canSend('555').ok).toBe(true)
  })

  it('old failures fall out of the window', () => {
    const { g, tick } = make()
    for (let i = 0; i < AUTH_POLICY.maxAttempts - 1; i++) g.recordFailure('555')
    tick(AUTH_POLICY.windowMs + 1)
    expect(g.recordFailure('555').locked).toBe(false)
  })
})

describe('mock auth service', () => {
  it('accepts only the app demo code and locks after repeated failures', async () => {
    const a = createMockAuth()
    expect(a.mode).toBe('mock')
    expect(await a.verifyPhoneOtp('rider', '500000001', '2468')).toEqual({ ok: true })
    expect((await a.verifyPhoneOtp('driver', '500000001', '2468')).ok).toBe(false) // rider code is not the captain code
    let last
    for (let i = 0; i < AUTH_POLICY.maxAttempts; i++) last = await a.verifyPhoneOtp('rider', '500000002', '0000')
    expect(last).toMatchObject({ ok: false, error: 'locked' })
    expect(await a.verifyPhoneOtp('rider', '500000002', '2468')).toMatchObject({ ok: false, error: 'locked' })
  })

  it('formats and masks Saudi numbers', () => {
    expect(toE164('551234567')).toBe('+966551234567')
    expect(toE164('0551234567')).toBe('+966551234567')
    expect(maskPhone('+966551234567')).toBe('+96655•••567')
  })
})

describe('roles and permissions', () => {
  it('super admin has every permission, including privacy.manage', () => {
    expect(ALL_PERMISSIONS.every((p) => hasPermission('super_admin', p))).toBe(true)
  })

  it('other roles follow DEFAULT_ROLE_PERMISSIONS (same matrix the database enforces)', () => {
    for (const role of Object.keys(DEFAULT_ROLE_PERMISSIONS) as AdminRole[]) {
      if (role === 'super_admin') continue
      for (const p of ALL_PERMISSIONS) expect(hasPermission(role, p)).toBe(DEFAULT_ROLE_PERMISSIONS[role].includes(p))
      expect(hasPermission(role, 'privacy.manage')).toBe(false)
    }
  })

  it('demo overrides apply to non-super roles only', () => {
    expect(hasPermission('marketing_manager', 'finance.view', { marketing_manager: ['finance.view'] })).toBe(true)
    expect(hasPermission('super_admin', 'finance.view', { super_admin: [] })).toBe(true)
    expect(hasPermission(undefined, 'dashboard.view')).toBe(false)
  })

  const id = (p: Partial<Identity>): Identity => ({
    userId: 'u1',
    appRole: 'rider',
    blocked: false,
    aal: 'aal1',
    missingConsents: { rider: [], driver: [] },
    ...p,
  })

  it('app entry: staff need role + MFA; blocked accounts enter nothing', () => {
    expect(canEnterApp('admin', null)).toEqual({ ok: false, reason: 'signed_out' })
    expect(canEnterApp('admin', id({}))).toEqual({ ok: false, reason: 'not_staff' })
    expect(canEnterApp('admin', id({ appRole: 'admin', adminRole: 'finance_manager' }))).toEqual({ ok: false, reason: 'mfa_required' })
    expect(canEnterApp('admin', id({ appRole: 'admin', adminRole: 'finance_manager', aal: 'aal2' }))).toEqual({ ok: true })
    expect(canEnterApp('rider', id({ blocked: true }))).toEqual({ ok: false, reason: 'blocked' })
    expect(canEnterApp('driver', id({ appRole: 'driver' }))).toEqual({ ok: true })
  })
})

describe('staff session policy', () => {
  const t0 = 10_000_000
  it('valid while active, ends after idle minutes or the absolute maximum', () => {
    expect(adminSessionState({ authAt: t0, lastActiveAt: t0, idleMinutes: 30, now: t0 + 29 * MIN }).valid).toBe(true)
    expect(adminSessionState({ authAt: t0, lastActiveAt: t0, idleMinutes: 30, now: t0 + 31 * MIN })).toMatchObject({ valid: false, reason: 'idle' })
    const late = t0 + ADMIN_SESSION_POLICY.maxAgeMs + 1
    expect(adminSessionState({ authAt: t0, lastActiveAt: late - 1, idleMinutes: 30, now: late })).toMatchObject({ valid: false, reason: 'expired' })
    expect(adminSessionState({ idleMinutes: 30, now: t0 }).valid).toBe(false)
  })
})

describe('consent rules', () => {
  const rec = (purpose: ConsentRecord['purpose'], granted: boolean, at: number, version = CONSENT_VERSIONS[purpose]): ConsentRecord => ({
    purpose,
    granted,
    policyVersion: version,
    at,
  })

  it('riders need terms + privacy; captains also location + regulatory sharing', () => {
    expect(missingRequiredConsents('rider', [])).toEqual(REQUIRED_CONSENTS.rider)
    const riderOk = [rec('terms_of_service', true, 1), rec('privacy_policy', true, 2)]
    expect(missingRequiredConsents('rider', riderOk)).toEqual([])
    expect(missingRequiredConsents('driver', riderOk)).toEqual(['location_tracking', 'regulatory_data_sharing'])
  })

  it('the latest decision wins, and outdated versions do not count', () => {
    const r = [rec('privacy_policy', true, 1), rec('privacy_policy', false, 2)]
    expect(isConsentCurrent(r, 'privacy_policy')).toBe(false)
    expect(isConsentCurrent([...r, rec('privacy_policy', true, 3)], 'privacy_policy')).toBe(true)
    expect(isConsentCurrent([rec('terms_of_service', true, 5, '2020-01-01')], 'terms_of_service')).toBe(false)
  })
})

describe('mock privacy service', () => {
  it('records consents, exports data and logs the access request', async () => {
    const p = new MockPrivacy(memoryKV())
    await p.recordConsents('cus-1', 'rider', [{ purpose: 'terms_of_service', granted: true }, { purpose: 'privacy_policy', granted: true }], 'ar')
    expect(missingRequiredConsents('rider', await p.getConsents('cus-1'))).toEqual([])
    const data = await p.exportMyData('cus-1')
    expect(data.format).toBe('aura.personal-data.v1')
    expect((await p.listMyRequests('cus-1')).map((r) => [r.type, r.status])).toEqual([['access', 'completed']])
  })

  it('one open request per type, 30-day deadline, reasons required to reject, deletion clears consents', async () => {
    let now = 5_000_000
    const p = new MockPrivacy(memoryKV(), () => now)
    await p.recordConsents('cus-2', 'rider', [{ purpose: 'terms_of_service', granted: true }], 'en')
    const r = await p.submitRequest('cus-2', 'deletion', 'please')
    expect(r.dueAt - r.createdAt).toBe(30 * 86_400_000)
    await expect(p.submitRequest('cus-2', 'deletion')).rejects.toThrow('open_request_exists')
    await expect(p.updateRequest(r.id, 'rejected')).rejects.toThrow('reason_required')
    await p.updateRequest(r.id, 'in_progress')
    now += 1000
    await p.updateRequest(r.id, 'completed', 'done')
    expect(await p.getConsents('cus-2')).toEqual([])
    await expect(p.updateRequest(r.id, 'rejected', 'x')).rejects.toThrow('invalid_transition')
    await expect(p.cancelRequest('cus-2', r.id)).rejects.toThrow('cannot_cancel')
  })
})
