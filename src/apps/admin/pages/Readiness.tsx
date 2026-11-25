import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw } from 'lucide-react'
import { Badge, Button, Spinner, useToast } from '../../../ds/ui'
import { useI18n } from '../../../i18n/I18n'
import { getSupabase } from '../../../auth/supabaseClient'
import { PageHeader, Panel } from '../kit'
import type { Readiness } from '../../../../supabase/functions/_shared/ops/health'

const AREA: Record<string, { ar: string; en: string }> = {
  security: { ar: 'الأمان', en: 'Security' },
  config: { ar: 'الإعدادات', en: 'Configuration' },
  operations: { ar: 'التشغيل', en: 'Operations' },
  payments: { ar: 'المدفوعات', en: 'Payments' },
  wasl: { ar: 'وصل / الهيئة', en: 'Wasl / TGA' },
  pdpl: { ar: 'حماية البيانات', en: 'Data protection (PDPL)' },
  safety: { ar: 'السلامة', en: 'Safety' },
}

/** Supabase mode: live production readiness (public.ops_readiness). */
export function ReadinessPage() {
  const { t, L } = useI18n()
  const toast = useToast()
  const [r, setR] = useState<Readiness | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    const { data, error } = await getSupabase().rpc('ops_readiness')
    setBusy(false)
    if (error) return toast(error.message.replace(/^AURA:\s*/, ''), 'error')
    setR(data as Readiness)
  }, [toast])
  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 60_000)
    return () => window.clearInterval(id)
  }, [load])

  const areas = r ? [...new Set(r.checks.map((c) => c.area))] : []
  return (
    <div>
      <PageHeader
        title={t('جاهزية النظام', 'System readiness')}
        sub={t('فحوصات مباشرة لقاعدة البيانات: الأمان، المدفوعات، وصل، حماية البيانات، السلامة.', 'Live database checks: security, payments, Wasl, PDPL and safety.')}
        actions={
          <Button variant="secondary" size="sm" icon={<RefreshCw size={15} />} loading={busy} onClick={() => void load()}>
            {t('تحديث', 'Refresh')}
          </Button>
        }
      />
      {!r ? (
        <div className="flex justify-center py-16">
          <Spinner size={26} />
        </div>
      ) : (
        <>
          <Panel>
            <div className="flex flex-wrap items-center gap-3">
              {r.ok ? <CheckCircle2 className="text-go-deep" size={28} /> : <XCircle className="text-danger" size={28} />}
              <div className="flex-1">
                <p className="font-display text-lg font-semibold">{r.ok ? t('جاهز للتشغيل', 'Ready for production') : t('غير جاهز', 'Not ready')}</p>
                <p className="text-sm text-mute">
                  {t(`${r.summary.blockers_failed} عائق، ${r.summary.warnings} تحذير، ${r.summary.passed}/${r.summary.total} ناجح`, `${r.summary.blockers_failed} blocker(s), ${r.summary.warnings} warning(s), ${r.summary.passed}/${r.summary.total} passed`)}
                </p>
              </div>
              <span className="num text-xs text-mute">{new Date(r.generated_at).toLocaleString()}</span>
            </div>
          </Panel>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {areas.map((a) => (
              <Panel key={a} title={AREA[a] ? L(AREA[a]) : a}>
                <div className="divide-y divide-line">
                  {r.checks
                    .filter((c) => c.area === a)
                    .sort((x, y) => Number(x.ok) - Number(y.ok) || (x.severity === 'blocker' ? -1 : 1))
                    .map((c) => (
                      <div key={c.id} className="flex items-start gap-2.5 py-2.5">
                        {c.ok ? <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-go-deep" /> : c.severity === 'blocker' ? <XCircle size={17} className="mt-0.5 shrink-0 text-danger" /> : <AlertTriangle size={17} className="mt-0.5 shrink-0 text-warn" />}
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-semibold">
                            <span className="num">{c.id}</span>
                          </p>
                          <p className="text-[12.5px] text-mute">{c.detail}</p>
                        </div>
                        {!c.ok && <Badge tone={c.severity === 'blocker' ? 'danger' : 'warn'}>{c.severity === 'blocker' ? t('عائق', 'Blocker') : t('تحذير', 'Warning')}</Badge>}
                      </div>
                    ))}
                </div>
              </Panel>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
