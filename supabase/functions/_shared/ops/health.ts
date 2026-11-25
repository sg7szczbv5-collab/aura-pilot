/**
 * Uptime/health response built from public.ops_readiness().
 * Public callers get status only; with the health secret, the failing checks too.
 */
export type ReadinessCheck = { id: string; area: string; severity: 'blocker' | 'warning'; ok: boolean; detail: string }
export type Readiness = {
  ok: boolean
  generated_at: string
  summary: { blockers_failed: number; warnings: number; passed: number; total: number }
  checks: ReadinessCheck[]
}

export function healthResponse(r: Readiness | null, opts: { detailed: boolean; version?: string; now?: Date }): { status: number; body: Record<string, unknown> } {
  const base = { service: 'aura', version: opts.version ?? 'unknown', checked_at: (opts.now ?? new Date()).toISOString() }
  if (!r) return { status: 503, body: { ...base, status: 'down', error: 'database_unreachable' } }
  const failing = r.checks.filter((c) => !c.ok)
  const body: Record<string, unknown> = {
    ...base,
    status: r.ok ? (r.summary.warnings > 0 ? 'ok_with_warnings' : 'ok') : 'degraded',
    blockers_failed: r.summary.blockers_failed,
    warnings: r.summary.warnings,
  }
  if (opts.detailed) {
    body.failing = failing.map((c) => ({ id: c.id, area: c.area, severity: c.severity, detail: c.detail }))
  }
  return { status: r.ok ? 200 : 503, body }
}
