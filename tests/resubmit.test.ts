import { describe, expect, it } from 'vitest'
import { docsToResubmit, validateResubmit } from '../src/captain/resubmit'
import { actions, getDriver, getVehicle, store } from '../src/core/store'
import type { DriverDoc } from '../src/core/types'

const docs = (over: Partial<Record<DriverDoc['id'], DriverDoc['status']>> = {}): DriverDoc[] =>
  (['national_id', 'license', 'photo', 'registration', 'insurance'] as const).map((id) => ({ id, status: over[id] ?? 'approved' }))
const file = (name = 'a.jpg', type = 'image/jpeg') => new File(['x'], name, { type })
const VEH = { classId: 'go', make: 'Kia', model: 'K5', year: new Date().getFullYear(), color: 'grey', plateLetters: 'RJT', plateDigits: '1234', sequenceNumber: '123456789', seats: 4 }

describe('docsToResubmit', () => {
  it('only rejected / missing documents for the same vehicle', () => {
    expect(docsToResubmit(docs({ license: 'rejected', insurance: 'missing' }), 'keep')).toEqual(['license', 'insurance'])
    expect(docsToResubmit(docs({ license: 'uploaded' }), 'edit')).toEqual([])
  })
  it('a new vehicle always needs its registration and insurance', () => {
    expect(docsToResubmit(docs({ photo: 'rejected' }), 'new')).toEqual(['photo', 'registration', 'insurance'])
  })
})

describe('validateResubmit', () => {
  const base = { driverStatus: 'rejected' as const, mode: 'keep' as const, required: ['license' as const], docs: { license: { file: file(), expiresAt: '2099-01-01' } } }
  it('accepts a complete re-upload', () => expect(validateResubmit(base, { live: true })).toEqual({ ok: true }))
  it('requires every listed file and, live, a future expiry date', () => {
    expect(validateResubmit({ ...base, docs: {} }, { live: true })).toEqual({ ok: false, field: 'doc:license' })
    expect(validateResubmit({ ...base, docs: { license: { file: file(), expiresAt: '2000-01-01' } } }, { live: true })).toEqual({ ok: false, field: 'expiry:license' })
    expect(validateResubmit({ ...base, docs: { license: { file: file('a.exe', 'application/x-msdownload'), expiresAt: '2099-01-01' } } }, { live: true })).toEqual({ ok: false, field: 'doc:license' })
  })
  it('nothing to send when the vehicle is kept and no document is missing', () => {
    expect(validateResubmit({ ...base, required: [], docs: {} }, { live: true })).toEqual({ ok: false, field: 'nothing' })
  })
  it('checks the vehicle when it is corrected or replaced', () => {
    expect(validateResubmit({ ...base, mode: 'edit', required: [], docs: {}, vehicle: VEH }, { live: true })).toEqual({ ok: true })
    expect(validateResubmit({ ...base, mode: 'new', required: [], docs: {}, vehicle: { ...VEH, plateDigits: '' } }, { live: true })).toEqual({ ok: false, field: 'plate' })
    expect(validateResubmit({ ...base, mode: 'new', required: [], docs: {}, vehicle: { ...VEH, sequenceNumber: '12' } }, { live: true })).toEqual({ ok: false, field: 'sequenceNumber' })
  })
})

describe('demo store: resubmitDriverApplication', () => {
  it('re-uploads documents, registers another vehicle and goes back to review', () => {
    const d = store.state.drivers[0]
    actions.setDriverStatus(d.id, 'rejected', { name: 'Admin', role: 'super_admin' } as never, 'المركبة')
    const oldVehicle = getDriver(d.id)!.vehicleId
    actions.resubmitDriverApplication(d.id, {
      mode: 'new',
      vehicle: { make: 'Kia', model: 'K5', year: 2024, color: { ar: 'رمادي', en: 'Grey' }, colorHex: '#6E7174', plate: { digits: '1234', lettersEn: 'RJT', lettersAr: 'ر ح ط' }, classId: 'go' },
      docs: { license: 'licence.jpg', registration: 'reg.pdf', insurance: 'ins.pdf' },
    })
    const after = getDriver(d.id)!
    expect(after.status).toBe('pending_review')
    expect(after.rejectionReason).toBeUndefined()
    expect(after.vehicleId).not.toBe(oldVehicle)
    expect(getVehicle(after.vehicleId)?.make).toBe('Kia')
    expect(after.docs.find((x) => x.id === 'license')).toEqual({ id: 'license', status: 'uploaded', fileName: 'licence.jpg' })
  })
})
