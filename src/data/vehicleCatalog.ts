/**
 * Vehicle catalogue for captain registration: makes sold in Saudi Arabia, their
 * current passenger models (Latin names, as written on the Istimara), colours and
 * manufacturing years allowed by the vehicle-age rule.
 *
 * "Other" (OTHER) lets a captain type a make / model that is not listed; the
 * database stores free text, so the list can be extended at any time.
 */
import { VEHICLE_MAX_AGE_YEARS } from '../compliance/validators'

export type CatalogMake = { id: string; en: string; ar: string; origin: 'jp' | 'kr' | 'us' | 'eu' | 'cn' | 'other'; models: string[] }

export const OTHER = '__other__'

export const MAKES: CatalogMake[] = [
  // Japan
  { id: 'toyota', en: 'Toyota', ar: 'تويوتا', origin: 'jp', models: ['Camry', 'Corolla', 'Corolla Cross', 'Yaris', 'Yaris Cross', 'Raize', 'Rush', 'Veloz', 'Avalon', 'Crown', 'C-HR', 'RAV4', 'Fortuner', 'Highlander', 'Grand Highlander', 'Land Cruiser', 'Land Cruiser Prado', 'Sequoia', 'Granvia', 'Hiace', 'Innova', 'bZ4X'] },
  { id: 'lexus', en: 'Lexus', ar: 'لكزس', origin: 'jp', models: ['ES', 'IS', 'LS', 'LM', 'UX', 'NX', 'RX', 'RZ', 'GX', 'LX', 'TX'] },
  { id: 'nissan', en: 'Nissan', ar: 'نيسان', origin: 'jp', models: ['Sunny', 'Sentra', 'Altima', 'Maxima', 'Kicks', 'X-Trail', 'Pathfinder', 'Patrol', 'Urvan', 'Ariya'] },
  { id: 'infiniti', en: 'Infiniti', ar: 'إنفينيتي', origin: 'jp', models: ['Q50', 'QX50', 'QX55', 'QX60', 'QX80'] },
  { id: 'honda', en: 'Honda', ar: 'هوندا', origin: 'jp', models: ['City', 'Civic', 'Accord', 'HR-V', 'ZR-V', 'CR-V', 'Pilot', 'Odyssey'] },
  { id: 'mazda', en: 'Mazda', ar: 'مازدا', origin: 'jp', models: ['Mazda2', 'Mazda3', 'Mazda6', 'CX-3', 'CX-30', 'CX-5', 'CX-60', 'CX-70', 'CX-9', 'CX-90'] },
  { id: 'mitsubishi', en: 'Mitsubishi', ar: 'ميتسوبيشي', origin: 'jp', models: ['Attrage', 'Xpander', 'Xpander Cross', 'ASX', 'Eclipse Cross', 'Outlander', 'Montero Sport', 'Pajero'] },
  { id: 'suzuki', en: 'Suzuki', ar: 'سوزوكي', origin: 'jp', models: ['Swift', 'Dzire', 'Ciaz', 'Baleno', 'Fronx', 'Ertiga', 'XL7', 'Vitara', 'Grand Vitara', 'Jimny'] },
  { id: 'subaru', en: 'Subaru', ar: 'سوبارو', origin: 'jp', models: ['Impreza', 'XV', 'Crosstrek', 'Forester', 'Outback'] },
  { id: 'isuzu', en: 'Isuzu', ar: 'إيسوزو', origin: 'jp', models: ['MU-X', 'D-Max'] },
  // Korea
  { id: 'hyundai', en: 'Hyundai', ar: 'هيونداي', origin: 'kr', models: ['Accent', 'Elantra', 'Sonata', 'Azera', 'Grandeur', 'Venue', 'Creta', 'Kona', 'Tucson', 'Santa Fe', 'Palisade', 'Staria', 'H-1', 'Ioniq 5', 'Ioniq 6'] },
  { id: 'kia', en: 'Kia', ar: 'كيا', origin: 'kr', models: ['Pegas', 'Picanto', 'Rio', 'K3', 'Cerato', 'K4', 'K5', 'K8', 'Seltos', 'Sonet', 'Sportage', 'Sorento', 'Telluride', 'Carnival', 'Carens', 'EV5', 'EV6', 'EV9'] },
  { id: 'genesis', en: 'Genesis', ar: 'جينيسيس', origin: 'kr', models: ['G70', 'G80', 'G90', 'GV60', 'GV70', 'GV80', 'GV80 Coupe'] },
  // United States
  { id: 'chevrolet', en: 'Chevrolet', ar: 'شيفروليه', origin: 'us', models: ['Spark', 'Aveo', 'Onix', 'Malibu', 'Groove', 'Captiva', 'Trailblazer', 'Equinox', 'Blazer', 'Traverse', 'Tahoe', 'Suburban'] },
  { id: 'gmc', en: 'GMC', ar: 'جي إم سي', origin: 'us', models: ['Terrain', 'Acadia', 'Yukon', 'Yukon XL'] },
  { id: 'cadillac', en: 'Cadillac', ar: 'كاديلاك', origin: 'us', models: ['CT4', 'CT5', 'XT4', 'XT5', 'XT6', 'Lyriq', 'Escalade', 'Escalade ESV'] },
  { id: 'ford', en: 'Ford', ar: 'فورد', origin: 'us', models: ['Figo', 'Focus', 'Taurus', 'Mustang', 'Territory', 'Escape', 'Edge', 'Explorer', 'Expedition', 'Bronco', 'Everest'] },
  { id: 'lincoln', en: 'Lincoln', ar: 'لينكون', origin: 'us', models: ['Corsair', 'Nautilus', 'Aviator', 'Navigator'] },
  { id: 'jeep', en: 'Jeep', ar: 'جيب', origin: 'us', models: ['Compass', 'Cherokee', 'Grand Cherokee', 'Grand Cherokee L', 'Wrangler', 'Wagoneer', 'Grand Wagoneer'] },
  { id: 'dodge', en: 'Dodge', ar: 'دودج', origin: 'us', models: ['Charger', 'Challenger', 'Durango'] },
  { id: 'chrysler', en: 'Chrysler', ar: 'كرايسلر', origin: 'us', models: ['300', 'Pacifica'] },
  { id: 'tesla', en: 'Tesla', ar: 'تسلا', origin: 'us', models: ['Model 3', 'Model Y', 'Model S', 'Model X'] },
  { id: 'lucid', en: 'Lucid', ar: 'لوسيد', origin: 'us', models: ['Air', 'Gravity'] },
  // Europe
  { id: 'mercedes', en: 'Mercedes-Benz', ar: 'مرسيدس بنز', origin: 'eu', models: ['A-Class', 'C-Class', 'E-Class', 'S-Class', 'CLA', 'CLE', 'GLA', 'GLB', 'GLC', 'GLC Coupe', 'GLE', 'GLE Coupe', 'GLS', 'G-Class', 'V-Class', 'EQA', 'EQB', 'EQE', 'EQS', 'Maybach S-Class', 'Maybach GLS'] },
  { id: 'bmw', en: 'BMW', ar: 'بي إم دبليو', origin: 'eu', models: ['1 Series', '2 Series', '3 Series', '4 Series', '5 Series', '7 Series', '8 Series', 'X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'XM', 'i4', 'i5', 'i7', 'iX', 'iX3'] },
  { id: 'audi', en: 'Audi', ar: 'أودي', origin: 'eu', models: ['A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'Q2', 'Q3', 'Q5', 'Q7', 'Q8', 'Q4 e-tron', 'Q6 e-tron', 'Q8 e-tron', 'e-tron GT'] },
  { id: 'volkswagen', en: 'Volkswagen', ar: 'فولكس فاجن', origin: 'eu', models: ['Polo', 'Jetta', 'Passat', 'Golf', 'T-Roc', 'Tiguan', 'Teramont', 'Touareg', 'ID.4'] },
  { id: 'porsche', en: 'Porsche', ar: 'بورشه', origin: 'eu', models: ['Macan', 'Cayenne', 'Cayenne Coupe', 'Panamera', 'Taycan'] },
  { id: 'landrover', en: 'Land Rover', ar: 'لاند روفر', origin: 'eu', models: ['Defender', 'Discovery', 'Discovery Sport', 'Range Rover', 'Range Rover Sport', 'Range Rover Velar', 'Range Rover Evoque'] },
  { id: 'jaguar', en: 'Jaguar', ar: 'جاكوار', origin: 'eu', models: ['XE', 'XF', 'E-Pace', 'F-Pace', 'I-Pace'] },
  { id: 'volvo', en: 'Volvo', ar: 'فولفو', origin: 'eu', models: ['S60', 'S90', 'XC40', 'EX30', 'XC60', 'XC90', 'EX90'] },
  { id: 'mini', en: 'MINI', ar: 'ميني', origin: 'eu', models: ['Cooper', 'Countryman', 'Aceman'] },
  { id: 'peugeot', en: 'Peugeot', ar: 'بيجو', origin: 'eu', models: ['208', '301', '408', '508', '2008', '3008', '5008', 'Landtrek', 'Traveller'] },
  { id: 'renault', en: 'Renault', ar: 'رينو', origin: 'eu', models: ['Symbol', 'Megane', 'Duster', 'Koleos', 'Arkana'] },
  { id: 'citroen', en: 'Citroën', ar: 'سيتروين', origin: 'eu', models: ['C3', 'C4', 'C5 Aircross', 'C5 X'] },
  { id: 'skoda', en: 'Škoda', ar: 'سكودا', origin: 'eu', models: ['Octavia', 'Superb', 'Kamiq', 'Karoq', 'Kodiaq'] },
  { id: 'opel', en: 'Opel', ar: 'أوبل', origin: 'eu', models: ['Corsa', 'Astra', 'Crossland', 'Grandland'] },
  { id: 'fiat', en: 'Fiat', ar: 'فيات', origin: 'eu', models: ['500', 'Tipo', 'Doblo'] },
  { id: 'alfaromeo', en: 'Alfa Romeo', ar: 'ألفا روميو', origin: 'eu', models: ['Giulia', 'Stelvio', 'Tonale'] },
  { id: 'maserati', en: 'Maserati', ar: 'مازيراتي', origin: 'eu', models: ['Ghibli', 'Quattroporte', 'Grecale', 'Levante'] },
  { id: 'bentley', en: 'Bentley', ar: 'بنتلي', origin: 'eu', models: ['Flying Spur', 'Continental GT', 'Bentayga'] },
  { id: 'rollsroyce', en: 'Rolls-Royce', ar: 'رولز رويس', origin: 'eu', models: ['Ghost', 'Phantom', 'Cullinan', 'Spectre'] },
  // China
  { id: 'mg', en: 'MG', ar: 'إم جي', origin: 'cn', models: ['MG3', 'MG5', 'MG6', 'MG7', 'GT', 'ZS', 'HS', 'RX5', 'RX8', 'RX9', 'Whale', 'One', 'MG4 EV'] },
  { id: 'changan', en: 'Changan', ar: 'شانجان', origin: 'cn', models: ['Alsvin', 'Eado', 'Eado Plus', 'Raeton', 'UNI-T', 'UNI-K', 'UNI-V', 'CS35 Plus', 'CS55 Plus', 'CS75 Plus', 'CS85', 'CS95', 'Hunter', 'Deepal S07'] },
  { id: 'geely', en: 'Geely', ar: 'جيلي', origin: 'cn', models: ['Emgrand', 'Preface', 'Coolray', 'Tugella', 'Monjaro', 'Okavango', 'Azkarra', 'Starray', 'Geometry C'] },
  { id: 'chery', en: 'Chery', ar: 'شيري', origin: 'cn', models: ['Arrizo 5', 'Arrizo 6', 'Arrizo 8', 'Tiggo 2 Pro', 'Tiggo 4 Pro', 'Tiggo 7 Pro', 'Tiggo 8 Pro', 'Tiggo 8 Pro Max', 'Tiggo 9'] },
  { id: 'haval', en: 'Haval', ar: 'هافال', origin: 'cn', models: ['Jolion', 'H6', 'H6 GT', 'Dargo', 'H9'] },
  { id: 'gwm', en: 'GWM', ar: 'جريت وول', origin: 'cn', models: ['Poer', 'Wingle 7', 'Tank 300', 'Tank 500', 'Ora 03'] },
  { id: 'jetour', en: 'Jetour', ar: 'جيتور', origin: 'cn', models: ['X50', 'X70', 'X70 Plus', 'X90 Plus', 'Dashing', 'T1', 'T2', 'G700'] },
  { id: 'exeed', en: 'Exeed', ar: 'إكسيد', origin: 'cn', models: ['LX', 'TXL', 'VX', 'RX'] },
  { id: 'byd', en: 'BYD', ar: 'بي واي دي', origin: 'cn', models: ['Qin Plus', 'Seal', 'Seal U', 'Atto 3', 'Song Plus', 'Han', 'Tang', 'Sealion 7', 'Dolphin'] },
  { id: 'gac', en: 'GAC', ar: 'جي إيه سي', origin: 'cn', models: ['GA4', 'GA6', 'GA8', 'Emkoo', 'Empow', 'GS3', 'GS4', 'GS8', 'GN6', 'GN8', 'M8'] },
  { id: 'hongqi', en: 'Hongqi', ar: 'هونشي', origin: 'cn', models: ['H5', 'H9', 'HS3', 'HS5', 'HS7', 'E-HS9'] },
  { id: 'jac', en: 'JAC', ar: 'جاك', origin: 'cn', models: ['J7', 'JS3', 'JS4', 'JS6', 'JS8', 'T8'] },
  { id: 'baic', en: 'BAIC', ar: 'بايك', origin: 'cn', models: ['X35', 'X55', 'X7', 'BJ40', 'BJ60'] },
  { id: 'dongfeng', en: 'Dongfeng', ar: 'دونغ فنغ', origin: 'cn', models: ['Shine', 'Shine Max', 'Aeolus Huge', 'Mage'] },
  { id: 'kaiyi', en: 'Kaiyi', ar: 'كايي', origin: 'cn', models: ['X3 Pro', 'X7'] },
  { id: 'zeekr', en: 'Zeekr', ar: 'زيكر', origin: 'cn', models: ['001', '007', '7X', 'X'] },
  { id: 'lynkco', en: 'Lynk & Co', ar: 'لينك آند كو', origin: 'cn', models: ['01', '03', '05', '06', '09'] },
  { id: 'tank', en: 'Tank', ar: 'تانك', origin: 'cn', models: ['300', '500', '700'] },
  { id: 'soueast', en: 'Soueast', ar: 'ساوايست', origin: 'cn', models: ['S07', 'S09'] },
  { id: 'maxus', en: 'Maxus', ar: 'ماكسوس', origin: 'cn', models: ['D60', 'D90', 'G10', 'G50', 'T60'] },
]

/** Colours as stored in vehicles.color (key) with labels and a swatch. */
export const VEHICLE_COLORS: { id: string; ar: string; en: string; hex: string }[] = [
  { id: 'white', ar: 'أبيض', en: 'White', hex: '#F5F5F3' },
  { id: 'pearl', ar: 'أبيض لؤلؤي', en: 'Pearl white', hex: '#EDEBE3' },
  { id: 'black', ar: 'أسود', en: 'Black', hex: '#141516' },
  { id: 'silver', ar: 'فضي', en: 'Silver', hex: '#B9BCBE' },
  { id: 'grey', ar: 'رمادي', en: 'Grey', hex: '#6E7174' },
  { id: 'darkgrey', ar: 'رمادي غامق', en: 'Dark grey', hex: '#3F4245' },
  { id: 'blue', ar: 'أزرق', en: 'Blue', hex: '#2F4E8C' },
  { id: 'navy', ar: 'كحلي', en: 'Navy', hex: '#1E2A44' },
  { id: 'red', ar: 'أحمر', en: 'Red', hex: '#9C2B2B' },
  { id: 'maroon', ar: 'عنابي', en: 'Maroon', hex: '#5C1F24' },
  { id: 'beige', ar: 'بيج', en: 'Beige', hex: '#D9C9A8' },
  { id: 'champagne', ar: 'شامبين', en: 'Champagne', hex: '#C9B48A' },
  { id: 'gold', ar: 'ذهبي', en: 'Gold', hex: '#B8963E' },
  { id: 'brown', ar: 'بني', en: 'Brown', hex: '#5A4132' },
  { id: 'green', ar: 'أخضر', en: 'Green', hex: '#2F5D45' },
  { id: 'orange', ar: 'برتقالي', en: 'Orange', hex: '#C8642A' },
  { id: 'yellow', ar: 'أصفر', en: 'Yellow', hex: '#D8B33A' },
]

export const colorById = (id?: string) => VEHICLE_COLORS.find((c) => c.id === id?.toLowerCase())
export const colorHex = (id?: string) => colorById(id)?.hex ?? (id?.toLowerCase() === 'gray' ? '#6E7174' : '#B9BCBE')

/** Manufacturing years a captain may register: newest first, back to the vehicle-age limit. */
export function vehicleYears(now = new Date()): number[] {
  const newest = now.getFullYear() + 1
  const oldest = now.getFullYear() - VEHICLE_MAX_AGE_YEARS
  return Array.from({ length: newest - oldest + 1 }, (_, i) => newest - i)
}

/** Catalogue entry for a stored make name ("Toyota", "mercedes-benz", …). */
export const findMake = (name?: string) => {
  const n = name?.trim().toLowerCase()
  return n ? MAKES.find((m) => m.en.toLowerCase() === n || m.id === n) : undefined
}
