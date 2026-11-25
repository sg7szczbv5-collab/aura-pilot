/**
 * PDPL privacy operations (consents, data export, data-subject requests).
 *   supabase : RPCs in supabase/migrations/20261126000100_auth_privacy.sql
 *   mock     : localStorage, shared across tabs, so the demo admin can process
 *              requests made in the rider/captain apps.
 */
import { AUTH_MODE } from '../auth/config'
import { browserKV, type KV } from '../auth/attemptGuard'
import { getSupabase } from '../auth/supabaseClient'
import { store } from '../core/store'
import {
  CONSENT_VERSIONS,
  PRIVACY_RESPONSE_DAYS,
  type ConsentApp,
  type ConsentPurpose,
  type ConsentRecord,
  type PrivacyRequest,
  type PrivacyRequestStatus,
  type PrivacyRequestType,
} from './consents'

export type ConsentDecision = { purpose: ConsentPurpose; granted: boolean }

export interface PrivacyService {
  getConsents(subjectId: string): Promise<ConsentRecord[]>
  recordConsents(subjectId: string, app: ConsentApp, decisions: ConsentDecision[], locale: 'ar' | 'en'): Promise<void>
  exportMyData(subjectId: string): Promise<Record<string, unknown>>
  listMyRequests(subjectId: string): Promise<PrivacyRequest[]>
  submitRequest(subjectId: string, type: Exclude<PrivacyRequestType, 'access'>, details?: string): Promise<PrivacyRequest>
  cancelRequest(subjectId: string, id: string): Promise<void>
  /** Staff (privacy.manage). */
  listAllRequests(): Promise<PrivacyRequest[]>
  updateRequest(id: string, status: Exclude<PrivacyRequestStatus, 'pending' | 'cancelled'>, note?: string): Promise<void>
}

export class PrivacyError extends Error {}

/* ============================== MOCK ============================== */

type MockDb = { consents: Record<string, ConsentRecord[]>; requests: PrivacyRequest[]; seq: number }
const KEY = 'aura.privacy.v1'
const DAY = 86_400_000

export class MockPrivacy implements PrivacyService {
  constructor(private kv: KV = browserKV(), private now: () => number = () => Date.now()) {}

  private read(): MockDb {
    try {
      return { consents: {}, requests: [], seq: 0, ...(JSON.parse(this.kv.get(KEY) ?? '{}') as Partial<MockDb>) }
    } catch {
      return { consents: {}, requests: [], seq: 0 }
    }
  }
  private write(db: MockDb) {
    this.kv.set(KEY, JSON.stringify(db))
  }

  async getConsents(subjectId: string) {
    return this.read().consents[subjectId] ?? []
  }

  async recordConsents(subjectId: string, _app: ConsentApp, decisions: ConsentDecision[]) {
    const db = this.read()
    const at = this.now()
    db.consents[subjectId] = [
      ...(db.consents[subjectId] ?? []),
      ...decisions.map((d, i) => ({ purpose: d.purpose, granted: d.granted, policyVersion: CONSENT_VERSIONS[d.purpose], at: at + i })),
    ]
    this.write(db)
  }

  async exportMyData(subjectId: string) {
    const s = store.state
    const db = this.read()
    const out = {
      format: 'aura.personal-data.v1',
      generated_at: new Date(this.now()).toISOString(),
      demo: true,
      profile: s.customers.find((c) => c.id === subjectId) ?? null,
      driver: s.drivers.find((d) => d.id === subjectId) ?? null,
      rides_as_rider: s.trips.filter((t) => t.passengerId === subjectId),
      rides_as_captain: s.trips.filter((t) => t.driverId === subjectId).map((t) => ({ id: t.id, status: t.status, fare: t.fare.driverNet })),
      tickets: s.tickets.filter((t) => t.requester.id === subjectId),
      consents: db.consents[subjectId] ?? [],
      privacy_requests: db.requests.filter((r) => r.userId === subjectId),
    }
    db.requests.push(this.make(db, subjectId, 'access', 'Self-service export', 'completed'))
    this.write(db)
    return out
  }

  private make(db: MockDb, userId: string, type: PrivacyRequestType, details: string | undefined, status: PrivacyRequestStatus = 'pending'): PrivacyRequest {
    const t = this.now()
    db.seq += 1
    return {
      id: `prq-${db.seq}-${t.toString(36)}`,
      number: db.seq,
      userId,
      type,
      status,
      details,
      createdAt: t,
      dueAt: t + PRIVACY_RESPONSE_DAYS * DAY,
      completedAt: status === 'completed' ? t : undefined,
    }
  }

  async listMyRequests(subjectId: string) {
    return this.read().requests.filter((r) => r.userId === subjectId).sort((a, b) => b.createdAt - a.createdAt)
  }

