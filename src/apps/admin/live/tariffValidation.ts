/**
 * Tariff edit validation for the live admin console (Pricing page).
 *
 * The same bounds are enforced by the database (migration 020,
 * supabase/migrations/20261205000100_tariff_bounds.sql) — keep both in sync.
 * Inputs are SAR (or % for commission) as typed by staff; output is the database
 * units (halalas / basis points). An empty or malformed field is an error — it is
 * never turned into 0.
 */

export type TariffKey = 'base_fare_halalas' | 'per_km_halalas' | 'per_min_halalas' | 'min_fare_halalas' | 'cancellation_fee_halalas' | 'commission_bps'

/** Inclusive bounds in database units (halalas, or basis points for commission). */
export const TARIFF_BOUNDS: Record<TariffKey, { min: number; max: number; unit: 'sar' | 'pct' }> = {
  base_fare_halalas: { min: 0, max: 10_000, unit: 'sar' },
  per_km_halalas: { min: 50, max: 2_000, unit: 'sar' },
  per_min_halalas: { min: 0, max: 500, unit: 'sar' },
  min_fare_halalas: { min: 500, max: 20_000, unit: 'sar' },
  cancellation_fee_halalas: { min: 0, max: 10_000, unit: 'sar' },
  commission_bps: { min: 0, max: 5_000, unit: 'pct' },
}
export const TARIFF_KEYS = Object.keys(TARIFF_BOUNDS) as TariffKey[]

export type FieldError = 'required' | 'format' | 'below_min' | 'above_max'
export type TariffValidation =
  | { ok: true; values: Record<TariffKey, number> }
  | { ok: false; errors: Partial<Record<TariffKey, FieldError>> }

/** Plain decimal with at most two decimals: "12", "12.5", "0.75". No sign, no exponent, no spaces inside. */
const DECIMAL = /^\d{1,6}(\.\d{1,2})?$/

/** Database units → the text shown in the form (SAR or %), two decimals. */
export const toInput = (v: number) => (v / 100).toFixed(2)

/** One field: trims, rejects empty / malformed / out-of-range, converts to database units. */
export function parseTariffField(key: TariffKey, raw: string | undefined): { ok: true; value: number } | { ok: false; error: FieldError } {
  const s = (raw ?? '').trim()
  if (s === '') return { ok: false, error: 'required' }
  if (!DECIMAL.test(s)) return { ok: false, error: 'format' }
  const value = Math.round(Number(s) * 100)
  const b = TARIFF_BOUNDS[key]
  if (value < b.min) return { ok: false, error: 'below_min' }
  if (value > b.max) return { ok: false, error: 'above_max' }
  return { ok: true, value }
}

/** Every field must be valid; returns database values or the error of each bad field. */
export function validateTariff(draft: Partial<Record<TariffKey, string>>): TariffValidation {
  const errors: Partial<Record<TariffKey, FieldError>> = {}
  const values = {} as Record<TariffKey, number>
  for (const k of TARIFF_KEYS) {
    const r = parseTariffField(k, draft[k])
    if (r.ok) values[k] = r.value
    else errors[k] = r.error
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values }
}

/** Fields whose value changes, for the confirmation step (old → new, database units). */
export function tariffChanges(current: Record<TariffKey, number>, next: Record<TariffKey, number>): { key: TariffKey; from: number; to: number }[] {
  return TARIFF_KEYS.filter((k) => current[k] !== next[k]).map((k) => ({ key: k, from: current[k], to: next[k] }))
}
