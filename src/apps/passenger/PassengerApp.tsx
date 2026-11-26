import { useCallback, useEffect, useMemo, useState } from 'react'
import { auth } from '../../auth/authService'
import { onCrossTabSignOut } from '../../auth/session'
import { clearServerMirror, startRideSync, syncRiderSelf } from '../../data/serverMirror'
import { payments } from '../../payments/paymentsGateway'
import { hashQuery } from '../../app/router'
import { ConsentScreen, useConsentGate } from '../../privacy/ConsentScreen'
import { AnimatePresence, motion } from 'framer-motion'
import { Home, History, Wallet, User } from 'lucide-react'
import { ICON, Surface, ToastHost } from '../../ds/ui'
import { useI18n } from '../../i18n/I18n'
import { clearSession, getCustomer, getSession, setSession, useAllTrips, useEco, zoneAt } from '../../core/store'
import { UNSET_PICKUP, mayApplyFix, pickupFromFix, validatePickup } from '../../location/riderLocation'
import { useRiderLocation } from '../../location/useRiderLocation'
import { DEMO_CURRENT } from '../../core/geo'
import { isActive } from '../../core/trip'
import type { Place, Trip } from '../../core/types'
import { TabBar, screenMotion } from '../shared/mobile'
import { PassengerAuth, PassengerSplash } from './Auth'
import { ConfirmScreen, DestinationScreen, MapPickScreen, PassengerHome, ScheduleSheet, VehiclesScreen, type BookingDraft } from './Booking'
import { CancelledNotice, LiveTripScreen, SearchingScreen, TripDoneScreen } from './LiveTrip'
import { AccountTab, InboxPanel, TripsTab, WalletTab } from './Tabs'
import { AUTH_MODE } from '../../auth/config'

type Tab = 'home' | 'trips' | 'wallet' | 'account'
type Step = 'destination' | 'pick' | 'vehicles' | 'confirm'

const DISMISS_KEY = 'aura.passenger.dismissed'
const SEEN_KEY = 'aura.passenger.inboxSeen'

