/**
 * Money in halalas as BigInt (1 SAR = 100 halalas). No floating point anywhere.
 * Pure TypeScript shared by the Edge Functions and the apps (src/money/halalas.ts).
 *
 * Rounding matches PostgreSQL round(numeric): half away from zero, so client
 * previews equal the database (private.compute_quote / settle_ride).
 */
export type Halalas = bigint

export class MoneyError extends Error {}

const ARABIC_DIGITS = /[٠-٩۰-۹]/g
const toLatinDigits = (s: string) =>
  s.replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10)).replace(/٫/g, '.').replace(/[٬,\s]/g, '')

/** "12", "12.5", "1,234.50", "١٢٫٥٠" → halalas. At most 2 decimals; no exponent, no float. */
export function parseSar(input: string, opts: { allowNegative?: boolean } = {}): Halalas {
  const s = toLatinDigits(String(input).trim())
  const m = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) throw new MoneyError(`invalid_amount:${input}`)
  const neg = m[1] === '-'
  if (neg && !opts.allowNegative) throw new MoneyError('negative_amount')
  const v = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0')
  return neg ? -v : v
}

/** Server text ("12345"), BigInt, or a *safe integer* number → halalas. */
export function toHalalas(v: bigint | number | string): Halalas {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new MoneyError(`unsafe_number:${v}`)
    return BigInt(v)
  }
  if (!/^-?\d+$/.test(v.trim())) throw new MoneyError(`invalid_halalas:${v}`)
  return BigInt(v.trim())
}

/** For JSON APIs that require numbers (e.g. Moyasar "amount"); refuses unsafe values. */
export function toSafeNumber(h: Halalas): number {
  if (h > BigInt(Number.MAX_SAFE_INTEGER) || h < BigInt(Number.MIN_SAFE_INTEGER)) throw new MoneyError('amount_too_large')
  return Number(h)
}

const abs = (x: bigint) => (x < 0n ? -x : x)

/** "1,234.50" (always two decimals, Latin digits). */
export function formatSar(h: Halalas, opts: { grouping?: boolean } = {}): string {
  const neg = h < 0n
  const a = abs(h)
  const riyals = (a / 100n).toString()
  const hal = (a % 100n).toString().padStart(2, '0')
  const grouped = opts.grouping === false ? riyals : riyals.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${grouped}.${hal}`
}

/** amount × basis points (1500 = 15%), rounded half away from zero. */
export function applyBps(amount: Halalas, bps: bigint | number): Halalas {
  const b = BigInt(bps)
  const q = amount * b
  const sign = q < 0n ? -1n : 1n
  return (q + sign * 5000n) / 10000n
}

/** Round up to whole riyals (the fare engine's upfront price rule). */
export const ceilToRiyal = (h: Halalas): Halalas => (h <= 0n ? 0n : ((h + 99n) / 100n) * 100n)

export const sumHalalas = (xs: Halalas[]): Halalas => xs.reduce((a, b) => a + b, 0n)

/**
 * Split `total` by integer weights with the largest-remainder method: the parts
 * always add up to exactly `total` (no halala lost or created).
 */
export function allocate(total: Halalas, weights: (bigint | number)[]): Halalas[] {
  const w = weights.map((x) => BigInt(x))
  if (!w.length || w.some((x) => x < 0n)) throw new MoneyError('invalid_weights')
  const W = sumHalalas(w)
  if (W === 0n) throw new MoneyError('zero_weights')
  const base = w.map((x) => (total * x) / W)
  const rem = w.map((x, i) => ({ i, r: abs(total * x - base[i] * W) }))
  let left = total - sumHalalas(base)
  const step = left < 0n ? -1n : 1n
  rem.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i))
  for (let k = 0; left !== 0n; k = (k + 1) % rem.length) {
    base[rem[k].i] += step
    left -= step
  }
  return base
}

export type FareSplit = { subtotal: Halalas; discount: Halalas; vat: Halalas; total: Halalas; commission: Halalas; driverNet: Halalas }

/** Same arithmetic as private.compute_quote: VAT on (subtotal − discount), commission on subtotal. */
export function splitFare(p: { subtotal: Halalas; discount?: Halalas; commissionBps: number | bigint; vatBps: number | bigint }): FareSplit {
  const discount = p.discount ?? 0n
  if (p.subtotal < 0n || discount < 0n || discount > p.subtotal) throw new MoneyError('invalid_fare')
  const vat = applyBps(p.subtotal - discount, p.vatBps)
  const commission = applyBps(p.subtotal, p.commissionBps)
  const out = { subtotal: p.subtotal, discount, vat, total: p.subtotal - discount + vat, commission, driverNet: p.subtotal - commission }
  if (out.commission + out.driverNet !== out.subtotal) throw new MoneyError('split_invariant')
  return out
}

export type SettlementLine = { account: string; amount: Halalas }

/** The double entry settle_ride posts (credit > 0). Always sums to zero. */
export function settlementLines(method: 'card' | 'wallet' | 'cash', f: FareSplit): SettlementLine[] {
  const source = method === 'card' ? 'gateway_clearing' : method === 'wallet' ? 'wallet_holds' : 'driver_wallet'
  const lines: SettlementLine[] = [
    { account: source, amount: -f.total },
    { account: 'promo_expense', amount: -f.discount },
    { account: 'driver_wallet', amount: f.driverNet },
    { account: 'platform_commission', amount: f.commission },
    { account: 'platform_vat', amount: f.vat },
  ].filter((l) => l.amount !== 0n)
  if (sumHalalas(lines.map((l) => l.amount)) !== 0n) throw new MoneyError('unbalanced_settlement')
  return lines
}
