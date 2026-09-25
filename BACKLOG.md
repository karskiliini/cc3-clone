# Feature and bug queue

Process requests in the order received. New requests are appended to the queue without interrupting the active item. Change that order only when the user explicitly reprioritizes or cancels work.

- Give every item a stable, increasing ID and mark it as a feature or bug.
- Record the request and a concrete completion criterion before starting it.
- Keep one item active. Finish and verify it before starting the next queued item.
- If an item cannot proceed, record the specific blocker and continue with the oldest unblocked item. Return to the blocked item when it becomes actionable.
- Keep completed items and their verification evidence below.
- After each completed fix or feature passes verification, commit it and push the new version to GitHub on the current working branch. This is an ongoing user preference.

## Active

**010 — Bug/feature: Explosion protection and posture.**

Request: Good cover should substantially reduce explosion effects. Exposed standing soldiers should take more damage and be thrown by sufficiently strong blasts.

Completion: Apply cover and posture consistently to blast injury, suppression, knockback and recovery, including vehicle explosions. Preserve directional protection and close exposed blast danger, verify relative outcomes and visible knockdown behavior, then commit and push.

## Queued

**011 — Feature: Command layer and per-side perspective (multiplayer prerequisite).**

Request: Prepare the sim for multiplayer (plan: `docs/superpowers/plans/multiplayer.md` §7 P1–P2). All UI-to-sim mutations become serializable commands applied at tick boundaries, and the sim stops assuming a single human `playerSide`.

Completion: `Battle.submit(command)` queues orders, deploy moves, truce, flee, pause and speed, applying them at the start of a sim tick in canonical order. No UI or render module calls `issueOrder`, `deployTeam`, `flee` or `addMessage` on sim state directly. `controllers: Record<Side, 'human' | 'ai'>` replaces `playerSide`/`aiBothSides` in the sim. Messages carry a side tag, and each side's debrief is graded from its own perspective. A test battle with two human sides runs without AI orders, and the harness still passes with both sides on AI. Single-player plays unchanged; full test suite and `npm run build` pass.

**012 — Feature: Determinism fixes, state hash and replays (multiplayer prerequisite).**

Request: Make lockstep determinism verifiable (plan §2 D1–D7, §7 P3–P5).

Completion:
- The crater height-field sync happens in the sim (`leaveCrater`), and render no longer writes `BattleState` (the `unitRender.ts` muzzle snap).
- `Rng` exposes its state, and `hashState` covers RNG state, time, soldiers, vehicles, VLs and scores.
- Battles record a command log that can be saved and replayed.
- A replay run in a fresh Node process reproduces the identical per-tick hash chain.
- `tools/determinism.html` gives identical hash chains in Chrome, Firefox, Safari and Node for 5 maps × 2 seeds. If it does not, the sim moves to a deterministic `src/shared/dmath.ts`, with a test banning `Math` transcendental functions under `src/sim`.

**013 — Feature: Online multiplayer (umbrella).**

Request: "plan multiplayer to the backlog. We should ponder 2 possibilities. 1) local games connecting to each other over internet, and 2) the game runs on a server and each player connects to the server and plays it." Both are evaluated in `docs/superpowers/plans/multiplayer.md`. The recommendation is deterministic lockstep over a WebSocket relay (option 1), with the authoritative server (option 2) kept as a later path for ranked play.

Blocked on: 011, 012 and the user decisions in plan §8 (1v1 or co-op, AI availability, lobby/ranked, relay hosting, map-hack tolerance, speed and pause policy, Safari support, scope).

Completion: plan milestones M1–M5 are met.
- Two browsers on different networks choose their own forces and deploy.
- They play a full battle through the deployed relay with matching state hashes.
- Pause and speed follow the agreed policy.
- A disconnect offers AI takeover or forfeit.
- A reloaded tab rejoins by fast-forwarding the command log.
- A desync produces a downloadable log that reproduces offline.

The next request receives ID 014.

## Completed

