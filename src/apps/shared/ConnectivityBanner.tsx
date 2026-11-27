/** A2.3 — "No connection" banner for the captain and the rider during a trip. */
import { useEffect, useState } from 'react'
import { WifiOff } from 'lucide-react'
import { useI18n } from '../../i18n/I18n'
import { connectivity } from '../../data/connectivity'

export function useOnline(): boolean {
  const [on, setOn] = useState(connectivity.isOnline())
  useEffect(() => connectivity.subscribe(setOn), [])
  return on
}

export function ConnectivityBanner() {
  const { t } = useI18n()
  const online = useOnline()
  if (online) return null
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      className="pointer-events-none absolute inset-x-3 z-50 flex items-center gap-2 rounded-2xl bg-amber-100 px-3 py-2 text-[12.5px] font-semibold text-amber-900 shadow-lg"
      style={{ top: 'calc(var(--safe-top) + 64px)' }}
    >
      <WifiOff size={16} />
      <span>{t('لا يوجد اتصال بالإنترنت. ما تراه هو آخر حالة أكدها الخادم، وسنحدّثها عند عودة الاتصال.', 'No internet connection. You are seeing the last state the server confirmed; it will refresh when you are back online.')}</span>
    </div>
  )
}
