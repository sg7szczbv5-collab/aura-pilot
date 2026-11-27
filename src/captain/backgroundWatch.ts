/**
 * A2.4 — what happened while the captain's app was not in front?
 *
 * A web app cannot run in the background on iOS (the page is suspended) and is throttled on Android;
 * GPS stops when the screen is off. The server only offers rides to captains whose position is at most
 * 2 minutes old (dispatch_candidates), so after a longer absence the captain was out of dispatch.
 * This module measures the absence; the screen tells the captain honestly, and the data layer
 * resyncs (serverMirror) as soon as the page is visible again.
 */

/** Absences shorter than this are ignored (notification shade, quick app switch). */
export const NOTICE_AFTER_MS = 10_000
/** Server-side freshness for dispatch: after this, no new offers were sent to this captain. */
export const DISPATCH_STALE_MS = 120_000

export type Away = { awayMs: number; outOfDispatch: boolean }

export function createBackgroundWatch(now: () => number) {
  let hiddenAt: number | null = null
  return {
    /** Page hidden. `online` = the captain was receiving requests at that moment. */
    hidden(online: boolean) {
      hiddenAt = online ? now() : null
    },
    /** Page visible again. Returns the absence worth telling the captain about, or null. */
    visible(stillOnline: boolean): Away | null {
      const at = hiddenAt
      hiddenAt = null
      if (at === null || !stillOnline) return null
      const awayMs = now() - at
      if (awayMs < NOTICE_AFTER_MS) return null
      return { awayMs, outOfDispatch: awayMs >= DISPATCH_STALE_MS }
    },
  }
}
