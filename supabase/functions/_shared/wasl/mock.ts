/**
 * Offline Wasl stand-in (WASL_MODE=mock). Deterministic rules for development:
 *   - captain: invalid Saudi ID/Iqama, or an ID starting with "1099" → ineligible
 *   - vehicle: older than the configured maximum age → ineligible
 *   - trips: always accepted
 */
import { isValidSaudiId, vehicleAgeOk } from '../validators.ts'
import type { WaslOperation, WaslProvider, WaslResult } from './provider.ts'

export class MockWasl implements WaslProvider {
  readonly name = 'mock' as const

  async call(op: WaslOperation, p: Record<string, unknown>): Promise<WaslResult> {
    switch (op) {
      case 'driver_registration':
      case 'eligibility_check': {
        const id = String(p.national_id ?? '')
        const ok = isValidSaudiId(id) && !id.startsWith('1099')
        return ok
          ? { success: true, reference: `MOCK-D-${id.slice(-4)}`, response: { eligible: true } }
          : { success: false, response: { eligible: false, reason: 'mock_rule' } }
      }
      case 'vehicle_registration': {
        const ok = vehicleAgeOk(Number(p.year))
        return ok
          ? { success: true, reference: `MOCK-V-${String(p.sequence_number ?? '')}`, response: { eligible: true } }
          : { success: false, response: { eligible: false, reason: 'vehicle_too_old' } }
      }
      case 'trip_registration':
        return { success: true, reference: `MOCK-T-${String(p.ride_number ?? '')}`, response: { accepted: true } }
      case 'trip_update':
        return { success: true, response: { accepted: true } }
    }
  }
}
