import { useEffect, useState } from 'react'
import { offerAlert, type AlertStatus } from './offerAlert'

/** Live alert status for the captain UI (sound ready / locked / muted / unsupported, vibration, ringing). */
export function useOfferAlertStatus(): AlertStatus {
  const [s, setS] = useState(() => offerAlert.status())
  useEffect(() => offerAlert.subscribe(() => setS(offerAlert.status())), [])
  return s
}

/**
 * Ring while an offer card is shown; stop when it goes away (withdrawn, taken, screen changed). The
 * accept / decline buttons call offerAlert.resolve() so the same offer can never ring again.
 */
export function useRingForOffer(offerId: string, expiresAt: number) {
  useEffect(() => {
    offerAlert.start(offerId, expiresAt)
    return () => offerAlert.stop(offerId)
  }, [offerId, expiresAt])
}
