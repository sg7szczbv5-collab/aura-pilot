/**
 * Captain application on Supabase: personal details → vehicle → documents
 * uploaded to Storage (driver-documents/<uid>/…) → consents → submit.
 * The database re-checks everything in submit_driver_application (ID and IBAN
 * checksums, age, vehicle age, documents and expiry dates, consents) and then
 * queues the Wasl registration.
 */
import { getSupabase } from '../auth/supabaseClient'
import { ageOn, isValidPlate, isValidSaudiIban, isValidSaudiId, isValidSequenceNumber, vehicleAgeOk } from '../compliance/validators'
import { REQUIRED_CONSENTS } from '../privacy/consents'
import { privacy } from '../privacy/privacyService'

export type DocKey = 'national_id' | 'license' | 'photo' | 'registration' | 'insurance'
export const DOC_TYPE: Record<DocKey, 'national_id' | 'driving_license' | 'profile_photo' | 'vehicle_registration' | 'vehicle_insurance'> = {
  national_id: 'national_id',
  license: 'driving_license',
  photo: 'profile_photo',
  registration: 'vehicle_registration',
  insurance: 'vehicle_insurance',
}
/** Documents whose expiry date Wasl/TGA needs. */
export const NEEDS_EXPIRY: DocKey[] = ['national_id', 'license', 'registration', 'insurance']
export const VEHICLE_DOCS: DocKey[] = ['registration', 'insurance']
export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'application/pdf']

export type OnboardingInput = {
  uid: string
  fullName: string
  nationalId: string
  dateOfBirth: string // YYYY-MM-DD
  iban: string
  cityCode: string
  vehicle: { classId: string; make: string; model: string; year: number; color: string; plateLetters: string; plateDigits: string; sequenceNumber: string; seats: number }
  docs: Partial<Record<DocKey, { file: File; expiresAt?: string }>>
  consentsAccepted: boolean
  locale: 'ar' | 'en'
}

export type OnboardingField = 'fullName' | 'nationalId' | 'dateOfBirth' | 'iban' | 'vehicle' | 'plate' | 'sequenceNumber' | 'vehicleYear' | `doc:${DocKey}` | `expiry:${DocKey}` | 'consents'

/** Same rules the database enforces, checked before anything is uploaded. */
export function validateOnboarding(i: OnboardingInput, now = new Date()): { ok: true } | { ok: false; field: OnboardingField } {
  if (i.fullName.trim().length < 3) return { ok: false, field: 'fullName' }
  if (!isValidSaudiId(i.nationalId)) return { ok: false, field: 'nationalId' }
  const dob = new Date(`${i.dateOfBirth}T00:00:00`)
  if (Number.isNaN(dob.getTime()) || ageOn(dob, now) < 18 || dob.getFullYear() < 1940) return { ok: false, field: 'dateOfBirth' }
  if (!isValidSaudiIban(i.iban.replace(/\s/g, '').toUpperCase())) return { ok: false, field: 'iban' }
  if (!i.vehicle.make.trim() || !i.vehicle.model.trim()) return { ok: false, field: 'vehicle' }
  if (!vehicleAgeOk(i.vehicle.year, now)) return { ok: false, field: 'vehicleYear' }
  if (!isValidPlate(i.vehicle.plateLetters.toUpperCase(), i.vehicle.plateDigits)) return { ok: false, field: 'plate' }
  if (!isValidSequenceNumber(i.vehicle.sequenceNumber)) return { ok: false, field: 'sequenceNumber' }
  const today = now.toISOString().slice(0, 10)
  for (const k of Object.keys(DOC_TYPE) as DocKey[]) {
    const d = i.docs[k]
    if (!d) return { ok: false, field: `doc:${k}` }
    if (d.file.size > MAX_FILE_BYTES || (d.file.type && !ALLOWED_TYPES.includes(d.file.type))) return { ok: false, field: `doc:${k}` }
    if (NEEDS_EXPIRY.includes(k) && (!d.expiresAt || d.expiresAt < today)) return { ok: false, field: `expiry:${k}` }
  }
  if (!i.consentsAccepted) return { ok: false, field: 'consents' }
  return { ok: true }
}

