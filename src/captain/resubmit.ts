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
import type { DriverDoc, VehicleClassId } from '../core/types'
import { classifyVehicle } from '../data/vehicleClassRules'
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

export type ResubmitField = 'nothing' | 'vehicle' | 'vehicleClass' | 'vehicleYear' | 'plate' | 'sequenceNumber' | `doc:${DocKey}` | `expiry:${DocKey}`

export function validateResubmit(i: Omit<ResubmitInput, 'uid'>, opts: { live: boolean; now?: Date }): { ok: true } | { ok: false; field: ResubmitField } {
  const now = opts.now ?? new Date()
  if (i.mode === 'keep' && i.required.length === 0) return { ok: false, field: 'nothing' }
  if (i.mode !== 'keep') {
    const v = i.vehicle
    if (!v || !v.make.trim() || !v.model.trim()) return { ok: false, field: 'vehicle' }
    if (!vehicleAgeOk(v.year, now)) return { ok: false, field: 'vehicleYear' }
    if (opts.live ? !isValidPlate(v.plateLetters.toUpperCase(), v.plateDigits) : v.plateDigits.length < 3 || v.plateLetters.length < 2) return { ok: false, field: 'plate' }
    if (opts.live && !isValidSequenceNumber(v.sequenceNumber)) return { ok: false, field: 'sequenceNumber' }
    if (!classifyVehicle(v, now).eligible.includes(v.classId as VehicleClassId)) return { ok: false, field: 'vehicleClass' }
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

type DbError = { message: string; code?: string; details?: string | null; hint?: string | null } | null | undefined
/** The database function is not on the server yet (migration 017 not deployed). */
export const isMissingFunction = (e: DbError) => !!e && (e.code === 'PGRST202' || /could not find the function|does not exist/i.test(e.message))
const isUnique = (e: DbError) => !!e && (e.code === '23505' || /duplicate key|unique/i.test(e.message))

export async function resubmitServer(i: ResubmitInput): Promise<{ ok: true } | { ok: false; error: string; step?: 'vehicle' | 'upload' | 'document' | 'submit' }> {
  const v = validateResubmit(i, { live: true })
  if (!v.ok) return { ok: false, error: `invalid:${v.field}` }
  const sb = getSupabase()
  const fail = (e: DbError, step?: 'vehicle' | 'upload' | 'document' | 'submit') => ({ ok: false as const, step, error: (e?.message ?? 'network').replace(/^AURA:\s*/, '') })

  let vehicleId: string | null = i.vehicleId ?? null
  if (i.mode !== 'keep' && i.vehicle) {
    const f = i.vehicle
    const fields = {
      vehicle_class: f.classId,
      make: f.make.trim(),
      model: f.model.trim(),
      year: f.year,
      color: f.color,
      plate_letters: f.plateLetters.toUpperCase(),
      plate_number: f.plateDigits,
      sequence_number: f.sequenceNumber,
      seats: f.seats,
    }
    // A retry after a failed attempt: the captain's own vehicle with this plate already exists.
    let target = i.mode === 'edit' ? (i.vehicleId ?? null) : null
    if (i.mode === 'new') {
      const { data: mine } = await sb
        .from('vehicles')
        .select('id, status')
        .eq('driver_id', i.uid)
        .eq('plate_letters', fields.plate_letters)
        .eq('plate_number', fields.plate_number)
        .maybeSingle()
      if (mine && (mine.status === 'pending_review' || mine.status === 'rejected')) target = mine.id as string
    }
    const { data, error } = await sb
      .rpc('driver_save_vehicle', {
        p_vehicle_id: target,
        p_vehicle_class: fields.vehicle_class,
        p_make: fields.make,
        p_model: fields.model,
        p_year: fields.year,
        p_color: fields.color,
        p_plate_letters: fields.plate_letters,
        p_plate_number: fields.plate_number,
        p_sequence_number: fields.sequence_number,
        p_seats: fields.seats,
      })
      .single()
    if (!error && data) {
      vehicleId = (data as { id: string }).id
    } else if (isMissingFunction(error)) {
      // Server not updated yet: a captain may still insert a vehicle and make it current (RLS).
      if (target && i.mode === 'edit') return { ok: false, step: 'vehicle', error: 'server_outdated' }
      if (target) {
        vehicleId = target
      } else {
        const ins = await sb.from('vehicles').insert({ driver_id: i.uid, ...fields }).select('id').single()
        if (ins.error || !ins.data) return fail(ins.error, 'vehicle')
        vehicleId = (ins.data as { id: string }).id
      }
      const { error: cvErr } = await sb.from('drivers').update({ current_vehicle_id: vehicleId }).eq('id', i.uid)
      if (cvErr) return fail(cvErr, 'vehicle')
    } else {
      return fail(error, 'vehicle')
    }
  }
  if (!vehicleId) {
    const { data } = await sb.from('drivers').select('current_vehicle_id').eq('id', i.uid).maybeSingle()
    vehicleId = (data?.current_vehicle_id as string | null) ?? null
  }

  for (const key of i.required) {
    const d = i.docs[key]!
    const docVehicle = VEHICLE_DOCS.includes(key) ? vehicleId : null
    // Already uploaded by an earlier attempt (one live document per type) → keep it.
    let q = sb.from('driver_documents').select('id').eq('driver_id', i.uid).eq('doc_type', DOC_TYPE[key]).in('status', ['uploaded', 'approved'])
    q = docVehicle ? q.eq('vehicle_id', docVehicle) : q.is('vehicle_id', null)
    const { data: live } = await q.limit(1)
    if (live?.length) continue
    const path = storagePath(i.uid, key, d.file)
    const up = await sb.storage.from('driver-documents').upload(path, d.file, { upsert: false, contentType: d.file.type || undefined })
    if (up.error) return fail(up.error, 'upload')
    const { error } = await sb.from('driver_documents').insert({
      driver_id: i.uid,
      vehicle_id: docVehicle,
      doc_type: DOC_TYPE[key],
      storage_path: path,
      expires_at: NEEDS_EXPIRY.includes(key) ? d.expiresAt : null,
    })
    if (error && !isUnique(error)) return fail(error, 'document')
  }

  // A rejected (or never submitted) application goes back to review; one already
  // under review simply shows the new files / vehicle to the reviewer.
  if (i.driverStatus === 'rejected' || i.driverStatus === 'incomplete') {
    const { error } = await sb.rpc('submit_driver_application')
    if (error && !/already submitted/.test(error.message)) return fail(error, 'submit')
  }
  return { ok: true }
}
