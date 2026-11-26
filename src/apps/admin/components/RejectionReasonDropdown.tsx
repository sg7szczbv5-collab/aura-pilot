import { useState } from 'react'
import { Field, Input, Select } from '../../../ds/ui'
import { useI18n } from '../../../i18n/I18n'

/**
 * Preset reasons for rejecting / suspending a captain document or application.
 * `value` is what gets stored (in Arabic, the language the captain app shows it in);
 * `en` is only the admin-facing label in English mode.
 */
export const REJECTION_REASONS = [
  { id: 'unclear', value: 'عدم وضوح الوثيقة أو رداءة التصوير', en: 'Unclear document or poor photo quality' },
  { id: 'expired', value: 'انتهاء صلاحية الوثيقة أو التأمين', en: 'Document or insurance has expired' },
  { id: 'mismatch', value: 'عدم تطابق البيانات', en: 'Data does not match' },
  { id: 'class', value: 'عدم استيفاء شروط الفئة المطلوبة', en: 'Does not meet the requirements of the requested class' },
  { id: 'missing', value: 'نقص في المرفقات أو البيانات المطلوبة', en: 'Missing attachments or required data' },
] as const

const OTHER = 'other'
const MAX_LEN = 500

/** Trim, collapse inner whitespace and cap the length of a free-text reason. */
export const cleanReason = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_LEN)

type Props = {
  /** Receives the final, cleaned reason text — or '' when nothing valid is selected yet. */
  onChange: (reason: string) => void
  label?: string
  disabled?: boolean
  error?: string
  className?: string
}

/**
 * Dropdown of rejection / suspension reasons. Choosing «سبب آخر» reveals a text field;
 * the parent only ever sees the final clean text through `onChange`.
 * Uncontrolled: give it a `key` (e.g. the record id) to reset it.
 */
export function RejectionReasonDropdown({ onChange, label, disabled, error, className }: Props) {
  const { t } = useI18n()
  const [choice, setChoice] = useState('')
  const [other, setOther] = useState('')

  const pick = (id: string) => {
    setChoice(id)
    if (id === OTHER) return onChange(cleanReason(other))
    onChange(REJECTION_REASONS.find((r) => r.id === id)?.value ?? '')
  }

  const type = (text: string) => {
    setOther(text.slice(0, MAX_LEN))
    onChange(cleanReason(text))
  }

  return (
    // A disabled <fieldset> disables every control inside it (Select has no `disabled` prop).
    <fieldset disabled={disabled} className={`min-w-0 ${className ?? ''}`}>
      <Field label={label ?? t('سبب الرفض / الإيقاف', 'Reason (reject / suspend)')} error={choice === OTHER ? undefined : error}>
        <Select
          className="w-full"
          value={choice}
          onChange={pick}
          options={[
            { value: '', label: t('— اختر السبب —', '— Select a reason —') },
            ...REJECTION_REASONS.map((r) => ({ value: r.id, label: t(r.value, r.en) })),
            { value: OTHER, label: t('سبب آخر', 'Other reason') },
          ]}
        />
      </Field>
      {choice === OTHER && (
        <Field className="mt-2" label={t('اكتب السبب', 'Describe the reason')} error={error} hint={`${other.length}/${MAX_LEN}`}>
          <Input
            autoFocus
            value={other}
            maxLength={MAX_LEN}
            placeholder={t('مثال: الصورة لا تُظهر تاريخ الانتهاء', 'e.g. the photo does not show the expiry date')}
            invalid={!!error}
            onChange={(e) => type(e.target.value)}
          />
        </Field>
      )}
    </fieldset>
  )
}
