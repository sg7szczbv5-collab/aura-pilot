import { useCallback, useEffect, useState } from 'react'
import { Banknote, CreditCard, Plus, ShieldCheck, Trash2, Wallet } from 'lucide-react'
import { Badge, Button, Field, ICON, Input, Row, Sheet, cx, useToast, useTone } from '../ds/ui'
import { useI18n } from '../i18n/I18n'
import { formatSar, type Halalas } from '../money/halalas'
import { CARD_TOKENIZER, cardBrand, digitsOnly, validateCard, type CardInput } from './cards'
import { payments, type CardView, type Statement } from './paymentsGateway'

const SAR = (h: Halalas) => `${formatSar(h)} SAR`

/** Saved cards for a rider, kept fresh after changes. */
export function useCards(riderId: string | undefined) {
  const [cards, setCards] = useState<CardView[]>([])
  const reload = useCallback(async () => {
    if (riderId) setCards(await payments.listCards(riderId))
  }, [riderId])
  useEffect(() => {
    void reload()
  }, [reload])
  return { cards, reload, defaultCard: cards.find((c) => c.isDefault) ?? cards[0] }
}

/** Payment methods panel: saved cards (default / remove), add card, Apple Pay, cash. */
export function SavedCards({ riderId, applePay }: { riderId: string; applePay: boolean }) {
  const { t } = useI18n()
  const { cards, reload } = useCards(riderId)
  const [adding, setAdding] = useState(false)
  return (
    <>
      <div className="divide-y divide-line rounded-2xl px-3 ring-1 ring-line">
        {cards.map((c) => (
          <Row
            key={c.id}
            icon={<CreditCard size={18} {...ICON} />}
            title={
              <span>
                {c.brand} <span className="num text-mute">•••• {c.last4}</span>
              </span>
            }
            sub={`${String(c.month).padStart(2, '0')}/${String(c.year).slice(-2)}`}
            end={
              <span className="flex items-center gap-2">
                {c.isDefault ? (
                  <Badge tone="live">{t('الافتراضية', 'Default')}</Badge>
                ) : (
                  <button className="text-xs font-semibold underline" onClick={() => void payments.setDefaultCard(riderId, c.id).then(reload)}>
                    {t('اجعلها افتراضية', 'Make default')}
                  </button>
                )}
                <button aria-label={t('حذف البطاقة', 'Remove card')} onClick={() => void payments.removeCard(riderId, c.id).then(reload)}>
                  <Trash2 size={16} className="text-mute" />
                </button>
              </span>
            }
          />
        ))}
        <Row icon={<CreditCard size={18} {...ICON} />} title="Apple Pay" sub={applePay ? t('متاحة', 'Available') : t('غير متاحة', 'Unavailable')} />
        <Row icon={<Wallet size={18} {...ICON} />} title={t('نقداً', 'Cash')} sub={t('ادفع للكابتن مباشرة', 'Pay the captain directly')} />
      </div>
      <Button variant="secondary" full className="mt-3" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
        {t('إضافة بطاقة', 'Add card')}
      </Button>
      <AddCardSheet open={adding} onClose={() => setAdding(false)} riderId={riderId} onAdded={() => void reload()} />
    </>
  )
}

