# 058–059 implementation and operating rules

Requested and activated 2026-11-02. The earlier requirements and historical sources
remain in [air-support-and-night-combat.md](air-support-and-night-combat.md).
Validation and recorded gameplay: `../../reports/air-night-20261102/README.md`.
This implements air support and illuminated night combat; general P2 optimization
and JEV controller research remain deferred.

## Player controls

- Skirmish setup chooses day/night, clear/overcast/rain and a scenario date.
  Multiplayer hosts choose the same canonical conditions in the room. Deployment
  and campaign briefing identify those conditions before battle.
- **U / AIR**, then click a map area, calls assigned air support. The adjacent
  role button cycles AUTO, BOMBING and ARMOUR. Escape/right click cancels targeting.
  The status and tooltip identify availability, mission, aircraft and actual load.
- Select an operational mortar, press **L / FLARE**, then click an area. The
  finite illumination stock and current mission are shown separately from HE.
  A new ordinary order stops further illumination rounds; existing airborne
  rounds/flares continue. Repeating the same target preserves the firing schedule.

## Air support

Later Close Combat mechanics provide the interaction: assigned support, a delayed
availability message, one map target, one aircraft attack pass and departure.
Default tactical allocation is one mission per side in clear daylight, with a
seeded 45–90 s readiness delay; scenarios can override allocation/readiness.
Approach takes 12 s, observation 4 s and departure 10 s. These timings are gameplay
calibration rather than the Normandy-specific manual's historical delays.

Assigned German bombing load is four SC 50 bombs (200 kg), not a claim that this
is the Ju 87's maximum or universal historical mixed load. Late anti-armour support
uses Ju 87G twin BK 3.7, 24 rounds. IL-2 uses four FAB-100 bombs or four cassettes
of 48 PTAB-2.5-1.5 (192 submunitions); the latter is a cassette load, not the larger
loose-carriage maximum. Anti-armour service is conservatively gated to explicit
dates from 1943-07-05 or years 1944–45. Unknown dates in 1943 use bombs.

AUTO uses frozen, aged personal reports delivered by an operational selected
radio leader, otherwise one operational HQ's already received knowledge. An
isolated rifleman's private contact cannot teleport to the pilot. Delivery takes
2 s and rechecks the same reporter/radio/seat. Death, radio loss or dismount drops
the payload. No reporter permits a blind area attack, without invented contacts.
Explicit ARMOUR is the player's mission classification; it requires no hidden
army scan. Aircraft/load confirmation precedes the visible approach.

The pilot is a canonical individual with capability, personal observations,
reports and private random stream. Own aerial sight uses physical 3D terrain,
roof/tree/hull transmission, concealment, range and view direction. Aim freezes
from permitted evidence; released ordnance never follows a hidden moving target.
Bombs, cannon projectiles and PTAB travel in world metres and collide with terrain,
vegetation and real hulls. Existing explosion/injury/crater/structure/vehicle damage
handles impacts, including friendly casualties and friendly vehicles.

Campaign support has a persisted two-mission pool per side per calendar day, at
most one assignment per battle. Assignment alone does not spend support; debrief
spends actual sorties once. Month-only legacy scenarios use an explicitly labelled
representative 15th; authored dates take precedence. Operation data can author
timeOfDay/weather as well as scenarioDate.

## Night illumination and information

Suitable manned mortars start with four separate illumination rounds by default
(scenario override 0–24). Normal range, deployment, gunner/helper capability,
traverse/laying work and a shared absolute mortar firing-cycle deadline apply.
Each participating man must accept the current order; first-fire shock, dodging,
fleeing/surrender, equipment pickup and hatch/mount handling also block the task.
Retargeting cannot bypass the HE/illumination cycle. No visible enemy is required
for an area illumination order. A round flies for 3 s + range/60 before bursting.

An actual burst creates a parachute flare 100 m above local ground, burning up to
90 s while descending at 1 m/s and drifting east/south at 0.16/0.05 m/s. Useful
radius is 110 m, with 1.5 s ignition and 12 s gradual burnout. A flare reaching
solid ground/roof extinguishes early. Repeated missions wait 65 s and consume
real stock, allowing overlap. Parameters are explicit tactical gameplay values.

Canonical CPU illumination uses five fixed emitter samples and 0.5 m physical
ray steps. Terrain and roofs occlude; crowns partially transmit and trunks block;
physical hulls/turrets occlude independently of asset loading. Multiple sources
combine with saturation. Burning vehicles are physical light sources as well.
Night ambient is 0.025. Both sides sample the same world light at the target;
observer eye/arc/range/ordinary LOS and personal capability still apply. Lighting
does not create an exact enemy contact, override a wall, or share personal sight.

Both sides' ground memory advances in simulation on the spotting cadence, in
4-tile cells. Currently observed, remembered and unseen areas receive distinct
fog treatment. The camera, selected unit and render backend never advance this
memory. Own units remain legible; hidden enemies retain ordinary spotting gates.

## Visual implementation and boundaries

Canvas ground and composited 3D vehicles share the warm descending point light,
cool night exposure and height-aware shadow mask. Parachute, glare and smoke use
the canonical flare pose/time. 3D vehicle point lighting uses the same positions;
daylight sun and old flat ground shadows are disabled at night.

The GPU mask is 192 × 126, at most 20 updates per simulation second, with three
stable emitter samples preserving the five-sample source centroid/covariance.
It retains 0.5 m ray steps and conservative height bounds. Cached Canvas copies
avoid repeated GL readbacks on unchanged frames. Up to eight displayed sources
and 96 visible hull/turret boxes bound rendering; CPU simulation uses all sources
and all physical hulls. Undiscovered moving hulls are not projected as sharp UI
silhouettes. This is a low-resolution physical ray-marched mask with finite source
softness, not hardware ray tracing or a radial-only overlay.

The Canvas fallback (`?nightLighting=canvas`; add `&vehicles=sprites` to exercise
the vehicle fallback too) samples the CPU light at 40 × 26, at most 5 updates per
simulation second. It preserves sensing, stock, physical shadows and replay;
display resolution and softness differ. Graphics quality never changes outcomes.
Aircraft artwork is procedural animated Canvas geometry, not new 3D aircraft assets.
Fighter interception, flak, flight planning and player-piloted aircraft are outside
these tickets. Numerical aircraft accuracy, armour and physiology are gameplay
approximations, not engineering or clinical validation.

All future-affecting aircraft/pilot/ordnance/light/flight/mortar-cycle/fog-memory
state is hashed and restored. Commands include airSupport and illuminate; room
validation rejects unsafe roles, identities, coordinates and invalid dates.
Replay ruleset is air-support-night-1. Peers must use the same source fingerprint;
identical results are not promised for older replay rulesets.
