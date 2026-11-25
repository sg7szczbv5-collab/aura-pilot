/**
 * One authentication API for all three apps, with two implementations:
 *   SupabaseAuth : real phone OTP (riders/captains) and email+password+TOTP MFA (staff)
 *   MockAuth     : the demo accounts/codes, offline, same guard and lockout rules
 * Apps call `auth.*` and never talk to Supabase Auth directly.
 */
import { AUTH_MODE, AUTH_POLICY, OTP_LENGTH, type AuthMode } from './config'
import { AttemptGuard } from './attemptGuard'
import type { Aal, AppRole, Identity } from './permissions'
import { getSupabase } from './supabaseClient'
import { broadcastSignOut } from './session'
import type { AdminRole } from '../core/types'
import { store } from '../core/store'
import type { ConsentPurpose } from '../privacy/consents'

export type OtpApp = 'rider' | 'driver'

export type AuthError =
  | 'invalid_code'
  | 'invalid_credentials'
  | 'locked'
  | 'rate_limited'
  | 'blocked'
  | 'not_staff'
  | 'mfa_failed'
  | 'network'

export type SendResult = { ok: true; resendInMs: number } | { ok: false; error: AuthError; waitMs?: number }
export type VerifyResult =
  | { ok: true; identity?: Identity }
  | { ok: false; error: AuthError; attemptsLeft?: number; lockedUntil?: number }
export type MfaEnrollment = { factorId: string; qrSvg: string; secret: string }
export type AdminSignInResult =
  | { ok: true; next: 'done' | 'mfa_verify' | 'mfa_enroll'; factorId?: string; enrollment?: MfaEnrollment; identity?: Identity; demoUserId?: string }
  | { ok: false; error: AuthError; attemptsLeft?: number; lockedUntil?: number }

export interface AuthService {
  readonly mode: AuthMode
  readonly otpLength: number
  /** Demo code to display, only in mock mode. */
  demoCode(app: OtpApp | 'admin_mfa'): string | null
  sendPhoneOtp(app: OtpApp, localPhone: string): Promise<SendResult>
  verifyPhoneOtp(app: OtpApp, localPhone: string, code: string): Promise<VerifyResult>
  adminSignIn(email: string, password: string): Promise<AdminSignInResult>
  adminVerifyMfa(email: string, code: string, factorId?: string): Promise<VerifyResult>
  /** Server-side identity of the current session (supabase); null in mock mode or when signed out. */
  currentIdentity(): Promise<Identity | null>
  signOut(app: 'rider' | 'driver' | 'admin', scope?: 'local' | 'global'): Promise<void>
}

/** +966 5XXXXXXXX from the 9-digit local mobile used by PhoneInput. */
export const toE164 = (localPhone: string) => `+966${localPhone.replace(/\D/g, '').replace(/^0/, '')}`
export const maskPhone = (e164?: string) => (e164 ? `${e164.slice(0, 6)}•••${e164.slice(-3)}` : '')

const otpGuard = () => new AttemptGuard('otp')
const pwGuard = () => new AttemptGuard('password')
const mfaGuard = () => new AttemptGuard('mfa')

const failed = (s: { locked: boolean; lockedUntil?: number; attemptsLeft: number }, error: AuthError): VerifyResult =>
  s.locked ? { ok: false, error: 'locked', lockedUntil: s.lockedUntil, attemptsLeft: 0 } : { ok: false, error, attemptsLeft: s.attemptsLeft }

/* ============================== MOCK ============================== */

const DEMO = { rider: '2468', driver: '1357', admin_mfa: '246810', password: 'Aura@2026' }

class MockAuth implements AuthService {
  readonly mode = 'mock' as const
  readonly otpLength = OTP_LENGTH

  demoCode(app: OtpApp | 'admin_mfa') {
    return DEMO[app]
  }

  async sendPhoneOtp(_app: OtpApp, localPhone: string): Promise<SendResult> {
    const g = otpGuard()
    const can = g.canSend(localPhone)
    if (!can.ok) return { ok: false, error: g.status(localPhone).locked ? 'locked' : 'rate_limited', waitMs: can.waitMs }
    g.markSent(localPhone)
    await delay(500)
    return { ok: true, resendInMs: AUTH_POLICY.resendMs }
  }

  async verifyPhoneOtp(app: OtpApp, localPhone: string, code: string): Promise<VerifyResult> {
    const g = otpGuard()
    if (g.status(localPhone).locked) return failed(g.status(localPhone), 'locked')
    if (code !== DEMO[app]) return failed(g.recordFailure(localPhone), 'invalid_code')
    g.recordSuccess(localPhone)
    return { ok: true }
  }

