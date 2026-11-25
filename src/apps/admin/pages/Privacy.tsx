import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Badge, Button, Field, Input, useToast } from '../../../ds/ui'
import { useI18n } from '../../../i18n/I18n'
import { AUTH_MODE } from '../../../auth/config'
import { REQUEST_STATUS_LABEL, REQUEST_TYPE_LABEL, type PrivacyRequest } from '../../../privacy/consents'
import { PrivacyError, privacy } from '../../../privacy/privacyService'
import { DataTable, Drawer, FilterChips, KV, PageHeader, Panel, type Col } from '../kit'
import { useAdmin } from '../kit'

type Filter = 'open' | 'overdue' | 'all'

/** PDPL data-subject requests queue (permission privacy.manage). */
export function PrivacyPage() {
  const { t, L, lang } = useI18n()
  const toast = useToast()
  const { can } = useAdmin()
  const [rows, setRows] = useState<PrivacyRequest[]>([])
  const [filter, setFilter] = useState<Filter>('open')
  const [sel, setSel] = useState<PrivacyRequest | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const now = Date.now()

  const load = useCallback(async () => {
    try {
      setRows(await privacy.listAllRequests())
    } catch {
      toast(t('تعذّر تحميل الطلبات', 'Could not load requests'), 'error')
    }
  }, [toast, t])
  useEffect(() => {
    void load()
    const on = () => void load()
    window.addEventListener('focus', on)
    return () => window.removeEventListener('focus', on)
  }, [load])

  const isOpen = (r: PrivacyRequest) => r.status === 'pending' || r.status === 'in_progress'
  const shown = useMemo(
    () => rows.filter((r) => (filter === 'all' ? true : filter === 'open' ? isOpen(r) : isOpen(r) && r.dueAt < now)),
    [rows, filter, now],
  )
  const fmt = (ms?: number) => (ms ? new Date(ms).toLocaleDateString(lang === 'ar' ? 'ar-SA' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
  const tone = (s: PrivacyRequest['status']) => (s === 'completed' ? 'done' : s === 'rejected' ? 'danger' : s === 'cancelled' ? 'outline' : s === 'in_progress' ? 'live' : 'pending')

  const act = async (status: 'in_progress' | 'completed' | 'rejected') => {
    if (!sel) return
    setBusy(true)
    try {
      await privacy.updateRequest(sel.id, status, note.trim() || undefined)
      toast(t('تم تحديث الطلب', 'Request updated'), 'success')
      setSel(null)
      setNote('')
      await load()
    } catch (e) {
      const m = e instanceof PrivacyError ? e.message : ''
      toast(
        /wallet/.test(m)
          ? t('لا يمكن الحذف قبل تسوية رصيد المحفظة', 'Settle the wallet balance before erasure')
          : /active ride/.test(m)
            ? t('للحساب رحلة جارية', 'Account has an active ride')
            : /reason/.test(m)
              ? t('اكتب سبب الرفض', 'Enter a rejection reason')
              : t('تعذّر التحديث', 'Update failed'),
        'error',
      )
    } finally {
      setBusy(false)
    }
  }

  const cols: Col<PrivacyRequest>[] = [
    { key: 'n', header: '#', cell: (r) => <span className="num">{r.number}</span>, sort: (r) => r.number, csv: (r) => r.number },
    { key: 'type', header: t('النوع', 'Type'), cell: (r) => L(REQUEST_TYPE_LABEL[r.type]), csv: (r) => r.type },
    { key: 'user', header: t('صاحب البيانات', 'Data subject'), cell: (r) => <span className="num text-mute" dir="ltr">{r.userId.slice(0, 8)}…</span>, csv: (r) => r.userId },
    { key: 'created', header: t('التاريخ', 'Submitted'), cell: (r) => fmt(r.createdAt), sort: (r) => r.createdAt, csv: (r) => new Date(r.createdAt).toISOString() },
    {
      key: 'due',
      header: t('الموعد النظامي', 'Due'),
      cell: (r) => <span className={isOpen(r) && r.dueAt < now ? 'font-semibold text-danger' : ''}>{isOpen(r) ? fmt(r.dueAt) : '—'}</span>,
      sort: (r) => r.dueAt,
      csv: (r) => new Date(r.dueAt).toISOString(),
    },
    { key: 'status', header: t('الحالة', 'Status'), cell: (r) => <Badge tone={tone(r.status)}>{L(REQUEST_STATUS_LABEL[r.status])}</Badge>, csv: (r) => r.status },
  ]

  return (
    <div>
      <PageHeader
        title={t('طلبات الخصوصية', 'Privacy requests')}
        sub={t('طلبات أصحاب البيانات بموجب نظام حماية البيانات الشخصية، مع مهلة الرد ٣٠ يوماً', 'Data-subject requests under the PDPL, with the 30-day response deadline')}
        actions={
          <Button variant="secondary" size="sm" icon={<RefreshCw size={15} />} onClick={() => void load()}>
            {t('تحديث', 'Refresh')}
          </Button>
        }
      />
      <Panel pad={false}>
        <DataTable
          rows={shown}
          cols={cols}
          rowKey={(r) => r.id}
          onRow={(r) => {
            setSel(r)
            setNote('')
          }}
          exportName="aura-privacy-requests"
          initialSort={{ key: 'due', dir: 1 }}
          filters={
            <FilterChips<Filter>
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'open', label: t('مفتوحة', 'Open'), count: rows.filter(isOpen).length },
                { value: 'overdue', label: t('متأخرة', 'Overdue'), count: rows.filter((r) => isOpen(r) && r.dueAt < now).length },
                { value: 'all', label: t('الكل', 'All'), count: rows.length },
              ]}
            />
          }
          empty={{ title: t('لا توجد طلبات', 'No requests'), body: t('تظهر هنا طلبات الحذف والتصحيح والاعتراض من التطبيقات.', 'Deletion, correction and objection requests from the apps appear here.') }}
        />
      </Panel>

      <Drawer
        open={!!sel}
        onClose={() => setSel(null)}
        title={sel ? `#${sel.number} · ${L(REQUEST_TYPE_LABEL[sel.type])}` : ''}
        footer={
          sel && isOpen(sel) && can('privacy.manage') ? (
            <>
              {sel.status === 'pending' && (
                <Button variant="secondary" loading={busy} onClick={() => act('in_progress')}>
                  {t('بدء المعالجة', 'Start')}
                </Button>
              )}
              <Button variant="secondary" loading={busy} onClick={() => act('rejected')}>
                {t('رفض', 'Reject')}
              </Button>
              <Button variant={sel.type === 'deletion' ? 'danger' : 'primary'} loading={busy} onClick={() => act('completed')}>
                {sel.type === 'deletion' ? t('تنفيذ الحذف', 'Erase data') : t('إكمال', 'Complete')}
              </Button>
            </>
          ) : undefined
        }
      >
        {sel && (
          <div className="space-y-1">
            <KV k={t('الحالة', 'Status')} v={<Badge tone={tone(sel.status)}>{L(REQUEST_STATUS_LABEL[sel.status])}</Badge>} />
            <KV k={t('صاحب البيانات', 'Data subject')} v={<span className="num" dir="ltr">{sel.userId}</span>} />
            <KV k={t('التاريخ', 'Submitted')} v={fmt(sel.createdAt)} />
            <KV k={t('الموعد النظامي', 'Due')} v={fmt(sel.dueAt)} />
            {sel.completedAt && <KV k={t('أُغلق', 'Closed')} v={fmt(sel.completedAt)} />}
            {sel.details && <KV k={t('التفاصيل', 'Details')} v={sel.details} />}
            {sel.resolutionNote && <KV k={t('ملاحظة', 'Note')} v={sel.resolutionNote} />}
            {sel.type === 'deletion' && isOpen(sel) && (
              <p className="mt-3 rounded-xl bg-road p-3 text-[12.5px] text-mute">
                {AUTH_MODE === 'supabase'
                  ? t(
                      'التنفيذ يمسح الاسم والجوال والبريد والهوية والآيبان وجهات الطوارئ ويوقف الحساب. تبقى السجلات المالية وسجلات الرحلات النظامية وإثبات الموافقات. حذف الملفات وحساب الدخول تتولاه دالة الخادم.',
                      'Erasure clears name, mobile, email, ID, IBAN and emergency contacts and blocks the account. Financial, regulatory trip records and consent proof are kept. Storage files and the login are removed by the server function.',
                    )
                  : t('نسخة تجريبية: يُسجَّل الطلب مكتملاً وتُمسح الموافقات فقط.', 'Demo build: the request is marked complete and only consents are cleared.')}
              </p>
            )}
            {isOpen(sel) && (
              <Field label={t('ملاحظة للمستخدم (مطلوبة عند الرفض)', 'Note to the user (required to reject)')} className="pt-3">
                <Input value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            )}
          </div>
        )}
      </Drawer>
    </div>
  )
}
