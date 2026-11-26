import type { Driver, DriverDoc } from '../../core/types'

/** Documents that belong to the vehicle (Istimara + insurance). */
export const VEHICLE_DOC_IDS: DriverDoc['id'][] = ['registration', 'insurance']

export type VehicleRejection = {
  /** The vehicle itself was rejected by an admin (vehicles.status = 'rejected'). */
  vehicleRejected: boolean
  /** vehicles.status_reason, when recorded. */
  vehicleReason?: string
  /** Rejected / expired vehicle documents with driver_documents.rejection_reason (or 'expired'). */
  docs: { id: DriverDoc['id']; reason?: string; expired: boolean }[]
}

/**
 * Why the captain's vehicle was not accepted, or null when the vehicle is not the cause.
 * Sources: vehicles.status_reason (admin_review_vehicle) and driver_documents.rejection_reason
 * of the vehicle documents.
 */
export function vehicleRejection(d: Pick<Driver, 'vehicleReview' | 'docs'>): VehicleRejection | null {
  const vehicleRejected = d.vehicleReview?.status === 'rejected'
  const docs = d.docs
    .filter((doc) => VEHICLE_DOC_IDS.includes(doc.id) && doc.status === 'rejected')
    .map((doc) => ({ id: doc.id, expired: doc.note === 'expired', reason: doc.note && doc.note !== 'expired' ? doc.note.trim() || undefined : undefined }))
  if (!vehicleRejected && docs.length === 0) return null
  return { vehicleRejected, vehicleReason: vehicleRejected ? d.vehicleReview?.reason : undefined, docs }
}

/** The captain sees the "not approved – vehicle" screen when the application or the vehicle was rejected. */
export function showVehicleRejectedScreen(d: Pick<Driver, 'status' | 'vehicleReview' | 'docs'>): boolean {
  if (d.status === 'approved') return false
  return d.vehicleReview?.status === 'rejected' || (d.status === 'rejected' && vehicleRejection(d) !== null)
}
