import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { auth } from '../../auth/authService'
import { onCrossTabSignOut } from '../../auth/session'
import { clearServerMirror, startRideSync } from '../../data/serverMirror'
import { trips as tripGateway } from '../../data/tripGateway'
import { useDriverGps } from '../../data/liveHooks'
import { ConnectivityBanner } from '../shared/ConnectivityBanner'
import { screenWakeLock } from '../../captain/wakeLock'
import { createBackgroundWatch, type Away } from '../../captain/backgroundWatch'
import { BackgroundNotice } from './Work'
import { ConsentScreen, useConsentGate } from '../../privacy/ConsentScreen'
import { AnimatePresence, motion } from 'framer-motion'
import { Home, History, Wallet, User } from 'lucide-react'
import { ICON, Surface, ToastHost } from '../../ds/ui'
import { useI18n } from '../../i18n/I18n'
import { clearSession, getDriver, getSession, setSession, useEco } from '../../core/store'
import { isActive } from '../../core/trip'
import { TabBar, screenMotion } from '../shared/mobile'
import { ApplicationStatus, DriverAuth, DriverSplash } from './Onboarding'
import { DriverActiveTrip, DriverHome, DriverTripSummary } from './Work'
import { DriverAccountTab, DriverTripsTab, EarningsTab, PerformancePanel } from './Tabs'
import { InboxPanel } from '../passenger/Tabs'

type Tab = 'home' | 'trips' | 'earnings' | 'account'
const DISMISS_KEY = 'aura.driver.dismissed'
const SEEN_KEY = 'aura.driver.inboxSeen'

