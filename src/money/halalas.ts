/**
 * BigInt halalas for the apps: the exact same module the Edge Functions use, so
 * a fare split or settlement previewed in the browser equals the server's.
 */
export {
  MoneyError,
  allocate,
  applyBps,
  ceilToRiyal,
  formatSar,
  parseSar,
  settlementLines,
  splitFare,
  sumHalalas,
  toHalalas,
  toSafeNumber,
  type FareSplit,
  type Halalas,
  type SettlementLine,
} from '../../supabase/functions/_shared/money'

import { formatSar, toHalalas } from '../../supabase/functions/_shared/money'

/** Format a halalas value that may still be a legacy number in the demo store. */
export const sarText = (h: bigint | number | string) => formatSar(toHalalas(typeof h === 'number' ? Math.round(h) : h))
