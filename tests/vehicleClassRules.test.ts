import { describe, expect, it } from 'vitest'
import { CLASS_RULE_LISTS, classifyVehicle } from '../src/data/vehicleClassRules'
import { MAKES } from '../src/data/vehicleCatalog'
import { normalizePlateLetters, plateLettersAr } from '../src/apps/driver/PlateInput'

const now = new Date('2026-11-26T00:00:00Z')
const c = (make: string, model: string, year: number, color = 'white') => classifyVehicle({ make, model, year, color }, now)

describe('automatic class from the vehicle', () => {
  it('Go: economy models', () => {
    expect(c('Toyota', 'Yaris', 2024)).toMatchObject({ primary: 'go', eligible: ['go'] })
    expect(c('Hyundai', 'Accent', 2026).primary).toBe('go')
  })
  it('Comfort: mid-size or premium, up to 6 years; older falls back to Go', () => {
    expect(c('Toyota', 'Camry', 2024)).toMatchObject({ primary: 'comfort', eligible: ['comfort'] })
    expect(c('Toyota', 'Camry', 2018).primary).toBe('go')
    expect(c('Mercedes-Benz', 'C-Class', 2023).primary).toBe('comfort') // premium make
  })
  it('Black: luxury model, up to 5 years, black exterior — otherwise Comfort with the reason', () => {
    expect(c('Lexus', 'ES', 2025, 'black')).toMatchObject({ primary: 'black', eligible: ['black'] })
    const white = c('Lexus', 'ES', 2025, 'white')
    expect(white.primary).toBe('comfort')
    expect(white.checks.black).toEqual({ ok: false, why: 'colour' })
    expect(c('Lexus', 'ES', 2019, 'black').checks.black).toEqual({ ok: false, why: 'age' })
  })
  it('XL: 7-seat models; a new black luxury XL may choose Black or XL', () => {
    expect(c('Hyundai', 'Staria', 2022)).toMatchObject({ primary: 'xl', eligible: ['xl'] })
    expect(c('GMC', 'Yukon', 2025, 'black')).toMatchObject({ primary: 'black', eligible: ['black', 'xl'] })
    expect(c('GMC', 'Yukon', 2025, 'white')).toMatchObject({ primary: 'xl', eligible: ['xl'] })
  })
  it('unlisted vehicle: Go by default, Go / Comfort / XL selectable, never Black', () => {
    const u = c('Acme', 'Roadster', 2025, 'black')
    expect(u).toMatchObject({ primary: 'go', unlisted: true })
    expect(u.eligible).toEqual(['go', 'comfort', 'xl'])
  })
  it('every model named in the rules exists in the catalogue', () => {
    const missing: string[] = []
    for (const [list, byMake] of Object.entries(CLASS_RULE_LISTS)) {
      for (const [makeId, models] of Object.entries(byMake as Record<string, string[] | 'all'>)) {
        const make = MAKES.find((m) => m.id === makeId)
        if (!make) { missing.push(`${list}:${makeId}`); continue }
        if (models === 'all') continue
        for (const m of models) if (!make.models.includes(m)) missing.push(`${list}:${makeId}:${m}`)
      }
    }
    expect(missing).toEqual([])
    for (const m of MAKES) for (const model of m.models) {
      const r = classifyVehicle({ make: m.en, model, year: 2026, color: 'black' }, now)
      expect(r.eligible).toContain(r.primary)
    }
  })
})

describe('Saudi plate letters', () => {
  it('accepts Arabic or Latin, keeps only plate letters, max 3', () => {
    expect(normalizePlateLetters('rhb')).toBe('RHB')
    expect(normalizePlateLetters('ر ه ب')).toBe('RHB')
    expect(normalizePlateLetters('أبحد')).toBe('ABJ')
    expect(normalizePlateLetters('QWF')).toBe('') // not used on Saudi plates
    expect(plateLettersAr('RHB')).toBe('ر ه ب')
  })
})
