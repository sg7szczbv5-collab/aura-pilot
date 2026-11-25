import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronDown, ShieldCheck } from 'lucide-react'
import { Button, Switch, cx, useTone } from '../ds/ui'
import { useI18n } from '../i18n/I18n'
import {
  CONSENT_TEXT,
  OPTIONAL_CONSENTS,
  REQUIRED_CONSENTS,
  isConsentCurrent,
  missingRequiredConsents,
  purposesFor,
  type ConsentApp,
  type ConsentPurpose,
  type ConsentRecord,
} from './consents'
import { privacy } from './privacyService'
import { AnimatePresence } from 'framer-motion'
import { LegalViewer } from '../legal/LegalViewer'
import { DOC_FOR_PURPOSE, type LegalDocId } from '../legal/documents'

/** Loads the subject's consents and reports which required ones are missing. Fails closed. */
export function useConsentGate(app: ConsentApp, subjectId?: string) {
  const [state, setState] = useState<{ loading: boolean; records: ConsentRecord[]; missing: ConsentPurpose[]; error: boolean }>({
    loading: true,
    records: [],
    missing: [],
    error: false,
  })
  const refresh = useCallback(async () => {
    if (!subjectId) return
    try {
      const records = await privacy.getConsents(subjectId)
      setState({ loading: false, records, missing: missingRequiredConsents(app, records), error: false })
    } catch {
      setState({ loading: false, records: [], missing: REQUIRED_CONSENTS[app], error: true })
    }
  }, [app, subjectId])
  useEffect(() => {
    setState((s) => ({ ...s, loading: true }))
    void refresh()
  }, [refresh])
  return { ...state, refresh }
}

