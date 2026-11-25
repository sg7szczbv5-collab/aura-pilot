/** Wasl worker persistence over a service-role client (shared by wasl-worker and the e2e test). */
import type { SupabaseLike } from '../payments/db.ts'
import type { WaslQueueItem, WaslRecord } from './worker.ts'

export function createWaslDb(admin: SupabaseLike) {
  return {
    async queue(limit = 50): Promise<WaslQueueItem[]> {
      const { data, error } = await admin.rpc('wasl_work_queue', { p_limit: limit })
      if (error) throw new Error(error.message)
      return (data ?? []) as WaslQueueItem[]
    },
    async record(r: WaslRecord): Promise<void> {
      const { error } = await admin.rpc('record_wasl_result', {
        p_entity: r.entity,
        p_entity_id: r.entityId,
        p_operation: r.operation,
        p_provider: r.provider,
        p_success: r.success,
        p_reference: r.reference ?? null,
        p_request: r.request ?? null,
        p_response: r.response ?? null,
        p_error: r.error ?? null,
      })
      if (error) throw new Error(error.message)
    },
  }
}
