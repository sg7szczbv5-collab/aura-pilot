/**
 * Saudi identity and banking validators. Pure TypeScript shared by the apps
 * (src/compliance/validators.ts) and Edge Functions; the database applies the
 * same rules (private.valid_saudi_id / private.valid_saudi_iban), parity tested.
 */

/** National ID (starts with 1) or Iqama (starts with 2): 10 digits, Luhn variant. */
export function isValidSaudiId(id: string): boolean {
  if (!/^[12]\d{9}$/.test(id)) return false
  let sum = 0
  for (let i = 0; i < 10; i++) {
    let d = id.charCodeAt(i) - 48
    if (i % 2 === 0) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

/** Last digit that makes the first nine digits a valid ID (test data, forms). */
export function saudiIdCheckDigit(first9: string): string {
  if (!/^[12]\d{8}$/.test(first9)) throw new Error('invalid_prefix')
  for (let c = 0; c <= 9; c++) if (isValidSaudiId(first9 + c)) return String(c)
  throw new Error('unreachable')
}

export const saudiIdKind = (id: string): 'citizen' | 'resident' | null => (!isValidSaudiId(id) ? null : id[0] === '1' ? 'citizen' : 'resident')

/** Saudi IBAN (24 chars): "SA" + 2 check digits + 2-digit bank code + 18-digit account, ISO 13616 mod-97 (BigInt). */
export function isValidSaudiIban(input: string): boolean {
  const iban = input.replace(/\s/g, '').toUpperCase()
  if (!/^SA\d{22}$/.test(iban)) return false // 24 characters: SA + 2 check digits + 20
  const rearranged = iban.slice(4) + '2810' + iban.slice(2, 4) // S=28, A=10
  return BigInt(rearranged) % 97n === 1n
}

export const formatIban = (iban: string) => iban.replace(/\s/g, '').toUpperCase().replace(/(.{4})(?=.)/g, '$1 ')

/** Placeholder rule (private.compliance_setting('vehicle_max_age_years')); confirm with TGA per class. */
export const VEHICLE_MAX_AGE_YEARS = 10
export const vehicleAgeOk = (year: number, now = new Date()) => Number.isInteger(year) && year >= now.getFullYear() - VEHICLE_MAX_AGE_YEARS && year <= now.getFullYear() + 1

/** Latin plate letters accepted on Saudi plates, plus 1–4 digits. */
export const PLATE_LETTERS = 'ABJDRSXTEGKLZNHUV'
export const isValidPlate = (letters: string, digits: string) =>
  /^[A-Z]{3}$/.test(letters) && [...letters].every((l) => PLATE_LETTERS.includes(l)) && /^\d{1,4}$/.test(digits)

/** Istimara (registration) sequence number. */
export const isValidSequenceNumber = (s: string) => /^\d{6,12}$/.test(s)

export const ageOn = (dob: Date, now = new Date()) =>
  now.getFullYear() - dob.getFullYear() - (now.getMonth() < dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate()) ? 1 : 0)
