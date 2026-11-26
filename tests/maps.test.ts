import { describe, expect, it } from 'vitest'
import { normalizeMapboxZoom } from '../src/map/CityMap'

describe('Mapbox zoom from the CityMap px/km convention', () => {
  it('converts the screens’ px-per-km values to sensible Mapbox zoom levels', () => {
    const z = (v: number) => Math.round(normalizeMapboxZoom(v, 24.7) * 10) / 10
    expect(z(22)).toBeCloseTo(10.6, 0) // whole city (admin zones)
    expect(z(70)).toBeCloseTo(12.3, 0) // passenger home
    expect(z(150)).toBeCloseTo(13.4, 0) // pick a point
    expect(z(70)).toBeGreaterThan(z(22))
  })
  it('keeps real Mapbox zoom levels and clamps nonsense', () => {
    expect(normalizeMapboxZoom(11.5)).toBe(11.5)
    expect(normalizeMapboxZoom(undefined)).toBe(11.5)
    expect(normalizeMapboxZoom(Number.NaN)).toBe(11.5)
    expect(normalizeMapboxZoom(1)).toBe(2)
  })
})