  async adminSignIn(email: string, password: string): Promise<AdminSignInResult> {
    const g = pwGuard()
    if (g.status(email).locked) return failed(g.status(email), 'locked') as AdminSignInResult
    await delay(450)
    const u = store.state.admins.find((a) => a.email.toLowerCase() === email.trim().toLowerCase())
    if (!u || password !== DEMO.password) return failed(g.recordFailure(email), 'invalid_credentials') as AdminSignInResult
    if (!u.active) return { ok: false, error: 'blocked' }
    g.recordSuccess(email)
    const needsMfa = u.twoFactor || store.state.settings.twoFactorRequired
    return { ok: true, next: needsMfa ? 'mfa_verify' : 'done', demoUserId: u.id }
  }

  async adminVerifyMfa(email: string, code: string): Promise<VerifyResult> {
    const g = mfaGuard()
    if (g.status(email).locked) return failed(g.status(email), 'locked')
    if (code !== DEMO.admin_mfa) return failed(g.recordFailure(email), 'mfa_failed')
    g.recordSuccess(email)
    return { ok: true }
  }

  async currentIdentity() {
    return null
  }

  async signOut(app: 'rider' | 'driver' | 'admin') {
    broadcastSignOut(app)
  }
}

/* ============================== SUPABASE ============================== */

type IdentityRow = {
  user_id: string
  app_role: AppRole
  admin_role: AdminRole | null
  is_blocked: boolean
  aal: Aal
  full_name: string | null
  phone: string | null
  email: string | null
  driver_status: string | null
  missing_rider_consents: ConsentPurpose[] | null
  missing_driver_consents: ConsentPurpose[] | null
}

export function identityFromRow(r: IdentityRow): Identity {
  return {
    userId: r.user_id,
    appRole: r.app_role,
    adminRole: r.admin_role ?? undefined,
    blocked: r.is_blocked,
    aal: r.aal,
    fullName: r.full_name ?? undefined,
    phone: r.phone ?? undefined,
    email: r.email ?? undefined,
    driverStatus: r.driver_status ?? undefined,
    missingConsents: { rider: r.missing_rider_consents ?? [], driver: r.missing_driver_consents ?? [] },
  }
}

class SupabaseAuth implements AuthService {
  readonly mode = 'supabase' as const
  readonly otpLength = OTP_LENGTH

  demoCode() {
    return null
  }

  async sendPhoneOtp(_app: OtpApp, localPhone: string): Promise<SendResult> {
    const g = otpGuard()
    const can = g.canSend(localPhone)
    if (!can.ok) return { ok: false, error: g.status(localPhone).locked ? 'locked' : 'rate_limited', waitMs: can.waitMs }
    const { error } = await getSupabase().auth.signInWithOtp({ phone: toE164(localPhone), options: { channel: 'sms', shouldCreateUser: true } })
    if (error) return { ok: false, error: error.status === 429 ? 'rate_limited' : 'network' }
    g.markSent(localPhone)
    return { ok: true, resendInMs: AUTH_POLICY.resendMs }
  }

  async verifyPhoneOtp(_app: OtpApp, localPhone: string, code: string): Promise<VerifyResult> {
    const g = otpGuard()
    if (g.status(localPhone).locked) return failed(g.status(localPhone), 'locked')
    const { error } = await getSupabase().auth.verifyOtp({ phone: toE164(localPhone), token: code, type: 'sms' })
    if (error) {
      if (error.status === 429) return { ok: false, error: 'rate_limited' }
      return failed(g.recordFailure(localPhone), 'invalid_code')
    }
    g.recordSuccess(localPhone)
    const identity = await this.currentIdentity()
    if (!identity) return { ok: false, error: 'network' }
    if (identity.blocked) {
      await getSupabase().auth.signOut({ scope: 'local' })
      return { ok: false, error: 'blocked' }
    }
    return { ok: true, identity }
  }

