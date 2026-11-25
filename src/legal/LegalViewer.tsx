import { FileText } from 'lucide-react'
import { cx, useTone } from '../ds/ui'
import { useI18n } from '../i18n/I18n'
import { Panel } from '../apps/shared/mobile'
import { LEGAL_DOCS, type LegalDocId } from './documents'

/** Full-screen reader for a legal or safety document (slides in like other sub pages). */
export function LegalViewer({ doc, onClose }: { doc: LegalDocId; onClose: () => void }) {
  const { t, L } = useI18n()
  const dark = useTone() === 'dark'
  const d = LEGAL_DOCS[doc]
  const sub = dark ? 'text-white/60' : 'text-mute'
  return (
    <Panel title={L(d.title)} onClose={onClose}>
      <div className={cx('mt-1 flex items-center gap-2 text-[12px]', sub)}>
        <FileText size={14} />
        <span>
          {t('الإصدار', 'Version')} <span className="num">{d.version}</span>
        </span>
      </div>
      {d.draft && (
        <p className={cx('mt-3 rounded-xl px-3 py-2 text-[12px] font-medium', dark ? 'bg-white/8' : 'bg-road')}>
          {t('مسودة قيد المراجعة القانونية — النص النهائي يصدر قبل الإطلاق.', 'Draft under legal review — the final text is issued before launch.')}
        </p>
      )}
      <p className={cx('mt-3 text-[13px]', sub)}>{L(d.summary)}</p>
      {d.sections.map((s) => (
        <section key={s.heading.en} className="mt-5">
          <h3 className="text-[14px] font-semibold">{L(s.heading)}</h3>
          {s.body.map((p, i) => (
            <p key={i} className={cx('mt-1.5 text-[13px] leading-relaxed', sub)}>
              {L(p)}
            </p>
          ))}
        </section>
      ))}
    </Panel>
  )
}
