/** A2.2 — Google Maps / Waze links: right target per ride status, coordinates only, valid URLs. */
import { describe, expect, it, vi } from 'vitest'
import { isIOS, navTarget, navUrl, openNav, validCoords } from '../src/captain/navLinks'

const P = { lat: 24.774312, lng: 46.738621 }
const D = { lat: 24.693511, lng: 46.669802 }
const trip = (status: string) => ({ status, pickup: { pos: P }, dropoff: { pos: D } })

describe('A2.2 target follows the ride', () => {
  it('pickup while heading to the rider', () => {
    expect(navTarget(trip('driver_assigned'))).toEqual({ leg: 'pickup', pos: P })
    expect(navTarget(trip('driver_arriving'))).toEqual({ leg: 'pickup', pos: P })
  })
  it('drop-off once the rider is on board', () => {
    expect(navTarget(trip('in_progress'))).toEqual({ leg: 'dropoff', pos: D })
  })
  it('no target when not driving somewhere (arrived, searching, completed, cancelled)', () => {
    for (const s of ['driver_arrived', 'searching', 'completed', 'cancelled', 'expired']) expect(navTarget(trip(s))).toBeNull()
  })
})

describe('A2.2 links', () => {
  it('Google Maps: official directions URL to the coordinates, driving', () => {
    const u = new URL(navUrl('google', P)!)
    expect(u.origin + u.pathname).toBe('https://www.google.com/maps/dir/')
    expect(u.searchParams.get('api')).toBe('1')
    expect(u.searchParams.get('destination')).toBe('24.774312,46.738621')
    expect(u.searchParams.get('travelmode')).toBe('driving')
  })
  it('Waze: official ul link with navigate=yes', () => {
    const u = new URL(navUrl('waze', D)!)
    expect(u.origin + u.pathname).toBe('https://waze.com/ul')
    expect(u.searchParams.get('ll')).toBe('24.693511,46.669802')
    expect(u.searchParams.get('navigate')).toBe('yes')
  })
  it('carries coordinates only — no names, ids or addresses', () => {
    for (const app of ['google', 'waze'] as const) {
      const u = new URL(navUrl(app, P)!)
      const keys = [...u.searchParams.keys()].sort()
      expect(keys).toEqual(app === 'google' ? ['api', 'destination', 'travelmode'] : ['ll', 'navigate'])
    }
  })
  it('rounds to 6 decimals without trailing zeros', () => {
    expect(new URL(navUrl('waze', { lat: 24.7, lng: 46.123456789 })!).searchParams.get('ll')).toBe('24.7,46.123457')
  })
  it('refuses unusable coordinates (NaN, out of range, 0,0)', () => {
    for (const p of [{ lat: NaN, lng: 46 }, { lat: 91, lng: 46 }, { lat: 24, lng: 181 }, { lat: 0, lng: 0 }]) {
      expect(validCoords(p)).toBe(false)
      expect(navUrl('google', p)).toBeNull()
      expect(navUrl('waze', p)).toBeNull()
    }
  })
  it('opens in a new context without opener or referrer', () => {
    const open = vi.fn()
    openNav('https://waze.com/ul?ll=1,2&navigate=yes', open)
    expect(open).toHaveBeenCalledWith('https://waze.com/ul?ll=1,2&navigate=yes', '_blank', 'noopener,noreferrer')
  })
})

describe('A2.2 iPhone detection for the R1 warning', () => {
  it('iPhone / iPad / iPadOS-as-Mac are iOS; Android and desktop are not', () => {
    expect(isIOS({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15' })).toBe(true)
    expect(isIOS({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', maxTouchPoints: 5 })).toBe(true)
    expect(isIOS({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', maxTouchPoints: 0 })).toBe(false)
    expect(isIOS({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile' })).toBe(false)
  })
})