  async adminSignIn(email: string, password: string): Promise<AdminSignInResult> {
    const g = pwGuard()
    if (g.status(email).locked) return failed(g.status(email), 'locked') as AdminSignInResult
    const sb = getSupabase()
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password })
    if (error) {
      if (error.status === 429) return { ok: false, error: 'rate_limited' }
      return failed(g.recordFailure(email), 'invalid_credentials') as AdminSignInResult
    }
    g.recordSuccess(email)
    const identity = await this.currentIdentity()
    if (!identity || identity.appRole !== 'admin' || !identity.adminRole || identity.blocked) {
      await sb.auth.signOut({ scope: 'local' })
      return { ok: false, error: identity?.blocked ? 'blocked' : 'not_staff' }
    }
    // MFA is mandatory for staff: verify an existing TOTP factor or enroll one now.
    const { data: factors, error: fErr } = await sb.auth.mfa.listFactors()
    if (fErr) return { ok: false, error: 'network' }
    const verified = factors.totp.find((f) => f.status === 'verified')
    if (verified) return { ok: true, next: 'mfa_verify', factorId: verified.id, identity }
    for (const f of factors.all.filter((x) => x.status !== 'verified')) await sb.auth.mfa.unenroll({ factorId: f.id })
    const { data: en, error: eErr } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `AURA Admin ${Date.now()}` })
    if (eErr || !en) return { ok: false, error: 'network' }
    return { ok: true, next: 'mfa_enroll', factorId: en.id, enrollment: { factorId: en.id, qrSvg: en.totp.qr_code, secret: en.totp.secret }, identity }
  }

  async adminVerifyMfa(email: string, code: string, factorId?: string): Promise<VerifyResult> {
    const g = mfaGuard()
    if (g.status(email).locked) return failed(g.status(email), 'locked')
    if (!factorId) return { ok: false, error: 'mfa_failed' }
    const { error } = await getSupabase().auth.mfa.challengeAndVerify({ factorId, code })
    if (error) return failed(g.recordFailure(email), 'mfa_failed')
    g.recordSuccess(email)
    const identity = await this.currentIdentity()
    if (!identity || identity.aal !== 'aal2') return { ok: false, error: 'mfa_failed' }
    return { ok: true, identity }
  }

  async currentIdentity(): Promise<Identity | null> {
    const sb = getSupabase()
    const { data } = await sb.auth.getSession()
    if (!data.session) return null
    const { data: row, error } = await sb.rpc('my_identity').maybeSingle<IdentityRow>()
    if (error || !row) return null
    return identityFromRow(row)
  }

  async signOut(app: 'rider' | 'driver' | 'admin', scope: 'local' | 'global' = 'local') {
    await getSupabase().auth.signOut({ scope })
    broadcastSignOut(app)
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const auth: AuthService = AUTH_MODE === 'supabase' ? new SupabaseAuth() : new MockAuth()

/** For tests. */
export const createMockAuth = (): AuthService => new MockAuth()

export function authErrorText(e: AuthError, t: (ar: string, en: string) => string, opts: { attemptsLeft?: number; lockedUntil?: number; waitMs?: number } = {}): string {
  const mins = (ms?: number) => Math.max(1, Math.ceil((ms ?? 0) / 60_000))
  const secs = (ms?: number) => Math.max(1, Math.ceil((ms ?? 0) / 1000))
  switch (e) {
    case 'invalid_code':
      return opts.attemptsLeft !== undefined
        ? t(`الرمز غير صحيح. المحاولات المتبقية: ${opts.attemptsLeft}`, `Incorrect code. ${opts.attemptsLeft} attempts left`)
        : t('الرمز غير صحيح', 'Incorrect code')
    case 'invalid_credentials':
      return t('البريد الإلكتروني أو كلمة المرور غير صحيحة', 'Incorrect email or password')
    case 'locked': {
      const m = mins(opts.lockedUntil ? opts.lockedUntil - Date.now() : opts.waitMs)
      return t(`محاولات كثيرة. حاول بعد ${m} دقيقة`, `Too many attempts. Try again in ${m} min`)
    }
    case 'rate_limited':
      return t(`انتظر ${secs(opts.waitMs)} ثانية قبل طلب رمز جديد`, `Wait ${secs(opts.waitMs)}s before requesting a new code`)
    case 'blocked':
      return t('هذا الحساب موقوف. تواصل مع الدعم.', 'This account is suspended. Contact support.')
    case 'not_staff':
      return t('هذا الحساب ليس لديه صلاحية دخول لوحة الإدارة', 'This account has no access to the admin console')
    case 'mfa_failed':
      return opts.attemptsLeft !== undefined
        ? t(`رمز التحقق غير صحيح. المحاولات المتبقية: ${opts.attemptsLeft}`, `Invalid verification code. ${opts.attemptsLeft} attempts left`)
        : t('رمز التحقق غير صحيح', 'Invalid verification code')
    case 'network':
      return t('تعذّر الاتصال، حاول مرة أخرى', 'Connection problem, please try again')
  }
}
