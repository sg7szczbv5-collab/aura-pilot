/**
 * Admin console pages for Supabase (live) mode: real data from the database, real
 * actions through the audited RPCs. Used instead of the demo-store pages when
 * AUTH_MODE === 'supabase' (see AdminApp). Data access lives in adminApi.ts.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { Badge, Button, EmptyState, ErrorState, Field, Input, Select, TripStatusBadge, useToast } from '../../../ds/ui'
import { useI18n } from '../../../i18n/I18n'
import type { TripStatus } from '../../../core/types'
import { CityMap, type MapMarker } from '../../../map/CityMap'
import { DataTable, Drawer, FilterChips, KV, Kpi, PageHeader, Panel, useAdmin, type Col } from '../kit'
import { RejectionReasonDropdown } from '../components/RejectionReasonDropdown'
import * as api from './adminApi'

/** Load on mount and on demand; keeps the last error for an ErrorState. */
function useLoad<T>(fn: () => Promise<api.Result<T>>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    const r = await fn()
    setLoading(false)
    if (r.error !== undefined) return setError(r.error)
    setError(null)
    setData(r.data)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    void load()
  }, [load])
  return { data, error, loading, reload: load }
}

const dt = (s?: string | null) => (s ? new Date(s).toLocaleString() : '—')
const name = (p?: api.Person | null) => p?.full_name || p?.phone || '—'

function RefreshButton({ onClick, loading }: { onClick: () => void; loading?: boolean }) {
  const { t } = useI18n()
  return (
    <Button variant="secondary" size="sm" loading={loading} icon={<RefreshCw size={15} />} onClick={onClick}>
      {t('تحديث', 'Refresh')}
    </Button>
  )
}

function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  const { t } = useI18n()
  return <ErrorState title={t('تعذّر تحميل البيانات', 'Could not load the data')} body={error} onRetry={onRetry} />
}

/* ---------------------------------------------------------------- Overview */

