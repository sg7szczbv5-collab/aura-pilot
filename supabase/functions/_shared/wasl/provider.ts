/**
 * TGA "Wasl" (operated by Elm) integration boundary.
 *
 * IMPORTANT: Elm issues the API specification with the operator contract. The
 * HTTP adapter below is deliberately configurable (base URL, paths, auth headers,
 * response fields) and MUST be aligned with that specification before go-live.
 * Nothing here should be read as the official Wasl API.
 */
export type WaslOperation = 'driver_registration' | 'vehicle_registration' | 'eligibility_check' | 'trip_registration' | 'trip_update'

/**
 * success=true                 → accepted / eligible
 * success=false, error unset   → business rejection (ineligible): no automatic retry
 * success=false, error set     → technical failure: retried with backoff, never downgrades an eligible captain
 */
export type WaslResult = { success: boolean; reference?: string; error?: string; response: unknown }

export interface WaslProvider {
  readonly name: 'wasl' | 'mock'
  call(op: WaslOperation, payload: Record<string, unknown>): Promise<WaslResult>
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>