/** <uid>/<doc>-<timestamp>.<ext>: the Storage policy only allows the captain's own folder. */
export function storagePath(uid: string, key: DocKey, file: { name: string; type: string }, now = Date.now()): string {
  const fromName = /\.([a-z0-9]{2,4})$/i.exec(file.name)?.[1]?.toLowerCase()
  const ext = fromName && ['jpg', 'jpeg', 'png', 'pdf'].includes(fromName) ? fromName : file.type === 'application/pdf' ? 'pdf' : file.type === 'image/png' ? 'png' : 'jpg'
  return `${uid}/${key}-${now}.${ext}`
}

export type SubmitResult = { ok: true } | { ok: false; error: string }

export async function submitServerApplication(i: OnboardingInput): Promise<SubmitResult> {
  const v = validateOnboarding(i)
  if (!v.ok) return { ok: false, error: `invalid:${v.field}` }
  const sb = getSupabase()
  const fail = (e: { message: string } | null | undefined) => ({ ok: false as const, error: (e?.message ?? 'network').replace(/^AURA:\s*/, '') })

  // Consents first: the database refuses an application without them.
  await privacy.recordConsents(i.uid, 'driver', REQUIRED_CONSENTS.driver.map((p) => ({ purpose: p, granted: true })), i.locale)

  await sb.from('profiles').update({ full_name: i.fullName.trim() }).eq('id', i.uid)
  const { data: city } = await sb.from('cities').select('id').eq('code', i.cityCode).maybeSingle()
  if (!city) return { ok: false, error: 'unknown city' }

  const iban = i.iban.replace(/\s/g, '').toUpperCase()
  const { data: existing } = await sb.from('drivers').select('id, status').eq('id', i.uid).maybeSingle()
  if (!existing) {
    const { error } = await sb.from('drivers').insert({ id: i.uid, city_id: city.id, national_id: i.nationalId, date_of_birth: i.dateOfBirth, iban })
    if (error) return fail(error)
  } else {
    const { error } = await sb.from('drivers').update({ city_id: city.id, iban }).eq('id', i.uid)
    if (error) return fail(error)
  }

  const { data: vehicle, error: vErr } = await sb
    .from('vehicles')
    .insert({
      driver_id: i.uid,
      vehicle_class: i.vehicle.classId,
      make: i.vehicle.make.trim(),
      model: i.vehicle.model.trim(),
      year: i.vehicle.year,
      color: i.vehicle.color,
      plate_letters: i.vehicle.plateLetters.toUpperCase(),
      plate_number: i.vehicle.plateDigits,
      sequence_number: i.vehicle.sequenceNumber,
      seats: i.vehicle.seats,
    })
    .select('id')
    .single()
  if (vErr || !vehicle) return fail(vErr)
  const { error: cvErr } = await sb.from('drivers').update({ current_vehicle_id: vehicle.id }).eq('id', i.uid)
  if (cvErr) return fail(cvErr)

  for (const key of Object.keys(DOC_TYPE) as DocKey[]) {
    const d = i.docs[key]!
    const path = storagePath(i.uid, key, d.file)
    const up = await sb.storage.from('driver-documents').upload(path, d.file, { upsert: false, contentType: d.file.type || undefined })
    if (up.error) return fail(up.error)
    const { error } = await sb.from('driver_documents').insert({
      driver_id: i.uid,
      vehicle_id: VEHICLE_DOCS.includes(key) ? vehicle.id : null,
      doc_type: DOC_TYPE[key],
      storage_path: path,
      expires_at: NEEDS_EXPIRY.includes(key) ? d.expiresAt : null,
    })
    if (error) return fail(error)
  }

  const { error } = await sb.rpc('submit_driver_application')
  return error ? fail(error) : { ok: true }
}
