import { useI18n } from '../../i18n/I18n'
import { PLATE_LETTERS } from '../../compliance/validators'
import { LATIN_TO_AR } from './formParts'

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const toArabicDigits = (s: string) => s.replace(/\d/g, (d) => AR_DIGITS[Number(d)])
/** Arabic plate letter → Latin (أ→A, ح→J, هـ→H …); also accepts ا/إ/آ, ه/ة and ي. */
const AR_TO_LATIN: Record<string, string> = {
  ...Object.fromEntries(Object.entries(LATIN_TO_AR).map(([l, a]) => [a, l])),
  ا: 'A', إ: 'A', آ: 'A', ة: 'H', ي: 'V',
}

/** Keep only Saudi plate letters (Latin or Arabic input), upper-case Latin, max 3. */
export function normalizePlateLetters(input: string): string {
  return [...input]
    .map((ch) => AR_TO_LATIN[ch] ?? ch.toUpperCase())
    .filter((ch) => PLATE_LETTERS.includes(ch))
    .join('')
    .slice(0, 3)
}
export const plateLettersAr = (latin: string) => [...latin].map((l) => LATIN_TO_AR[l] ?? l).join(' ')

/**
 * Plate entry drawn as a Saudi licence plate: numbers on the left, letters on the right,
 * Arabic on the top row (filled in automatically) and Latin on the bottom row (typed),
 * with the KSA strip. Letters can be typed in Arabic or English.
 */
export function PlateInput({ digits, letters, onChange, invalid }: { digits: string; letters: string; onChange: (v: { digits: string; letters: string }) => void; invalid?: boolean }) {
  const { t } = useI18n()
  const cell = 'flex h-14 items-center justify-center'
  const field = 'num h-full w-full bg-transparent text-center text-[26px] font-bold tracking-[0.2em] text-ink outline-none placeholder:text-ink/20'
  return (
    <div>
      <p className="mb-1.5 text-[13px] font-medium text-white/70">{t('لوحة المركبة', 'Number plate')}</p>
      <div
        dir="ltr"
        className={`flex overflow-hidden rounded-xl border-[3px] bg-white text-ink shadow-[inset_0_0_0_2px_#fff] ${invalid ? 'border-danger' : 'border-ink'}`}
        role="group"
        aria-label={t('لوحة المركبة', 'Number plate')}
      >
        <div className="grid flex-1 grid-cols-2 divide-x-[3px] divide-ink">
          {/* Numbers */}
          <div className="flex flex-col divide-y-[3px] divide-ink">
            <div className={`${cell} text-[28px] font-bold tracking-[0.15em]`} aria-hidden>
              {digits ? toArabicDigits(digits) : <span className="text-ink/20">{'١٢٣٤'}</span>}
            </div>
            <div className={cell}>
              <input
                aria-label={t('أرقام اللوحة', 'Plate digits')}
                className={field}
                inputMode="numeric"
                placeholder="1234"
                value={digits}
                onChange={(e) => onChange({ digits: e.target.value.replace(/[^\d٠-٩]/g, '').replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d))).slice(0, 4), letters })}
              />
            </div>
          </div>
          {/* Letters */}
          <div className="flex flex-col divide-y-[3px] divide-ink">
            <div className={`${cell} text-[26px] font-bold`} dir="rtl" aria-hidden>
              {letters ? plateLettersAr(letters) : <span className="text-ink/20">{'ب ح ر'}</span>}
            </div>
            <div className={cell}>
              <input
                aria-label={t('حروف اللوحة', 'Plate letters')}
                className={`${field} uppercase`}
                placeholder="BJR"
                autoCapitalize="characters"
                value={letters}
                onChange={(e) => onChange({ digits, letters: normalizePlateLetters(e.target.value) })}
              />
            </div>
          </div>
        </div>
        {/* KSA strip */}
        <div className="flex w-11 flex-col items-center justify-between border-s-[3px] border-ink bg-white py-1.5">
          <span className="text-[9px] font-bold leading-none" dir="rtl">
            السعودية
          </span>
          <span className="flex flex-col items-center text-[13px] font-extrabold leading-[1.05]">
            <span>K</span>
            <span>S</span>
            <span>A</span>
          </span>
        </div>
      </div>
      <p className="mt-1.5 text-[11.5px] text-white/45">
        {t('اكتب الحروف بالعربي أو الإنجليزي، والصف العلوي يُكمَل تلقائياً. الحروف المسموحة:', 'Type letters in Arabic or English; the top row fills in. Allowed letters:')}{' '}
        <span dir="rtl">{plateLettersAr(PLATE_LETTERS)}</span>
      </p>
    </div>
  )
}
