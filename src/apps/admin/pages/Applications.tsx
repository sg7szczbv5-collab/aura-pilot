import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { Badge, Button, useToast } from '../../../ds/ui'
import { useI18n } from '../../../i18n/I18n'
import { getSupabase } from '../../../auth/supabaseClient'
import { DataTable, Drawer, FilterChips, KV, PageHeader, Panel, useAdmin, type Col } from '../kit'
import { RejectionReasonDropdown } from '../components/RejectionReasonDropdown'

type Status = 'incomplete' | 'pending_review' | 'approved' | 'rejected' | 'suspended'
type Row = {
  id: string
  status: Status
  wasl_status: string
  wasl_reference: string | null
  submitted_at: string | null
  national_id: string | null
  iban: string | null
  date_of_birth: string | null
  status_reason: string | null
  current_vehicle_id: string | null
  profile: { full_name: string | null; phone: string | null } | null
}
type Doc = { id: string; doc_type: string; status: string; storage_path: string; expires_at: string | null; rejection_reason: string | null; reviewed_at: string | null; vehicle_id: string | null }
const DOC_COLS = 'id, doc_type, status, storage_path, expires_at, rejection_reason, reviewed_at, vehicle_id'
type Vehicle = { id: string; make: string; model: string; year: number; color: string; plate_letters: string; plate_number: string; sequence_number: string; vehicle_class: string; status: string; status_reason: string | null; wasl_status: string }
type WaslLog = { id: string; operation: string; status: string; attempt: number; error_message: string | null; created_at: string; next_retry_at: string | null }

const mask = (s: string | null, keep = 4) => (s ? `${'•'.repeat(Math.max(0, s.length - keep))}${s.slice(-keep)}` : '—')
const tone = (s: string) => (s === 'approved' || s === 'eligible' ? 'done' : s === 'rejected' || s === 'ineligible' || s === 'suspended' || s === 'expired' ? 'danger' : s === 'pending_review' || s === 'uploaded' || s === 'pending' ? 'pending' : 'neutral')

