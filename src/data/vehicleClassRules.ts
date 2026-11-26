/**
 * Automatic AURA class for a vehicle, from its make / model / year / colour —
 * the way ride-hailing apps assign products to a car:
 *
 *  • Aura XL      — 6+ passenger seats (3-row SUVs, minivans, vans).
 *  • Aura Black   — luxury model, at most BLACK_MAX_AGE years old, black exterior.
 *  • Aura Comfort — mid-size / premium model, at most COMFORT_MAX_AGE years old.
 *  • Aura Go      — everything else the age rule allows.
 *
 * A higher class also serves lower requests (see SERVES in core/pricing), so a car
 * gets the single highest class it qualifies for; a car that qualifies for both
 * Black and XL (e.g. a new black Escalade) lets the captain choose.
 * Unlisted vehicles ("Other") can pick Go, Comfort or XL and are checked by the reviewer.
 */
import type { VehicleClassId } from '../core/types'
import { findMake, type CatalogMake } from './vehicleCatalog'

export const COMFORT_MAX_AGE = 6
export const BLACK_MAX_AGE = 5
export const BLACK_COLORS = ['black']

/** 3-row / 6+ seat models, by make id. */
const XL: Record<string, string[]> = {
  toyota: ['Highlander', 'Grand Highlander', 'Land Cruiser', 'Land Cruiser Prado', 'Sequoia', 'Granvia', 'Hiace', 'Innova', 'Fortuner', 'Veloz', 'Rush'],
  lexus: ['GX', 'LX', 'TX', 'LM'],
  nissan: ['Pathfinder', 'Patrol', 'Urvan'],
  infiniti: ['QX60', 'QX80'],
  honda: ['Pilot', 'Odyssey'],
  mazda: ['CX-9', 'CX-90'],
  mitsubishi: ['Xpander', 'Xpander Cross', 'Outlander', 'Montero Sport', 'Pajero'],
  suzuki: ['Ertiga', 'XL7'],
  isuzu: ['MU-X'],
  hyundai: ['Santa Fe', 'Palisade', 'Staria', 'H-1'],
  kia: ['Sorento', 'Telluride', 'Carnival', 'Carens', 'EV9'],
  chevrolet: ['Captiva', 'Traverse', 'Tahoe', 'Suburban'],
  gmc: ['Acadia', 'Yukon', 'Yukon XL'],
  cadillac: ['XT6', 'Escalade', 'Escalade ESV'],
  ford: ['Explorer', 'Expedition', 'Everest'],
  lincoln: ['Aviator', 'Navigator'],
  jeep: ['Grand Cherokee L', 'Wagoneer', 'Grand Wagoneer'],
  dodge: ['Durango'],
  chrysler: ['Pacifica'],
  tesla: ['Model X'],
  mercedes: ['GLS', 'V-Class'],
  bmw: ['X7'],
  audi: ['Q7'],
  volkswagen: ['Teramont'],
  landrover: ['Discovery'],
  volvo: ['XC90', 'EX90'],
  peugeot: ['5008', 'Traveller'],
  skoda: ['Kodiaq'],
  mg: ['RX8', 'RX9'],
  changan: ['CS95'],
  geely: ['Okavango'],
  chery: ['Tiggo 8 Pro', 'Tiggo 8 Pro Max'],
  haval: ['H9'],
  jetour: ['X70', 'X70 Plus', 'X90 Plus'],
  exeed: ['VX'],
  byd: ['Tang'],
  gac: ['GS8', 'GN6', 'GN8', 'M8'],
  jac: ['JS8'],
  maxus: ['D90', 'G10', 'G50'],
  lynkco: ['09'],
  tank: ['500'],
}

