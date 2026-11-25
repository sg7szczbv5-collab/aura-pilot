/**
 * After a PDPL erasure (private.erase_user) the database is clean, but files in
 * Storage and the login itself remain. This removes the person's files from every
 * user bucket and disables the login (ban; the auth row stays because financial
 * and regulatory records reference the anonymised profile).
 */
export const USER_BUCKETS = ['driver-documents', 'avatars'] as const

export type CleanupDeps = {
  queue(): Promise<{ request_id: string; user_id: string }[]>
  listFiles(bucket: string, prefix: string): Promise<string[]>
  removeFiles(bucket: string, paths: string[]): Promise<number>
  disableLogin(userId: string): Promise<boolean>
  complete(requestId: string, filesRemoved: number, loginDisabled: boolean): Promise<void>
}

/** Minimal shape of the supabase-js admin client used here (keeps this file SDK-free). */
export type StorageAdminLike = {
  // deno-lint-ignore no-explicit-any
  rpc(fn: string, args?: Record<string, unknown>): any
  storage: {
    from(bucket: string): {
      list(prefix: string, opts?: { limit?: number }): Promise<{ data: { name: string }[] | null; error: { message: string } | null }>
      remove(paths: string[]): Promise<{ data: unknown[] | null; error: { message: string } | null }>
    }
  }
  auth: { admin: { updateUserById(id: string, attrs: Record<string, unknown>): Promise<{ error: { message: string } | null }> } }
}

/** Production wiring (privacy-worker/index.ts and the e2e test). */
export function createCleanupDeps(admin: StorageAdminLike): CleanupDeps {
  return {
    queue: async () => {
      const { data, error } = await admin.rpc('privacy_cleanup_queue', { p_limit: 50 })
      if (error) throw new Error(error.message)
      return (data ?? []) as { request_id: string; user_id: string }[]
    },
    listFiles: async (bucket, prefix) => {
      const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000 })
      if (error) return []
      return (data ?? []).map((f) => f.name)
    },
    removeFiles: async (bucket, paths) => {
      const { data, error } = await admin.storage.from(bucket).remove(paths)
      if (error) throw new Error(error.message)
      return data?.length ?? 0
    },
    disableLogin: async (userId) => {
      const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: '876000h', user_metadata: {} })
      return !error
    },
    complete: async (requestId, files, loginDisabled) => {
      const { error } = await admin.rpc('complete_privacy_cleanup', { p_request_id: requestId, p_files_removed: files, p_login_disabled: loginDisabled })
      if (error) throw new Error(error.message)
    },
  }
}

export async function runPrivacyCleanup(d: CleanupDeps) {
  const items = await d.queue()
  const results: { requestId: string; files: number; loginDisabled: boolean; ok: boolean; error?: string }[] = []
  for (const it of items) {
    try {
      let files = 0
      for (const bucket of USER_BUCKETS) {
        const names = await d.listFiles(bucket, it.user_id)
        // Only ever touch this person's own folder.
        const paths = names.map((n) => `${it.user_id}/${n}`).filter((p) => p.startsWith(`${it.user_id}/`) && !p.includes('..'))
        if (paths.length) files += await d.removeFiles(bucket, paths)
      }
      const loginDisabled = await d.disableLogin(it.user_id)
      await d.complete(it.request_id, files, loginDisabled)
      results.push({ requestId: it.request_id, files, loginDisabled, ok: true })
    } catch (e) {
      results.push({ requestId: it.request_id, files: 0, loginDisabled: false, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { processed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results }
}
