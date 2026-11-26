import { useEffect, useRef, useState } from 'react'
import { Camera, Car, CarFront, PencilLine } from 'lucide-react'
import { Button, cx, ICON } from '../../ds/ui'
import { useI18n } from '../../i18n/I18n'
import { actions, getDriver, getVehicle } from '../../core/store'
import { auth } from '../../auth/authService'
import { getSupabase } from '../../auth/supabaseClient'
import { syncDriverSelf } from '../../data/serverMirror'
import { NEEDS_EXPIRY, type DocKey } from '../../captain/onboarding'
import { docsToResubmit, resubmitServer, validateResubmit, type VehicleFields, type VehicleMode } from '../../captain/resubmit'
import { VEHICLE_MAX_AGE_YEARS } from '../../compliance/validators'
import type { DriverDoc, VehicleClassId } from '../../core/types'
import { TopBar } from '../shared/mobile'
import { ExpiryField, LATIN_TO_AR, UploadTile } from './formParts'
import { VehicleForm } from './VehicleForm'
import { VEHICLE_COLORS, colorById } from '../../data/vehicleCatalog'
import { onboardingErrorText } from './formParts'

const EMPTY: VehicleFields = { classId: 'go', make: '', model: '', year: 0, color: 'white', plateLetters: '', plateDigits: '', sequenceNumber: '', seats: 4 }

/**
 * «إكمال الطلب وإعادة التقديم»: upload only the rejected / missing documents, correct the
 * current vehicle or register another one, then send the application back to review.
 */
