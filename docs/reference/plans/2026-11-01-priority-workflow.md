# Requested implementation workflow — 2026-11-01

User instruction: implement 051, 052, 054, 055, 044/047b and 056 now, as a workflow.
This explicitly replaces the previous 050 P2-first queue priority. Additional P2
performance optimization remains deferred by the user; do not restart that work.

## Execution

One active implementation stage, in the requested order. Each stage includes its
simulation/UI/render integration, focused regression tests, relevant visual/network
verification, specification/backlog update, commit and push. Update the ledger below
with concrete evidence. A design document, isolated prototype or passing partial test
is not completion. Continue to the next stage without requesting routine permission.
Do not introduce Superpowers approval/TDD ceremonies. Existing user authorization
covers CC3 source/test/tool transfer to their own Mac mini; exclude secrets, check
capacity and preserve other jobs. Use immutable isolated inputs for long tests.

| Stage | Work | Status | Required completion evidence |
|---|---|---|---|
| 1 | 051 physical APC passengers | Complete; spec `docs/superpowers/specs/2026-11-01-physical-apc-passengers.md` | Full squad boards/rides/crouches/fires/jumps out; killed riders remain constrained by walls/benches under pitch/roll; deterministic physical state; in-game recording |
| 2 | 052 physical broken tracks | Complete; physical cut/drive/render integration | Hit/mine breaks a particular link; loose chain moves over wheels/ground, can be dragged, loses that side's drive after sprocket disengagement; visible links and exact deterministic tests |
| 3 | 054 terrain compression | Complete; accepted load/height/cover/art integration | Loaded accepted track/wheel contacts progressively compress holes/rims by vehicle weight and passes; height, cover and visuals agree; rejected movement creates no deformation |
| 4 | 055 infantry digging | Complete; canonical sites/cover/tasks/animation/render integration | Eligible idle men dig visibly over time; orders/threats interrupt; persistent site depth/cover evolves deterministically and interacts with stage 3 |
| 5 | 044 + 047b online multiplayer and recovery | Implementation complete; real relay/lobby/UI/recovery verified; public deployment left to user | Relay/browser transport, room join and forces/deployment, game UI, speed/pause policy, disconnect takeover/forfeit/rejoin, visible desync rebuild/failure/report flow, two browser/host verification |
| 6 | 056 individual perception and human condition | Active: personal evidence and capability migration | Personal visual/acoustic contacts and delivered reports replace omniscient decisions; integrated pain/exertion/shock/exhaustion/sweat/tremor affect capability; hidden-state/viewer independence and exact replay tests |

## Stage 1: compartment implementation decisions

Reuse existing sequential boarding and passenger damage/fire rules; do not create a
second boarding system. Add authored simulation compartment geometry in the hull's
model-origin frame (+x right, +y rear, +z up). Match the visible SdKfz 251 bay floor,
bench and side plate dimensions in `tools/blender/vehicles.py`, with conservative
collision padding documented as gameplay approximations. The sim owns stable seat
indices, posture and articulated casualty bodies; rendering consumes that state.

Living riders stay in their seat region and crouch below the sides when moving,
suppressed or afraid; eligible stationary shooters rise to fire over the wall and
return to cover. Dead/incapacitated riders become small linked body particles with
gravity in the accelerating/rotating hull frame, constraints against floor, sloping
walls and benches, and world support after an actual ejection. An overturned open
compartment must not be an invisible sealed cage. Fallen bodies continue to occupy
space and capacity. Physics and seat ownership are canonical and hashed; camera,
render rate and visibility cannot create seat assignments or change the body.

Extend the existing hull-child occupant renderer, including limbs, weapon, posture,
fire feedback and casualty pose. Boarding/dismount animation uses the same physical
seat anchor. No-WebGL fallback remains readable. Verify that the current model bay
is actually hollow where riders are meant to sit; opaque filled geometry is not a
valid substitute for compartment occlusion. Render or model fixes belong to 051.

## Cross-stage safeguards

- P2 hull pose remains authoritative; no physics is initialized from rendering.
- New mutable state must survive replay/resync and be included in appropriate hashes.
- 054 and 055 share canonical terrain-site state rather than layering incompatible
  visual-only craters/foxholes. Apply height changes and LOS/cover updates together.
- 044/047b starts from the existing lockstep, integrity, health and transport modules.
  Check their actual current behavior rather than the older plan's historical gaps.
  Read the required API-engineering skill when starting relay/network API work.
- 056 must migrate decision inputs, not merely dim the UI or add unused condition
  fields. Physical collisions, area damage and already communicated fire may use truth.
- Keep 053, 057, 058 and 059 queued; they are outside this requested workflow.

## Evidence ledger

- Baseline: `ce5e9db`, branch `codex/vehicles-3d-p2`; worktree clean at start.
- Initial audit confirms existing passenger boarding, halted fire and staying aboard
  after casualties; no completion of 051 is claimed by those existing mechanisms.

- Stage 051 completed: 252 broad related tests, final 53 changed-path tests, types/build;
  exact M5/M2 100-tick parity SHA `9d7b54047567ef896b0bd1398324648fba05077ac2b6bcb7926b71846f489265`;
  actual Chromium 10 aboard → 2 corpses retained → 8 survivors out; no page errors.

- Stage 052 completed: eight dedicated tests, 40 related damage/mine/passenger tests,
  30 hull/chain and final 50 chain/3D tests; types/build; real Chromium chain left
  behind, no page errors. Exact M5/M2 180-tick SHA
  `2c7d39fdbb147e3baace920819ccae215d6d97d5ae73c9959c5a33f1472ff62e`.
  M2 one 47-link chain: 0.191 ms/tick over 1000 ticks under current load.

- Stage 054 completed: real KV-1 versus T-70 crossing, nine dedicated tests,
  39 height/cover/contact and 43 crater/terrain/hull checks; final types/build.
  Exact M5/M2 160-tick SHA `3ec8df680c5767736367fa8a105d6dd977ae62183e4c44b3c3ba582ed22546e8`.
  Actual Chromium crossing changed 25 dig samples; final art preserves round outlines;
  no page errors and own server stopped.

- Stage 055 completed: ten dedicated cases; 77 integration/replay checks and final
  41 digging/morale/HUD checks; types/build. Ten real soldiers finish personal holes
  with 0.717–0.8 physical cover; background no longer rebakes on shovel strokes.
  M5 Node / M2 Node / Chromium 240 s SHA
  `88b31f0a2d26198b58615a6886d955f6400a08c532a989f671206b15c1d0c885`.
  Own browser/server stopped; no page errors.

- Stage 044/047b implementation completed: native browser WebSocket and Node relay,
  room/roster/deploy/UI, canonical pause/speed, disconnect/rejoin/AI/forfeit,
  sliced history recovery/report/failure actions. Original 43 network tests and
  final nine relay/policy tests pass; types/build; downloaded browser replay matches.
  Two Chromium contexts pass the complete UI flow. Separate M5/M2 real LAN peers
  match all 12 checkpoints over 120 ticks and repair injected desync. Owned servers
  stopped. Public Internet hosting and cross-browser soak remain explicitly
  unverified/user-deployed; see `docs/reference/multiplayer-protocol.md` and report
  `docs/superpowers/reports/workflow-044-20261101/README.md`.