export function DriverApp({ embedded }: { embedded?: boolean }) {
  const { t, dir } = useI18n()
  const [stage, setStage] = useState<'splash' | 'auth' | 'main'>(embedded && getSession().driverId ? 'main' : 'splash')
  const [did, setDid] = useState<string | undefined>(() => getSession().driverId)
  const [tab, setTab] = useState<Tab>('home')
  const [perf, setPerf] = useState(false)
  const [inbox, setInbox] = useState(false)
  const [seen, setSeen] = useState(() => Number(localStorage.getItem(SEEN_KEY) ?? 0))
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(DISMISS_KEY) ?? '[]')
    } catch {
      return []
    }
  })
  const trips = useEco((s) => s.trips)
  const inboxCount = useEco((s) => (auth.mode === 'supabase' ? 0 : s.inbox.filter((i) => (i.to === 'all' || i.to === 'captains') && i.at > seen).length))
  useEco((s) => s.rev)
  const driver = getDriver(did)
  // Show the approval welcome once if this captain was under review during this session.
  const [wasPending, setWasPending] = useState(false)
  if (driver && driver.status !== 'approved' && !wasPending) setWasPending(true)

  const active = useMemo(
    () => trips.find((x) => x.driverId === did && (isActive(x.status) || (x.status === 'completed' && !x.driverRating && !dismissed.includes(x.id)))),
    [trips, did, dismissed],
  )

  const onSplash = useCallback(() => setStage(getSession().driverId ? 'main' : 'auth'), [])
  const resetLocal = useCallback(() => {
    const id = getSession().driverId
    if (id) void tripGateway.setOnline(id, false)
    if (auth.mode === 'supabase') clearServerMirror()
    clearSession(['driverId', 'driverAuthId'])
    setDid(undefined)
    setStage('auth')
    setTab('home')
  }, [])
  const logout = () => {
    void auth.signOut('driver')
    resetLocal()
  }

  // Identity for privacy records: the Supabase user (supabase) or the demo captain (mock).
  const subjectId = auth.mode === 'supabase' ? getSession().driverAuthId : did
  const gate = useConsentGate('driver', stage === 'main' && driver ? subjectId : undefined)

  // Missing required consents (e.g. location withdrawn) → offline immediately.
  useEffect(() => {
    if (driver?.online && !gate.loading && gate.missing.length > 0) void tripGateway.setOnline(driver.id, false)
  }, [driver, gate.loading, gate.missing.length])

  // Supabase: mirror offers/rides for this captain and stream GPS while online.
  useEffect(() => {
    if (auth.mode !== 'supabase' || stage !== 'main' || !did) return
    return startRideSync('driver', did)
  }, [stage, did])
  const { state: gps, lastSentAt } = useDriverGps(auth.mode === 'supabase' && stage === 'main' && !!driver?.online)
  const online = stage === 'main' && !!driver?.online
  // A2.4: keep the screen on only while the captain is online; released when offline / signed out.
  useEffect(() => {
    void screenWakeLock.want(online)
  }, [online])
  useEffect(() => () => void screenWakeLock.want(false), [])
  // A2.4: tell the captain, honestly, what a stay in the background meant (resync runs in serverMirror).
  const [away, setAway] = useState<Away | null>(null)
  const watch = useMemo(() => createBackgroundWatch(() => Date.now()), [])
  const onlineRef = useRef(online)
  onlineRef.current = online
  useEffect(() => {
    const f = () => {
      if (document.visibilityState === 'hidden') watch.hidden(onlineRef.current)
      else {
        const a = watch.visible(onlineRef.current)
        if (a) setAway(a)
      }
    }
    document.addEventListener('visibilitychange', f)
    return () => document.removeEventListener('visibilitychange', f)
  }, [watch])

  useEffect(() => onCrossTabSignOut('driver', resetLocal), [resetLocal])
  useEffect(() => {
    if (auth.mode !== 'supabase' || !did) return
    let live = true
    void auth.currentIdentity().then((id) => {
      if (live && (!id || id.blocked || id.userId !== getSession().driverAuthId)) resetLocal()
    })
    return () => {
      live = false
    }
  }, [did, resetLocal])
  const dismiss = (id: string) => {
    const next = [...dismissed, id]
    setDismissed(next)
    try {
      sessionStorage.setItem(DISMISS_KEY, JSON.stringify(next))
    } catch {
      /* noop */
    }
  }

  let content: React.ReactNode
  if (stage === 'splash') content = <DriverSplash onDone={onSplash} />
  else if (stage === 'auth' || !driver)
    content = (
      <DriverAuth
        onAuthed={(id) => {
          setSession({ driverId: id })
          setDid(id)
          setStage('main')
        }}
      />
    )
  else if (!active && gate.loading) content = <div className="absolute inset-0 bg-ink" />
  else if (!active && gate.missing.length > 0 && subjectId)
    content = <ConsentScreen app="driver" subjectId={subjectId} records={gate.records} onDone={() => void gate.refresh()} onSignOut={logout} />
  else if (driver.status !== 'approved' || wasPending) content = (
      <ApplicationStatus
        driverId={driver.id}
        onApproved={() => { setWasPending(false); setTab('home') }}
        onLogout={logout}
      />
    )
  else if (active) content = active.status === 'completed' ? <DriverTripSummary trip={active} onDone={() => dismiss(active.id)} /> : <DriverActiveTrip trip={active} driver={driver} />
  else
    content = (
      <div className="absolute inset-0 flex flex-col">
        <div className="relative flex-1">
          <AnimatePresence mode="wait">
            <motion.div key={tab} {...screenMotion} className="absolute inset-0">
              {tab === 'home' && <DriverHome driver={driver} inboxCount={inboxCount} onInbox={() => setInbox(true)} onPerformance={() => setPerf(true)} gps={auth.mode === 'supabase' ? { state: gps, lastSentAt } : undefined} />}
              {tab === 'trips' && <DriverTripsTab driver={driver} />}
              {tab === 'earnings' && <EarningsTab driver={driver} />}
              {tab === 'account' && (
                <DriverAccountTab driver={driver} onLogout={logout} privacy={{ subjectId: subjectId ?? driver.id, onChanged: () => void gate.refresh() }} />
              )}
            </motion.div>
          </AnimatePresence>
          <AnimatePresence>
            {perf && <PerformancePanel driver={driver} onClose={() => setPerf(false)} />}
            {inbox && (
              <InboxPanel
                audience="captains"
                onClose={() => {
                  setInbox(false)
                  const now = Date.now()
                  setSeen(now)
                  localStorage.setItem(SEEN_KEY, String(now))
                }}
              />
            )}
          </AnimatePresence>
        </div>
        <TabBar<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { id: 'home', label: t('الرئيسية', 'Home'), icon: <Home size={22} {...ICON} /> },
            { id: 'trips', label: t('الرحلات', 'Trips'), icon: <History size={22} {...ICON} /> },
            { id: 'earnings', label: t('الأرباح', 'Earnings'), icon: <Wallet size={22} {...ICON} /> },
            { id: 'account', label: t('حسابي', 'Account'), icon: <User size={22} {...ICON} /> },
          ]}
        />
      </div>
    )

  return (
    <Surface tone="dark">
      <ToastHost contained>
        <div dir={dir} className="absolute inset-0 overflow-hidden bg-ink font-sans text-white">
          {content}
          {auth.mode === 'supabase' && stage === 'main' && <ConnectivityBanner />}
          {away && <BackgroundNotice away={away} onClose={() => setAway(null)} />}
          {(gps === 'denied' || gps === 'unsupported') && (
            <div className="absolute inset-x-3 z-50 rounded-2xl bg-danger px-4 py-2.5 text-center text-[12.5px] font-semibold text-white" style={{ top: 'calc(var(--safe-top) + 8px)' }}>
              {t('اسمح بالوصول إلى الموقع لتستقبل الطلبات. موقعك يُرسل فقط أثناء الاتصال.', 'Allow location access to receive trips. Location is only sent while you are online.')}
            </div>
          )}
        </div>
      </ToastHost>
    </Surface>
  )
}
