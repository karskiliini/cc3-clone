# Conversation feedback queue

Reconciled 2026-10-29. This session is not complete. Process these requests in arrival order, checking existing branch implementations first. These S-prefixed identifiers preserve this conversation's order without renumbering the separate repository backlog (which has evolved through 056 on another branch). Commit and push each verified change.

## Resume baseline

- Fetched GitHub; updated main to b6bd89a. Continued on `codex/resume-battle-feedback` from published gameplay 3f04887, merging current main as f0ca7c3. Retained three.js dependencies and main's patched TypeScript/Vite/Vitest versions. Other worktrees remain untouched.
- Explosion protection (old item 010) was already committed as 06bbd9e and is present in this baseline; the old main backlog was stale.
- No commit author, subject or body in available Git history identifies Bonsai-2. Attribution remains unresolved; do not label other authors' commits Bonsai. Inspect actual changes before relying on uncertain provenance. Identifiable earlier GLM patch commits are f01a0b3 and its corrective 58e4d6a; this is not evidence of Bonsai authorship.
- Mac mini capacity checked: load 17.53 on 10 cores, 22 GiB disk available. Heavy rendering and broad tests deferred while loaded. Focused checks may run locally. Blood sprite generation (S01) remains pending; no bloody-art completion is claimed.
- Merge dependencies: npm reported zero known vulnerabilities. Endor dependency-reviewer package-risk lookup is unavailable in this tool session; its separate malware/license/policy assessment is unknown, not approved by the npm audit result.

## Requests

| ID | Request and acceptance | Current status |
| --- | --- | --- |
| S01 | Bloody wounded/dead sprites that clearly distinguish incapacitated soldiers. Verify at battle zooms. | Pending; needs art and visual verification. |
| S02 | Unit type in the elevation hover tooltip, including weapon-specific teams. | Existing unit/vehicle labels found; audit all types. |
| S03 | Terrain name and cover quality in the hover tooltip. | Cover quality and percentage added from `omniCoverAt`, beside existing place name/elevation. Includes bunker cover; 16 hover/cover tests and `tsc --noEmit` pass. Named church-floor distinctions remain to audit. |
| S04 | Building occupants seek useful cover/windows; directional fire orders move them to a firing opening. | Reconcile existing building behavior; verify end to end. |
| S05 | PAK crews prepare a wall opening and position the gun barrel to fire outside, with crew animation. | Pending audit/implementation. |
| S06 | Consistent tank speed, tree crushing/falling cover, attractive grass concealment. | Existing later vehicle/grass branches have work; integration and visual acceptance remain. |
| S07 | Vehicle crew role displays/actions must respect each member's job; driver cannot aim while driving. | Pending audit. |
| S08 | Double-click bottom unit icon selects all units of that exact type. | Pending audit. |
| S09 | Drag existing movement waypoints and fire-target markers at any time. | Pending audit. |
| S10 | More visible tank shells and better destruction animations. | Existing FX work; verify requested result. |
| S11 | Better broken-track art, both tracks breakable, persistent hull/turret strike marks, grenade shrapnel marking terrain/trees/buildings and breaking windows. | Partial existing systems; verify each requested behavior. |
| S12 | Contextual right-click Move/Fire; rear destination defaults to reverse. | Pending audit. |
| S13 | Move behind vehicle reverses; Move Fast turns before driving forward. | Pending audit. |
| S14 | Per-weapon barrel height and prone eye level affect vision and fire clearance. | Existing height work; verify across weapons. |
| S15 | Every crew member's viewing port contributes vision according to injury/availability. | Existing crew vision; verify injury constraints. |
| S16 | Dead soldiers stop all voluntary movement/animation; no crawling corpses. | Pending reproduction/audit. |
| S17 | Tanks plow through trees, which fall and provide infantry cover. | Follow-up to S06; verify pathfinding and physical cover. |
| S18 | More close-combat grenades; satchels breach difficult cover and open routes. | Pending audit/implementation. |
| S19 | Satchel placer warns nearby units; those units move farther away into cover. | Pending audit/implementation. |
| S20 | PAK leader recruits nearby available soldiers, particularly bailed-out tank crew, as inexperienced replacement crew. Never take men from an active tank. | Pending audit/implementation. |
| S21 | Material-specific bullet impacts: dirt spray, metal sparks, wood splinters, rock ricochets. | Existing FX; verify full material coverage. |
| S22 | Friendly bullet paths clearly start near the firer; preserve enemy tracer appearance and conceal firing origins. | Pending audit/implementation. |
| S23 | Clearly visible MG and separately carried mount sprites; gun visibly distinct from rifle. | Existing carry sprites found; visual acceptance remains. |
| S24 | Blast throws weapon separately; recovering soldier can retrieve it or another gun; weapons can be damaged. | Pending audit/implementation. |
| S25 | MG fires as LMG while mount arrives, then deploys to HMG at belt exhaustion/reload. | Pending audit/implementation. |
| S26 | Slight visibility shroud wherever no friendly unit has line of sight. | Pending audit/implementation. |

## Verification limits

2026-10-29: `npx vitest run test/hoverInfo.test.ts test/cover.test.ts`: 2 files, 16 tests pass on Vitest 4.1.12. `npx tsc --noEmit` passes. No full-suite, production build or new browser visual acceptance claimed for this resumed change. Existing broad-test evidence belongs to its recorded historical revisions.
