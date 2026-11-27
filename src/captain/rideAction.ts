/**
 * A2.3 — run one ride operation (accept, arrived, start, complete, cancel) safely over a bad network.
 *
 *  - One at a time: a second call for the same ride + operation while the first is running is
 *    refused ('busy'), so a double tap or a re-run effect never sends two requests.
 *  - The SERVER decides: whenever the answer is not a clean success — the request failed on the
 *    network, the response was lost, or the server refused — the ride is re-read from the server
 *    (`confirm`) before anything is reported. A refusal that is really "already done" (e.g. accept
 *    retried after a lost success) is a success; a refusal that is not done is reported as such.
 *  - Retries only when the network failed AND the server says it is not done yet (or cannot be
 *    reached). Business refusals (expired offer, wrong code, not allowed) are never retried.
 *  - Never claims success it could not confirm: with no answer from the server the result is
 *    'offline', and the screen keeps showing the last state the server confirmed.
 */
import { connectivity } from '../data/connectivity'

export type AttemptResult = { ok: true } | { ok: false; network: boolean; message?: string }
/** What the server says now: the operation is done, cannot happen any more, may still happen, or no answer. */
export type Confirmation = 'done' | 'impossible' | 'pending' | 'unknown'
export type RideActionResult =
  | { ok: true; via: 'response' | 'server' }
  | { ok: false; reason: 'busy' | 'rejected' | 'offline'; message?: string }

export type RideActionSpec = {
  key: string
  attempt: () => Promise<AttemptResult>
  confirm: () => Promise<Confirmation>
  /** Waits between network retries (ms). Default: 3 attempts in total. */
  delays?: number[]
  sleep?: (ms: number) => Promise<void>
}

export const DEFAULT_DELAYS = [800, 2000]
const inFlight = new Set<string>()

export function isBusy(key: string) {
  return inFlight.has(key)
}

export async function runRideAction(spec: RideActionSpec): Promise<RideActionResult> {
  if (inFlight.has(spec.key)) return { ok: false, reason: 'busy' }
  inFlight.add(spec.key)
  const delays = spec.delays ?? DEFAULT_DELAYS
  const sleep = spec.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  try {
    let lastMessage: string | undefined
    for (let i = 0; ; i++) {
      let r: AttemptResult
      try {
        r = await spec.attempt()
      } catch (e) {
        r = { ok: false, network: true, message: e instanceof Error ? e.message : String(e) }
      }
      if (r.ok || !r.network) connectivity.requestAnswered()
      else connectivity.requestFailed()
      if (r.ok) return { ok: true, via: 'response' }
      lastMessage = r.message
      let c: Confirmation
      try {
        c = await spec.confirm()
      } catch {
        c = 'unknown'
      }
      if (c !== 'unknown') connectivity.requestAnswered()
      if (c === 'done') return { ok: true, via: 'server' }
      if (c === 'impossible') return { ok: false, reason: 'rejected', message: lastMessage }
      // Not done yet. A business refusal with the server reachable is final; retry only network failures.
      if (!r.network && c === 'pending') return { ok: false, reason: 'rejected', message: lastMessage }
      if (i >= delays.length) return { ok: false, reason: r.network || c === 'unknown' ? 'offline' : 'rejected', message: lastMessage }
      await sleep(delays[i])
    }
  } finally {
    inFlight.delete(spec.key)
  }
}

/**
 * Supabase errors: a request that never got an HTTP answer has no SQLSTATE code (fetch failed,
 * connection reset, timeout). Anything with a code is the database answering.
 */
export function isNetworkError(e: { code?: string | null; message?: string; status?: number } | null | undefined): boolean {
  if (!e) return false
  if (e.code) return false
  if (typeof e.status === 'number' && e.status > 0 && e.status < 500 && e.status !== 408) return false
  return true
}
