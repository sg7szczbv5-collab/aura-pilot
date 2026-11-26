/**
 * Pickup row on the rider home sheet: where the ride starts and how we know it.
 * States: locating · located (± accuracy, approximate warning) · not asked yet · denied ·
 * unavailable / timeout · unsupported. Manual pickup (map pin, address search) is always offered,
 * so a refused or failed GPS never blocks the app.
 */
import { Crosshair, LocateFixed, MapPin, Search } from 'lucide-react'
import type { Place } from '../../core/types'
import { cx, ICON, Spinner } from '../../ds/ui'
import { useI18n } from '../../i18n/I18n'
import { APPROXIMATE_ACCURACY_M, GPS_PICKUP_ID, UNSET_PICKUP, type LocState, type PermissionHint } from '../../location/riderLocation'

export type PickupLocationProps = {
  pickup: Place
  location: { state: LocState; permission: PermissionHint; request: () => void }
  onPickOnMap: () => void
  onSearch: () => void
}

export function PickupLocation({ pickup, location, onPickOnMap, onSearch }: PickupLocationProps) {
  const { t, L } = useI18n()
  const { status, accuracyM } = location.state
  const unset = pickup.id === UNSET_PICKUP.id
  const fromGps = pickup.id === GPS_PICKUP_ID
  const demoPoint = pickup.id === 'current' // the demo build's fixed point, never a real position

  let tone: 'ok' | 'info' | 'warn' = 'info'
  let line: string
  if (status === 'locating') line = t('جارٍ تحديد موقعك…', 'Finding your location…')
  else if (fromGps && accuracyM && accuracyM > APPROXIMATE_ACCURACY_M) {
    tone = 'warn'
    line = t(`موقع تقريبي (± ${Math.round(accuracyM)} م) — اضبط الدبوس`, `Approximate (± ${Math.round(accuracyM)} m) — adjust the pin`)
  } else if (fromGps) {
    tone = 'ok'
    line = t('تم تحديد موقعك', 'Location found')
  } else if (status === 'denied') {
    tone = 'warn'
    line = t('إذن الموقع مرفوض. اختر نقطة الالتقاء يدوياً، أو فعّل الإذن من إعدادات المتصفح.', 'Location permission is off. Choose your pickup by hand, or allow it in your browser settings.')
  } else if (status === 'unavailable' || status === 'timeout') {
    tone = 'warn'
    line = t('تعذّر تحديد موقعك. حاول مجدداً أو اختر نقطة الالتقاء يدوياً.', 'Could not find your location. Try again or choose your pickup by hand.')
  } else if (status === 'unsupported' || status === 'insecure') {
    tone = 'warn'
    line = t('تحديد الموقع غير متاح في هذا المتصفح. اختر نقطة الالتقاء يدوياً.', 'Location is not available in this browser. Choose your pickup by hand.')
  } else if (unset) line = t('حدّد نقطة الالتقاء لطلب رحلة.', 'Set your pickup to request a ride.')
  else line = L(pickup.sub)

  const canAsk = status !== 'locating' && status !== 'denied' && status !== 'unsupported' && status !== 'insecure' && !fromGps
  return (
    <section aria-label={t('نقطة الالتقاء', 'Pickup')} className="mb-2.5 rounded-2xl border border-line px-3 py-2.5" data-testid="pickup-location">
      <div className="flex items-center gap-2.5">
        <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-full', tone === 'ok' ? 'bg-go/15 text-ink' : tone === 'warn' ? 'bg-amber-100 text-amber-800' : 'bg-road text-ink')}>
          {status === 'locating' ? <Spinner size={16} /> : <LocateFixed size={16} {...ICON} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold" data-testid="pickup-name">{unset ? t('نقطة الالتقاء غير محددة', 'No pickup yet') : demoPoint ? t('موقع تجريبي', 'Demo location') : L(pickup.name)}</p>
          <p role="status" aria-live="polite" className={cx('text-[11.5px] leading-snug', tone === 'warn' ? 'text-amber-800' : 'text-mute')} data-testid="pickup-status">{line}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {canAsk && (
          <button onClick={location.request} className="flex h-9 items-center gap-1 rounded-full bg-ink px-2.5 text-[12px] font-semibold text-white">
            <Crosshair size={14} {...ICON} />
            {status === 'unavailable' || status === 'timeout' ? t('إعادة المحاولة', 'Try again') : t('استخدام موقعي', 'Use my location')}
          </button>
        )}
        <button onClick={onPickOnMap} className="flex h-9 items-center gap-1 rounded-full bg-road px-2.5 text-[12px] font-semibold">
          <MapPin size={14} {...ICON} />
          {fromGps || !unset ? t('ضبط الدبوس', 'Adjust pin') : t('على الخريطة', 'On the map')}
        </button>
        <button onClick={onSearch} className="flex h-9 items-center gap-1 rounded-full bg-road px-2.5 text-[12px] font-semibold">
          <Search size={14} {...ICON} />
          {t('بحث بالعنوان', 'Search address')}
        </button>
      </div>
    </section>
  )
}