  async submitRequest(subjectId: string, type: Exclude<PrivacyRequestType, 'access'>, details?: string) {
    const db = this.read()
    if (db.requests.some((r) => r.userId === subjectId && r.type === type && (r.status === 'pending' || r.status === 'in_progress'))) {
      throw new PrivacyError('open_request_exists')
    }
    const r = this.make(db, subjectId, type, details)
    db.requests.push(r)
    this.write(db)
    return r
  }

  async cancelRequest(subjectId: string, id: string) {
    const db = this.read()
    const r = db.requests.find((x) => x.id === id && x.userId === subjectId && x.status === 'pending')
    if (!r) throw new PrivacyError('cannot_cancel')
    r.status = 'cancelled'
    r.completedAt = this.now()
    this.write(db)
  }

  async listAllRequests() {
    return [...this.read().requests].sort((a, b) => a.dueAt - b.dueAt)
  }

  async updateRequest(id: string, status: Exclude<PrivacyRequestStatus, 'pending' | 'cancelled'>, note?: string) {
    const db = this.read()
    const r = db.requests.find((x) => x.id === id)
    if (!r) throw new PrivacyError('not_found')
    const ok = r.status === 'pending' || (r.status === 'in_progress' && status !== 'in_progress')
    if (!ok) throw new PrivacyError('invalid_transition')
    if (status === 'rejected' && !note?.trim()) throw new PrivacyError('reason_required')
    r.status = status
    r.resolutionNote = note ?? r.resolutionNote
    if (status === 'completed' || status === 'rejected') r.completedAt = this.now()
    if (status === 'completed' && r.type === 'deletion') delete db.consents[r.userId]
    this.write(db)
  }
}

/* ============================== SUPABASE ============================== */

type RequestRow = {
  id: string
  request_number: number
  user_id: string
  request_type: PrivacyRequestType
  status: PrivacyRequestStatus
  details: string | null
  resolution_note: string | null
  created_at: string
  due_at: string
  completed_at: string | null
}

const fromRow = (r: RequestRow): PrivacyRequest => ({
  id: r.id,
  number: r.request_number,
  userId: r.user_id,
  type: r.request_type,
  status: r.status,
  details: r.details ?? undefined,
  resolutionNote: r.resolution_note ?? undefined,
  createdAt: Date.parse(r.created_at),
  dueAt: Date.parse(r.due_at),
  completedAt: r.completed_at ? Date.parse(r.completed_at) : undefined,
})

const REQ_COLS = 'id, request_number, user_id, request_type, status, details, resolution_note, created_at, due_at, completed_at'

function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new PrivacyError(res.error.message.replace(/^AURA:\s*/, ''))
  return res.data as T
}

class SupabasePrivacy implements PrivacyService {
  async getConsents() {
    const rows = must(await getSupabase().from('user_consents').select('purpose, granted, policy_version, created_at').order('created_at'))
    return (rows as { purpose: ConsentPurpose; granted: boolean; policy_version: string; created_at: string }[]).map((r) => ({
      purpose: r.purpose,
      granted: r.granted,
      policyVersion: r.policy_version,
      at: Date.parse(r.created_at),
    }))
  }

  async recordConsents(_subjectId: string, app: ConsentApp, decisions: ConsentDecision[], locale: 'ar' | 'en') {
    const sb = getSupabase()
    for (const d of decisions) {
      must(
        await sb.rpc('record_consent', {
          p_purpose: d.purpose,
          p_granted: d.granted,
          p_policy_version: CONSENT_VERSIONS[d.purpose],
          p_source: app === 'rider' ? 'rider_app' : 'driver_app',
          p_locale: locale,
          p_user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 300) : null,
        }),
      )
    }
  }

  async exportMyData() {
    return must(await getSupabase().rpc('export_my_data')) as Record<string, unknown>
  }

  async listMyRequests() {
    const rows = must(await getSupabase().from('privacy_requests').select(REQ_COLS).order('created_at', { ascending: false }))
    return (rows as RequestRow[]).map(fromRow)
  }

  async submitRequest(_s: string, type: Exclude<PrivacyRequestType, 'access'>, details?: string) {
    return fromRow(must(await getSupabase().rpc('submit_privacy_request', { p_type: type, p_details: details ?? null })) as RequestRow)
  }

  async cancelRequest(_s: string, id: string) {
    must(await getSupabase().rpc('cancel_privacy_request', { p_request_id: id }))
  }

  async listAllRequests() {
    const rows = must(await getSupabase().from('privacy_requests').select(REQ_COLS).order('due_at'))
    return (rows as RequestRow[]).map(fromRow)
  }

  async updateRequest(id: string, status: Exclude<PrivacyRequestStatus, 'pending' | 'cancelled'>, note?: string) {
    must(await getSupabase().rpc('admin_update_privacy_request', { p_request_id: id, p_status: status, p_note: note ?? null }))
  }
}

export const privacy: PrivacyService = AUTH_MODE === 'supabase' ? new SupabasePrivacy() : new MockPrivacy()

/** Save a JSON export through the browser. */
export function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