export function PassengerApp({ embedded }: { embedded?: boolean }) {
  const { t, dir } = useI18n()
  const [stage, setStage] = useState<'splash' | 'auth' | 'main'>(embedded && getSession().passengerId ? 'main' : 'splash')
  const [pid, setPid] = useState<string | undefined>(() => getSession().passengerId)
  const [tab, setTab] = useState<Tab>('home')
  const [step, setStep] = useState<Step | null>(null)
  const [pickTarget, setPickTarget] = useState<'pickup' | 'dropoff'>('dropoff')
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [inboxOpen, setInboxOpen] = useState(false)
  // LIVE: the pickup starts unset (GPS, a map pin or a search sets it); DEMO keeps the demo point.
  const live = AUTH_MODE === 'supabase'
  const [draft, setDraft] = useState<BookingDraft>({ pickup: live ? UNSET_PICKUP : DEMO_CURRENT, classId: 'comfort', payment: 'mada' })
  const [destEditing, setDestEditing] = useState<'pickup' | 'dropoff'>('dropoff')
  /** Where to go after the pickup pin is confirmed (when the rider had to set it mid-booking). */
  const [pickReturn, setPickReturn] = useState<Step | null>(null)
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(DISMISS_KEY) ?? '[]')
    } catch {
      return []
    }
  })
  const [seen, setSeen] = useState<number>(() => Number(localStorage.getItem(SEEN_KEY) ?? 0))

  useEco((s) => s.rev) // re-render on any store change
  const customer = getCustomer(pid)
  const loc = useRiderLocation(stage === 'main' && !!customer)
  // Apply a GPS fix to the pickup. An automatic fix never replaces a pickup the rider chose by hand;
  // an explicit "Use my location" tap does. In the demo build a
  // fix outside the demo service area is ignored (the demo city stays usable from anywhere).
  useEffect(() => {
    const pos = loc.state.status === 'located' ? loc.state.pos : undefined
    if (!pos || (!live && !zoneAt(pos).inService)) return
    setDraft((d) => (mayApplyFix(d.pickup, live, loc.state.byUser) ? { ...d, pickup: pickupFromFix(pos, loc.state.accuracyM) } : d))
  }, [loc.state, live])
  const pickupOk = validatePickup(draft.pickup, live).ok
  /** The rider must set a pickup first: open the pin screen, then continue to `next`. */
  const askPickup = (next: Step) => {
    setPickTarget('pickup')
    setPickReturn(next)
    setStep('pick')
  }
  const all = useAllTrips()
  const inboxCount = useEco((s) => (AUTH_MODE === 'supabase' ? 0 : s.inbox.filter((i) => (i.to === 'all' || i.to === 'passengers') && i.at > seen).length))

  const trip: Trip | undefined = useMemo(
    () =>
      all.find(
        (x) =>
          x.passengerId === pid &&
          !x.seeded &&
          (isActive(x.status) || (x.status === 'completed' && !x.passengerRating && !dismissed.includes(x.id)) || (x.status === 'cancelled' && x.cancel?.by !== 'passenger' && !dismissed.includes(x.id))),
      ),
    [all, pid, dismissed],
  )

  const recent = useMemo(() => {
    const seen = new Set<string>()
    const out: Place[] = []
    for (const x of all) {
      if (x.passengerId !== pid || x.dropoff.id.startsWith('d')) continue
      if (!seen.has(x.dropoff.id)) {
        seen.add(x.dropoff.id)
        out.push(x.dropoff)
      }
      if (out.length > 5) break
    }
    return out
  }, [all, pid])

  const dismiss = (id: string) => {
    const next = [...dismissed, id]
    setDismissed(next)
    try {
      sessionStorage.setItem(DISMISS_KEY, JSON.stringify(next))
    } catch {
      /* noop */
    }
    setStep(null)
    setDraft((d) => ({ ...d, dropoff: undefined, promo: undefined, scheduleAt: undefined }))
  }

  const authed = (id: string) => {
    setSession({ passengerId: id })
    setPid(id)
    setStage('main')
  }

  // Identity for privacy records: the Supabase user (supabase) or the demo customer (mock).
  const subjectId = auth.mode === 'supabase' ? getSession().riderAuthId : pid
  const gate = useConsentGate('rider', stage === 'main' && customer ? subjectId : undefined)

  const resetLocal = useCallback(() => {
    if (auth.mode === 'supabase') clearServerMirror()
    clearSession(['passengerId', 'riderAuthId'])
    setPid(undefined)
    setStage('auth')
    setTab('home')
  }, [])
  const logout = () => {
    void auth.signOut('rider')
    resetLocal()
  }

  // Back from bank 3-D Secure (#/passenger?payment=<id>): confirm the payment on the server.
  useEffect(() => {
    if (auth.mode !== 'supabase' || stage !== 'main' || !pid) return
    const paymentId = hashQuery().payment
    if (!paymentId) return
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/passenger`)
    void payments.sync(paymentId).then(() => syncRiderSelf(pid))
  }, [stage, pid])

  // Supabase: mirror this rider's rides (Realtime) into the store the screens render from.
  useEffect(() => {
    if (auth.mode !== 'supabase' || stage !== 'main' || !pid) return
    return startRideSync('rider', pid)
  }, [stage, pid])

  // Sign-out in another tab; Supabase: the session must still be valid and the account not blocked.
  useEffect(() => onCrossTabSignOut('rider', resetLocal), [resetLocal])
  useEffect(() => {
    if (auth.mode !== 'supabase' || !pid) return
    let live = true
    void auth.currentIdentity().then((id) => {
      if (live && (!id || id.blocked || id.userId !== getSession().riderAuthId)) resetLocal()
    })
    return () => {
      live = false
    }
  }, [pid, resetLocal])
  const onSplashDone = useCallback(() => setStage(getSession().passengerId ? 'main' : 'auth'), [])

  const startBooking = (dropoff?: Place, scheduleAt?: number) => {
    setDraft((d) => ({ ...d, dropoff, scheduleAt, classId: d.classId }))
    setDestEditing('dropoff')
    if (dropoff && !pickupOk) return askPickup('vehicles')
    setStep(dropoff ? 'vehicles' : 'destination')
  }

  let content: React.ReactNode
  if (stage === 'splash') content = <PassengerSplash onDone={onSplashDone} />
  else if (stage === 'auth' || !customer) content = <PassengerAuth onAuthed={authed} />
  else if (trip) {
    content =
      trip.status === 'searching' ? (
        <SearchingScreen trip={trip} />
      ) : trip.status === 'completed' ? (
        <TripDoneScreen trip={trip} onClose={() => dismiss(trip.id)} />
      ) : trip.status === 'cancelled' ? (
        <CancelledNotice trip={trip} onClose={() => dismiss(trip.id)} />
      ) : (
        <LiveTripScreen trip={trip} customerId={customer.id} />
      )
  } else if (gate.loading) content = <div className="absolute inset-0 bg-white" />
  else if (gate.missing.length > 0 && subjectId)
    content = <ConsentScreen app="rider" subjectId={subjectId} records={gate.records} onDone={() => void gate.refresh()} onSignOut={logout} />
  else if (step === 'destination')
    content = (
      <DestinationScreen
        draft={draft}
        customer={customer}
        recent={recent}
        onBack={() => setStep(null)}
        initialEditing={destEditing}
        onChoose={(p) => {
          setDraft((d) => ({ ...d, dropoff: p }))
          if (!pickupOk) return askPickup('vehicles')
          setStep('vehicles')
        }}
        onEditPickup={(p) => setDraft((d) => ({ ...d, pickup: p }))}
        onPickOnMap={(target) => {
          setPickTarget(target)
          setStep('pick')
        }}
      />
    )
  else if (step === 'pick')
    content = (
      <MapPickScreen
        target={pickTarget}
        start={pickTarget === 'pickup' ? draft.pickup : (draft.dropoff ?? draft.pickup)}
        onBack={() => {
          setPickReturn(null)
          setStep(draft.dropoff && pickTarget === 'pickup' ? 'confirm' : 'destination')
        }}
        onConfirm={(p) => {
          if (pickTarget === 'pickup') {
            setDraft((d) => ({ ...d, pickup: p }))
            setStep(pickReturn ?? (draft.dropoff ? 'confirm' : 'destination'))
            setPickReturn(null)
          } else {
            setDraft((d) => ({ ...d, dropoff: p }))
            setStep('vehicles')
          }
        }}
      />
    )
  else if (step === 'vehicles' && draft.dropoff)
    content = <VehiclesScreen draft={draft} onBack={() => setStep('destination')} onSelect={(classId) => setDraft((d) => ({ ...d, classId }))} onNext={() => setStep('confirm')} />
  else if (step === 'confirm' && draft.dropoff)
    content = (
      <ConfirmScreen
        draft={draft}
        customer={customer}
        onBack={() => (draft.scheduleAt && step === 'confirm' ? setStep('vehicles') : setStep('vehicles'))}
        onChange={(p) => setDraft((d) => ({ ...d, ...p }))}
        onConfirm={() => setStep(null)}
        onEditPickup={() => {
          setPickTarget('pickup')
          setStep('pick')
        }}
      />
    )
  else
    content = (
      <div className="absolute inset-0 flex flex-col">
        <div className="relative flex-1">
          <AnimatePresence mode="wait">
            <motion.div key={tab} {...screenMotion} className="absolute inset-0">
              {tab === 'home' && (
                <PassengerHome
                  customer={customer}
                  onWhereTo={() => startBooking()}
                  onQuick={(p) => startBooking(p)}
                  onOpenInbox={() => setInboxOpen(true)}
                  inboxCount={inboxCount}
                  onMenu={() => setTab('account')}
                  onSchedule={() => setScheduleOpen(true)}
                  pickup={draft.pickup}
                  location={loc}
                  onPickupOnMap={() => askPickup('destination')}
                  onPickupSearch={() => {
                    setDestEditing('pickup')
                    setStep('destination')
                  }}
                />
              )}
              {tab === 'trips' && <TripsTab customer={customer} />}
              {tab === 'wallet' && <WalletTab customer={customer} />}
              {tab === 'account' && (
                <AccountTab
                  customer={customer}
                  onTab={setTab}
                  onLogout={logout}
                  privacy={{ subjectId: subjectId ?? customer.id, onChanged: () => void gate.refresh() }}
                />
              )}
            </motion.div>
          </AnimatePresence>
          <AnimatePresence>
            {inboxOpen && (
              <InboxPanel
                audience="passengers"
                onClose={() => {
                  setInboxOpen(false)
                  const now = Date.now()
                  setSeen(now)
                  localStorage.setItem(SEEN_KEY, String(now))
                }}
              />
            )}
          </AnimatePresence>
          <ScheduleSheet
            open={scheduleOpen}
            onClose={() => setScheduleOpen(false)}
            onPick={(at) => {
              setScheduleOpen(false)
              startBooking(undefined, at)
            }}
          />
        </div>
        <TabBar<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { id: 'home', label: t('الرئيسية', 'Home'), icon: <Home size={22} {...ICON} /> },
            { id: 'trips', label: t('رحلاتي', 'My trips'), icon: <History size={22} {...ICON} /> },
            { id: 'wallet', label: t('المحفظة', 'Wallet'), icon: <Wallet size={22} {...ICON} /> },
            { id: 'account', label: t('حسابي', 'Account'), icon: <User size={22} {...ICON} />, badge: inboxCount || undefined },
          ]}
        />
      </div>
    )

  return (
    <Surface tone="light">
      <ToastHost contained>
        <div dir={dir} className="absolute inset-0 overflow-hidden bg-white font-sans text-ink">
          {content}
        </div>
      </ToastHost>
    </Surface>
  )
}
