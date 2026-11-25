import { useCallback, useEffect, useState } from 'react'
import { Download, FileEdit, Hand, PauseCircle, Trash2 } from 'lucide-react'
import { Badge, Button, Modal, Switch, cx, useToast, useTone, ICON } from '../ds/ui'
import { useI18n } from '../i18n/I18n'
import { Panel } from '../apps/shared/mobile'
import {
  CONSENT_TEXT,
  REQUEST_STATUS_LABEL,
  REQUEST_TYPE_LABEL,
  REQUIRED_CONSENTS,
  isConsentCurrent,
  purposesFor,
  type ConsentApp,
  type ConsentPurpose,
  type ConsentRecord,
  type PrivacyRequest,
  type PrivacyRequestType,
} from './consents'
import { PrivacyError, downloadJson, privacy } from './privacyService'
import { AnimatePresence } from 'framer-motion'
import { LegalViewer } from '../legal/LegalViewer'
import type { LegalDocId } from '../legal/documents'

type Ask = Exclude<PrivacyRequestType, 'access'>

const statusTone = (s: PrivacyRequest['status']) =>
  s === 'completed' ? 'done' : s === 'rejected' ? 'danger' : s === 'cancelled' ? 'outline' : s === 'in_progress' ? 'live' : 'pending'

