/**
 * Client-side brute-force and SMS-spam guard (defence in depth: Supabase Auth
 * also rate-limits on the server). Pure logic over a key-value store so it can
 * be unit-tested and shared across tabs through localStorage.
 */
import { AUTH_POLICY } from './config'

export type KV = { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void }

export function memoryKV(): KV {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) }
}

/** Shared in-memory fallback so guard state survives across calls when storage is unavailable. */
const fallbackKV = memoryKV()

/** localStorage when available, in-memory otherwise (private mode, tests, SSR). */
export function browserKV(): KV {
  try {
    const ls = globalThis.localStorage
    const probe = '__aura_probe__'
    ls.setItem(probe, '1')
    ls.removeItem(probe)
    return {
      get: (k) => { try { return ls.getItem(k) } catch { return null } },
      set: (k, v) => { try { ls.setItem(k, v) } catch { /* quota / blocked */ } },
      remove: (k) => { try { ls.removeItem(k) } catch { /* noop */ } },
    }
  } catch {
    return fallbackKV
  }
}

export type GuardPolicy = { maxAttempts: number; lockMs: number; windowMs: number; resendMs: number }
export type GuardStatus = { locked: boolean; lockedUntil?: number; attemptsLeft: number }

type Rec = { fails: number[]; lockedUntil?: number; lastSent?: number }

export class AttemptGuard {
  constructor(
    private scope: string,
    private kv: KV = browserKV(),
    private policy: GuardPolicy = AUTH_POLICY,
    private now: () => number = () => Date.now(),
  ) {}

  private key(id: string) {
    return `aura.guard.${this.scope}.${id.trim().toLowerCase()}`
  }

  private read(id: string): Rec {
    try {
      return JSON.parse(this.kv.get(this.key(id)) ?? '{"fails":[]}') as Rec
    } catch {
      return { fails: [] }
    }
  }

  private write(id: string, r: Rec) {
    this.kv.set(this.key(id), JSON.stringify(r))
  }

  status(id: string): GuardStatus {
    const r = this.read(id)
    const t = this.now()
    if (r.lockedUntil && r.lockedUntil > t) return { locked: true, lockedUntil: r.lockedUntil, attemptsLeft: 0 }
    const recent = r.fails.filter((f) => t - f < this.policy.windowMs)
    return { locked: false, attemptsLeft: Math.max(0, this.policy.maxAttempts - recent.length) }
  }

  recordFailure(id: string): GuardStatus {
    const r = this.read(id)
    const t = this.now()
    if (r.lockedUntil && r.lockedUntil <= t) r.lockedUntil = undefined
    r.fails = [...r.fails.filter((f) => t - f < this.policy.windowMs), t]
    if (r.fails.length >= this.policy.maxAttempts) {
      r.lockedUntil = t + this.policy.lockMs
      r.fails = []
    }
    this.write(id, r)
    return this.status(id)
  }

  recordSuccess(id: string) {
    const r = this.read(id)
    this.write(id, { fails: [], lastSent: r.lastSent })
  }

  /** Can another code be sent to this identifier now? */
  canSend(id: string): { ok: boolean; waitMs: number } {
    const s = this.status(id)
    if (s.locked) return { ok: false, waitMs: (s.lockedUntil ?? 0) - this.now() }
    const last = this.read(id).lastSent
    const wait = last ? last + this.policy.resendMs - this.now() : 0
    return { ok: wait <= 0, waitMs: Math.max(0, wait) }
  }

  markSent(id: string) {
    const r = this.read(id)
    this.write(id, { ...r, lastSent: this.now() })
  }
}
