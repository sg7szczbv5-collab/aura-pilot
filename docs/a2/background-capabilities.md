# A2 — Captain app: background, alerts and connectivity on real phones

AURA's captain app is a **web app** (no native wrapper, no Service Worker, no Web Push in this build).
This page says what a web app can and cannot do on iPhone and Android, what AURA does about each point,
and **how each point was verified**. "Browser simulation" means headless Chromium with faked APIs. It
proves AURA's own rules, **not** the phone's behaviour. Every "real device" row still has to be run on
a phone in the BETA environment (checklist at the end).

## Capability matrix

| Capability | iPhone (Safari) | Android (Chrome) | What AURA does | Verified |
|---|---|---|---|---|
| Run JavaScript while in the background / screen locked | **No**: the page is suspended. | Throttled (timers slowed down heavily); suspended when the screen is off. | Does not pretend otherwise. Resyncs immediately when the page is visible again, and shows how long it was away (A2.4). | Unit + browser simulation. **Real device pending.** |
| GPS while in the background / screen off | **No**: `watchPosition` stops. | Stops when the page is hidden / screen off. | The server only dispatches to captains whose position is ≤ 2 min old (`dispatch_candidates`), so a backgrounded captain drops out of dispatch automatically. The notice says so after > 2 min. | Server rule read from the code (migration `…0800_rpc.sql`). **Real device pending.** |
| New-request **sound** | Only while AURA is in front and after a tap (autoplay policy). The silent switch may mute Web Audio. | Only while in front (or recently in front) and after a tap. | The tap on "Go online" unlocks sound. A status row says when alerts are locked or muted, with a "Test alert" button (A2.1). | Unit + browser (autoplay **emulated**). **Speaker / silent switch pending.** |
| New-request **vibration** | **Not available** (no Vibration API). | Yes, after the user has tapped the page. | Vibrates on Android; on iPhone the row says vibration is not supported. | Unit + browser simulation. **Real vibration pending.** |
| Keep the screen on (Screen Wake Lock) | Safari 16.4+ (per WebKit release notes); not in older versions. | Chrome 84+. | Requested **only while the captain is online**. Released when they go offline or sign out. Re-acquired when the page returns. If unsupported or refused, says so and what to do (A2.4). | Unit + browser simulation (API stubbed). **Real device pending** (incl. home-screen mode on iPhone). |
| Alerts when the app is closed (push) | Only installed home-screen web apps (16.4+) with a Service Worker and a push server: **not in this build**. | Needs a Service Worker and a push server: **not in this build**. | None. Captains must keep AURA open. Stated in the app. | n/a (declared limitation R4). |
| Opening Google Maps / Waze | Safari goes to the background: **GPS and alerts stop** while the other app is in front. | Same when AURA is fully hidden; split-screen keeps AURA visible on many devices. | Warns on iPhone **before** leaving (R1). The rider sees the captain's last position until AURA is back in front. | Browser (links, warning). **Hand-off to the installed app pending.** |
| Losing the connection mid-trip | Same on both platforms. | Same on both platforms. | One operation at a time. The server confirms before success is shown, and nothing is claimed without an answer. "No connection" banner. Resync and a fresh GPS fix when the connection returns (A2.3). | Unit (scripted server) + LIVE browser with mocked Supabase. **Real networks pending.** |

**R1: accepted for BETA only.** On iPhone, a web app cannot keep sending the captain's position while
another app (navigation) is in front or the screen is locked. This is **not** acceptable for a
commercial launch. The fix is a native shell (e.g. Capacitor) with background location and push. That
is a separate decision, outside A2.

## Real-device checklist (BETA, test accounts only)

Use one iPhone (Safari, latest iOS, plus one older iOS if possible) and one Android phone (Chrome).
Record the result of each step (pass / fail / note) and the OS and browser versions.

1. **Sound unlock:** sign in as captain → "Go online". The row says "Request sound on". Tap "Test alert": you hear two beeps (and Android vibrates).
2. **Silent switch (iPhone):** with the ringer switch on silent, request a ride from a rider test account. Note whether the beep is heard.
3. **Offer alert:** request a ride. The tone and vibration repeat until Accept or Decline, and stop at once. Repeat and let it expire: it stops at the timeout.
4. **Reload while online:** reload the page and request a ride before touching the screen. Expected: no sound, and the row says "tap to enable". Tap the row, then request again: it rings.
5. **Screen stays on:** online, leave the phone untouched longer than its auto-lock time. Expected: the screen stays on (where supported). Go offline: the screen locks normally again.
6. **Background:**
   - Online, switch to another app for about 1 minute, then come back. Expected: a notice "AURA was in the background…" and the status refreshes.
   - Repeat for more than 2 minutes. Expected: the notice says no new requests were sent.
   - Meanwhile, from the rider account, request a ride and check that the captain was not offered it while away for more than 2 minutes.
7. **Screen locked:** online, lock the phone for 3 minutes, then unlock. Same as step 6.
8. **Navigation:**
   - On an accepted ride, tap Google Maps, then Waze. Each opens the installed app at the pickup, and later at the drop-off.
   - On iPhone the warning appears first.
   - On the rider phone, note how the captain's position behaves while the captain is in the navigation app.
9. **Connection:** during a ride, turn on airplane mode.
   - The banner appears. Tap "I've arrived": the message says the server did not confirm it.
   - Turn airplane mode off. The banner clears and the state refreshes; tap again.
   - Also try a weak signal (lift, underground car park) while accepting an offer.
10. **Double tap:** tap "End trip" twice quickly. Only one completion appears in the admin trip log.
