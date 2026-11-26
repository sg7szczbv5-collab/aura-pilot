import { useRef } from 'react'
import { FileCheck2, FileUp, X } from 'lucide-react'
import { Button, cx, Field, ICON, Input } from '../../ds/ui'
import { useI18n } from '../../i18n/I18n'

/* Form pieces shared by the captain application and the resubmission screen. */

export function ExpiryField({ value, onChange, min }: { value?: string; onChange: (v: string) => void; min: string }) {
  const { t } = useI18n()
  return (
    <Field label={t('تاريخ الانتهاء', 'Expiry date')} error={value && value < min ? t('الوثيقة منتهية', 'Document has expired') : undefined}>
      <Input type="date" dir="ltr" value={value ?? ''} min={min} onChange={(e) => onChange(e.target.value)} />
    </Field>
  )
}

export const LATIN_TO_AR: Record<string, string> = { A: 'أ', B: 'ب', J: 'ح', D: 'د', R: 'ر', S: 'س', X: 'ص', T: 'ط', E: 'ع', G: 'ق', K: 'ك', L: 'ل', Z: 'م', N: 'ن', H: 'ه', U: 'و', V: 'ى' }

export function UploadTile({ label, file, onFile, icon }: { label: string; file?: string; onFile: (name: string | undefined, file?: File) => void; icon?: React.ReactNode }) {
  const { t } = useI18n()
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div className={cx('flex items-center gap-3 rounded-2xl p-3.5', file ? 'bg-go/10 ring-1 ring-go/40' : 'bg-ink-2 ring-1 ring-white/8')}>
      <span className={cx('flex size-11 items-center justify-center rounded-xl', file ? 'bg-go text-ink' : 'bg-ink-3')}>{file ? <FileCheck2 size={20} {...ICON} /> : (icon ?? <FileUp size={20} {...ICON} />)}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{label}</p>
        <p className="truncate text-xs text-white/50">{file ?? t('لم يتم الرفع', 'Not uploaded')}</p>
      </div>
      {file ? (
        <button aria-label={t('إزالة', 'Remove')} onClick={() => onFile(undefined)} className="text-white/60">
          <X size={18} />
        </button>
      ) : (
        <Button size="sm" variant="primary" onClick={() => ref.current?.click()}>
          {t('رفع', 'Upload')}
        </Button>
      )}
      <input
        ref={ref}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f.name, f)
        }}
      />
    </div>
  )
}

export function onboardingErrorText(e: string, t: (ar: string, en: string) => string): string {
  if (e.includes('national ID')) return t('رقم الهوية غير صحيح', 'The ID number is not valid')
  if (e.includes('IBAN')) return t('الآيبان غير صحيح', 'The IBAN is not valid')
  if (e.includes('older than')) return t('المركبة أقدم من المسموح', 'The vehicle is older than allowed')
  if (e.includes('expiry')) return t('تحقق من تواريخ انتهاء الوثائق', 'Check the document expiry dates')
  if (e.includes('duplicate') || e.includes('unique')) return t('اللوحة أو الرقم التسلسلي أو رقم الهوية مسجّل مسبقاً', 'The plate, sequence number or ID is already registered')
  if (e.startsWith('invalid:')) return t('بعض البيانات ناقصة أو غير صحيحة', 'Some details are missing or invalid')
  return t('تعذّر إرسال الطلب، حاول مرة أخرى', 'Could not submit the application, please try again')
}