/** Account → Privacy & data: consents, download my data, PDPL requests. */
export function PrivacyCenter({ app, subjectId, onClose, onConsentsChanged }: { app: ConsentApp; subjectId: string; onClose: () => void; onConsentsChanged: () => void }) {
  const { t, L, lang } = useI18n()
  const toast = useToast()
  const dark = useTone() === 'dark'
  const [records, setRecords] = useState<ConsentRecord[]>([])
  const [requests, setRequests] = useState<PrivacyRequest[]>([])
  const [withdraw, setWithdraw] = useState<ConsentPurpose | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [doc, setDoc] = useState<LegalDocId | null>(null)
  const [details, setDetails] = useState('')
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [c, r] = await Promise.all([privacy.getConsents(subjectId), privacy.listMyRequests(subjectId)])
    setRecords(c)
    setRequests(r)
  }, [subjectId])
  useEffect(() => {
    load().catch(() => toast(t('تعذّر تحميل بيانات الخصوصية', 'Could not load privacy settings'), 'error'))
  }, [load, toast, t])

  const fmt = (ms: number) => new Date(ms).toLocaleDateString(lang === 'ar' ? 'ar-SA' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  const err = (e: unknown) => {
    const m = e instanceof PrivacyError ? e.message : ''
    if (/open|already/.test(m)) return t('لديك طلب مفتوح من هذا النوع', 'You already have an open request of this type')
    if (/active ride/.test(m)) return t('أنهِ رحلتك الحالية أولاً', 'Finish your current ride first')
    if (/limit/.test(m)) return t('وصلت للحد اليومي للتنزيل', 'Daily download limit reached')
    return t('حدث خطأ، حاول مرة أخرى', 'Something went wrong, please try again')
  }

  const setConsent = async (p: ConsentPurpose, granted: boolean) => {
    setBusy(true)
    try {
      await privacy.recordConsents(subjectId, app, [{ purpose: p, granted }], lang)
      await load()
      onConsentsChanged()
      toast(granted ? t('تم حفظ موافقتك', 'Consent saved') : t('تم سحب الموافقة', 'Consent withdrawn'), 'success')
    } catch (e) {
      toast(err(e), 'error')
    } finally {
      setBusy(false)
      setWithdraw(null)
    }
  }

  const exportData = async () => {
    setBusy(true)
    try {
      const data = await privacy.exportMyData(subjectId)
      downloadJson(`aura-my-data-${new Date().toISOString().slice(0, 10)}.json`, data)
      await load()
      toast(t('تم تجهيز نسخة بياناتك', 'Your data copy is ready'), 'success')
    } catch (e) {
      toast(err(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!ask) return
    setBusy(true)
    try {
      await privacy.submitRequest(subjectId, ask, details.trim() || undefined)
      await load()
      toast(t('استلمنا طلبك وسنرد خلال ٣٠ يوماً كحد أقصى', 'Request received. We will respond within 30 days'), 'success')
      setAsk(null)
      setDetails('')
      setUnderstood(false)
    } catch (e) {
      toast(err(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (id: string) => {
    try {
      await privacy.cancelRequest(subjectId, id)
      await load()
    } catch (e) {
      toast(err(e), 'error')
    }
  }

  const card = cx('rounded-2xl p-4', dark ? 'bg-ink-2 ring-1 ring-white/8' : 'bg-road')
  const sub = dark ? 'text-white/55' : 'text-mute'
  const asks: { id: Ask; icon: React.ReactNode }[] = [
    { id: 'correction', icon: <FileEdit size={17} {...ICON} /> },
    { id: 'restriction', icon: <PauseCircle size={17} {...ICON} /> },
    { id: 'objection', icon: <Hand size={17} {...ICON} /> },
    { id: 'deletion', icon: <Trash2 size={17} {...ICON} /> },
  ]

  return (
    <Panel title={t('الخصوصية والبيانات', 'Privacy & data')} onClose={onClose}>
      <p className={cx('mt-1 text-[12.5px]', sub)}>
        {t('حقوقك بموجب نظام حماية البيانات الشخصية: الاطلاع، والتصحيح، والحذف، وسحب الموافقة.', 'Your rights under the PDPL: access, correction, deletion and withdrawing consent.')}
      </p>
      <div className="mt-2 flex flex-wrap gap-3 text-[12.5px] font-semibold underline">
        <button onClick={() => setDoc('privacy')}>{t('سياسة الخصوصية', 'Privacy policy')}</button>
        <button onClick={() => setDoc('terms')}>{t('الشروط والأحكام', 'Terms of service')}</button>
        {app === 'driver' && <button onClick={() => setDoc('captain')}>{t('اتفاقية الكابتن', 'Captain agreement')}</button>}
        <button onClick={() => setDoc('safety')}>{t('إرشادات السلامة', 'Safety guidelines')}</button>
      </div>

      <h3 className="mt-5 text-[13px] font-semibold">{t('الموافقات', 'Consents')}</h3>
      <div className="mt-2 grid gap-2">
        {purposesFor(app).map((p) => {
          const required = REQUIRED_CONSENTS[app].includes(p)
          const on = isConsentCurrent(records, p)
          return (
            <div key={p} className={cx(card, 'flex items-center gap-3 py-3')}>
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-semibold">{L(CONSENT_TEXT[p].title)}</p>
                <p className={cx('text-[11.5px]', sub)}>
                  {L(CONSENT_TEXT[p].basis)} · {required ? t('مطلوب للخدمة', 'Required for service') : t('اختياري', 'Optional')}
                </p>
              </div>
              {required ? (
                on ? (
                  <button disabled={busy} onClick={() => setWithdraw(p)} className={cx('text-[12px] font-semibold underline', sub)}>
                    {t('سحب', 'Withdraw')}
                  </button>
                ) : (
                  <Badge tone="warn">{t('غير مُوافق', 'Not given')}</Badge>
                )
              ) : (
                <Switch checked={on} disabled={busy} onChange={(v) => setConsent(p, v)} label={L(CONSENT_TEXT[p].title)} />
              )}
            </div>
          )
        })}
      </div>

      <h3 className="mt-6 text-[13px] font-semibold">{t('بياناتك', 'Your data')}</h3>
      <div className={cx(card, 'mt-2')}>
        <p className="text-[13.5px] font-semibold">{t('تنزيل نسخة من بياناتي', 'Download a copy of my data')}</p>
        <p className={cx('mt-0.5 text-[12px]', sub)}>{t('ملف JSON يضم الملف الشخصي والرحلات والمدفوعات والموافقات.', 'A JSON file with your profile, rides, payments and consents.')}</p>
        <Button variant="secondary" size="sm" className="mt-3" icon={<Download size={15} />} loading={busy} onClick={exportData}>
          {t('تنزيل', 'Download')}
        </Button>
      </div>

      <h3 className="mt-6 text-[13px] font-semibold">{t('تقديم طلب', 'Make a request')}</h3>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {asks.map((a) => (
          <button key={a.id} onClick={() => setAsk(a.id)} className={cx(card, 'flex items-center gap-2 py-3 text-start text-[12.5px] font-semibold', a.id === 'deletion' && 'text-danger')}>
            {a.icon}
            {L(REQUEST_TYPE_LABEL[a.id])}
          </button>
        ))}
      </div>

      {requests.length > 0 && (
        <>
          <h3 className="mt-6 text-[13px] font-semibold">{t('طلباتي', 'My requests')}</h3>
          <div className="mt-2 grid gap-2">
            {requests.map((r) => (
              <div key={r.id} className={cx(card, 'py-3')}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[13px] font-semibold">
                    <span className="num">#{r.number}</span> · {L(REQUEST_TYPE_LABEL[r.type])}
                  </p>
                  <Badge tone={statusTone(r.status)}>{L(REQUEST_STATUS_LABEL[r.status])}</Badge>
                </div>
                <p className={cx('mt-1 text-[11.5px]', sub)}>
                  {t('قُدّم', 'Submitted')} {fmt(r.createdAt)}
                  {(r.status === 'pending' || r.status === 'in_progress') && <> · {t('الرد قبل', 'Reply by')} {fmt(r.dueAt)}</>}
                </p>
                {r.resolutionNote && <p className={cx('mt-1 text-[12px]', sub)}>{r.resolutionNote}</p>}
                {r.status === 'pending' && (
                  <button onClick={() => cancel(r.id)} className={cx('mt-2 text-[12px] font-semibold underline', sub)}>
                    {t('إلغاء الطلب', 'Cancel request')}
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <Modal contained open={!!withdraw} onClose={() => setWithdraw(null)} title={t('سحب الموافقة', 'Withdraw consent')} width={340}>
        {withdraw && (
          <>
            <p className="text-sm text-mute">
              {t(
                `«${CONSENT_TEXT[withdraw].title.ar}» مطلوبة لتقديم الخدمة. بعد السحب لن تتمكن من ${app === 'driver' ? 'الاتصال واستقبال الطلبات' : 'طلب الرحلات'} حتى توافق مجدداً.`,
                `"${CONSENT_TEXT[withdraw].title.en}" is required for the service. After withdrawing you cannot ${app === 'driver' ? 'go online' : 'request rides'} until you accept again.`,
              )}
            </p>
            <div className="mt-4 grid gap-2">
              <Button variant="danger" full loading={busy} onClick={() => setConsent(withdraw, false)}>
                {t('سحب الموافقة', 'Withdraw')}
              </Button>
              <Button variant="secondary" full onClick={() => setWithdraw(null)}>
                {t('تراجع', 'Keep')}
              </Button>
            </div>
          </>
        )}
      </Modal>

      <Modal contained open={!!ask} onClose={() => setAsk(null)} title={ask ? L(REQUEST_TYPE_LABEL[ask]) : ''} width={360}>
        {ask && (
          <>
            {ask === 'deletion' && (
              <p className="rounded-xl bg-danger/10 p-3 text-[12.5px] text-danger">
                {t(
                  'سيُحذف حسابك وبياناتك الشخصية. نحتفظ نظاماً بسجلات الرحلات والفواتير والمعاملات المالية المجهولة. يجب ألا يكون لديك رحلة جارية أو رصيد في المحفظة.',
                  'Your account and personal data will be deleted. Trip, invoice and financial records are kept in anonymised form as required by law. You must have no active ride and a zero wallet balance.',
                )}
              </p>
            )}
            <label className="mt-3 block text-[12.5px] font-semibold">{t('تفاصيل (اختياري)', 'Details (optional)')}</label>
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value.slice(0, 2000))}
              rows={3}
              className="mt-1 w-full rounded-xl bg-road p-3 text-sm outline-none ring-1 ring-line focus:ring-ink"
              placeholder={ask === 'correction' ? t('ما البيانات التي تريد تصحيحها؟', 'Which data should be corrected?') : ''}
            />
            {ask === 'deletion' && (
              <label className="mt-3 flex items-center gap-2 text-[12.5px]">
                <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
                {t('أفهم أن الحذف نهائي', 'I understand deletion is permanent')}
              </label>
            )}
            <Button full className="mt-4" variant={ask === 'deletion' ? 'danger' : 'primary'} disabled={ask === 'deletion' && !understood} loading={busy} onClick={submit}>
              {t('إرسال الطلب', 'Submit request')}
            </Button>
          </>
        )}
      </Modal>
      <AnimatePresence>{doc && <LegalViewer doc={doc} onClose={() => setDoc(null)} />}</AnimatePresence>
    </Panel>
  )
}
