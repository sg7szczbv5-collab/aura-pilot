import { useState } from 'react'
import { Field, Input, Select, cx } from '../../ds/ui'
import { useI18n } from '../../i18n/I18n'
import { VEHICLE_MAX_AGE_YEARS, isValidSequenceNumber } from '../../compliance/validators'
import { VEHICLE_CLASSES } from '../../core/pricing'
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

      <Field label={t('أرقام اللوحة', 'Plate digits')}>
        <Input value={value.plateDigits} inputMode="numeric" className="num" dir="ltr" placeholder="1234" onChange={(e) => set({ plateDigits: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
      </Field>
      <Field label={t('حروف اللوحة (EN)', 'Plate letters')}>
        <Input value={value.plateLetters} className="num uppercase" dir="ltr" placeholder="RHB" onChange={(e) => set({ plateLetters: e.target.value.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase() })} />
      </Field>
      {live && (
        <Field label={t('الرقم التسلسلي (الاستمارة)', 'Sequence no. (Istimara)')} className="col-span-2" error={value.sequenceNumber && !isValidSequenceNumber(value.sequenceNumber) ? t('٦–١٢ رقماً', '6–12 digits') : undefined}>
          <Input value={value.sequenceNumber} inputMode="numeric" className="num" dir="ltr" onChange={(e) => set({ sequenceNumber: e.target.value.replace(/\D/g, '').slice(0, 12) })} />
        </Field>
      )}

      <div className="col-span-2">
        <p className="mb-2 text-[13px] font-medium text-white/70">{t('الفئة المطلوبة', 'Requested class')}</p>
        <div className="grid grid-cols-2 gap-2">
          {VEHICLE_CLASSES.map((c) => (
            <button key={c.id} type="button" onClick={() => set({ classId: c.id, seats: c.id === 'xl' ? 7 : 4 })} className={cx('rounded-xl px-3 py-2.5 text-start text-sm font-semibold', value.classId === c.id ? 'bg-go text-ink' : 'bg-ink-3')} dir="ltr">
              {c.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
