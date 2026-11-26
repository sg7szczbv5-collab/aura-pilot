import { describe, expect, it } from 'vitest'
import { MAKES, VEHICLE_COLORS, colorById, colorHex, findMake, vehicleYears } from '../src/data/vehicleCatalog'
import { vehicleAgeOk } from '../src/compliance/validators'

describe('vehicle catalogue', () => {
  it('makes have unique ids/names and non-empty, unique model lists that fit the database (≤ 40 chars)', () => {
    expect(new Set(MAKES.map((m) => m.id)).size).toBe(MAKES.length)
    expect(new Set(MAKES.map((m) => m.en.toLowerCase())).size).toBe(MAKES.length)
    for (const m of MAKES) {
      expect(m.models.length).toBeGreaterThan(0)
      expect(new Set(m.models).size).toBe(m.models.length)
      expect(m.en.length).toBeLessThanOrEqual(40)
      for (const x of m.models) expect(x.length).toBeLessThanOrEqual(40)
    }
  })
  it('finds a make by stored name or id', () => {
    expect(findMake('Toyota')?.id).toBe('toyota')
    expect(findMake(' mercedes-benz ')?.id).toBe('mercedes')
    expect(findMake('Unknown')).toBeUndefined()
  })
  it('colour keys fit vehicles.color and resolve to labels / swatches', () => {
    expect(new Set(VEHICLE_COLORS.map((c) => c.id)).size).toBe(VEHICLE_COLORS.length)
    expect(colorById('WHITE')?.ar).toBe('أبيض')
    expect(colorHex('navy')).toBe('#1E2A44')
    expect(colorHex('something')).toBe('#B9BCBE')
  })
  it('years: newest first, every one allowed by the vehicle-age rule, nothing allowed is missing', () => {
    const now = new Date('2026-11-26T00:00:00Z')
    const ys = vehicleYears(now)
    expect(ys[0]).toBe(2027)
    expect(ys.at(-1)).toBe(2016)
    expect(ys.every((y) => vehicleAgeOk(y, now))).toBe(true)
    expect(vehicleAgeOk(2015, now)).toBe(false)
  })
})
