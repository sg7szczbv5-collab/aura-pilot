import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TARIFF_BOUNDS, TARIFF_KEYS, parseTariffField, tariffChanges, toInput, validateTariff, type TariffKey } from '../src/apps/admin/live/tariffValidation'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const valid: Record<TariffKey, string> = {
  base_fare_halalas: '6.00', per_km_halalas: '1.65', per_min_halalas: '0.30', min_fare_halalas: '12.00', cancellation_fee_halalas: '0', commission_bps: '20',
}

describe('tariff validation (admin Pricing page)', () => {
  it('rejects empty and whitespace-only fields — never turns them into 0', () => {
    expect(parseTariffField('per_km_halalas', '')).toEqual({ ok: false, error: 'required' })
    expect(parseTariffField('per_km_halalas', '   ')).toEqual({ ok: false, error: 'required' })
    expect(parseTariffField('base_fare_halalas', undefined)).toEqual({ ok: false, error: 'required' })
    const v = validateTariff({ ...valid, per_km_halalas: ' ' })
    expect(v).toEqual({ ok: false, errors: { per_km_halalas: 'required' } })
  })

  it('rejects malformed input', () => {
    for (const s of ['abc', '1,5', '1e3', '+5', '1.234', '1.2.3', '0x10', '5 0', 'NaN', 'Infinity', '.5']) {
      expect(parseTariffField('base_fare_halalas', s)).toEqual({ ok: false, error: 'format' })
    }
  })

  it('rejects negative values', () => {
    expect(parseTariffField('base_fare_halalas', '-1')).toEqual({ ok: false, error: 'format' })
    expect(parseTariffField('commission_bps', '-0.01')).toEqual({ ok: false, error: 'format' })
  })

  it('rejects values above the maximum and below the minimum', () => {
    expect(parseTariffField('base_fare_halalas', '100.01')).toEqual({ ok: false, error: 'above_max' })
    expect(parseTariffField('per_km_halalas', '20.01')).toEqual({ ok: false, error: 'above_max' })
    expect(parseTariffField('min_fare_halalas', '999999')).toEqual({ ok: false, error: 'above_max' })
    expect(parseTariffField('commission_bps', '50.01')).toEqual({ ok: false, error: 'above_max' })
    expect(parseTariffField('per_km_halalas', '0')).toEqual({ ok: false, error: 'below_min' })
    expect(parseTariffField('per_km_halalas', '0.49')).toEqual({ ok: false, error: 'below_min' })
    expect(parseTariffField('min_fare_halalas', '4.99')).toEqual({ ok: false, error: 'below_min' })
  })

  it('accepts valid values (incl. bounds and surrounding spaces) and converts to database units', () => {
    expect(parseTariffField('per_km_halalas', ' 1.65 ')).toEqual({ ok: true, value: 165 })
    expect(parseTariffField('per_km_halalas', '0.50')).toEqual({ ok: true, value: 50 })
    expect(parseTariffField('base_fare_halalas', '100')).toEqual({ ok: true, value: 10_000 })
    expect(parseTariffField('base_fare_halalas', '0')).toEqual({ ok: true, value: 0 }) // explicit 0 is allowed where the bound allows it
    expect(parseTariffField('commission_bps', '20')).toEqual({ ok: true, value: 2000 })
    expect(validateTariff(valid)).toEqual({
      ok: true,
      values: { base_fare_halalas: 600, per_km_halalas: 165, per_min_halalas: 30, min_fare_halalas: 1200, cancellation_fee_halalas: 0, commission_bps: 2000 },
    })
  })

  it('lists only the changed fields, old → new, for the confirmation step', () => {
    const cur = { base_fare_halalas: 600, per_km_halalas: 165, per_min_halalas: 30, min_fare_halalas: 1200, cancellation_fee_halalas: 0, commission_bps: 2000 }
    expect(tariffChanges(cur, { ...cur, per_km_halalas: 180, commission_bps: 1800 })).toEqual([
      { key: 'per_km_halalas', from: 165, to: 180 },
      { key: 'commission_bps', from: 2000, to: 1800 },
    ])
    expect(tariffChanges(cur, cur)).toEqual([])
    expect(toInput(165)).toBe('1.65')
  })

  it('client bounds match the database bounds (migrations 020 and catalog)', () => {
    const sql = readFileSync(join(ROOT, 'supabase', 'migrations', '20261205000100_tariff_bounds.sql'), 'utf8')
    const catalog = readFileSync(join(ROOT, 'supabase', 'migrations', '20261125000200_catalog.sql'), 'utf8')
    for (const k of TARIFF_KEYS) {
      const src = k === 'commission_bps' ? catalog : sql
      const m = new RegExp(`${k}\\s+between\\s+(\\d+)\\s+and\\s+(\\d+)`).exec(src)
      expect(m, k).not.toBeNull()
      expect({ min: Number(m![1]), max: Number(m![2]) }, k).toEqual({ min: TARIFF_BOUNDS[k].min, max: TARIFF_BOUNDS[k].max })
    }
  })
})