/** Luxury models eligible for Aura Black (when new enough and black). */
const BLACK: Record<string, string[] | 'all'> = {
  lexus: ['ES', 'LS', 'LM', 'RX', 'TX', 'LX'],
  genesis: ['G80', 'G90', 'GV80', 'GV80 Coupe'],
  mercedes: ['E-Class', 'S-Class', 'GLE', 'GLS', 'G-Class', 'V-Class', 'EQE', 'EQS', 'Maybach S-Class', 'Maybach GLS'],
  bmw: ['5 Series', '7 Series', 'X5', 'X7', 'i5', 'i7', 'iX'],
  audi: ['A6', 'A7', 'A8', 'Q7', 'Q8', 'Q8 e-tron'],
  cadillac: ['Escalade', 'Escalade ESV'],
  lincoln: ['Aviator', 'Navigator'],
  gmc: ['Yukon', 'Yukon XL'],
  chevrolet: ['Tahoe', 'Suburban'],
  landrover: ['Range Rover', 'Range Rover Sport'],
  porsche: ['Panamera', 'Cayenne', 'Taycan'],
  volvo: ['S90', 'XC90'],
  infiniti: ['QX80'],
  nissan: ['Patrol'],
  toyota: ['Land Cruiser'],
  lucid: ['Air', 'Gravity'],
  tesla: ['Model S', 'Model X'],
  maserati: ['Quattroporte', 'Levante'],
  hongqi: ['H9', 'E-HS9'],
  bentley: 'all',
  rollsroyce: 'all',
}

/** Mid-size / higher-trim mainstream models eligible for Aura Comfort. */
const COMFORT: Record<string, string[]> = {
  toyota: ['Camry', 'Avalon', 'Crown', 'Corolla Cross', 'C-HR', 'RAV4', 'Fortuner', 'Highlander', 'Grand Highlander', 'Land Cruiser Prado', 'bZ4X'],
  nissan: ['Altima', 'Maxima', 'X-Trail', 'Pathfinder', 'Ariya'],
  honda: ['Civic', 'Accord', 'ZR-V', 'CR-V', 'Pilot', 'Odyssey'],
  mazda: ['Mazda6', 'CX-30', 'CX-5', 'CX-60', 'CX-70', 'CX-9', 'CX-90'],
  mitsubishi: ['Eclipse Cross', 'Outlander', 'Montero Sport', 'Pajero'],
  subaru: ['Outback', 'Forester'],
  hyundai: ['Sonata', 'Azera', 'Grandeur', 'Tucson', 'Santa Fe', 'Palisade', 'Staria', 'Ioniq 5', 'Ioniq 6'],
  kia: ['K5', 'K8', 'Sportage', 'Sorento', 'Telluride', 'Carnival', 'EV5', 'EV6', 'EV9'],
  chevrolet: ['Malibu', 'Equinox', 'Blazer', 'Traverse', 'Tahoe', 'Suburban'],
  gmc: ['Terrain', 'Acadia', 'Yukon', 'Yukon XL'],
  ford: ['Taurus', 'Territory', 'Escape', 'Edge', 'Explorer', 'Expedition', 'Everest'],
  jeep: ['Cherokee', 'Grand Cherokee', 'Grand Cherokee L', 'Wagoneer', 'Grand Wagoneer'],
  dodge: ['Charger', 'Durango'],
  chrysler: ['300', 'Pacifica'],
  volkswagen: ['Passat', 'Tiguan', 'Teramont', 'Touareg', 'ID.4'],
  skoda: ['Superb', 'Karoq', 'Kodiaq'],
  peugeot: ['408', '508', '3008', '5008', 'Traveller'],
  citroen: ['C5 Aircross', 'C5 X'],
  renault: ['Koleos', 'Arkana'],
  mg: ['MG7', 'HS', 'RX5', 'RX8', 'RX9', 'Whale'],
  changan: ['Raeton', 'UNI-T', 'UNI-K', 'UNI-V', 'CS75 Plus', 'CS85', 'CS95', 'Deepal S07'],
  geely: ['Preface', 'Tugella', 'Monjaro', 'Okavango', 'Starray'],
  chery: ['Arrizo 8', 'Tiggo 7 Pro', 'Tiggo 8 Pro', 'Tiggo 8 Pro Max', 'Tiggo 9'],
  haval: ['H6', 'H6 GT', 'Dargo', 'H9'],
  gwm: ['Tank 300', 'Tank 500'],
  jetour: ['X70 Plus', 'X90 Plus', 'Dashing', 'T2', 'G700'],
  exeed: ['LX', 'TXL', 'VX', 'RX'],
  byd: ['Seal', 'Seal U', 'Song Plus', 'Han', 'Tang', 'Sealion 7', 'Atto 3'],
  gac: ['GA6', 'GA8', 'Emkoo', 'Empow', 'GS8', 'GN6', 'GN8', 'M8'],
  hongqi: ['H5', 'HS5', 'HS7'],
  tank: ['300', '500', '700'],
  tesla: ['Model 3', 'Model Y'],
  maxus: ['D90', 'G10', 'G50'],
}

