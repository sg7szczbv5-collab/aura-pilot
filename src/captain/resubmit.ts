/**
 * Captain resubmission after a rejection (or while under review with a rejected
 * document / vehicle): upload only what is missing or rejected, correct the
 * vehicle or register another one, then resubmit.
 *
 * Supabase: driver_save_vehicle() (migration 017) → driver_documents inserts →
 * submit_driver_application() when the application itself was rejected.
 */
import { getSupabase } from '../auth/supabaseClient'
import { isValidPlate, isValidSequenceNumber, vehicleAgeOk } from '../compliance/validators'
import type { DriverDoc } from '../core/types'
import { ALLOWED_TYPES, DOC_TYPE, MAX_FILE_BYTES, NEEDS_EXPIRY, VEHICLE_DOCS, storagePath, type DocKey, type OnboardingInput } from './onboarding'

export type VehicleMode = 'keep' | 'edit' | 'new'
export type VehicleFields = OnboardingInput['vehicle']

const ALL_DOCS: DocKey[] = ['national_id', 'license', 'photo', 'registration', 'insurance']
const needsUpload = (d?: DriverDoc) => !d || d.status === 'missing' || d.status === 'rejected'

/**
 * Documents the captain must upload: personal documents that are missing or rejected,
 * and the vehicle documents that are missing or rejected — or both of them for a new vehicle.
 */
export function docsToResubmit(docs: DriverDoc[], mode: VehicleMode): DocKey[] {
  return ALL_DOCS.filter((k) => {
    if (VEHICLE_DOCS.includes(k) && mode === 'new') return true
    return needsUpload(docs.find((d) => d.id === k))
  })
}

export type ResubmitInput = {
  uid: string
  driverStatus: 'incomplete' | 'pending_review' | 'rejected' | 'approved' | 'suspended'
  mode: VehicleMode
  /** Vehicle being corrected (mode 'edit'). */
  vehicleId?: string
  vehicle?: VehicleFields
  required: DocKey[]
  docs: Partial<Record<DocKey, { file: File; expiresAt?: string }>>
}

export type ResubmitField = 'nothing' | 'vehicle' | 'vehicleYear' | 'plate' | 'sequenceNumber' | `doc:${DocKey}` | `expiry:${DocKey}`

export function validateResubmit(i: Omit<ResubmitInput, 'uid'>, opts: { live: boolean; now?: Date }): { ok: true } | { ok: false; field: ResubmitField } {
  const now = opts.now ?? new Date()
  if (i.mode === 'keep' && i.required.length === 0) return { ok: false, field: 'nothing' }
  if (i.mode !== 'keep') {
    const v = i.vehicle
    if (!v || !v.make.trim() || !v.model.trim()) return { ok: false, field: 'vehicle' }
    if (!vehicleAgeOk(v.year, now)) return { ok: false, field: 'vehicleYear' }
    if (opts.live ? !isValidPlate(v.plateLetters.toUpperCase(), v.plateDigits) : v.plateDigits.length < 3 || v.plateLetters.length < 2) return { ok: false, field: 'plate' }
    if (opts.live && !isValidSequenceNumber(v.sequenceNumber)) return { ok: false, field: 'sequenceNumber' }
  }
  const today = now.toISOString().slice(0, 10)
  for (const k of i.required) {
    const d = i.docs[k]
    if (!d) return { ok: false, field: `doc:${k}` }
    if (opts.live && (d.file.size > MAX_FILE_BYTES || (d.file.type && !ALLOWED_TYPES.includes(d.file.type)))) return { ok: false, field: `doc:${k}` }
    if (opts.live && NEEDS_EXPIRY.includes(k) && (!d.expiresAt || d.expiresAt < today)) return { ok: false, field: `expiry:${k}` }
  }
  return { ok: true }
}

export async function resubmitServer(i: ResubmitInput): Promise<{ ok: true } | { ok: false; error: string }> {
  const v = validateResubmit(i, { live: true })
  if (!v.ok) return { ok: false, error: `invalid:${v.field}` }
  const sb = getSupabase()
  const fail = (e: { message: string } | null | undefined) => ({ ok: false as const, error: (e?.message ?? 'network').replace(/^AURA:\s*/, '') })

  let vehicleId: string | null = i.vehicleId ?? null
  if (i.mode !== 'keep' && i.vehicle) {
    const f = i.vehicle
    const { data, error } = await sb
      .rpc('driver_save_vehicle', {
        p_vehicle_id: i.mode === 'edit' ? (i.vehicleId ?? null) : null,
        p_vehicle_class: f.classId,
        p_make: f.make.trim(),
        p_model: f.model.trim(),
        p_year: f.year,
        p_color: f.color,
        p_plate_letters: f.plateLetters.toUpperCase(),
        p_plate_number: f.plateDigits,
        p_sequence_number: f.sequenceNumber,
        p_seats: f.seats,
      })
      .single()
    if (error || !data) return fail(error)
    vehicleId = (data as { id: string }).id
  }
  if (!vehicleId) {
    const { data } = await sb.from('drivers').select('current_vehicle_id').eq('id', i.uid).maybeSingle()
    vehicleId = (data?.current_vehicle_id as string | null) ?? null
  }

  for (const key of i.required) {
    const d = i.docs[key]!
    const path = storagePath(i.uid, key, d.file)
    const up = await sb.storage.from('driver-documents').upload(path, d.file, { upsert: false, contentType: d.file.type || undefined })
    if (up.error) return fail(up.error)
    const { error } = await sb.from('driver_documents').insert({
      driver_id: i.uid,
      vehicle_id: VEHICLE_DOCS.includes(key) ? vehicleId : null,
      doc_type: DOC_TYPE[key],
      storage_path: path,
      expires_at: NEEDS_EXPIRY.includes(key) ? d.expiresAt : null,
    })
    if (error) return fail(error)
  }

  // A rejected (or never submitted) application goes back to review; one already
  // under review simply shows the new files / vehicle to the reviewer.
  if (i.driverStatus === 'rejected' || i.driverStatus === 'incomplete') {
    const { error } = await sb.rpc('submit_driver_application')
    if (error) return fail(error)
  }
  return { ok: true }
}
