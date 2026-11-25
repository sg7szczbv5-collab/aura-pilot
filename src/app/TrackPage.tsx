import { useEffect, useState } from 'react'
import { Car, ShieldCheck } from 'lucide-react'
import { Wordmark } from '../ds/Logo'
import { Badge, Spinner, Surface } from '../ds/ui'
import { useI18n } from '../i18n/I18n'
import { CityMap, type MapMarker } from '../map/CityMap'
import { STATUS_LABEL } from '../core/trip'
import type { TripStatus } from '../core/types'
import { AUTH_MODE } from '../auth/config'
import { fetchSharedTrip, SAUDI_EMERGENCY_NUMBER, type SharedTrip } from '../safety/safety'

/** #/track/<token>: what a rider's family or friends see from a shared link. No account needed. */
export function TrackPage({ token }: { token: string }) {
  const { t, L, dir } = useI18n()
  const [trip, setTrip] = useState<SharedTrip | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'gone'>('loading')

  useEffect(() => {
    let alive = true
    const load = async () => {
      const v = await fetchSharedTrip(token)
      if (!alive) return
      setTrip(v)
      setState(v ? 'ok' : 'gone')
    }
    void load()
    const id = window.setInterval(load, 10_000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [token])

  const markers: MapMarker[] = trip
    ? [
        { id: 'p', pos: { lat: trip.pickup.lat, lng: trip.pickup.lng }, kind: 'pickup' },
        { id: 'd', pos: { lat: trip.dropoff.lat, lng: trip.dropoff.lng }, kind: 'dropoff' },
        ...(trip.location ? [{ id: 'car', pos: { lat: trip.location.lat, lng: trip.location.lng }, kind: 'car' as const, heading: Number(trip.location.heading ?? 0) }] : []),
      ]
    : []

  return (
    <Surface tone="light">
      <div dir={dir} className="relative flex min-h-screen flex-col bg-white font-sans text-ink">
        <header className="flex items-center justify-between px-5 py-4">
          <Wordmark width={84} />
          <Badge tone="live">{t('تتبّع مباشر', 'Live tracking')}</Badge>
        </header>
        {state === 'loading' && (
          <div className="flex flex-1 items-center justify-center">
            <Spinner size={28} />
          </div>
        )}
        {state === 'gone' && (
          <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
            <ShieldCheck size={40} className="text-mute" />
            <h1 className="mt-3 font-display text-xl font-semibold">{t('انتهت صلاحية رابط التتبّع', 'This tracking link has ended')}</h1>
            <p className="mt-1 text-sm text-mute">
              {AUTH_MODE === 'supabase'
                ? t('تنتهي الروابط بعد الرحلة بقليل أو عند إلغائها من الراكب.', 'Links end shortly after the trip, or when the rider turns them off.')
                : t('التتبّع المباشر يعمل عند ربط التطبيق بالخادم.', 'Live tracking works when the app is connected to the server.')}
            </p>
          </div>
        )}
        {state === 'ok' && trip && (
          <>
            <div className="relative h-[55vh] min-h-[320px]">
              <CityMap fit={markers.map((m) => m.pos)} fitKey={`${trip.ride_number}-${trip.status}`} markers={markers} padding={[60, 40, 60, 40]} />
            </div>
            <div className="-mt-6 flex-1 rounded-t-[28px] bg-white px-5 pt-5 shadow-[0_-4px_20px_rgba(16,17,18,.08)]">
              <p className="text-xs text-mute">
                {t('رحلة', 'Trip')} <span className="num">#{trip.ride_number}</span>
              </p>
              <h1 className="mt-0.5 font-display text-xl font-semibold">{L(STATUS_LABEL[trip.status as TripStatus] ?? { ar: trip.status, en: trip.status })}</h1>
              {trip.captain && trip.vehicle && (
                <div className="mt-4 flex items-center gap-3 rounded-2xl bg-road p-3">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-white">
                    <Car size={20} />
                  </span>
                  <div className="flex-1">
                    <p className="text-sm font-semibold">{trip.captain.first_name}</p>
                    <p className="text-xs text-mute">
                      {trip.vehicle.color} {trip.vehicle.make} {trip.vehicle.model}
                    </p>
                  </div>
                  <span className="num rounded-lg bg-white px-2 py-1 text-sm font-semibold" dir="ltr">
                    {trip.vehicle.plate}
                  </span>
                </div>
              )}
              <div className="mt-3 space-y-1.5 text-sm">
                <p>
                  <span className="text-mute">{t('من', 'From')}:</span> {trip.pickup.address}
                </p>
                <p>
                  <span className="text-mute">{t('إلى', 'To')}:</span> {trip.dropoff.address}
                </p>
              </div>
              <p className="mt-4 rounded-xl bg-road px-3 py-2 text-[12px] text-mute">
                {t(`في حال الخطر اتصل فوراً بالطوارئ ${SAUDI_EMERGENCY_NUMBER}.`, `In an emergency call ${SAUDI_EMERGENCY_NUMBER} immediately.`)}
              </p>
            </div>
          </>
        )}
      </div>
    </Surface>
  )
}
