import { useEffect, useRef, useState } from 'react'
import { Field, Input, Select, cx } from '../../ds/ui'
import { useI18n } from '../../i18n/I18n'
import { VEHICLE_MAX_AGE_YEARS, isValidSequenceNumber } from '../../compliance/validators'
import { VEHICLE_CLASSES } from '../../core/pricing'
import type { VehicleClassId } from '../../core/types'
import { BLACK_MAX_AGE, COMFORT_MAX_AGE, classifyVehicle } from '../../data/vehicleClassRules'
import { PlateInput } from './PlateInput'
import type { VehicleFields } from '../../captain/resubmit'
import { MAKES, OTHER, VEHICLE_COLORS, colorHex, findMake, vehicleYears } from '../../data/vehicleCatalog'

const ORIGIN_LABEL: Record<string, { ar: string; en: string }> = {
  jp: { ar: 'يابانية', en: 'Japanese' },
  kr: { ar: 'كورية', en: 'Korean' },
  us: { ar: 'أمريكية', en: 'American' },
  eu: { ar: 'أوروبية', en: 'European' },
  cn: { ar: 'صينية', en: 'Chinese' },
}

/**
 * Vehicle details for captain registration / resubmission: make → model (dependent
 * dropdowns from the catalogue, with «أخرى» for anything unlisted), year, colour,
 * plate, sequence number (live) and requested class.
 */
export function VehicleForm({ value, onChange, live }: { value: VehicleFields; onChange: (v: VehicleFields) => void; live: boolean }) {
  const { t, lang } = useI18n()
  const make = findMake(value.make)
  const [otherMake, setOtherMake] = useState(!!value.make && !make)
  const [otherModel, setOtherModel] = useState(!!value.model && !!make && !make.models.includes(value.model))
  const set = (patch: Partial<VehicleFields>) => onChange({ ...value, ...patch })
  const L = (x: { ar: string; en: string }) => (lang === 'en' ? x.en : x.ar)

  const makeValue = otherMake ? OTHER : (make?.id ?? '')
  const modelValue = otherMake || otherModel ? OTHER : value.model
  const years = vehicleYears()
  const grouped = (['jp', 'kr', 'us', 'eu', 'cn'] as const).flatMap((o) => MAKES.filter((m) => m.origin === o).map((m) => ({ value: m.id, label: `${lang === 'en' ? m.en : `${m.ar} · ${m.en}`}`, group: L(ORIGIN_LABEL[o]) })))

  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label={t('الشركة المصنّعة', 'Make')} className="col-span-2">
        <select
          className="h-12 w-full rounded-xl bg-ink-3 px-3 text-[15px] text-white outline-none focus:ring-2 focus:ring-go/70"
          value={makeValue}
          onChange={(e) => {
            const id = e.target.value
            setOtherModel(false)
            if (id === OTHER) {
              setOtherMake(true)
              return set({ make: '', model: '' })
            }
            setOtherMake(false)
            set({ make: MAKES.find((m) => m.id === id)?.en ?? '', model: '' })
          }}
        >
          <option value="" disabled>
            {t('— اختر الشركة —', '— Select make —')}
          </option>
          {(['jp', 'kr', 'us', 'eu', 'cn'] as const).map((o) => (
            <optgroup key={o} label={L(ORIGIN_LABEL[o])}>
              {grouped.filter((g) => g.group === L(ORIGIN_LABEL[o])).map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </optgroup>
          ))}
          <option value={OTHER}>{t('أخرى (غير مدرجة)', 'Other (not listed)')}</option>
        </select>
      </Field>
      {otherMake && (
        <Field label={t('اسم الشركة كما في الاستمارة', 'Make as on the registration')} className="col-span-2">
          <Input value={value.make} dir="ltr" maxLength={40} onChange={(e) => set({ make: e.target.value })} />
        </Field>
      )}

      <Field label={t('الطراز', 'Model')} className="col-span-2">
        {otherMake ? (
          <Input value={value.model} dir="ltr" maxLength={40} placeholder={t('اكتب الطراز', 'Type the model')} onChange={(e) => set({ model: e.target.value })} />
        ) : (
          <Select
            className="h-12 w-full"
            value={modelValue}
            onChange={(m) => {
              if (m === OTHER) {
                setOtherModel(true)
                return set({ model: '' })
              }
              setOtherModel(false)
              set({ model: m })
            }}
            options={[
              { value: '', label: make ? t('— اختر الطراز —', '— Select model —') : t('اختر الشركة أولاً', 'Select the make first') },
              ...(make?.models ?? []).map((m) => ({ value: m, label: m })),
              ...(make ? [{ value: OTHER, label: t('طراز آخر', 'Other model') }] : []),
            ]}
          />
        )}
      </Field>
      {otherModel && !otherMake && (
        <Field label={t('اسم الطراز كما في الاستمارة', 'Model as on the registration')} className="col-span-2">
          <Input value={value.model} dir="ltr" maxLength={40} onChange={(e) => set({ model: e.target.value })} />
        </Field>
      )}

      <Field label={t('سنة الصنع', 'Year')} hint={t(`حتى ${VEHICLE_MAX_AGE_YEARS} سنوات`, `Up to ${VEHICLE_MAX_AGE_YEARS} years old`)}>
        <Select className="num h-12 w-full" value={String(value.year || '')} onChange={(y) => set({ year: Number(y) })} options={[{ value: '', label: t('— السنة —', '— Year —') }, ...years.map((y) => ({ value: String(y), label: String(y) }))]} />
      </Field>
      <Field label={t('اللون', 'Colour')}>
        <div className="relative">
          <span aria-hidden className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 rounded-full ring-1 ring-white/30" style={{ background: colorHex(value.color) }} />
          <Select className="h-12 w-full ps-9" value={value.color} onChange={(c) => set({ color: c })} options={VEHICLE_COLORS.map((c) => ({ value: c.id, label: L(c) }))} />
        </div>
      </Field>

      <div className="col-span-2">
        <PlateInput digits={value.plateDigits} letters={value.plateLetters} onChange={(p) => set({ plateDigits: p.digits, plateLetters: p.letters })} />
      </div>
      {live && (
        <Field label={t('الرقم التسلسلي (الاستمارة)', 'Sequence no. (Istimara)')} className="col-span-2" error={value.sequenceNumber && !isValidSequenceNumber(value.sequenceNumber) ? t('٦–١٢ رقماً', '6–12 digits') : undefined}>
          <Input value={value.sequenceNumber} inputMode="numeric" className="num" dir="ltr" onChange={(e) => set({ sequenceNumber: e.target.value.replace(/\D/g, '').slice(0, 12) })} />
        </Field>
      )}

      <div className="col-span-2">
        <ClassPicker value={value} onChange={(c) => set({ classId: c, seats: c === 'xl' ? 7 : 4 })} />
      </div>
    </div>
  )
}