export function Resubmit({ driverId, onDone, onCancel }: { driverId: string; onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n()
  const live = auth.mode === 'supabase'
  const d = getDriver(driverId)!
  const vehicleRejected = d.vehicleReview?.status === 'rejected'
  const [mode, setMode] = useState<VehicleMode>(vehicleRejected ? 'edit' : 'keep')
  const [current, setCurrent] = useState<VehicleFields & { id?: string }>()
  const [veh, setVeh] = useState<VehicleFields>(EMPTY)
  const [names, setNames] = useState<Partial<Record<DocKey, string>>>({})
  const files = useRef<Partial<Record<DocKey, File>>>({})
  const [expiry, setExpiry] = useState<Partial<Record<DocKey, string>>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  /** Technical detail (step · server message) under the error, for support. */
  const [errDetail, setErrDetail] = useState('')
  const today = new Date().toISOString().slice(0, 10)

  // The current vehicle, to prefill "correct the vehicle details".
  useEffect(() => {
    let alive = true
    if (live) {
      void getSupabase()
        .from('vehicles')
        .select('id, vehicle_class, make, model, year, color, plate_letters, plate_number, sequence_number, seats')
        .eq('id', d.vehicleId ?? '')
        .maybeSingle()
        .then(({ data: v }) => {
          if (!alive || !v) return
          setCurrent({ id: v.id, classId: v.vehicle_class, make: v.make, model: v.model, year: v.year, color: v.color, plateLetters: v.plate_letters, plateDigits: v.plate_number, sequenceNumber: v.sequence_number, seats: v.seats })
        })
    } else {
      const v = getVehicle(d.vehicleId)
      if (v) setCurrent({ id: v.id, classId: v.classId, make: v.make, model: v.model, year: v.year, color: VEHICLE_COLORS.find((c) => c.en === v.color.en)?.id ?? v.color.en.toLowerCase(), plateLetters: v.plate.lettersEn, plateDigits: v.plate.digits, sequenceNumber: '', seats: v.classId === 'xl' ? 7 : 4 })
    }
    return () => {
      alive = false
    }
  }, [live, d.vehicleId])

  const pickMode = (m: VehicleMode) => {
    setMode(m)
    setErr('')
    setVeh(m === 'edit' && current ? current : EMPTY)
  }
  useEffect(() => {
    if (mode === 'edit' && current) setVeh(current)
  }, [current, mode])

  const required = docsToResubmit(d.docs, mode)
  const docNote = (k: DocKey) => d.docs.find((x) => x.id === k)?.note
  const label: Record<DocKey, string> = {
    national_id: t('الهوية الوطنية / الإقامة', 'National ID / Iqama'),
    license: t('رخصة القيادة', 'Driving licence'),
    photo: t('صورة شخصية', 'Profile photo'),
    registration: t('استمارة المركبة', 'Vehicle registration (Istimara)'),
    insurance: t('وثيقة التأمين', 'Insurance policy'),
  }
  const setFile = (k: DocKey) => (name?: string, file?: File) => {
    if (file) files.current[k] = file
    else delete files.current[k]
    setNames((n) => ({ ...n, [k]: name }))
  }

  const submit = async () => {
    setErr('')
    setErrDetail('')
    const input = {
      driverStatus: d.status,
      mode,
      vehicleId: mode === 'edit' ? current?.id : undefined,
      vehicle: mode === 'keep' ? undefined : { ...veh, seats: veh.classId === 'xl' ? 7 : 4 },
      required,
      docs: Object.fromEntries(required.filter((k) => files.current[k] || names[k]).map((k) => [k, { file: files.current[k] ?? new File([], names[k]!), expiresAt: expiry[k] }])),
    }
    const v = validateResubmit(input, { live })
    if (!v.ok) return setErr(fieldText(v.field))
    setBusy(true)
    if (live) {
      const r = await resubmitServer({ ...input, uid: driverId })
      if (!r.ok) {
        setBusy(false)
        console.error('resubmit failed', r)
        setErrDetail(r.error.startsWith('invalid:') ? '' : `${r.step ?? ''} · ${r.error}`)
        return setErr(onboardingErrorText(r.error, t))
      }
      await syncDriverSelf(driverId)
    } else {
      const c = colorById(veh.color) ?? VEHICLE_COLORS[0]
      const letters = veh.plateLetters.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3)
      actions.resubmitDriverApplication(driverId, {
        mode,
        vehicle:
          mode === 'keep'
            ? undefined
            : {
                make: veh.make.trim(),
                model: veh.model.trim(),
                year: veh.year,
                color: { ar: c.ar, en: c.en },
                colorHex: c.hex,
                plate: { digits: veh.plateDigits, lettersEn: letters, lettersAr: letters.split('').map((l) => LATIN_TO_AR[l] ?? l).join(' ') },
                classId: veh.classId as VehicleClassId,
              },
        docs: Object.fromEntries(required.map((k) => [k, names[k]!])) as Partial<Record<DriverDoc['id'], string>>,
      })
    }
    setBusy(false)
    onDone()
  }

  const fieldText = (f: string) =>
    f === 'nothing'
      ? t('لا توجد مستندات ناقصة. عدّل بيانات المركبة أو سجّل مركبة أخرى.', 'Nothing is missing. Correct the vehicle or register another one.')
      : f === 'vehicle'
        ? t('أدخل الشركة والطراز', 'Enter the make and model')
        : f === 'vehicleYear'
          ? t(`لا يزيد عمر المركبة عن ${VEHICLE_MAX_AGE_YEARS} سنوات`, `At most ${VEHICLE_MAX_AGE_YEARS} years old`)
          : f === 'vehicleClass'
            ? t('الفئة المختارة لا تناسب هذه المركبة', 'The selected class does not fit this vehicle')
          : f === 'plate'
            ? t('تحقق من أرقام وحروف اللوحة', 'Check the plate digits and letters')
            : f === 'sequenceNumber'
              ? t('الرقم التسلسلي ٦–١٢ رقماً', 'Sequence number: 6–12 digits')
              : f.startsWith('expiry:')
                ? `${label[f.slice(7) as DocKey]}: ${t('أدخل تاريخ انتهاء صالحاً', 'enter a valid expiry date')}`
                : `${label[f.slice(4) as DocKey]}: ${t('ارفع الملف (JPG أو PNG أو PDF حتى ١٠ م.ب)', 'upload the file (JPG, PNG or PDF up to 10 MB)')}`

  const modes: { id: VehicleMode; icon: React.ReactNode; title: string; sub: string }[] = [
    ...(vehicleRejected ? [] : [{ id: 'keep' as const, icon: <Car size={18} {...ICON} />, title: t('نفس المركبة', 'Same vehicle'), sub: t('أرفع المستندات الناقصة فقط', 'Only upload the missing documents') }]),
    { id: 'edit', icon: <PencilLine size={18} {...ICON} />, title: t('تصحيح بيانات المركبة', 'Correct vehicle details'), sub: t('نفس المركبة ببيانات معدّلة', 'Same vehicle, corrected details') },
    { id: 'new', icon: <CarFront size={18} {...ICON} />, title: t('مركبة أخرى', 'Another vehicle'), sub: t('تسجيل مركبة جديدة مع استمارتها وتأمينها', 'Register a new vehicle with its registration and insurance') },
  ]

  return (
    <div className="absolute inset-0 flex flex-col bg-ink text-white">
      <TopBar title={t('إكمال الطلب وإعادة التقديم', 'Fix and re-apply')} onBack={onCancel} />
      <div className="flex-1 space-y-5 overflow-y-auto px-5 pb-4">
        <section>
          <h2 className="font-display text-lg font-semibold">{t('المركبة', 'Vehicle')}</h2>
          {vehicleRejected && d.vehicleReview?.reason && <p className="mt-1 text-xs text-danger">{d.vehicleReview.reason}</p>}
          <div className="mt-2 space-y-2">
            {modes.map((m) => (
              <button key={m.id} onClick={() => pickMode(m.id)} className={cx('flex w-full items-center gap-3 rounded-2xl p-3.5 text-start', mode === m.id ? 'bg-go/10 ring-1 ring-go/60' : 'bg-ink-2 ring-1 ring-white/8')} aria-pressed={mode === m.id}>
                <span className={cx('flex size-10 items-center justify-center rounded-xl', mode === m.id ? 'bg-go text-ink' : 'bg-ink-3')}>{m.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{m.title}</span>
                  <span className="block text-xs text-white/50">{m.sub}</span>
                </span>
              </button>
            ))}
          </div>
          {mode !== 'keep' && (
            <div className="mt-3">
              <VehicleForm key={mode} value={veh} onChange={setVeh} live={live} />
            </div>
          )}
        </section>

        <section>
          <h2 className="font-display text-lg font-semibold">{t('المستندات المطلوبة', 'Documents to upload')}</h2>
          {required.length === 0 ? (
            <p className="mt-1 text-sm text-white/55">{t('جميع مستنداتك مقبولة أو قيد المراجعة.', 'All your documents are approved or in review.')}</p>
          ) : (
            <div className="mt-2 space-y-2.5">
              {required.map((k) => {
                const note = docNote(k)
                return (
                  <div key={k} className="space-y-2">
                    <UploadTile label={label[k]} file={names[k]} onFile={setFile(k)} icon={k === 'photo' ? <Camera size={20} {...ICON} /> : undefined} />
                    {note && !(mode === 'new' && (k === 'registration' || k === 'insurance')) && (
                      <p className="px-1 text-[11.5px] text-danger">{note === 'expired' ? t('منتهية الصلاحية، ارفع نسخة محدّثة', 'Expired, upload a renewed copy') : note}</p>
                    )}
                    {live && NEEDS_EXPIRY.includes(k) && <ExpiryField value={expiry[k]} onChange={(v) => setExpiry({ ...expiry, [k]: v })} min={today} />}
                  </div>
                )
              })}
            </div>
          )}
        </section>
        {err && (
          <div role="alert" className="rounded-xl bg-danger/15 px-3 py-2 text-sm text-danger">
            <p>{err}</p>
            {errDetail && (
              <p className="num mt-1 break-all text-[10.5px] text-danger/70" dir="ltr">
                {errDetail}
              </p>
            )}
          </div>
        )}
      </div>
      <div className="px-5 pt-3" style={{ paddingBottom: 'calc(var(--safe-bottom) + 10px)' }}>
        <Button variant="go" size="lg" full loading={busy} onClick={() => void submit()}>
          {d.status === 'rejected' || d.status === 'incomplete' ? t('إعادة تقديم الطلب', 'Re-submit application') : t('إرسال للمراجعة', 'Send for review')}
        </Button>
      </div>
    </div>
  )
}
