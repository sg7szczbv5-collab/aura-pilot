/**
 * Roles and permissions shared by every app. The admin matrix is the same one
 * the database enforces in private.admin_can() (parity tested in tests/db).
 */
import { DEFAULT_ROLE_PERMISSIONS } from '../core/seed'
import type { AdminRole, Permission } from '../core/types'
import type { ConsentPurpose } from '../privacy/consents'

export type AppId = 'rider' | 'driver' | 'admin'
export type AppRole = 'rider' | 'driver' | 'admin'
export type Aal = 'aal1' | 'aal2'

/** Who is signed in, as resolved from the server (supabase) or the demo store (mock). */
export type Identity = {
  userId: string
  appRole: AppRole
  adminRole?: AdminRole
  blocked: boolean
  aal: Aal
  fullName?: string
  phone?: string
  email?: string
  driverStatus?: string
  missingConsents: { rider: ConsentPurpose[]; driver: ConsentPurpose[] }
}

export type RolePermissions = Record<AdminRole, Permission[]>

/**
 * Super admin always has every permission (as in the database). Other roles use
 * `overrides` when given (the demo's editable matrix) or the shipped defaults.
 */
export function hasPermission(role: AdminRole | undefined, perm: Permission, overrides?: Partial<RolePermissions>): boolean {
  if (!role) return false
  if (role === 'super_admin') return true
  return (overrides?.[role] ?? DEFAULT_ROLE_PERMISSIONS[role] ?? []).includes(perm)
}

export type AccessDecision = { ok: true } | { ok: false; reason: 'signed_out' | 'blocked' | 'not_staff' | 'mfa_required' }

/** Gate for entering an app. Staff need role admin + MFA; riders/captains need an unblocked account. */
export function canEnterApp(app: AppId, identity: Identity | null | undefined): AccessDecision {
  if (!identity) return { ok: false, reason: 'signed_out' }
  if (identity.blocked) return { ok: false, reason: 'blocked' }
  if (app === 'admin') {
    if (identity.appRole !== 'admin' || !identity.adminRole) return { ok: false, reason: 'not_staff' }
    if (identity.aal !== 'aal2') return { ok: false, reason: 'mfa_required' }
  }
  return { ok: true }
}
