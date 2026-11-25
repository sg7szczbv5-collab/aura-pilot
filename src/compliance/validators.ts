/** Same validators the Edge Functions use; the database enforces identical rules. */
export {
  PLATE_LETTERS,
  VEHICLE_MAX_AGE_YEARS,
  ageOn,
  formatIban,
  isValidPlate,
  isValidSaudiIban,
  isValidSaudiId,
  isValidSequenceNumber,
  saudiIdCheckDigit,
  saudiIdKind,
  vehicleAgeOk,
} from '../../supabase/functions/_shared/validators'
