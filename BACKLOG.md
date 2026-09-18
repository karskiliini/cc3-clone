# Feature and bug queue

Process requests in the order received. New requests are appended to the queue without interrupting the active item. Change that order only when the user explicitly reprioritizes or cancels work.

- Give every item a stable, increasing ID and mark it as a feature or bug.
- Record the request and a concrete completion criterion before starting it.
- Keep one item active. Finish and verify it before starting the next queued item.
- If an item cannot proceed, record the specific blocker and continue with the oldest unblocked item. Return to the blocked item when it becomes actionable.
- Keep completed items and their verification evidence below.
- After each completed fix or feature passes verification, commit it and push the new version to GitHub on the current working branch. This is an ongoing user preference.

## Active

None.

## Queued

**008 — Feature: Hasty fire during assault, heavy defensive pressure, or panic.**

Request: A hectic soldier may fire without completing deliberate aim. Assaulting, defending under heavy attack, or panicking should allow hurried shots rather than always requiring the full acquisition/settling delay.

Completion: Support quick snap shots or hip fire during assaults, hurried return fire toward known threats under heavy defensive pressure, and occasional erratic shots/bursts during panic. Hasty fire skips most aiming time at the cost of substantially worse accuracy, wider dispersion, and poorer ammunition discipline. Panic may still produce hesitation or flight; it must not guarantee effective return fire. Preserve weapon cycling/reloading and targeting rules, and retain deliberate aiming for calm or precise fire. Verify behavior across relevant infantry weapons and mental states. Build on item 007's SMG handling where applicable.

The next request receives ID 009.

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

Verified together on 2026-09-19: 77 test files passed; 653 tests passed and 2 pre-existing tests skipped. `npm run build` passed, including `tsc --noEmit`. Control-group HUD and vegetation effects were also checked in the browser.

Item 005 verified on 2026-09-19: nine new tests exercise keyboard/mouse events through the battle screen, including quick Shift releases. Full suite: 78 files passed, 662 tests passed, 2 pre-existing skips. `npm run build` passed, including `tsc --noEmit`.

Item 006 verified on 2026-09-19: movement/posture limits, crew hauling without teleporting, crowd separation, physical animation cadence, acquisition and interruption behavior, move/aim/fire/resume, and full battle-loop pause/resume covered by regression tests. Existing arrival tests now wait for the slower movement. Browser preview checked with the real infantry simulation and unit renderer. Full suite: 80 files passed, 705 tests passed, 2 pre-existing skips. `npm run build` passed, including `tsc --noEmit`; `git diff --check` passed. Logs: `/private/tmp/cc3-infantry-final-tests.log`, `/private/tmp/cc3-infantry-build.log`.

Item 007 verified on 2026-09-19: 84 test files passed, 745 tests passed, 2 pre-existing skips. `npm run build` passed, including `tsc --noEmit`; `git diff --check` passed. Regression coverage includes individual ammunition consumption, burst interruption, physical swept rays, infantry/vehicle/terrain interception, suppression, posture and torso animation, muzzle alignment, single-round sound, and sprite assets. The live SMG preview was checked with no browser errors. Logs: `/private/tmp/cc3-smg-final-tests.log`, `/private/tmp/cc3-smg-build.log`.
