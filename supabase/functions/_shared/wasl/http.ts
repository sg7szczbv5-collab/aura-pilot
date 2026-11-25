/**
 * Configurable HTTP adapter for Wasl (WASL_MODE=live). Align every TODO with the
 * Elm specification you receive with the contract:
 *   - WASL_API_BASE_URL, WASL_PATH_<OPERATION> (paths below are placeholders)
 *   - auth headers (WASL_APP_ID / WASL_APP_KEY / WASL_CLIENT_ID → header names)
 *   - how eligibility and the reference number appear in responses
 *
 * Safety rule: only an explicit "not eligible" answer is treated as a rejection.
 * Every other failure (HTTP error, timeout, unexpected body) is *technical*: it is
 * retried with backoff and never takes an eligible captain off the road.
 */
import type { FetchLike, WaslOperation, WaslProvider, WaslResult } from './provider.ts'

export type WaslHttpConfig = {
  baseUrl: string
  appId: string
  appKey: string
  clientId?: string
  /** TODO(contract): confirm the exact paths. */
  paths?: Partial<Record<WaslOperation, string>>
  /** TODO(contract): confirm header names. */
  headerNames?: { appId: string; appKey: string; clientId: string }
  timeoutMs?: number
}

export const DEFAULT_WASL_PATHS: Record<WaslOperation, string> = {
  driver_registration: '/drivers',
  vehicle_registration: '/vehicles',
  eligibility_check: '/drivers/eligibility',
  trip_registration: '/trips',
  trip_update: '/trips/update',
}

type Body = {
  success?: boolean
  eligible?: boolean
  referenceNumber?: string
  id?: string
  resultMsg?: string
  message?: string
  result?: { eligibility?: boolean; eligible?: boolean; referenceNumber?: string }
}

/** Interpret a Wasl response body (TODO(contract): map the official fields). */
export function interpretWaslBody(status: number, body: Body | null): WaslResult {
  const b = body ?? {}
  const eligible = b.result?.eligibility ?? b.result?.eligible ?? b.eligible
  const reference = b.result?.referenceNumber ?? b.referenceNumber ?? b.id
  if (status < 200 || status >= 300) return { success: false, error: `http_${status}${b.resultMsg || b.message ? `: ${b.resultMsg ?? b.message}` : ''}`, response: body }
  if (eligible === false) return { success: false, response: body } // explicit business rejection
  if (b.success === false) return { success: false, error: b.resultMsg ?? b.message ?? 'wasl_unsuccessful', response: body }
  return { success: true, reference: reference ?? undefined, response: body }
}

export class WaslHttpProvider implements WaslProvider {
  readonly name = 'wasl' as const

  constructor(private readonly cfg: WaslHttpConfig, private readonly fetchFn: FetchLike) {
    if (!cfg.baseUrl || !cfg.appId || !cfg.appKey) throw new Error('wasl_not_configured')
  }

  async call(op: WaslOperation, payload: Record<string, unknown>): Promise<WaslResult> {
    const h = this.cfg.headerNames ?? { appId: 'app-id', appKey: 'app-key', clientId: 'client-id' }
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', [h.appId]: this.cfg.appId, [h.appKey]: this.cfg.appKey }
    if (this.cfg.clientId) headers[h.clientId] = this.cfg.clientId
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : undefined
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 15_000) : undefined
    try {
      const res = await this.fetchFn(`${this.cfg.baseUrl.replace(/\/$/, '')}${this.cfg.paths?.[op] ?? DEFAULT_WASL_PATHS[op]}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: ctrl?.signal,
      })
      const body = (await res.json().catch(() => null)) as Body | null
      return interpretWaslBody(res.status, body)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'network_error', response: null }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
