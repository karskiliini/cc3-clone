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
| 1 | 051 physical APC passengers | Active: integrate existing boarding/fire/damage with compartment simulation and 3D occupants | Full squad boards/rides/crouches/fires/jumps out; killed riders remain constrained by walls/benches under pitch/roll; deterministic physical state; in-game recording |
| 2 | 052 physical broken tracks | Pending | Hit/mine breaks a particular link; loose chain moves over wheels/ground, can be dragged, loses that side's drive after sprocket disengagement; visible links and exact deterministic tests |
| 3 | 054 terrain compression | Pending | Loaded accepted track/wheel contacts progressively compress holes/rims by vehicle weight and passes; height, cover and visuals agree; rejected movement creates no deformation |
| 4 | 055 infantry digging | Pending | Eligible idle men dig visibly over time; orders/threats interrupt; persistent site depth/cover evolves deterministically and interacts with stage 3 |
| 5 | 044 + 047b online multiplayer and recovery | Pending | Relay/browser transport, room join and forces/deployment, game UI, speed/pause policy, disconnect takeover/forfeit/rejoin, visible desync rebuild/failure/report flow, two browser/host verification |
| 6 | 056 individual perception and human condition | Pending | Personal visual/acoustic contacts and delivered reports replace omniscient decisions; integrated pain/exertion/shock/exhaustion/sweat/tremor affect capability; hidden-state/viewer independence and exact replay tests |

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
