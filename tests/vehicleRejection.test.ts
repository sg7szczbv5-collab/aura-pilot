import { describe, expect, it } from 'vitest'
import { showVehicleRejectedScreen, vehicleRejection } from '../src/apps/driver/vehicleRejection'
import type { DriverDoc } from '../src/core/types'

const docs = (over: Partial<Record<DriverDoc['id'], Partial<DriverDoc>>> = {}): DriverDoc[] =>
  (['national_id', 'license', 'photo', 'registration', 'insurance'] as DriverDoc['id'][]).map((id) => ({ id, status: 'approved', ...over[id] }) as DriverDoc)

describe('captain vehicle rejection', () => {
  it('uses vehicles.status_reason when the vehicle was rejected', () => {
    const d = { status: 'pending_review' as const, vehicleReview: { status: 'rejected' as const, reason: 'عدم تطابق البيانات' }, docs: docs() }
    expect(showVehicleRejectedScreen(d)).toBe(true)
    expect(vehicleRejection(d)).toEqual({ vehicleRejected: true, vehicleReason: 'عدم تطابق البيانات', docs: [] })
  })

  it('collects rejection reasons of the vehicle documents only', () => {
    const d = {
      status: 'rejected' as const,
      docs: docs({ insurance: { status: 'rejected', note: 'انتهاء صلاحية الوثيقة أو التأمين' }, registration: { status: 'rejected', note: 'expired' }, license: { status: 'rejected', note: 'x' } }),
    }
    expect(showVehicleRejectedScreen(d)).toBe(true)
    expect(vehicleRejection(d)?.docs).toEqual([
      { id: 'registration', expired: true, reason: undefined },
      { id: 'insurance', expired: false, reason: 'انتهاء صلاحية الوثيقة أو التأمين' },
    ])
  })

  it('rejected vehicle without a recorded reason → screen shown, no reason (UI shows the default text)', () => {
    const d = { status: 'pending_review' as const, vehicleReview: { status: 'rejected' as const }, docs: docs() }
    expect(showVehicleRejectedScreen(d)).toBe(true)
    expect(vehicleRejection(d)).toEqual({ vehicleRejected: true, vehicleReason: undefined, docs: [] })
  })

  it('not shown when the vehicle is fine, or the captain is approved', () => {
    expect(showVehicleRejectedScreen({ status: 'rejected', vehicleReview: { status: 'approved' }, docs: docs() })).toBe(false)
    expect(showVehicleRejectedScreen({ status: 'pending_review', docs: docs({ insurance: { status: 'rejected', note: 'x' } }) })).toBe(false)
    expect(showVehicleRejectedScreen({ status: 'approved', vehicleReview: { status: 'rejected', reason: 'x' }, docs: docs() })).toBe(false)
  })
})