/** Supabase mode: review captain applications, documents (signed URLs), vehicle and Wasl status. */
export function ApplicationsPage() {
  const { t } = useI18n()
  const toast = useToast()
  const { can } = useAdmin()
  const [filter, setFilter] = useState<'pending_review' | 'approved' | 'suspended' | 'all'>('pending_review')
  const [rows, setRows] = useState<Row[]>([])
  const [sel, setSel] = useState<Row | null>(null)
  const [docs, setDocs] = useState<Doc[]>([])
  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [wasl, setWasl] = useState<WaslLog[]>([])
  const [reason, setReason] = useState('')
  /** Vehicle rejection reason (own dropdown in the vehicle section → vehicles.status_reason). */
  const [vehicleReason, setVehicleReason] = useState('')
  const [busy, setBusy] = useState(false)
  /** Document currently being rejected (disables its button) and the last per-document error. */
  const [rejectingDoc, setRejectingDoc] = useState<string | null>(null)
  const [docError, setDocError] = useState<{ id: string; message: string } | null>(null)
  const sb = getSupabase()

  const load = useCallback(async () => {
    let q = sb
      .from('drivers')
      .select('id, status, wasl_status, wasl_reference, submitted_at, national_id, iban, date_of_birth, status_reason, current_vehicle_id, profile:profiles!drivers_id_fkey(full_name, phone)')
      .order('submitted_at', { ascending: true, nullsFirst: false })
      .limit(200)
    if (filter !== 'all') q = q.eq('status', filter)
    const { data, error } = await q
    if (error) toast(t('تعذّر التحميل', 'Could not load'), 'error')
    setRows((data ?? []) as unknown as Row[])
  }, [sb, filter, toast, t])
  useEffect(() => {
    void load()
  }, [load])

  const open = async (r: Row) => {
    setSel(r)
    setReason('')
    setVehicleReason('')
    setDocError(null)
    const [d, v, w] = await Promise.all([
      sb.from('driver_documents').select(DOC_COLS).eq('driver_id', r.id).order('created_at'),
      r.current_vehicle_id ? sb.from('vehicles').select('*').eq('id', r.current_vehicle_id).maybeSingle() : Promise.resolve({ data: null }),
      sb.from('wasl_sync_log').select('id, operation, status, attempt, error_message, created_at, next_retry_at').in('entity_id', [r.id, r.current_vehicle_id].filter(Boolean)).order('created_at', { ascending: false }).limit(10),
    ])
    setDocs((d.data ?? []) as Doc[])
    setVehicle((v.data ?? null) as Vehicle | null)
    setWasl((w.data ?? []) as WaslLog[])
  }

  const view = async (doc: Doc) => {
    const { data, error } = await sb.storage.from('driver-documents').createSignedUrl(doc.storage_path, 300)
    if (error || !data) return toast(t('تعذّر فتح الملف', 'Could not open the file'), 'error')
    window.open(data.signedUrl, '_blank', 'noopener')
  }

  const run = async (fn: string, args: Record<string, unknown>, ok: string) => {
    setBusy(true)
    const { error } = await sb.rpc(fn, args)
    setBusy(false)
    if (error) return toast(error.message.replace(/^AURA:\s*/, ''), 'error')
    toast(ok, 'success')
    if (sel) await open(sel)
    await load()
  }

  /**
   * Reject one document by writing straight to driver_documents (allowed for staff with
   * drivers.edit by migration 20261201000100). Only rows still 'uploaded' are matched, so a
   * document someone else already reviewed is not overwritten.
   */
  const rejectDocument = async (doc: Doc) => {
    const rejection_reason = reason.trim()
    if (!rejection_reason || rejectingDoc) return
    setRejectingDoc(doc.id)
    setDocError(null)
    try {
      const { data: auth } = await sb.auth.getSession()
      const now = new Date().toISOString()
      const { data, error } = await sb
        .from('driver_documents')
        .update({ status: 'rejected', rejection_reason, reviewed_at: now, updated_at: now, reviewed_by: auth.session?.user.id ?? null })
        .eq('id', doc.id)
        .eq('status', 'uploaded')
        .select(DOC_COLS)
        .maybeSingle()
      if (error) throw new Error(error.message.replace(/^AURA:\s*/, ''))
      if (!data) throw new Error(t('لم تعد الوثيقة بانتظار المراجعة أو لا تملك صلاحية تعديلها.', 'The document is no longer awaiting review, or you are not allowed to change it.'))
      setDocs((prev) => prev.map((d) => (d.id === doc.id ? (data as Doc) : d)))
      toast(t('تم رفض الوثيقة', 'Document rejected'), 'success')
      void load()
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : t('حدث خطأ غير متوقع', 'Unexpected error')
      setDocError({ id: doc.id, message })
      toast(t('تعذّر رفض الوثيقة: ', 'Could not reject the document: ') + message, 'error')
    } finally {
      setRejectingDoc(null)
    }
  }

  const noReason = reason.trim().length === 0

  const cols: Col<Row>[] = [
    { key: 'name', header: t('الكابتن', 'Captain'), cell: (r) => r.profile?.full_name ?? '—', csv: (r) => r.profile?.full_name ?? '' },
    { key: 'phone', header: t('الجوال', 'Mobile'), cell: (r) => <span className="num" dir="ltr">{r.profile?.phone ?? '—'}</span> },
    { key: 'status', header: t('الحالة', 'Status'), cell: (r) => <Badge tone={tone(r.status)}>{r.status}</Badge>, csv: (r) => r.status },
    { key: 'wasl', header: t('وصل', 'Wasl'), cell: (r) => <Badge tone={tone(r.wasl_status)}>{r.wasl_status}</Badge>, csv: (r) => r.wasl_status },
    { key: 'submitted', header: t('تاريخ التقديم', 'Submitted'), cell: (r) => (r.submitted_at ? new Date(r.submitted_at).toLocaleString() : '—'), sort: (r) => r.submitted_at ?? '' },
  ]

  return (
    <div>
      <PageHeader
        title={t('طلبات الكباتن (الخادم)', 'Captain applications (server)')}
        sub={t('مراجعة الوثائق والمركبة وحالة الأهلية لدى وصل قبل الاعتماد.', 'Review documents, vehicle and Wasl eligibility before approval.')}
        actions={
          <Button variant="secondary" size="sm" icon={<RefreshCw size={15} />} onClick={() => void load()}>
            {t('تحديث', 'Refresh')}
          </Button>
        }
      />
      <Panel pad={false}>
        <DataTable
          rows={rows}
          cols={cols}
          rowKey={(r) => r.id}
          onRow={(r) => void open(r)}
          filters={
            <FilterChips
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'pending_review', label: t('قيد المراجعة', 'Pending review') },
                { value: 'approved', label: t('معتمدون', 'Approved') },
                { value: 'suspended', label: t('موقوفون', 'Suspended') },
                { value: 'all', label: t('الكل', 'All') },
              ]}
            />
          }
          empty={{ title: t('لا توجد طلبات', 'No applications') }}
        />
      </Panel>

      <Drawer
        open={!!sel}
        onClose={() => setSel(null)}
        title={sel?.profile?.full_name ?? t('كابتن', 'Captain')}
        width={620}
        footer={
          sel && can('drivers.approve') ? (
            <>
              <Button variant="secondary" loading={busy} disabled={busy || noReason} title={noReason ? t('اختر سبب الرفض أولاً', 'Select a reason first') : undefined} onClick={() => void run('admin_set_driver_status', { p_driver_id: sel.id, p_status: 'rejected', p_reason: reason }, t('تم الرفض', 'Rejected'))}>
                {t('رفض الطلب', 'Reject')}
              </Button>
              {sel.status === 'approved' && can('drivers.suspend') && (
                <Button variant="danger" loading={busy} disabled={busy || noReason} title={noReason ? t('اختر سبب الإيقاف أولاً', 'Select a reason first') : undefined} onClick={() => void run('admin_set_driver_status', { p_driver_id: sel.id, p_status: 'suspended', p_reason: reason }, t('تم الإيقاف', 'Suspended'))}>
                  {t('إيقاف', 'Suspend')}
                </Button>
              )}
              <Button loading={busy} onClick={() => void run('admin_set_driver_status', { p_driver_id: sel.id, p_status: 'approved', p_reason: null }, t('تم الاعتماد', 'Approved'))}>
                {t('اعتماد الكابتن', 'Approve captain')}
              </Button>
            </>
          ) : undefined
        }
      >
        {sel && (
          <div className="space-y-4">
            <div>
              <KV k={t('الحالة', 'Status')} v={<Badge tone={tone(sel.status)}>{sel.status}</Badge>} />
              <KV k={t('الهوية / الإقامة', 'ID / Iqama')} v={<span className="num">{can('drivers.edit') ? sel.national_id : mask(sel.national_id)}</span>} />
              <KV k={t('تاريخ الميلاد', 'Date of birth')} v={sel.date_of_birth ?? '—'} />
              <KV k="IBAN" v={<span className="num">{mask(sel.iban, 6)}</span>} />
              <KV k={t('وصل', 'Wasl')} v={<span>{sel.wasl_status}{sel.wasl_reference ? ` · ${sel.wasl_reference}` : ''}</span>} />
              {sel.status_reason && <KV k={t('ملاحظة', 'Note')} v={sel.status_reason} />}
            </div>

            <div>
              <p className="mb-1.5 text-[13px] font-semibold">{t('الوثائق', 'Documents')}</p>
              <div className="divide-y divide-line rounded-2xl ring-1 ring-line">
                {docs.map((d) => (
                  <div key={d.id} className="px-3 py-2.5 text-[13px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-[150px] flex-1 font-medium">{d.doc_type}</span>
                      <span className="num text-xs text-mute">{d.expires_at ?? '—'}</span>
                      <Badge tone={tone(d.status)}>{d.status}</Badge>
                      <button className="text-mute" aria-label={t('عرض', 'View')} onClick={() => void view(d)}>
                        <ExternalLink size={15} />
                      </button>
                      {d.status === 'uploaded' && can('drivers.edit') && (
                        <span className="flex gap-1">
                          <Button size="sm" variant="secondary" onClick={() => void run('admin_review_document', { p_document_id: d.id, p_approve: true }, t('تم اعتماد الوثيقة', 'Document approved'))}>
                            {t('اعتماد', 'Approve')}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={rejectingDoc === d.id}
                            disabled={noReason || rejectingDoc !== null || busy}
                            title={noReason ? t('اختر سبب الرفض من القائمة أدناه أولاً', 'Select a rejection reason below first') : undefined}
                            onClick={() => void rejectDocument(d)}
                          >
                            {t('رفض', 'Reject')}
                          </Button>
                        </span>
                      )}
                    </div>
                    {d.status === 'rejected' && d.rejection_reason && (
                      <p className="mt-1 text-[12px] text-mute">
                        {t('سبب الرفض: ', 'Reason: ')}
                        {d.rejection_reason}
                        {d.reviewed_at ? <span className="num"> · {new Date(d.reviewed_at).toLocaleString()}</span> : null}
                      </p>
                    )}
                    {docError?.id === d.id && (
                      <p role="alert" className="mt-1 text-[12px] text-danger">
                        {docError.message}
                      </p>
                    )}
                  </div>
                ))}
                {docs.length === 0 && <p className="px-3 py-3 text-sm text-mute">{t('لا توجد وثائق', 'No documents')}</p>}
              </div>
            </div>

            {vehicle && (
              <div>
                <p className="mb-1.5 text-[13px] font-semibold">{t('المركبة', 'Vehicle')}</p>
                <KV k={t('المركبة', 'Vehicle')} v={`${vehicle.make} ${vehicle.model} ${vehicle.year} · ${vehicle.color} · ${vehicle.vehicle_class}`} />
                <KV k={t('اللوحة', 'Plate')} v={<span className="num">{vehicle.plate_letters} {vehicle.plate_number}</span>} />
                <KV k={t('الرقم التسلسلي', 'Sequence no.')} v={<span className="num">{vehicle.sequence_number}</span>} />
                <KV k={t('الحالة / وصل', 'Status / Wasl')} v={`${vehicle.status} · ${vehicle.wasl_status}`} />
                {vehicle.status === 'rejected' && <KV k={t('سبب رفض المركبة', 'Vehicle rejection reason')} v={vehicle.status_reason ?? '—'} />}
                {vehicle.status === 'pending_review' && can('vehicles.edit') && (
                  <div className="mt-2 space-y-2">
                    {/* Saved by admin_review_vehicle into vehicles.status_reason (shown to the captain). */}
                    <RejectionReasonDropdown key={vehicle.id} label={t('سبب رفض المركبة', 'Vehicle rejection reason')} onChange={setVehicleReason} disabled={busy} />
                    <div className="flex gap-2">
                      <Button size="sm" disabled={busy} onClick={() => void run('admin_review_vehicle', { p_vehicle_id: vehicle.id, p_approve: true }, t('تم اعتماد المركبة', 'Vehicle approved'))}>
                        {t('اعتماد المركبة', 'Approve vehicle')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busy}
                        disabled={busy || !vehicleReason.trim()}
                        title={!vehicleReason.trim() ? t('اختر سبب رفض المركبة أولاً', 'Select a vehicle rejection reason first') : undefined}
                        onClick={() => void run('admin_review_vehicle', { p_vehicle_id: vehicle.id, p_approve: false, p_reason: vehicleReason.trim() }, t('تم رفض المركبة', 'Vehicle rejected'))}
                      >
                        {t('رفض المركبة', 'Reject vehicle')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div>
              <p className="mb-1.5 text-[13px] font-semibold">{t('سجل وصل', 'Wasl log')}</p>
              {wasl.map((w) => (
                <p key={w.id} className="text-[12px] text-mute">
                  <span className="num">{new Date(w.created_at).toLocaleString()}</span> · {w.operation} · {w.status} · #{w.attempt}
                  {w.error_message ? ` · ${w.error_message}` : ''}
                  {w.next_retry_at ? ` · ${t('إعادة المحاولة', 'retry')} ${new Date(w.next_retry_at).toLocaleTimeString()}` : ''}
                </p>
              ))}
              {wasl.length === 0 && <p className="text-[12px] text-mute">{t('لم يُرسل إلى وصل بعد', 'Not sent to Wasl yet')}</p>}
            </div>

            <RejectionReasonDropdown key={sel.id} label={t('سبب رفض الوثيقة / الطلب / الإيقاف', 'Reason (document / application / suspension)')} onChange={setReason} disabled={busy || rejectingDoc !== null} />
          </div>
        )}
      </Drawer>
    </div>
  )
}
