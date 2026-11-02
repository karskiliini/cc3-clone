# 056 — Personal evidence and human capability

Every person, including seated crew, acts on personal observation, delivered
information, orders and their own capability. Side-wide spotted sets are display
outputs. They cannot grant an individual precision targeting, enemy counts,
fear directions, casualty awareness or knowledge that an enemy has died.

## Evidence and communication

Visual acquisition runs per eligible person and actual seat eye/arc. A contact is
an immutable observed descriptor, not an alias to a live enemy. Fresh sight lasts
1.1 seconds; bounded memory/reports retain original observation time for at most
120 seconds. Unknown enemy ammunition, reload phase, crew skill and damage use
nominal estimates, rather than reading the hidden object's current internals.
A report conveys last observed information; precision fire still requires the
shooter/gunner's own direct acquisition. Explicit area fire uses the ordered point.
Orders retain their issued point for isolated recipients; a leader's later
observation does not silently update every recipient's aim.

Heat/smoke in an occupant's own burning vehicle are physical observations retained
through exit shock. Physical shot, engine, blast and voice events have a separate canonical queue;
rendering may drain UI events without making a sound disappear. Hearing has
propagation delay, range, masking and personal impairment. Cues quantize bearing
and estimate distance with uncertainty. They contain no confirmed hidden entity
ID or exact emitter position. Pain moans and moving engines can betray activity.
An impact without a perceived source is an alarm, not precise shooter knowledge.

Communication requires conscious eligible endpoints and a surviving channel at
delivery: intercom 0.5 s; LOS voice 0.7 s plus sound travel (10 m ordinary,
30 m leader, 5 m hiding/ambush); radio 2 s, 300 m. Portable command/mortar/rocket
leader radios are a gameplay equipment assumption. A vehicle leader must occupy
an operational radio-equipped hull. Walking away does not retain a remote radio.
Reports can traverse at most four forwarding hops, lose confidence, preserve
origin/age and deduplicate by recipient/version. Queues and personal memories are
bounded. Local casualty/leadership awareness also respects closed armor and seat eyes;
occupants of one compartment have local internal awareness. Casualties, leadership, objectives and navigation changes use the same
explicit delayed mechanism. There is no whole-side sensory union at HQ.

Indirect missions send an actual request through reachable command endpoints.
An eligible observer must receive the task, see the area/impact and return a
report through the surviving route. Only a delivered observation improves ranging;
only a uniquely delivered actual impact advances walk-in. Blind ordered fire
remains available at the less accurate unobserved setting.

## Planning knowledge and physical reality

Initial authored terrain, bare-ground elevation and authored trench vectors are
shared briefing knowledge. An immutable deep data copy isolates it from subsequent
physical destruction; source paint/generator functions are not copied into state. Sparse per-person cell/height/earthwork and hull-footprint
observations update through eligible eyes, delivered reports or actual contact.
Predictive routes, shortcuts, hypothetical cover/firing positions and fire-hazard
costs use that person's briefing-plus-evidence view. Drivers use driver knowledge,
including delayed crew information. Unknown remote demolition, fires and hulls
cannot alter a route. Sparse bounded memory can conservatively forget old changes. An unidentified physical contact is one revisable local footprint hypothesis per driver, expires after 10 seconds and is not duplicated when an already identified local footprint explains the contact. Its expiry follows personal time, never hidden movement.

Swept movement, collisions, local support, area damage and projectile impacts use
the real world. A hull bump teaches a local anonymous estimated obstacle, not its
hidden identity or all other vehicles. A terrain rejection teaches the contacted
cell. A planner may therefore attempt a formerly traversable but now blocked way;
physical enforcement prevents passage. Render dirty lists are never evidence. At an already reached corner, a known traffic obstruction can start a separate canonical wait/replan timer without inventing a physical collision. Terrain/profile vetoes remain in force; the detour preserves the next unconsumed player waypoint.
Derived planning views/caches cannot become authoritative state or mutate the
briefing through their array readers.

## Condition and calibration

One fatigue owner runs per simulation tick, using prior actual displacement or
active work. Breath, sweat, hearing loss, pain bouts and acute shock combine with
existing fatigue, wounds, stress and mental states. Capability is the common
input for pace, sensing/hearing, settling, dispersion, work, decision latency and
operation gates. Loaded guns, MGs, drivers, loaders and weapon crews participate.
Personality, motivation, experience and existing obedience remain individual.
Pain cannot be double-counted as a second independent fatigue producer.

These are gameplay approximations, not clinical physiology. At maximum sprint
exertion breath rises 12 points/s and fatigue 2/s; walking adds breath 3.6/s and
fatigue 0.5/s; active work adds breath 2.64/s and fatigue 0.35/s. Rest recovers
breath 8/s and fatigue 1/s. Sweat builds with effort/breath, cools slowly and builds
less in winter. Hearing loss recovers at 1/30 per second. Pain retains the existing
12–25 s personal cycle and 3–6 s bouts. Acute blast shock uses existing stun/daze
and shaken timers. The common capability function documents the exact weights.
Tremor grows from breath, fatigue, stress, pain and acute shock; it worsens settling
and accuracy. Severe injury or incapacitating mental states stop applicable work
and firing. Panicked driving can still support the existing self-preservation
response. Recovery is bounded and cannot erase a wound.

## Consumers and determinism

Migrated consumers include infantry/vehicle/stationary weapon targeting, fear and
fleeing, casualty/leadership awareness, cover, order tracking/obedience, HQ planning,
medic selection, pickups, subordinate initiative, crew return and dismount direction, mortar observers,
infantry pace/aim/dispersion, digging and weapon crew work. Physical collision and
damage are explicitly outside the information filter. Friendly formation/resource
reservations are coordination data; they do not supply hidden enemy evidence.

Personal evidence, sound queue, report queues, condition, decision timers, private
mind/morale/AI/task state and per-person random streams are canonical and hashed.
Separate streams prevent unrelated hidden decisions from consuming another
person's decision randomness. Restoring/replaying cannot rely on object-identity
WeakMaps for future decisions. Derived query caches are allowed only when they do
not alter output. Replay logs carry explicit ruleset `personal-evidence-1`; the CLI warns
for legacy/different rulesets. Full source fingerprint changes invalidate incompatible online
builds; old replay logs are not promised identical behavior under this new model.

The I-key inspector shows the selected own person's order, evidence age/source/
uncertainty and condition/capability. It is read-only and does not acquire contacts,
consume RNG or change decisions. Selection, camera, viewer side and render modes
must remain independent of simulation state.

Validation and remaining limits are recorded in
`../reports/workflow-056-20261101/README.md` once verified.

## New-feature cost guard

A measured diagnostic found repeated full-memory sorting/cloning in navigation
acquisition. Each pass now gathers world candidates/eyes once, each person still
performs their own local range/LOS/capability checks, and the latest 256-cell set
is selected before copying geometry. Freshness/version accounting remains intact.
A 20-pass dense-terrain comparison has identical complete state hashes. Per-sender
report dedup retains the same 512-key insertion-order bound using one local key
list, instead of enumerating keys for each report. Hearing rejects beyond maximum
audible range before LOS and computes masking once per listener/pass. These
changes preserve evidence and do not resume the deferred P2 performance project.