export function LiveOverviewPage() {
  const { t } = useI18n()
  const o = useLoad(() => api.loadOverview(), [])
  useEffect(() => {
    const id = window.setInterval(() => void o.reload(), 30_000)
    return () => window.clearInterval(id)
  }, [o.reload])
  const d = o.data
  return (
    <div>
      <PageHeader title={t('الرئيسية', 'Overview')} sub={t('مؤشرات مباشرة من قاعدة البيانات، تتحدث كل ٣٠ ثانية.', 'Live figures from the database, refreshed every 30 s.')} actions={<RefreshButton onClick={() => void o.reload()} loading={o.loading} />} />
      {o.error && !d ? (
        <LoadError error={o.error} onRetry={() => void o.reload()} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi live label={t('رحلات نشطة', 'Active trips')} value={d?.active ?? '—'} />
          <Kpi live label={t('بانتظار كابتن', 'Searching')} value={d?.searching ?? '—'} />
          <Kpi live label={t('كباتن متصلون', 'Captains online')} value={d?.online ?? '—'} />
          <Kpi label={t('رحلات مكتملة اليوم', 'Completed today')} value={d?.completedToday ?? '—'} />
          <Kpi label={t('إجمالي الأجرة اليوم', 'Gross fares today')} value={d ? api.sar(d.grossToday) : '—'} unit="SAR" />
          <Kpi label={t('عمولة أورا اليوم', 'AURA commission today')} value={d ? api.sar(d.commissionToday) : '—'} unit="SAR" />
          <Kpi label={t('طلبات كباتن للمراجعة', 'Applications to review')} value={d?.pendingApplications ?? '—'} />
          <Kpi label={t('تذاكر مفتوحة', 'Open tickets')} value={d?.openTickets ?? '—'} />
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- Trips */

export function LiveTripsPage() {
  const { t } = useI18n()
  const toast = useToast()
  const { can } = useAdmin()
  const [filter, setFilter] = useState<'active' | 'completed' | 'cancelled' | 'all'>('active')
  const r = useLoad(() => api.loadRides(filter), [filter])
  const [sel, setSel] = useState<api.RideRow | null>(null)
  const [events, setEvents] = useState<api.RideEvent[]>([])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const ppl = r.data?.people

  const open = async (x: api.RideRow) => {
    setSel(x)
    setReason('')
    setEvents(await api.loadRideEvents(x.id))
  }
  const cancel = async () => {
    if (!sel || !reason.trim()) return
    setBusy(true)
    const res = await api.cancelRide(sel.id, reason.trim())
    setBusy(false)
    if (res.error !== undefined) return toast(res.error, 'error')
    toast(t('تم إلغاء الرحلة', 'Trip cancelled'), 'success')
    setSel(null)
    void r.reload()
  }

  const cols: Col<api.RideRow>[] = [
    { key: 'n', header: '#', cell: (x) => <span className="num">{x.ride_number}</span>, sort: (x) => x.ride_number, csv: (x) => x.ride_number },
    { key: 'status', header: t('الحالة', 'Status'), cell: (x) => <TripStatusBadge status={x.status as TripStatus} />, csv: (x) => x.status },
    { key: 'rider', header: t('العميل', 'Rider'), cell: (x) => name(ppl?.get(x.rider_id)), csv: (x) => name(ppl?.get(x.rider_id)) },
    { key: 'driver', header: t('الكابتن', 'Captain'), cell: (x) => name(ppl?.get(x.driver_id ?? '')), csv: (x) => name(ppl?.get(x.driver_id ?? '')) },
    { key: 'class', header: t('الفئة', 'Class'), cell: (x) => x.vehicle_class, csv: (x) => x.vehicle_class },
    { key: 'fare', header: t('الأجرة', 'Fare'), cell: (x) => <span className="num">{api.sar(x.fare_total_halalas)}</span>, sort: (x) => x.fare_total_halalas, csv: (x) => api.sar(x.fare_total_halalas) },
    { key: 'at', header: t('الطلب', 'Requested'), cell: (x) => dt(x.requested_at), sort: (x) => x.requested_at, csv: (x) => x.requested_at },
  ]
  const active = sel && api.ACTIVE_STATUSES.includes(sel.status)
  return (
    <div>
      <PageHeader title={t('الرحلات', 'Trips')} sub={t('من قاعدة البيانات مباشرة. الإلغاء الإداري يُسجَّل في سجل الرحلة وسجل التدقيق.', 'Straight from the database. Admin cancellations are recorded in the trip log and audit log.')} actions={<RefreshButton onClick={() => void r.reload()} loading={r.loading} />} />
      {r.error && !r.data ? (
        <LoadError error={r.error} onRetry={() => void r.reload()} />
      ) : (
        <Panel pad={false}>
          <DataTable
            rows={r.data?.rides ?? []}
            cols={cols}
            rowKey={(x) => x.id}
            onRow={(x) => void open(x)}
            exportName="aura-trips"
            search={(x, q) => `${x.ride_number} ${x.pickup_address} ${x.dropoff_address} ${name(ppl?.get(x.rider_id))} ${name(ppl?.get(x.driver_id ?? ''))}`.toLowerCase().includes(q)}
            filters={<FilterChips value={filter} onChange={setFilter} options={[{ value: 'active', label: t('نشطة', 'Active') }, { value: 'completed', label: t('مكتملة', 'Completed') }, { value: 'cancelled', label: t('ملغاة', 'Cancelled') }, { value: 'all', label: t('الكل', 'All') }]} />}
            empty={{ title: t('لا توجد رحلات', 'No trips') }}
          />
        </Panel>
      )}
      <Drawer
        open={!!sel}
        onClose={() => setSel(null)}
        title={sel ? `${t('رحلة', 'Trip')} #${sel.ride_number}` : ''}
        footer={
          active && can('trips.cancel') ? (
            <Button variant="danger" loading={busy} disabled={!reason.trim() || busy} onClick={() => void cancel()}>
              {t('إلغاء الرحلة', 'Cancel trip')}
            </Button>
          ) : undefined
        }
      >
        {sel && (
          <div className="space-y-4">
            <div>
              <KV k={t('الحالة', 'Status')} v={<TripStatusBadge status={sel.status as TripStatus} />} />
              <KV k={t('العميل', 'Rider')} v={name(ppl?.get(sel.rider_id))} />
              <KV k={t('الكابتن', 'Captain')} v={name(ppl?.get(sel.driver_id ?? ''))} />
              <KV k={t('من', 'From')} v={sel.pickup_address} />
              <KV k={t('إلى', 'To')} v={sel.dropoff_address} />
              <KV k={t('الأجرة / العمولة / صافي الكابتن', 'Fare / commission / captain net')} v={<span className="num">{api.sar(sel.fare_total_halalas)} / {api.sar(sel.commission_halalas)} / {api.sar(sel.driver_net_halalas)}</span>} />
              <KV k={t('الدفع', 'Payment')} v={sel.payment_method} />
              {sel.cancellation_reason && <KV k={t('سبب الإلغاء', 'Cancellation reason')} v={`${sel.cancellation_reason} (${sel.cancelled_by ?? '—'})`} />}
            </div>
            <div>
              <p className="mb-1.5 text-[13px] font-semibold">{t('سجل الرحلة', 'Trip log')}</p>
              {events.map((e) => (
                <p key={e.id} className="text-[12px] text-mute">
                  <span className="num">{dt(e.created_at)}</span> · {e.from_status ?? '∅'} → {e.to_status} · {e.actor ?? ''}
                  {e.note ? ` · ${e.note}` : ''}
                </p>
              ))}
              {events.length === 0 && <p className="text-[12px] text-mute">—</p>}
            </div>
            {active && can('trips.cancel') && <RejectionReasonDropdown key={sel.id} label={t('سبب الإلغاء الإداري', 'Admin cancellation reason')} onChange={setReason} disabled={busy} />}
          </div>
        )}
      </Drawer>
    </div>
  )
}

/* ---------------------------------------------------------------- Captains */

const DRIVER_TONE = (s: string) => (s === 'approved' ? 'done' : s === 'suspended' || s === 'rejected' ? 'danger' : 'pending')

export function LiveCaptainsPage() {
  const { t } = useI18n()
  const toast = useToast()
  const { can } = useAdmin()
  const [filter, setFilter] = useState<'approved' | 'online' | 'suspended' | 'all'>('approved')
  const r = useLoad(() => api.loadDrivers(filter), [filter])
  const [sel, setSel] = useState<api.DriverRow | null>(null)
  const [rides, setRides] = useState<api.RideRow[]>([])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const open = async (d: api.DriverRow) => {
    setSel(d)
    setReason('')
    setRides(await api.loadDriverRides(d.id))
  }
  const act = async (status: 'approved' | 'suspended') => {
    if (!sel) return
    setBusy(true)
    const res = await api.setDriverStatus(sel.id, status, status === 'suspended' ? reason.trim() : null)
    setBusy(false)
    if (res.error !== undefined) return toast(res.error, 'error')
    toast(status === 'suspended' ? t('تم إيقاف الكابتن', 'Captain suspended') : t('تم تفعيل الكابتن', 'Captain reactivated'), 'success')
    setSel(null)
    void r.reload()
  }
  const cols: Col<api.DriverRow>[] = [
    { key: 'name', header: t('الكابتن', 'Captain'), cell: (d) => name(d.profile), csv: (d) => name(d.profile) },
    { key: 'phone', header: t('الجوال', 'Mobile'), cell: (d) => <span className="num" dir="ltr">{d.profile?.phone ?? '—'}</span> },
    { key: 'status', header: t('الحالة', 'Status'), cell: (d) => <Badge tone={DRIVER_TONE(d.status)}>{d.status}</Badge>, csv: (d) => d.status },
    { key: 'online', header: t('متصل', 'Online'), cell: (d) => (d.is_online ? <Badge tone="live" dot>{t('متصل', 'Online')}</Badge> : '—'), csv: (d) => String(d.is_online) },
    { key: 'rating', header: t('التقييم', 'Rating'), cell: (d) => <span className="num">{d.rating ?? '—'}</span>, sort: (d) => Number(d.rating ?? 0) },
    { key: 'trips', header: t('الرحلات', 'Trips'), cell: (d) => <span className="num">{d.completed_rides}</span>, sort: (d) => d.completed_rides },
    { key: 'wasl', header: t('وصل', 'Wasl'), cell: (d) => d.wasl_status, csv: (d) => d.wasl_status },
  ]
  return (
    <div>
      <PageHeader title={t('الكباتن', 'Captains')} sub={t('مراجعة الطلبات الجديدة من صفحة «طلبات الكباتن».', 'Review new applications under “Applications”.')} actions={<RefreshButton onClick={() => void r.reload()} loading={r.loading} />} />
      {r.error && !r.data ? (
        <LoadError error={r.error} onRetry={() => void r.reload()} />
      ) : (
        <Panel pad={false}>
          <DataTable
            rows={r.data ?? []}
            cols={cols}
            rowKey={(d) => d.id}
            onRow={(d) => void open(d)}
            exportName="aura-captains"
            search={(d, q) => `${name(d.profile)} ${d.profile?.phone ?? ''}`.toLowerCase().includes(q)}
            filters={<FilterChips value={filter} onChange={setFilter} options={[{ value: 'approved', label: t('معتمدون', 'Approved') }, { value: 'online', label: t('متصلون', 'Online') }, { value: 'suspended', label: t('موقوفون/مرفوضون', 'Suspended/rejected') }, { value: 'all', label: t('الكل', 'All') }]} />}
            empty={{ title: t('لا يوجد كباتن', 'No captains') }}
          />
        </Panel>
      )}
      <Drawer
        open={!!sel}
        onClose={() => setSel(null)}
        title={name(sel?.profile)}
        footer={
          sel ? (
            sel.status === 'approved' && can('drivers.suspend') ? (
              <Button variant="danger" loading={busy} disabled={!reason.trim() || busy} onClick={() => void act('suspended')}>
                {t('إيقاف الكابتن', 'Suspend captain')}
              </Button>
            ) : sel.status === 'suspended' && can('drivers.approve') ? (
              <Button loading={busy} onClick={() => void act('approved')}>
                {t('إعادة التفعيل', 'Reactivate')}
              </Button>
            ) : undefined
          ) : undefined
        }
      >
        {sel && (
          <div className="space-y-4">
            <div>
              <KV k={t('الحالة', 'Status')} v={<Badge tone={DRIVER_TONE(sel.status)}>{sel.status}</Badge>} />
              <KV k={t('الجوال', 'Mobile')} v={<span className="num" dir="ltr">{sel.profile?.phone ?? '—'}</span>} />
              <KV k={t('نسبة القبول', 'Acceptance')} v={sel.acceptance_rate == null ? '—' : `${sel.acceptance_rate}%`} />
              <KV k={t('وصل', 'Wasl')} v={sel.wasl_status} />
              {sel.status_reason && <KV k={t('ملاحظة', 'Note')} v={sel.status_reason} />}
            </div>
            <div>
              <p className="mb-1.5 text-[13px] font-semibold">{t('آخر الرحلات', 'Recent trips')}</p>
              {rides.slice(0, 15).map((x) => (
                <p key={x.id} className="text-[12px] text-mute">
                  <span className="num">#{x.ride_number}</span> · {x.status} · <span className="num">{api.sar(x.fare_total_halalas)}</span> · {dt(x.requested_at)}
                </p>
              ))}
              {rides.length === 0 && <p className="text-[12px] text-mute">—</p>}
            </div>
            {sel.status === 'approved' && can('drivers.suspend') && <RejectionReasonDropdown key={sel.id} label={t('سبب الإيقاف', 'Suspension reason')} onChange={setReason} disabled={busy} />}
          </div>
        )}
      </Drawer>
    </div>
  )
}

/* ---------------------------------------------------------------- Customers */

export function LiveCustomersPage() {
  const { t } = useI18n()
  const toast = useToast()
  const { can } = useAdmin()
  const [filter, setFilter] = useState<'all' | 'blocked'>('all')
  const r = useLoad(() => api.loadCustomers(filter), [filter])
  const [sel, setSel] = useState<api.CustomerRow | null>(null)
  const [rides, setRides] = useState<api.RideRow[]>([])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const open = async (c: api.CustomerRow) => {
    setSel(c)
    setReason('')
    setRides(await api.loadRiderRides(c.id))
  }
  const toggle = async () => {
    if (!sel) return
    setBusy(true)
    const res = await api.setCustomerBlocked(sel.id, !sel.is_blocked, sel.is_blocked ? null : reason.trim())
    setBusy(false)
    if (res.error !== undefined) return toast(res.error, 'error')
    toast(sel.is_blocked ? t('تم رفع الحظر', 'Unblocked') : t('تم حظر العميل', 'Customer blocked'), 'success')
    setSel(null)
    void r.reload()
  }
  const cols: Col<api.CustomerRow>[] = [
    { key: 'name', header: t('العميل', 'Customer'), cell: (c) => c.full_name ?? '—', csv: (c) => c.full_name ?? '' },
    { key: 'phone', header: t('الجوال', 'Mobile'), cell: (c) => <span className="num" dir="ltr">{c.phone ?? '—'}</span>, csv: (c) => c.phone ?? '' },
    { key: 'trips', header: t('الرحلات', 'Trips'), cell: (c) => <span className="num">{c.completed_rides}</span>, sort: (c) => c.completed_rides },
    { key: 'rating', header: t('التقييم', 'Rating'), cell: (c) => <span className="num">{c.rating ?? '—'}</span> },
    { key: 'status', header: t('الحالة', 'Status'), cell: (c) => (c.is_blocked ? <Badge tone="danger">{t('محظور', 'Blocked')}</Badge> : <Badge tone="done">{t('نشط', 'Active')}</Badge>) },
    { key: 'joined', header: t('التسجيل', 'Joined'), cell: (c) => dt(c.created_at), sort: (c) => c.created_at },
  ]
  return (
    <div>
      <PageHeader title={t('العملاء', 'Customers')} actions={<RefreshButton onClick={() => void r.reload()} loading={r.loading} />} />
      {r.error && !r.data ? (
        <LoadError error={r.error} onRetry={() => void r.reload()} />
      ) : (
        <Panel pad={false}>
          <DataTable
            rows={r.data ?? []}
            cols={cols}
            rowKey={(c) => c.id}
            onRow={(c) => void open(c)}
            exportName="aura-customers"
            search={(c, q) => `${c.full_name ?? ''} ${c.phone ?? ''} ${c.email ?? ''}`.toLowerCase().includes(q)}
            filters={<FilterChips value={filter} onChange={setFilter} options={[{ value: 'all', label: t('الكل', 'All') }, { value: 'blocked', label: t('المحظورون', 'Blocked') }]} />}
            empty={{ title: t('لا يوجد عملاء', 'No customers') }}
          />
        </Panel>
      )}
      <Drawer
        open={!!sel}
        onClose={() => setSel(null)}
        title={sel?.full_name ?? sel?.phone ?? ''}
        footer={
          sel && can('customers.block') ? (
            <Button variant={sel.is_blocked ? 'primary' : 'danger'} loading={busy} disabled={busy || (!sel.is_blocked && !reason.trim())} onClick={() => void toggle()}>
              {sel.is_blocked ? t('رفع الحظر', 'Unblock') : t('حظر العميل', 'Block customer')}
            </Button>
          ) : undefined
        }
      >
        {sel && (
          <div className="space-y-4">
            <div>
              <KV k={t('الجوال', 'Mobile')} v={<span className="num" dir="ltr">{sel.phone ?? '—'}</span>} />
              <KV k={t('البريد', 'Email')} v={sel.email ?? '—'} />
              {sel.blocked_reason && <KV k={t('سبب الحظر', 'Block reason')} v={sel.blocked_reason} />}
            </div>
            <div>
              <p className="mb-1.5 text-[13px] font-semibold">{t('آخر الرحلات', 'Recent trips')}</p>
              {rides.slice(0, 15).map((x) => (
                <p key={x.id} className="text-[12px] text-mute">
                  <span className="num">#{x.ride_number}</span> · {x.status} · <span className="num">{api.sar(x.fare_total_halalas)}</span> · {dt(x.requested_at)}
                </p>
              ))}
              {rides.length === 0 && <p className="text-[12px] text-mute">—</p>}
            </div>
            {!sel.is_blocked && can('customers.block') && (
              <Field label={t('سبب الحظر', 'Reason')}>
                <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
              </Field>
            )}
          </div>
        )}
      </Drawer>
    </div>
  )
}

/* ---------------------------------------------------------------- Support */

export function LiveSupportPage() {
  const { t } = useI18n()
  const toast = useToast()
  const { can, admin } = useAdmin()
  const [filter, setFilter] = useState<'open' | 'pending' | 'resolved' | 'all'>('open')
  const r = useLoad(() => api.loadTickets(filter), [filter])
  const [sel, setSel] = useState<api.TicketRow | null>(null)
  const [msgs, setMsgs] = useState<api.TicketMessage[]>([])
  const [reply, setReply] = useState('')
  const [internal, setInternal] = useState(false)
  const [busy, setBusy] = useState(false)
  const open = async (x: api.TicketRow) => {
    setSel(x)
    setReply('')
    setMsgs(await api.loadTicketMessages(x.id))
  }
  const send = async () => {
    if (!sel || !reply.trim()) return
    setBusy(true)
    const res = await api.replyTicket(sel.id, admin.id, reply, internal)
    setBusy(false)
    if (res.error !== undefined) return toast(res.error, 'error')
    setReply('')
    setMsgs(await api.loadTicketMessages(sel.id))
  }
  const setStatus = async (status: api.TicketRow['status']) => {
    if (!sel) return
    const res = await api.updateTicket(sel.id, { status })
    if (res.error !== undefined) return toast(res.error, 'error')
    setSel({ ...sel, status })
    void r.reload()
  }
  const PRI = (p: string) => (p === 'urgent' ? 'danger' : p === 'high' ? 'pending' : 'neutral')
  const cols: Col<api.TicketRow>[] = [
    { key: 'n', header: '#', cell: (x) => <span className="num">{x.ticket_number}</span>, sort: (x) => x.ticket_number },
    { key: 'subject', header: t('الموضوع', 'Subject'), cell: (x) => x.subject, csv: (x) => x.subject },
    { key: 'from', header: t('من', 'From'), cell: (x) => `${name(x.opener)} · ${x.opener_kind}`, csv: (x) => name(x.opener) },
    { key: 'cat', header: t('النوع', 'Category'), cell: (x) => x.category, csv: (x) => x.category },
    { key: 'pri', header: t('الأولوية', 'Priority'), cell: (x) => <Badge tone={PRI(x.priority)}>{x.priority}</Badge>, csv: (x) => x.priority },
    { key: 'status', header: t('الحالة', 'Status'), cell: (x) => <Badge tone={x.status === 'resolved' ? 'done' : 'pending'}>{x.status}</Badge>, csv: (x) => x.status },
    { key: 'at', header: t('التاريخ', 'Date'), cell: (x) => dt(x.created_at), sort: (x) => x.created_at },
  ]
  return (
    <div>
      <PageHeader title={t('خدمة العملاء', 'Support')} sub={t('تذاكر العملاء والكباتن وبلاغات السلامة من قاعدة البيانات.', 'Rider and captain tickets and safety reports from the database.')} actions={<RefreshButton onClick={() => void r.reload()} loading={r.loading} />} />
      {r.error && !r.data ? (
        <LoadError error={r.error} onRetry={() => void r.reload()} />
      ) : (
        <Panel pad={false}>
          <DataTable
            rows={r.data ?? []}
            cols={cols}
            rowKey={(x) => x.id}
            onRow={(x) => void open(x)}
            exportName="aura-tickets"
            search={(x, q) => `${x.ticket_number} ${x.subject} ${name(x.opener)}`.toLowerCase().includes(q)}
            filters={<FilterChips value={filter} onChange={setFilter} options={[{ value: 'open', label: t('مفتوحة', 'Open') }, { value: 'pending', label: t('معلّقة', 'Pending') }, { value: 'resolved', label: t('محلولة', 'Resolved') }, { value: 'all', label: t('الكل', 'All') }]} />}
            empty={{ title: t('لا توجد تذاكر', 'No tickets') }}
          />
        </Panel>
      )}
      <Drawer open={!!sel} onClose={() => setSel(null)} title={sel ? `#${sel.ticket_number} · ${sel.subject}` : ''} width={600}>
        {sel && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={PRI(sel.priority)}>{sel.priority}</Badge>
              <Badge tone={sel.status === 'resolved' ? 'done' : 'pending'}>{sel.status}</Badge>
              <span className="text-xs text-mute">{name(sel.opener)} · {sel.opener_kind} · {sel.category}</span>
              {can('support.reply') && (
                <Select className="ms-auto h-9" value={sel.status} onChange={(v) => void setStatus(v as api.TicketRow['status'])} options={[{ value: 'open', label: t('مفتوحة', 'Open') }, { value: 'pending', label: t('معلّقة', 'Pending') }, { value: 'resolved', label: t('محلولة', 'Resolved') }]} />
              )}
            </div>
            <div className="space-y-2">
              {msgs.map((m) => (
                <div key={m.id} className={`rounded-xl px-3 py-2 text-sm ${m.is_internal ? 'bg-amber-50 ring-1 ring-amber-200' : m.author_kind === 'agent' ? 'bg-road' : 'bg-white ring-1 ring-line'}`}>
                  <p className="mb-0.5 text-[11px] text-mute">
                    {m.author_kind}
                    {m.is_internal ? ` · ${t('ملاحظة داخلية', 'internal note')}` : ''} · <span className="num">{dt(m.created_at)}</span>
                  </p>
                  <p className="whitespace-pre-wrap">{m.body}</p>
                </div>
              ))}
              {msgs.length === 0 && <EmptyState title={t('لا توجد رسائل', 'No messages')} />}
            </div>
            {can('support.reply') && (
              <div className="space-y-2">
                <textarea className="min-h-24 w-full rounded-xl bg-road p-3 text-sm outline-none focus:ring-2 focus:ring-ink" maxLength={4000} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t('اكتب الرد…', 'Write a reply…')} />
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-xs text-mute">
                    <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> {t('ملاحظة داخلية (لا يراها العميل)', 'Internal note (hidden from the customer)')}
                  </label>
                  <Button size="sm" loading={busy} disabled={!reply.trim() || busy} onClick={() => void send()}>
                    {t('إرسال', 'Send')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  )
}

/* ---------------------------------------------------------------- Finance */

export function LiveFinancePage() {
  const { t } = useI18n()
  const toast = useToast()
  const { can } = useAdmin()
  const r = useLoad(() => api.loadFinance(), [])
  const [tab, setTab] = useState<'payments' | 'payouts'>('payments')
  const [busy, setBusy] = useState(false)
  const h = r.data?.health as { balanced?: boolean; ok?: boolean; total_halalas?: number } | null | undefined
  const payout = async (id: string, status: 'approved' | 'cancelled') => {
    const res = await api.setPayoutStatus(id, status, null)
    if (res.error !== undefined) return toast(res.error, 'error')
    toast(t('تم التحديث', 'Updated'), 'success')
    void r.reload()
  }
  const batch = async () => {
    setBusy(true)
    const res = await api.createPayoutBatch()
    setBusy(false)
    if (res.error !== undefined) return toast(res.error, 'error')
    toast(t(`أُنشئت ${res.data} تحويلات`, `${res.data} payouts created`), 'success')
    void r.reload()
  }
  const payCols: Col<api.PaymentRow>[] = [
    { key: 'at', header: t('التاريخ', 'Date'), cell: (x) => dt(x.created_at), sort: (x) => x.created_at, csv: (x) => x.created_at },
    { key: 'kind', header: t('النوع', 'Kind'), cell: (x) => x.kind, csv: (x) => x.kind },
    { key: 'method', header: t('الطريقة', 'Method'), cell: (x) => `${x.method_type} · ${x.provider}`, csv: (x) => x.method_type },
    { key: 'amount', header: t('المبلغ', 'Amount'), cell: (x) => <span className="num">{api.sar(x.amount_halalas)}</span>, sort: (x) => x.amount_halalas, csv: (x) => api.sar(x.amount_halalas) },
    { key: 'status', header: t('الحالة', 'Status'), cell: (x) => <Badge tone={x.status === 'paid' || x.status === 'captured' ? 'done' : x.status === 'failed' ? 'danger' : 'pending'}>{x.status}</Badge>, csv: (x) => x.status },
  ]
  const outCols: Col<api.PayoutRow>[] = [
    { key: 'at', header: t('الطلب', 'Requested'), cell: (x) => dt(x.requested_at), sort: (x) => x.requested_at, csv: (x) => x.requested_at },
    { key: 'driver', header: t('الكابتن', 'Captain'), cell: (x) => name(x.driver), csv: (x) => name(x.driver) },
    { key: 'amount', header: t('المبلغ', 'Amount'), cell: (x) => <span className="num">{api.sar(x.amount_halalas)}</span>, sort: (x) => x.amount_halalas, csv: (x) => api.sar(x.amount_halalas) },
    { key: 'status', header: t('الحالة', 'Status'), cell: (x) => <Badge tone={x.status === 'paid' ? 'done' : x.status === 'failed' || x.status === 'cancelled' ? 'danger' : 'pending'}>{x.status}</Badge>, csv: (x) => x.status },
    {
      key: 'act',
      header: '',
      cell: (x) =>
        x.status === 'pending' && can('finance.settle') ? (
          <span className="flex gap-1">
            <Button size="sm" onClick={() => void payout(x.id, 'approved')}>{t('اعتماد', 'Approve')}</Button>
            <Button size="sm" variant="secondary" onClick={() => void payout(x.id, 'cancelled')}>{t('إلغاء', 'Cancel')}</Button>
          </span>
        ) : null,
    },
  ]
  return (
    <div>
      <PageHeader
        title={t('المالية', 'Finance')}
        sub={t('المدفوعات والتحويلات من قاعدة البيانات، وصحة دفتر القيود المزدوج.', 'Payments and payouts from the database, and double-entry ledger health.')}
        actions={
          <span className="flex gap-2">
            {can('finance.settle') && (
              <Button size="sm" loading={busy} onClick={() => void batch()}>
                {t('إنشاء دفعة تحويلات الكباتن', 'Create captain payout batch')}
              </Button>
            )}
            <RefreshButton onClick={() => void r.reload()} loading={r.loading} />
          </span>
        }
      />
      {r.error && !r.data ? (
        <LoadError error={r.error} onRetry={() => void r.reload()} />
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Kpi label={t('توازن الدفتر', 'Ledger balanced')} value={h == null ? '—' : (h.balanced ?? h.ok) ? t('متوازن', 'Balanced') : t('غير متوازن', 'NOT balanced')} />
            <Kpi label={t('مدفوعات (آخر ٣٠٠)', 'Payments (last 300)')} value={r.data?.payments.length ?? '—'} />
            <Kpi label={t('تحويلات معلّقة', 'Pending payouts')} value={r.data?.payouts.filter((x) => x.status === 'pending').length ?? '—'} />
          </div>
          <Panel pad={false}>
            {tab === 'payments' ? (
              <DataTable rows={r.data?.payments ?? []} cols={payCols} rowKey={(x) => x.id} exportName="aura-payments" filters={<FilterChips value={tab} onChange={setTab} options={[{ value: 'payments', label: t('المدفوعات', 'Payments') }, { value: 'payouts', label: t('تحويلات الكباتن', 'Payouts') }]} />} empty={{ title: t('لا توجد مدفوعات', 'No payments') }} />
            ) : (
              <DataTable rows={r.data?.payouts ?? []} cols={outCols} rowKey={(x) => x.id} exportName="aura-payouts" filters={<FilterChips value={tab} onChange={setTab} options={[{ value: 'payments', label: t('المدفوعات', 'Payments') }, { value: 'payouts', label: t('تحويلات الكباتن', 'Payouts') }]} />} empty={{ title: t('لا توجد تحويلات', 'No payouts') }} />
            )}
          </Panel>
        </>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- Pricing */

const TARIFF_FIELDS: { key: keyof api.TariffPatch; ar: string; en: string; unit: 'sar' | 'bps' }[] = [
  { key: 'base_fare_halalas', ar: 'فتح العداد', en: 'Base fare', unit: 'sar' },
  { key: 'per_km_halalas', ar: 'لكل كم', en: 'Per km', unit: 'sar' },
  { key: 'per_min_halalas', ar: 'لكل دقيقة', en: 'Per minute', unit: 'sar' },
  { key: 'min_fare_halalas', ar: 'الحد الأدنى', en: 'Minimum fare', unit: 'sar' },
  { key: 'cancellation_fee_halalas', ar: 'رسوم الإلغاء', en: 'Cancellation fee', unit: 'sar' },
  { key: 'commission_bps', ar: 'عمولة أورا %', en: 'AURA commission %', unit: 'bps' },
]

export function LivePricingPage() {
  const { t, lang } = useI18n()
  const toast = useToast()
  const { can } = useAdmin()
  const r = useLoad(() => api.loadTariffs(), [])
  const [edit, setEdit] = useState<api.TariffRow | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const shown = (row: api.TariffRow, f: (typeof TARIFF_FIELDS)[number]) => (f.unit === 'sar' ? api.sar(row[f.key]) : (row[f.key] / 100).toFixed(2))
  const open = (row: api.TariffRow) => {
    setEdit(row)
    setDraft(Object.fromEntries(TARIFF_FIELDS.map((f) => [f.key, shown(row, f)])))
  }
  const save = async () => {
    if (!edit) return
    const patch = Object.fromEntries(TARIFF_FIELDS.map((f) => [f.key, Math.round(Number(draft[f.key]) * 100)])) as api.TariffPatch
    if (Object.values(patch).some((v) => !Number.isFinite(v) || v < 0)) return toast(t('قيم غير صالحة', 'Invalid values'), 'error')
    setBusy(true)
    const res = await api.updateTariff(edit.id, patch)
    setBusy(false)
    if (res.error !== undefined) return toast(res.error, 'error')
    toast(t('تم حفظ التسعيرة', 'Tariff saved'), 'success')
    setEdit(null)
    void r.reload()
  }
  const cols: Col<api.TariffRow>[] = [
    { key: 'city', header: t('المدينة', 'City'), cell: (x) => (lang === 'en' ? x.city?.name_en : x.city?.name_ar) ?? '—', csv: (x) => x.city?.code ?? '' },
    { key: 'class', header: t('الفئة', 'Class'), cell: (x) => x.vehicle_class, csv: (x) => x.vehicle_class },
    ...TARIFF_FIELDS.map((f): Col<api.TariffRow> => ({ key: f.key, header: lang === 'en' ? f.en : f.ar, cell: (x) => <span className="num">{shown(x, f)}</span>, csv: (x) => shown(x, f) })),
    { key: 'active', header: t('مفعّلة', 'Active'), cell: (x) => (x.is_active ? <Badge tone="done">✓</Badge> : '—') },
  ]
  return (
    <div>
      <PageHeader title={t('التسعير والعمولات', 'Pricing & commission')} sub={t('التعرفة الفعلية التي يحسب بها الخادم الأجرة والعمولة. التعديل يُسجَّل في سجل التدقيق.', 'The tariffs the server prices trips and commission with. Edits are audited.')} actions={<RefreshButton onClick={() => void r.reload()} loading={r.loading} />} />
      {r.error && !r.data ? (
        <LoadError error={r.error} onRetry={() => void r.reload()} />
      ) : (
        <Panel pad={false}>
          <DataTable rows={r.data ?? []} cols={cols} rowKey={(x) => x.id} onRow={can('pricing.edit') ? open : undefined} exportName="aura-tariffs" empty={{ title: t('لا توجد تعرفة', 'No tariffs') }} />
        </Panel>
      )}
      <Drawer
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit ? `${edit.vehicle_class} · ${(lang === 'en' ? edit.city?.name_en : edit.city?.name_ar) ?? ''}` : ''}
        footer={
          <Button loading={busy} onClick={() => void save()}>
            {t('حفظ', 'Save')}
          </Button>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          {TARIFF_FIELDS.map((f) => (
            <Field key={f.key} label={`${lang === 'en' ? f.en : f.ar}${f.unit === 'sar' ? ' (SAR)' : ''}`}>
              <Input dir="ltr" inputMode="decimal" className="num" value={draft[f.key] ?? ''} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value.replace(/[^\d.]/g, '') })} />
            </Field>
          ))}
        </div>
      </Drawer>
    </div>
  )
}

/* ---------------------------------------------------------------- Live map */

export function LiveMapServerPage() {
  const { t } = useI18n()
  const r = useLoad(() => api.loadMap(), [])
  useEffect(() => {
    const id = window.setInterval(() => void r.reload(), 15_000)
    return () => window.clearInterval(id)
  }, [r.reload])
  const pts = r.data ?? []
  const markers: MapMarker[] = pts.map((p) => ({ id: p.driver_id, pos: { lat: p.lat, lng: p.lng }, kind: 'car', heading: p.heading ?? 0, tone: p.is_available ? 'go' : 'ink' }))
  return (
    <div>
      <PageHeader title={t('الخريطة المباشرة', 'Live map')} sub={t(`${pts.length} كابتن خلال آخر ١٠ دقائق · ${pts.filter((p) => p.is_available).length} متاح · تتحدث كل ١٥ ثانية`, `${pts.length} captains in the last 10 min · ${pts.filter((p) => p.is_available).length} available · refreshes every 15 s`)} actions={<RefreshButton onClick={() => void r.reload()} loading={r.loading} />} />
      {r.error && !r.data ? (
        <LoadError error={r.error} onRetry={() => void r.reload()} />
      ) : (
        <Panel pad={false}>
          <div className="relative h-[620px] overflow-hidden rounded-2xl">
            <CityMap markers={markers} zoom={28} controls />
          </div>
        </Panel>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- Staff */

export function LiveStaffPage() {
  const { t } = useI18n()
  const r = useLoad(() => api.loadStaff(), [])
  type S = NonNullable<typeof r.data>[number]
  const cols: Col<S>[] = [
    { key: 'name', header: t('الاسم', 'Name'), cell: (s) => s.full_name ?? '—', csv: (s) => s.full_name ?? '' },
    { key: 'role', header: t('الدور', 'Role'), cell: (s) => <Badge>{s.admin_role ?? '—'}</Badge>, csv: (s) => s.admin_role ?? '' },
    { key: 'contact', header: t('التواصل', 'Contact'), cell: (s) => <span className="num" dir="ltr">{s.email ?? s.phone ?? '—'}</span> },
    { key: 'status', header: t('الحالة', 'Status'), cell: (s) => (s.is_blocked ? <Badge tone="danger">{t('موقوف', 'Blocked')}</Badge> : <Badge tone="done">{t('نشط', 'Active')}</Badge>) },
  ]
  return (
    <div>
      <PageHeader
        title={t('المستخدمون والصلاحيات', 'Users & roles')}
        sub={t('حسابات الموظفين وأدوارهم من قاعدة البيانات. منح الأدوار يتم من الخادم فقط (private.grant_admin) ويتطلب التحقق الثنائي.', 'Staff accounts and roles from the database. Roles are granted server-side only (private.grant_admin), with MFA.')}
        actions={<RefreshButton onClick={() => void r.reload()} loading={r.loading} />}
      />
      {r.error && !r.data ? <LoadError error={r.error} onRetry={() => void r.reload()} /> : <Panel pad={false}><DataTable rows={r.data ?? []} cols={cols} rowKey={(s) => s.id} empty={{ title: t('لا يوجد موظفون', 'No staff') }} /></Panel>}
    </div>
  )
}

/** Placeholder for pages that have no server backing yet in live mode (honest, no demo data). */
export function NotInLiveMode({ title, children }: { title: string; children?: ReactNode }) {
  const { t } = useI18n()
  return (
    <div>
      <PageHeader title={title} />
      <EmptyState title={t('غير متاحة في الوضع المباشر بعد', 'Not available in live mode yet')} body={t('هذه الصفحة تعمل في النسخة التجريبية فقط ولا تتصل بقاعدة البيانات بعد، لذلك أُخفيت بياناتها التجريبية هنا.', 'This page works in the demo build only and is not connected to the database yet, so its demo data is not shown here.')} />
      {children}
    </div>
  )
}