/**
 * Class chosen automatically from make / model / year / colour (see vehicleClassRules):
 * the qualifying class is selected; others are shown with the reason they do not apply.
 */
function ClassPicker({ value, onChange }: { value: VehicleFields; onChange: (c: VehicleClassId) => void }) {
  const { t } = useI18n()
  const ready = !!value.make.trim() && !!value.model.trim() && !!value.year
  const c = classifyVehicle(value)
  // Pick the class automatically whenever the vehicle changes. On first render keep a saved
  // class that still applies (e.g. a Yukon saved as XL), otherwise use the computed one.
  const first = useRef(true)
  useEffect(() => {
    if (!ready) return
    const keep = first.current && c.eligible.includes(value.classId as VehicleClassId)
    first.current = false
    if (!keep && value.classId !== c.primary) onChange(c.primary)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, value.make, value.model, value.year, value.color])

  const why = (id: VehicleClassId) => {
    const k = c.checks[id]
    if (k.ok) return c.eligible.includes(id) ? undefined : t('تغطيها فئة مركبتك الأعلى', 'Covered by your higher class')
    if (k.why === 'seats') return t('للمركبات ٧ مقاعد', '7-seat vehicles only')
    if (k.why === 'colour') return t('تتطلب لوناً أسود', 'Requires a black exterior')
    if (k.why === 'age') return id === 'black' ? t(`حتى ${BLACK_MAX_AGE} سنوات`, `Up to ${BLACK_MAX_AGE} years old`) : t(`حتى ${COMFORT_MAX_AGE} سنوات`, `Up to ${COMFORT_MAX_AGE} years old`)
    return id === 'black' ? t('للطرازات الفاخرة', 'Luxury models only') : t('للطرازات المتوسطة والفاخرة', 'Mid-size and premium models')
  }

  return (
    <div>
      <p className="mb-1 text-[13px] font-medium text-white/70">{t('الفئة', 'Class')}</p>
      <p className="mb-2 text-[11.5px] text-white/45">
        {!ready
          ? t('تُحدَّد الفئة تلقائياً بعد اختيار الشركة والطراز والسنة.', 'The class is set automatically once make, model and year are chosen.')
          : c.unlisted
            ? t('مركبة غير مدرجة: اختر الفئة المناسبة وسيتحقق منها فريق المراجعة.', 'Unlisted vehicle: pick the class; the review team will confirm it.')
            : c.eligible.length > 1
              ? t('مركبتك مؤهلة لأكثر من فئة، اختر واحدة.', 'Your vehicle qualifies for more than one class; pick one.')
              : t('حُدِّدت الفئة تلقائياً حسب طراز المركبة وسنتها ولونها.', 'Set automatically from the model, year and colour.')}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {VEHICLE_CLASSES.map((k) => {
          const enabled = ready && c.eligible.includes(k.id)
          const selected = ready && value.classId === k.id
          return (
            <button
              key={k.id}
              type="button"
              disabled={!enabled}
              aria-pressed={selected}
              onClick={() => onChange(k.id)}
              className={cx('rounded-xl px-3 py-2.5 text-start transition', selected ? 'bg-go text-ink' : enabled ? 'bg-ink-3 text-white' : 'bg-ink-2 text-white/35')}
            >
              <span className="block text-sm font-semibold" dir="ltr" style={{ textAlign: 'start' }}>
                {k.name}
              </span>
              <span className={cx('block text-[11px]', selected ? 'text-ink/70' : 'text-white/40')}>{ready ? (why(k.id) ?? (selected ? t('الفئة المختارة', 'Selected') : '')) : '—'}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