/** Shown after sign-in (and whenever a policy version changes) until required consents are given. */
export function ConsentScreen({
  app,
  subjectId,
  records,
  onDone,
  onSignOut,
}: {
  app: ConsentApp
  subjectId: string
  records: ConsentRecord[]
  onDone: () => void
  onSignOut: () => void
}) {
  const { t, L, lang } = useI18n()
  const dark = useTone() === 'dark'
  const required = REQUIRED_CONSENTS[app]
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(required.map((p) => [p, isConsentCurrent(records, p)])))
  const [optional, setOptional] = useState<Record<string, boolean>>(() => Object.fromEntries(OPTIONAL_CONSENTS.map((p) => [p, isConsentCurrent(records, p)])))
  const [open, setOpen] = useState<ConsentPurpose | null>(null)
  const [doc, setDoc] = useState<LegalDocId | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const allRequired = required.every((p) => checked[p])

  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      const decisions = [
        ...required.filter((p) => !isConsentCurrent(records, p)).map((p) => ({ purpose: p, granted: true })),
        ...OPTIONAL_CONSENTS.filter((p) => optional[p] !== isConsentCurrent(records, p) || !records.some((r) => r.purpose === p)).map((p) => ({
          purpose: p,
          granted: !!optional[p],
        })),
      ]
      await privacy.recordConsents(subjectId, app, decisions, lang)
      onDone()
    } catch {
      setErr(t('تعذّر حفظ موافقتك، حاول مرة أخرى', 'Could not save your choices, please try again'))
    } finally {
      setBusy(false)
    }
  }

  const card = dark ? 'bg-ink-2 ring-1 ring-white/8' : 'bg-road'
  const sub = dark ? 'text-white/55' : 'text-mute'

  return (
    <div className="absolute inset-0 flex flex-col" style={{ paddingTop: 'var(--safe-top, 0px)' }}>
      <div className="thin-scroll flex-1 overflow-y-auto px-5 pb-4 pt-8">
        <div className={cx('flex size-12 items-center justify-center rounded-2xl', dark ? 'bg-go/15 text-go' : 'bg-ink text-go')}>
          <ShieldCheck size={24} />
        </div>
        <h1 className="mt-4 font-display text-[24px] font-semibold leading-tight">{t('خصوصيتك أولاً', 'Your privacy comes first')}</h1>
        <p className={cx('mt-1 text-sm', sub)}>
          {app === 'driver'
            ? t('قبل الاتصال واستقبال الطلبات، راجع الإشعارات التالية ووافق عليها.', 'Before going online, review and accept the following.')
            : t('قبل طلب أول رحلة، راجع ما يلي ووافق عليه.', 'Before your first ride, review and accept the following.')}
        </p>

        <div className="mt-5 grid gap-2">
          {purposesFor(app).map((p) => {
            const isReq = required.includes(p)
            const on = isReq ? !!checked[p] : !!optional[p]
            const toggle = () => (isReq ? setChecked((c) => ({ ...c, [p]: !c[p] })) : setOptional((o) => ({ ...o, [p]: !o[p] })))
            return (
              <div key={p} className={cx('rounded-2xl p-3.5', card)}>
                <div className="flex items-start gap-3">
                  {isReq ? (
                    <button
                      onClick={toggle}
                      role="checkbox"
                      aria-checked={on}
                      aria-label={L(CONSENT_TEXT[p].title)}
                      className={cx(
                        'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border',
                        on ? (dark ? 'border-go bg-go text-ink' : 'border-ink bg-ink text-white') : dark ? 'border-white/30' : 'border-line-2',
                      )}
                    >
                      {on && <Check size={14} strokeWidth={3} />}
                    </button>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-[14px] font-semibold">{L(CONSENT_TEXT[p].title)}</p>
                      <span className={cx('rounded-md px-1.5 py-0.5 text-[10px] font-semibold', isReq ? (dark ? 'bg-white/10' : 'bg-white') : dark ? 'text-white/45' : 'text-mute')}>
                        {isReq ? t('مطلوب', 'Required') : t('اختياري', 'Optional')}
                      </span>
                    </div>
                    <button onClick={() => setOpen(open === p ? null : p)} className={cx('mt-0.5 flex items-center gap-1 text-[12px] font-medium', sub)}>
                      {L(CONSENT_TEXT[p].basis)} · {t('التفاصيل', 'Details')}
                      <ChevronDown size={13} className={cx('transition', open === p && 'rotate-180')} />
                    </button>
                    {open === p && (
                      <>
                        <p className={cx('mt-2 text-[12.5px] leading-relaxed', sub)}>{L(CONSENT_TEXT[p].body)}</p>
                        <button onClick={() => setDoc(DOC_FOR_PURPOSE[p])} className="mt-1.5 text-[12px] font-semibold underline">
                          {t('قراءة النص الكامل', 'Read the full document')}
                        </button>
                      </>
                    )}
                  </div>
                  {!isReq && <Switch checked={on} onChange={toggle} label={L(CONSENT_TEXT[p].title)} />}
                </div>
              </div>
            )
          })}
        </div>

        <p className={cx('mt-4 text-[11.5px] leading-relaxed', sub)}>
          {t(
            'تعالج أورا بياناتك وفق نظام حماية البيانات الشخصية في المملكة. يمكنك في أي وقت تعديل موافقاتك أو تنزيل نسخة من بياناتك أو طلب حذف حسابك من: حسابي ← الخصوصية والبيانات.',
            'AURA processes your data under the Saudi Personal Data Protection Law. Any time, you can change consents, download your data or request deletion in Account → Privacy & data.',
          )}
        </p>
        {err && <p className="mt-3 text-sm text-danger">{err}</p>}
      </div>
      <div className="px-5 pt-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 14px)' }}>
        <Button size="lg" full disabled={!allRequired} loading={busy} onClick={submit} variant={dark ? 'go' : 'primary'}>
          {t('موافقة ومتابعة', 'Accept and continue')}
        </Button>
        <button onClick={onSignOut} className={cx('mt-3 w-full text-center text-sm font-semibold', sub)}>
          {t('تسجيل الخروج', 'Sign out')}
        </button>
      </div>
      <AnimatePresence>{doc && <LegalViewer doc={doc} onClose={() => setDoc(null)} />}</AnimatePresence>
    </div>
  )
}