| ID | Type | Request | Result |
| --- | --- | --- | --- |
| 001 | Feature | Slow crew panic bail-out | Crews climb out, drop down, remain prone in shock, then crawl toward cover. |
| 002 | Feature | Ctrl+number group assignment and number selection UI | Numbered groups support keyboard assignment/recall and HUD buttons with team counts and active selection. |
| 003 | Feature | Guesstimate fire through obscured areas with vegetation interactions | Vehicles and MGs scatter fire around ordered areas or recent beliefs; rounds cut vegetation, damage/remove woody cover, and can deflect with visible effects. |
| 004 | Bug | Tanks slide sideways and backwards when seeking cover | Tanks follow reachable routes with hull-aligned movement, turn toward side cover, use aligned reverse when appropriate, settle in cover, and resume their prior route after the threat clears. |
| 005 | Feature | Release Shift to finish movement waypoint placement at the last placed point | Move, Move Fast, and Sneak now finish on Shift release without another click. Earlier points remain ordered waypoints; the last becomes the destination. Empty chains stay in targeting mode, Escape cancels, and window blur does not submit a route. |
| 006 | Feature/bug | Soldiers move and animate too fast; aiming takes practically no time | Infantry walk at 1.1 m/s and run at 2.4 m/s, with crouch/crawl caps of 0.7/0.3 m/s and slower emergency, carrying, and crew movement. Animation steps follow distance without phase jumps; idle and posture changes are slower. Soldiers turn, raise, and settle before firing, with acquisition affected by range, handling, training, fatigue, and suppression. Moving troops halt to aim, then resume; target changes, relocation, and interruptions require reacquisition. Existing vehicle and crew weapon firing timing is preserved. |
| 007 | Feature | SMG aimed, hip, and prone fire with torso rotation, recoil, sweeping bullets, and panic-related magazine dumps | MP40 and PPSh rounds fire individually at timed cyclic intervals. Aim and shot bearings drive torso poses, recoil, flashes, and traced bullets. Close engagements can use less accurate hip fire; prone fire is steadier. Stress and inexperience increase full-magazine sweeps, which stop on interruptions. New sprite atlases cover both sides, seasons, and resolutions. |
| 008 | Feature | Hasty fire during assault, heavy defensive pressure, or panic | Close assaults and defensive pressure allow faster, less accurate small-arms fire. Physical rays scatter; suppressed shooters hesitate between shots. Full panic occasionally allows a brief erratic shot/burst while preserving hesitation/flight, visibility, weapon cycles, reloads, and severe-state interruption. |
| 009 | Feature | Separately carried machine-gun mounts | A capable assistant carries the physical mount, moves more slowly and keeps his hands occupied. Carrier incapacity drops the mount for physical recovery. MG34/MG42 tripod guns can become light MGs; the Maxim waits for a carrier. Deployed guns stay mounted after assistant casualties. Equipment and carrier poses reflect the actual load, including transport boarding and riding. |

Verified together on 2026-09-19: 77 test files passed; 653 tests passed and 2 pre-existing tests skipped. `npm run build` passed, including `tsc --noEmit`. Control-group HUD and vegetation effects were also checked in the browser.

Item 005 verified on 2026-09-19: nine new tests exercise keyboard/mouse events through the battle screen, including quick Shift releases. Full suite: 78 files passed, 662 tests passed, 2 pre-existing skips. `npm run build` passed, including `tsc --noEmit`.

Item 006 verified on 2026-09-19: movement/posture limits, crew hauling without teleporting, crowd separation, physical animation cadence, acquisition and interruption behavior, move/aim/fire/resume, and full battle-loop pause/resume covered by regression tests. Existing arrival tests now wait for the slower movement. Browser preview checked with the real infantry simulation and unit renderer. Full suite: 80 files passed, 705 tests passed, 2 pre-existing skips. `npm run build` passed, including `tsc --noEmit`; `git diff --check` passed. Logs: `/private/tmp/cc3-infantry-final-tests.log`, `/private/tmp/cc3-infantry-build.log`.

Item 007 verified on 2026-09-19: 84 test files passed, 745 tests passed, 2 pre-existing skips. `npm run build` passed, including `tsc --noEmit`; `git diff --check` passed. Regression coverage includes individual ammunition consumption, burst interruption, physical swept rays, infantry/vehicle/terrain interception, suppression, posture and torso animation, muzzle alignment, single-round sound, and sprite assets. The live SMG preview was checked with no browser errors. Logs: `/private/tmp/cc3-smg-final-tests.log`, `/private/tmp/cc3-smg-build.log`.

Item 008 verified on 2026-09-19: 85 test files passed, 754 tests passed, 2 pre-existing skips. `npm run build` (including `tsc --noEmit`) and `git diff --check` passed. New tests cover rifle, pistol, SMG and LMG acquisition/accuracy, defensive pressure, distance, mechanical cycling, reloading, visibility, probabilistic panic fire, and broken/cowering states. Existing suppression-rate regression remains passing. Logs: `/private/tmp/cc3-hasty-final-tests.log`, `/private/tmp/cc3-hasty-final-build.log`.

Item 009 verified on 2026-09-19: 87 test files passed, 784 tests passed, 2 pre-existing skips. `npm run build` (including `tsc --noEmit`) and `git diff --check` passed. New regressions cover carrier selection/incapacity, loaded hands, portable fallback and ammunition conservation, mounted firing after casualties, heavy-gun immobility and normal packing, physical mount/gun recovery, blocked setup approaches, remounting, reload/movement resumption, transport boarding order and cargo, and renderer equipment/pose placement. The live mount preview confirmed separate carried loads, left-behind tripods, mounted firing after assistant loss and the Maxim's Need carrier status. Logs: `/private/tmp/cc3-mount-final-tests.log`, `/private/tmp/cc3-mount-final-build.log`.
