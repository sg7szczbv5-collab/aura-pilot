/**
 * Wasl worker: drains public.wasl_work_queue() through a provider and records
 * every attempt with public.record_wasl_result (which owns retry/backoff and the
 * effects on captains, vehicles and rides).
 */
import { MockWasl } from './mock.ts'
import { DEFAULT_WASL_PATHS, WaslHttpProvider } from './http.ts'
import type { FetchLike, WaslOperation, WaslProvider } from './provider.ts'

export type WaslQueueItem = { entity_type: 'driver' | 'vehicle' | 'ride'; entity_id: string; operation: WaslOperation; attempt: number; payload: Record<string, unknown> }
export type WaslRecord = {
  entity: WaslQueueItem['entity_type']
  entityId: string
  operation: WaslOperation
  provider: 'wasl' | 'mock'
  success: boolean
  reference?: string
  request: unknown
  response: unknown
  error?: string
}

export async function runWaslWorker(d: { queue(): Promise<WaslQueueItem[]>; provider: WaslProvider; record(r: WaslRecord): Promise<void> }) {
  const items = await d.queue()
  const out = { processed: 0, accepted: 0, rejected: 0, errors: 0 }
  for (const it of items) {
    let r
    try {
      r = await d.provider.call(it.operation, it.payload)
    } catch (e) {
      r = { success: false, error: e instanceof Error ? e.message : 'provider_error', response: null }
    }
    try {
      await d.record({ entity: it.entity_type, entityId: it.entity_id, operation: it.operation, provider: d.provider.name, success: r.success, reference: r.reference, request: it.payload, response: r.response, error: r.error })
      out.processed++
      if (r.success) out.accepted++
      else if (r.error) out.errors++
      else out.rejected++
    } catch {
      out.errors++
    }
  }
  return out
}

/** WASL_MODE=mock | live */
export function getWaslProvider(env: (k: string) => string | undefined, fetchFn: FetchLike): WaslProvider {
  if ((env('WASL_MODE') ?? 'mock') !== 'live') return new MockWasl()
  const paths = Object.fromEntries(
    (Object.keys(DEFAULT_WASL_PATHS) as WaslOperation[]).map((op) => [op, env(`WASL_PATH_${op.toUpperCase()}`) ?? DEFAULT_WASL_PATHS[op]]),
  ) as Record<WaslOperation, string>
  return new WaslHttpProvider(
    { baseUrl: env('WASL_API_BASE_URL') ?? '', appId: env('WASL_APP_ID') ?? '', appKey: env('WASL_APP_KEY') ?? '', clientId: env('WASL_CLIENT_ID') || undefined, paths },
    fetchFn,
  )
}
