# A2 — acceptance criteria → tests

Levels:
- **U**: unit tests (Vitest).
- **B**: browser, demo build.
- **L**: browser, LIVE build against a fully mocked Supabase; nothing leaves the browser.
- **D**: real device in BETA. Not run yet; see the checklist in `background-capabilities.md`.

Simulated tests prove AURA's own logic. They are not a substitute for **D**.

## How to run

Run the demo dev server first (`npm run dev`, port 5180) for the **B** suites. The **L** suites start their own server.

| Command | What |
|---|---|
| `npx vitest run tests/captainAlert.test.ts tests/captainNav.test.ts tests/captainOffline.test.ts tests/captainBackground.test.ts` | U |
| `npm run e2e:captain-alerts` | B: A2.1 |
| `npm run e2e:captain-nav` | B: A2.2 |
| `npm run e2e:captain-background` | B: A2.4 (simulation: Wake Lock stubbed, visibility faked) |
| `npm run e2e:captain-live` | L: A2.3 + A2.4 |
| `npm run e2e:rider-gps-live` | L: A1 regression + rider "no connection" banner |

## A2.1 New-request alert

| Criterion | U | B | D |
|---|---|---|---|
| No sound before a user gesture | ✔ | ✔ (autoplay emulated) | pending |
| Starts at once on a new offer; repeats | ✔ | ✔ | pending |
| Stops on accept / decline / expiry, and the vibration is cancelled | ✔ | ✔ | pending |
| The same offer never rings twice; a re-mount resumes an open offer | ✔ | ✔ | — |
| No Vibration API (iPhone) → said, no error | ✔ | ✔ | pending (iPhone) |
| Mute (kept per device), "Test alert" | ✔ | ✔ | pending |
| Silent switch (iPhone) | — | — | pending |

## A2.2 Navigation

| Criterion | U | B | D |
|---|---|---|---|
| Pickup → none on arrival → drop-off | ✔ | ✔ | pending |
| Official Google Maps / Waze URLs, coordinates only | ✔ | ✔ | — |
| Invalid coordinates refused | ✔ | — | — |
| `_blank` + `noopener,noreferrer` | ✔ | ✔ | — |
| iPhone: R1 warning before leaving | ✔ (detection) | ✔ | pending |
| Opens the installed app; return to AURA | — | — | pending |

## A2.3 Connection loss

| Criterion | U | L | D |
|---|---|---|---|
| Double tap → one request | ✔ | ✔ ("End trip") | pending |
| Lost accept answer → server-confirmed accepted, not "expired"; continues to "arriving" | ✔ | ✔ | pending |
| Lost start answer → server-confirmed started, not "wrong code" | ✔ | ✔ | — |
| Lost follow-up to "arriving" is completed before "arrived" | ✔ | — | — |
| A request that never arrived → retried → done | ✔ | ✔ | — |
| No answer → "not confirmed", screen keeps the last server-confirmed state | ✔ | ✔ | pending (airplane mode) |
| Business refusals (wrong code, taken offer) never retried | ✔ | — | — |
| Banner offline / online (captain and rider) | ✔ | ✔ | pending |
| Back online → server state shown ≤ 3 s; fresh GPS fix sent | — | ✔ (33 ms; GPS via captive-network path) | pending |
| "Connected but no internet" detected from failed requests | ✔ | ✔ | pending |

## A2.4 Background

| Criterion | U | B / L | D |
|---|---|---|---|
| Wake lock only while online; released offline / sign-out | ✔ | ✔ (B, stubbed) | pending |
| Re-acquired when the page returns after the system released it | ✔ | ✔ (B, simulated) | pending |
| Unsupported / refused → explained, captain stays online | ✔ | ✔ (B; real headless Chromium also refuses) | pending |
| Background notice: none < 10 s; "may have missed" ≥ 10 s; "no requests sent" > 2 min | ✔ | ✔ (B, fake clock) | pending |
| GPS chip reflects the real stream in LIVE | — | ✔ (L) | pending |
| "Reveal rider code" hidden in LIVE, kept in demo | — | ✔ (L / B) | — |

## A1 protection

`src/location/` is unchanged. The passenger app only gained the banner (2 lines). The A1 suites still pass:
- unit: `riderLocation.test.ts`
- `e2e:rider-gps`
- `e2e:rider-gps-live`