/** Premium makes: every model is at least Comfort. */
const PREMIUM_MAKES = new Set(['lexus', 'genesis', 'infiniti', 'mercedes', 'bmw', 'audi', 'porsche', 'landrover', 'jaguar', 'volvo', 'cadillac', 'lincoln', 'lucid', 'tesla', 'maserati', 'alfaromeo', 'bentley', 'rollsroyce', 'zeekr', 'lynkco', 'hongqi'])

const has = (list: string[] | 'all' | undefined, model: string) => list === 'all' || !!list?.some((m) => m.toLowerCase() === model.trim().toLowerCase())

export type ClassCheck = { ok: boolean; why?: 'age' | 'colour' | 'model' | 'seats' }
export type Classification = {
  /** Class selected automatically. */
  primary: VehicleClassId
  /** Classes the captain may pick (always contains primary). */
  eligible: VehicleClassId[]
  /** Per-class result, to explain why a class is not available. */
  checks: Record<VehicleClassId, ClassCheck>
  /** Make / model not in the catalogue: the reviewer confirms the class. */
  unlisted: boolean
}

export function classifyVehicle(v: { make: string; model: string; year: number; color: string }, now = new Date()): Classification {
  const make: CatalogMake | undefined = findMake(v.make)
  const listed = !!make && make.models.some((m) => m.toLowerCase() === v.model.trim().toLowerCase())
  const age = v.year ? now.getFullYear() - v.year : 99
  const id = make?.id ?? ''

  if (!listed) {
    const checks: Record<VehicleClassId, ClassCheck> = { go: { ok: true }, comfort: { ok: age <= COMFORT_MAX_AGE, why: 'age' }, black: { ok: false, why: 'model' }, xl: { ok: true } }
    if (checks.comfort.ok) delete checks.comfort.why
    return { primary: 'go', eligible: (['go', 'comfort', 'xl'] as const).filter((c) => checks[c].ok), checks, unlisted: true }
  }

  const isXl = has(XL[id], v.model)
  const blackModel = has(BLACK[id], v.model)
  const comfortModel = blackModel || PREMIUM_MAKES.has(id) || has(COMFORT[id], v.model)
  const checks: Record<VehicleClassId, ClassCheck> = {
    go: { ok: true },
    comfort: !comfortModel ? { ok: false, why: 'model' } : age > COMFORT_MAX_AGE ? { ok: false, why: 'age' } : { ok: true },
    black: !blackModel ? { ok: false, why: 'model' } : age > BLACK_MAX_AGE ? { ok: false, why: 'age' } : !BLACK_COLORS.includes(v.color) ? { ok: false, why: 'colour' } : { ok: true },
    xl: isXl ? { ok: true } : { ok: false, why: 'seats' },
  }
  // Highest single class (Black > XL > Comfort > Go); Black + XL both offered when both qualify.
  const tier: VehicleClassId = checks.black.ok ? 'black' : checks.comfort.ok ? 'comfort' : 'go'
  const primary: VehicleClassId = tier === 'black' ? 'black' : isXl ? 'xl' : tier
  const eligible: VehicleClassId[] = tier === 'black' && isXl ? ['black', 'xl'] : [primary]
  return { primary, eligible, checks, unlisted: false }
}

/** The model lists, exported for consistency tests against the catalogue. */
export const CLASS_RULE_LISTS = { XL, BLACK, COMFORT }
