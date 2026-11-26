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

const DOC_NAMES: Record<string, [string, string]> = {
  national_id: ['الهوية', 'ID'],
  driving_license: ['رخصة القيادة', 'driving licence'],
  profile_photo: ['الصورة الشخصية', 'profile photo'],
  vehicle_registration: ['استمارة المركبة', 'vehicle registration'],
  vehicle_insurance: ['التأمين', 'insurance'],
}
const docList = (e: string, lang: 0 | 1) =>
  (e.split(':').pop() ?? '').split(',').map((x) => DOC_NAMES[x.trim()]?.[lang] ?? x.trim()).filter(Boolean).join(lang ? ', ' : '، ')

/** Server / storage error from the captain application or resubmission → a message the captain can act on. */
export function onboardingErrorText(e: string, t: (ar: string, en: string) => string): string {
  const s = e.toLowerCase()
  if (e === 'server_outdated' || s.includes('could not find the function'))
    return t('تصحيح بيانات نفس المركبة غير متاح حالياً. اختر «مركبة أخرى» أو تواصل مع الدعم.', 'Correcting the same vehicle is not available yet. Choose “Another vehicle” or contact support.')
  if (s.includes('missing or past expiry')) return t(`تاريخ الانتهاء ناقص أو منتهٍ: ${docList(e, 0)}`, `Missing or past expiry date: ${docList(e, 1)}`)
  if (s.includes('missing documents')) return t(`مستندات ناقصة: ${docList(e, 0)}`, `Missing documents: ${docList(e, 1)}`)
  if (s.includes('accept the captain terms')) return t('يجب الموافقة على اتفاقية الكابتن وسياسة الخصوصية أولاً. سجّل الخروج ثم الدخول ووافق عليها.', 'Accept the captain agreement and privacy notices first (sign out and in again).')
  if (s.includes('add a vehicle')) return t('أضف مركبة أولاً', 'Add a vehicle first')
  if (s.includes('national id') && s.includes('not valid')) return t('رقم الهوية غير صحيح', 'The ID number is not valid')
  if (s.includes('iban')) return t('الآيبان غير صحيح', 'The IBAN is not valid')
  if (s.includes('at least 18')) return t('يجب أن يكون عمر الكابتن ١٨ سنة على الأقل', 'Captains must be at least 18')
  if (s.includes('older than')) return t('المركبة أقدم من المسموح', 'The vehicle is older than allowed')
  if (s.includes('expiry')) return t('تحقق من تواريخ انتهاء الوثائق', 'Check the document expiry dates')
  if (s.includes('already registered') || s.includes('duplicate') || s.includes('unique'))
    return t('اللوحة أو الرقم التسلسلي مسجّل لمركبة أخرى. تحقق من البيانات أو تواصل مع الدعم.', 'The plate or sequence number is registered to another vehicle.')
  if (s.includes('vehicles_plate') || s.includes('plate_letters') || s.includes('plate_number')) return t('تحقق من أرقام وحروف اللوحة', 'Check the plate digits and letters')
  if (s.includes('sequence_number')) return t('الرقم التسلسلي يجب أن يكون ٦–١٢ رقماً', 'The sequence number must be 6–12 digits')
  if (s.includes('xl_seats')) return t('فئة XL تتطلب مركبة ٧ مقاعد', 'Aura XL needs a 7-seat vehicle')
  if (s.includes('can no longer be edited') || s.includes('approved captains'))
    return t('لا يمكن تعديل هذه المركبة الآن. تواصل مع الدعم.', 'This vehicle can no longer be edited. Contact support.')
  if (s.includes('payload too large') || s.includes('exceeded the maximum') || s.includes('entity too large')) return t('حجم الملف كبير، الحد ١٠ م.ب', 'The file is too large (max 10 MB)')
  if (s.includes('mime') || s.includes('content type')) return t('نوع الملف غير مدعوم، استخدم JPG أو PNG أو PDF', 'Unsupported file type; use JPG, PNG or PDF')
  if (s.includes('row-level security') || s.includes('permission denied') || s.includes('jwt') || s.includes('not authenticated'))
    return t('انتهت الجلسة أو لا توجد صلاحية. سجّل الخروج ثم الدخول وحاول مرة أخرى.', 'Session expired or not allowed. Sign out and in, then try again.')
  if (s.includes('failed to fetch') || s === 'network' || s.includes('network')) return t('تعذّر الاتصال بالخادم، تحقق من الإنترنت وحاول مرة أخرى', 'Could not reach the server; check your connection')
  if (e.startsWith('invalid:')) return t('بعض البيانات ناقصة أو غير صحيحة', 'Some details are missing or invalid')
  return t('تعذّر إرسال الطلب، حاول مرة أخرى', 'Could not submit the application, please try again')
}