export function AddCardSheet({ open, onClose, riderId, onAdded }: { open: boolean; onClose: () => void; riderId: string; onAdded: () => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const [card, setCard] = useState({ name: '', number: '', exp: '', cvc: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [verify, setVerify] = useState<{ url: string; token: string } | null>(null)
  const [m, y] = card.exp.split('/').map((x) => Number(x))
  const input: CardInput = { name: card.name, number: card.number, month: m || 0, year: y || 0, cvc: card.cvc }
  const check = validateCard(input)
  const brand = cardBrand(card.number)

  const done = () => {
    toast(t('تمت إضافة البطاقة', 'Card added'), 'success')
    setCard({ name: '', number: '', exp: '', cvc: '' })
    setVerify(null)
    onAdded()
    onClose()
  }
  const submit = async () => {
    setBusy(true)
    setErr('')
    const r = await payments.addCard(riderId, input)
    setBusy(false)
    if (r.ok) return done()
    if (r.error === 'verification_required' && r.verificationUrl && r.token) {
      setVerify({ url: r.verificationUrl, token: r.token })
      window.open(r.verificationUrl, '_blank', 'noopener')
      return
    }
    setErr(r.error === 'payments_disabled' ? t('الدفع بالبطاقة غير متاح في هذه البيئة', 'Card payments are not available in this environment') : r.error === 'declined' ? t('رُفضت البطاقة', 'Card declined') : r.error === 'invalid_card' ? t('بيانات البطاقة غير صحيحة', 'Invalid card details') : t('تعذّر حفظ البطاقة', 'Could not save the card'))
  }
  const confirmVerified = async () => {
    if (!verify) return
    setBusy(true)
    const r = await payments.confirmCard(riderId, verify.token)
    setBusy(false)
    if (r.ok) done()
    else setErr(t('لم يكتمل التحقق من البطاقة', 'Card verification is not complete'))
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('إضافة بطاقة', 'Add card')}>
      {verify ? (
        <div className="text-center">
          <ShieldCheck size={30} className="mx-auto text-go-deep" />
          <p className="mt-2 text-sm">{t('أكمل التحقق الآمن من البنك في النافذة المفتوحة ثم عد هنا.', 'Complete the bank verification in the opened window, then come back here.')}</p>
          <Button full className="mt-4" loading={busy} onClick={confirmVerified}>
            {t('أكملت التحقق', "I've completed verification")}
          </Button>
          <a className="mt-3 block text-xs font-semibold underline" href={verify.url} target="_blank" rel="noopener noreferrer">
            {t('فتح صفحة التحقق مجدداً', 'Open verification page again')}
          </a>
        </div>
      ) : (
        <div className="grid gap-3">
          <Field label={t('الاسم على البطاقة', 'Name on card')}>
            <Input dir="ltr" autoComplete="cc-name" value={card.name} onChange={(e) => setCard({ ...card, name: e.target.value })} />
          </Field>
          <Field label={t('رقم البطاقة', 'Card number')} hint={brand !== 'unknown' ? brand : undefined}>
            <Input
              dir="ltr"
              inputMode="numeric"
              autoComplete="cc-number"
              value={card.number}
              invalid={!!card.number && !check.ok && check.field === 'number'}
              onChange={(e) => setCard({ ...card, number: digitsOnly(e.target.value).slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ') })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('تاريخ الانتهاء', 'Expiry')}>
              <Input
                dir="ltr"
                inputMode="numeric"
                autoComplete="cc-exp"
                placeholder="MM/YY"
                value={card.exp}
                onChange={(e) => {
                  const d = digitsOnly(e.target.value).slice(0, 4)
                  setCard({ ...card, exp: d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d })
                }}
              />
            </Field>
            <Field label="CVC">
              <Input dir="ltr" inputMode="numeric" autoComplete="cc-csc" type="password" value={card.cvc} onChange={(e) => setCard({ ...card, cvc: digitsOnly(e.target.value).slice(0, 4) })} />
            </Field>
          </div>
          {err && <p className="text-sm text-danger">{err}</p>}
          <p className="text-[11.5px] text-mute">
            {CARD_TOKENIZER === 'moyasar'
              ? t('تُرسل بيانات البطاقة مباشرة إلى بوابة الدفع (ميسّر). لا تحفظ أورا رقم البطاقة.', 'Card details go directly to the payment gateway (Moyasar). AURA never stores your card number.')
              : t('وضع الاختبار: 4111 1111 1111 1111 مقبولة، 4000 0000 0000 0002 مرفوضة، 4000 0000 0000 3220 تتطلب تحققاً.', 'Test mode: 4111 1111 1111 1111 succeeds, 4000 0000 0000 0002 is declined, 4000 0000 0000 3220 needs verification.')}
          </p>
          <Button full size="lg" loading={busy} disabled={!check.ok} onClick={submit}>
            {t('حفظ البطاقة', 'Save card')}
          </Button>
        </div>
      )}
    </Sheet>
  )
}

/** Captain: server statement for a period, balance and payout request (supabase mode). */
export function DriverStatementCard({ from }: { from: Date }) {
  const { t } = useI18n()
  const toast = useToast()
  const dark = useTone() === 'dark'
  const [s, setS] = useState<Statement | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => setS(await payments.driverStatement(from)), [from])
  useEffect(() => {
    void load()
  }, [load])
  if (payments.mode !== 'supabase' || !s) return null

  const owes = s.balance < 0n
  const canPayout = s.balance >= 5000n && !s.openPayout
  const line = (k: string, v: Halalas, neg = false) => (
    <div className="flex justify-between py-1.5 text-[13px]">
      <span className={dark ? 'text-white/55' : 'text-mute'}>{k}</span>
      <span className="num" dir="ltr">
        {neg && v > 0n ? '−' : ''}
        {SAR(v)}
      </span>
    </div>
  )
  const payout = async () => {
    setBusy(true)
    const r = await payments.requestPayout(s.balance)
    setBusy(false)
    toast(r.ok ? t('تم طلب التحويل', 'Payout requested') : t('تعذّر طلب التحويل', 'Could not request a payout'), r.ok ? 'success' : 'error')
    void load()
  }

  return (
    <div className={cx('mt-4 rounded-3xl p-4', dark ? 'bg-ink-2 ring-1 ring-white/6' : 'bg-road')}>
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold">{t('كشف الحساب', 'Statement')}</p>
        <Banknote size={18} {...ICON} />
      </div>
      <p className={cx('num mt-2 text-[28px] font-semibold', owes && 'text-danger')} dir="ltr">
        {SAR(s.balance)}
      </p>
      <p className={cx('text-[12px]', dark ? 'text-white/50' : 'text-mute')}>
        {owes ? t('مستحق لأورا من الرحلات النقدية (عمولة وضريبة)', 'Owed to AURA from cash trips (commission and VAT)') : t('الرصيد القابل للتحويل', 'Available to transfer')}
      </p>
      <div className={cx('mt-3 border-t pt-2', dark ? 'border-white/8' : 'border-line')}>
        {line(t('إجمالي الأجرة', 'Gross fares'), s.gross)}
        {line(t('عمولة أورا', 'AURA commission'), s.commission, true)}
        {line(t('أرباحك من الرحلات', 'Your ride earnings'), s.earnings)}
        {line(t('الإكراميات', 'Tips'), s.tips)}
        {line(t('نقد محصّل', 'Cash collected'), s.cashCollected, true)}
        {line(t('إيداعات نقدية', 'Cash deposited'), s.cashDeposited)}
        {line(t('تحويلات مستلمة', 'Paid out'), s.paidOut, true)}
      </div>
      {s.openPayout ? (
        <p className="mt-3 text-[12.5px] font-semibold">
          {t('تحويل قيد المعالجة:', 'Payout in progress:')} <span className="num">{SAR(s.openPayout.amount)}</span>
        </p>
      ) : (
        <Button variant="go" full className="mt-3" disabled={!canPayout} loading={busy} onClick={payout}>
          {t('تحويل الرصيد إلى الآيبان', 'Transfer balance to IBAN')}
        </Button>
      )}
    </div>
  )
}

/** Server wallet balance for a rider (supabase) — BigInt halalas. */
export function useServerWallet(ownerId: string | undefined) {
  const [balance, setBalance] = useState<Halalas | null>(null)
  const reload = useCallback(async () => {
    if (!ownerId || payments.mode !== 'supabase') return
    setBalance((await payments.wallet(ownerId, 'rider_wallet')).balance)
  }, [ownerId])
  useEffect(() => {
    void reload()
  }, [reload])
  return { balance, reload }
}
