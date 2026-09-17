# Soldier animation — postures, actions and visible mental states

Date: 2026-09-17. Requested by the user:

> The soldiers should be animated. They should have a crouched state and an "on the knee" state,
> firing and idling, and hiding in all of these states. Panicked in all of them, running, walking,
> sneaking, and so on. All kinds of mental states should be visible for the user directly.

All art is original and generated in code. Nothing is copied from the original game.

## 1. Model: posture × action × mood

A soldier's picture each frame is chosen from three independent axes.

**Posture** (how the body is carried)

| Posture | When |
| --- | --- |
| `standing` | sim stance standing |
| `crouched` | stance crouching while moving or alert: low, both feet down, ready to move |
| `kneeling` | stance crouching while stationary and aiming, firing, reloading or defending: one knee down, steady |
| `prone` | stance prone |

Kneeling is a visual posture derived from the sim's `crouching` stance plus activity; the sim needs no
new stance.

**Action** (what he is doing), available in every posture unless marked

| Action | Frames | Notes |
| --- | --- | --- |
| `idle` | 4, slow (about 1.2 s loop) | breathing, small head turns, weapon shifts; phase offset per soldier |
| `aim` | 2 | weapon shouldered toward the target |
| `fire` | 3 (about 0.25 s) | recoil kick, muzzle lift, return; triggered by `lastFiredAt` |
| `reload` | 4 | hand to pouch, bolt or magazine, back to aim |
| `hide` | 2 | head down below cover line, weapon pulled in; used for `hiding`, ambush-waiting and `cowering` base |
| `walk` | 4 | standing only |
| `run` | 6 | standing, leaning forward, arms pumping with the weapon |
| `sneak` | 4 | crouched walk |
| `crawl` | 4 | prone, alternating elbows and knees |
| `throw` | 4 | grenade: wind-up, release, follow-through, recover |
| `hit` | 3 → corpse | stagger, fall, settle into the dead pose |
| `woundedCrawl` | 4 | slower, one arm dragging |

**Mood overlay** (mental state), applied on top of any posture and action

| Mood | Visible effect |
| --- | --- |
| calm | none |
| alert / wary | head scans toward the threat direction every second or two; weapon stays up |
| shaken | fine tremble (1 px jitter at irregular intervals), glances over the shoulder, slower and hesitant step cadence |
| pinned | flattens in the current posture (kneeling drops to prone over a few frames), flinches when a round lands near, one hand on the helmet |
| cowering | curls up in place whatever the posture, head covered, visible shaking, weapon on the ground beside him |
| panicked | in any posture: erratic turning, arms flailing, weapon lowered or dropped; when moving, a stumbling sprint with arms out; when stationary, frozen and shaking or scrabbling backwards |
| berserk | upright, charging, weapon thrust forward, no cover use |
| surrendered | hands raised; standing or kneeling |
| suppressed (any mood) | dust kicks around him, scaled by suppression |

Moods must be readable at zoom 1 without any icon or text, and distinct from one another.

## 2. Implementation approach

- **Parametric rig, not hand-drawn frames.** Define the figure as a small skeleton (helmet, torso,
  upper and lower arms, hands, weapon, thighs, shins, boots) seen from the game's oblique top-down
  angle. Each animation is a short list of keyframes of joint offsets and rotations; frames are
  interpolated and rasterised with the existing shape-based painter, lit from the NW, at scale 1 and 2.
  This keeps walk, run, crawl and recoil smooth without authoring hundreds of grids.
- **Frame selection is pure.** `frameFor(soldier, battleTime)` uses the battle clock, a per-soldier
  phase offset from his id, his speed for gait cadence, `lastFiredAt` for the fire kick, the reload
  timer for reload progress, `mind.lastIncomingAt` for flinches, and the time since his state changed
  for transitions (stand→kneel→prone, hit→corpse). No new sim state is required beyond timestamps
  that already exist; add an optional `animSince` only if a transition needs it.
- **Gait matches ground speed** so feet do not slide: cadence = speed ÷ stride length per posture.
- **Facing in 16 directions** for moving and aiming figures (8 is visibly steppy when turning).
- **Sprite cache:** key = side, season, posture, action, quantised phase (8 steps), mood variant,
  facing, scale. Build lazily, bounded LRU (about 4,000 entries), and pre-warm the common walk and
  idle sets for deployed teams so the first seconds of battle do not hitch.
- **Crew-served weapons** keep their role poses; add loop animations for serving the weapon (loader
  passing a round, gunner traversing), plus the same mood overlays.
- **Performance target:** 200 animated soldiers at zoom 2 within the current frame budget.

## 3. Tests and verification

- Pure tests: posture derivation (crouching+firing → kneeling; crouching+moving → crouched),
  action selection from activity, mood selection from `mind.state`, frame index stability for a fixed
  clock, gait cadence proportional to speed, 16-way facing quantisation.
- A preview page (`tools/animPreview.html`) showing every posture × action × mood as a looping
  animation at 1× and 3×, both sides, summer and winter.
- In-game captures as short frame sequences (8 frames, 100 ms apart) of a squad walking, running,
  sneaking, crawling, kneeling and firing, reloading, being pinned, cowering and panicking.

## 4. Ragdoll on blasts (user request)

> A ragdoll would be perfect when a round hits near a man.

- **Trigger:** any HE burst (grenade, mortar, tank or gun HE, satchel, collapsing building) within its
  blast radius of a soldier. Strength falls off with distance and scales with the explosive.
- **Sim side (deterministic, small):** the sim already decides the casualty. It additionally records
  on the soldier a `blast` record `{ from: Vec2, time: number, force: number }` and applies a
  knockback to his position: 0.5–3 m directly away from the burst, scaled by force, stopped by walls,
  vehicles and water (use the existing passability check; never through a wall). Survivors inside the
  inner half of the radius are knocked down: they cannot act for 1.5–4 s (longer when wounded or
  green), take a stress spike through the existing mind hooks, then get up through the normal
  posture transitions. Use the seeded Rng only.
- **Render side:** the rig switches to a physical ragdoll for the flight: joints as verlet points with
  distance constraints and simple angle limits, an initial impulse away from `blast.from` with an
  upward (toward-camera) component, spin proportional to the off-centre hit, gravity, one or two
  bounces with friction, then the limbs settle. The flight interpolates from the pre-blast position to
  the sim's post-knockback position over 0.5–1.1 s so the body lands exactly where the sim says he is.
  The settled pose is kept: a dead man's corpse stays in the pose he landed in (cache the settled joint
  positions per soldier id), a survivor lies stunned in it, then pushes up to prone, kneeling and
  standing.
- **Look:** a soft shadow that shrinks and detaches while he is airborne sells the height; a helmet or
  weapon may separate and land nearby (weapon stays on the ground beside a corpse, a survivor picks it
  up as he rises); a puff of dust on landing; on snow a spray and a body-shaped dent.
- **Small arms** do not ragdoll: a hit man uses the `hit` stagger-and-fall animation; near misses make
  him flinch.
- **Limits:** at most about 12 simultaneous ragdolls; beyond that fall back to the `hit` animation.
  Render-side physics must not feed back into the sim, so determinism tests stay green.
- **Tests:** knockback direction and distance scale with force and are blocked by a wall; a knocked-down
  survivor cannot act until his stun ends; the determinism test stays green; the ragdoll integrator
  conserves its constraints (limb lengths within 5%) and settles within its time limit.

## 5. Asset pipeline: pre-rendered sprites from Blender (supersedes the in-code rig of §2)

User decision (2026-09-17): in-code figure drawing gives poor results; generate the images by any
means that looks best and is cheap to build. Blender 5.2 is installed (`/opt/homebrew/bin/blender`).

**Principle.** All models are our own, built procedurally by Python scripts from primitives (no
downloaded or third-party assets, nothing taken from the original game). Blender runs headless:
`blender -b -P tools/blender/<script>.py -- <args>`; `npm run sprites` rebuilds everything. Outputs are
committed under `public/sprites/` so the game needs no Blender at runtime. The code-drawn sprites stay
as a fallback when an atlas is missing.

**Camera and light (shared by all scripts, in `tools/blender/common.py`).** Orthographic camera
looking straight down with a slight tilt (about 12° from vertical, toward the north edge of the
screen) so bodies and hull sides show a little; one sun from the NW (azimuth 315°, elevation 45°) plus
soft sky fill; transparent film; the object's contact shadow rendered onto a shadow-catcher plane and
kept in the sprite as semi-transparent dark pixels. World scale: 10 px per metre at scale 1 and
20 px per metre at scale 2, each rendered at 2× supersampling and downsampled for clean edges.
Because light and tilt are fixed, every facing is rendered separately (no runtime rotation).

**Atlas format (the contract between the render scripts and the game).**
Each atlas is a PNG grid plus a JSON file with the same base name:

```json
{
  "scale": 1,
  "cell": { "w": 40, "h": 40 },
  "anchor": { "x": 20, "y": 24 },
  "columns": 32,
  "dirs": 16,
  "entries": {
    "standing.walk": { "start": 0, "frames": 6, "fps": 9, "loop": true },
    "kneeling.fire": { "start": 96, "frames": 3, "fps": 12, "loop": false }
  }
}
```

Frame index = `start + dir * frames + frame`; grid position = (index % columns, floor(index / columns)).
Direction 0 faces north (up), increasing clockwise. `anchor` is the pixel in the cell that sits on the
unit's ground position.

| Atlas | Files | Entry keys |
| --- | --- | --- |
| Soldiers | `soldiers_<german\|soviet>_<summer\|winter>_<1\|2>.png/.json` | `<posture>.<action>` and mood variants `<posture>.<action>.<mood>`; postures standing/crouched/kneeling/prone; actions per §1; ragdoll flights `ragdoll.flight<N>` and landed poses `ragdoll.landed<N>`; `corpse<N>`; weapon variants by suffix `@rifle`, `@smg`, `@lmg` where the silhouette differs |
| Vehicles | `vehicles_<1\|2>.png/.json` | `<defId>.hull.ok`, `<defId>.hull.ko`, `<defId>.turret.ok`, `<defId>.turret.ko`; 64 dirs; JSON adds per vehicle `turretPivotM: {x, y}` in hull-local metres |
| Crew weapons | `weapons_<1\|2>.png/.json` | `<weaponId>.setup`, `.half`, `.packed`; 32 dirs |

**Ragdoll with pre-rendered frames.** The flight is a set of baked tumbling sequences (Blender
rigid-body or keyframed), 6 variants × 16 dirs, plus 8 landed sprawl poses; the game picks a variant
by hash, plays it while interpolating the position to the sim's knockback point, then holds the
landed pose (corpse or stunned survivor). The detaching shadow is drawn by the game (a separate soft
ellipse that shrinks with height) so the sprite itself carries no shadow during flight.

**Runtime (`src/render/spriteAtlas.ts`).** Loads atlases and JSON before a battle starts (progress on
the deploy screen), exposes `drawSoldier(ctx, key, dir, frame, x, y, zoom)` etc., falls back to the
code-drawn sprite when an entry is missing, and frees atlases for unused side/season combinations.

## 6. Crew-served weapons are worked by men, task by task (user request)

> When a PaK crew is setting up the gun we should see the full animation: setting up the legs of the
> cannon, opening them up and placing them on the ground; one man has to take the leg and extend it.
> The weapon can't be used until it's all done. It doesn't matter who does it, but it can't extend
> without a person doing it. Same for loading: a person needs to load a round into the chamber and then
> it's ready to fire. One person needs to be aiming it, and firing it.

**Model.** A crew-served weapon is a small state machine whose transitions are TASKS. A task only
progresses while a living, able crewman (not dead, incapacitated, stunned, pinned, cowering, panicked,
routed or surrendered) stands at that task's station and works it. Any crewman may take any task;
the team assigns free men to open tasks each step (nearest able man first, leader last). A man walks
to the station, works for the task's duration, and the task completes; if he is hit or breaks
mid-task, progress is kept but stops until someone else takes over. With fewer men, tasks that could
run in parallel run one after the other, so a short crew is slow rather than blocked.

**AT and infantry guns** (PaK 36/38/40, 45 mm, ZiS-3)

| State | Tasks to leave it | Station | Time per man |
| --- | --- | --- | --- |
| `limbered` (trails closed, being hauled) | `unhook` | gun tail | 2 s |
| `trailsClosed` | `spreadLeft`, `spreadRight` (parallel: one man per trail leg) | each trail end | 3 s each |
| `trailsOpen` | `digSpades` (seat both spades) | trail ends | 2 s per spade |
| `emplaced`, breech empty | `load` (loader takes a round from the ammo stack, rams it, closes the breech) | breech, loader's side | 3–4 s |
| `loaded` | `lay` (gunner at the sight traverses and elevates onto the target) | gunner's seat | 1.5–4 s by angle |
| `laid` | `fire` (gunner) → recoil → breech opens, case ejects → back to `emplaced` | gunner's seat | instant + 0.6 s recoil |

Packing up reverses it (`liftSpades`, `closeLeft`, `closeRight`, `hook`). The gunner must be at the
sight to lay and fire; the loader must be at the breech to load; one man can do both jobs in turn but
must walk between the stations (about 1.5 m), so a one-man gun fires slowly. The gun cannot fire unless
it is `laid`, cannot be laid unless `loaded`, and cannot be loaded unless `emplaced`.

**Mortars:** `placeBaseplate` (1 man, 3 s) → `mountTube` (1 man, 2 s) → `setBipod` (1 man, 2 s) →
`lay` (gunner, 6–10 s by range) → `dropRound` (loader, 2 s per bomb). Baseplate and bipod are carried
by different men, so both must arrive.
**Heavy MGs:** `placeTripod` (1 man, 3 s) → `mountGun` (1 man, 2 s) → `feedBelt` (assistant, 2 s; again
every 250 rounds) → gunner fires; without an assistant the gunner feeds his own belts (4 s).

**Experience** scales every task time (green ×1.25, veteran ×0.8). **Status words** follow the open
task: "Unlimbering", "Spreading trails", "Digging in", "Loading", "Aiming", "Firing", "Packing up".
The soldier monitor shows each crewman's current task in his activity cell.

**Visuals.** The weapon sprite has one state per step (`limbered`, `trailsClosed`, `trailLeftOpen`,
`trailRightOpen`, `trailsOpen`, `emplaced`, plus `recoil`), and the man working a task plays that
task's pose at the station, so you watch a man walk to a trail leg, swing it out and set it down.
Crew pose keys: `crew.haul`, `crew.trail` (gripping and swinging a trail leg), `crew.dig`,
`crew.load.gun` (round in arms → ram → step back), `crew.lay` (at the sight, hand on the traverse
wheel), `crew.fire` (lanyard pull, flinch), `crew.baseplate`, `crew.tube`, `crew.bipod`,
`crew.load.mortar` (bomb over the muzzle → drop → duck), `crew.tripod`, `crew.mountmg`, `crew.belt`,
`crew.mg`.

**Tests:** a gun with no crewman at a trail never opens it; two men open both trails in parallel and
one man opens them in sequence; killing the man mid-task pauses progress until another arrives; the gun
fires only after load → lay; a one-man crew still fires, slowly; determinism stays green; the balance
harness stays in range (guns and mortars get slower to bring into action, so tune times if needed).

## 7. Tank overrun (user request)

> It could just crush the man under the tracks, leaving a squished body, with bloodstains.

- **Sim:** a vehicle moving faster than 1 m/s whose hull footprint passes over an ENEMY soldier
  overruns him. Men who can react (standing or crouched, not pinned, stunned, cowering or wounded)
  dodge aside to the nearest free tile with probability 0.85 (green 0.7, veteran 0.95) and take a
  large stress spike; men who cannot react, and those who fail the dodge, are killed. Friendly men
  always step aside (drivers avoid their own troops). An overrun raises stress for every enemy within
  15 m who sees it. Seeded Rng only. Message: "<team>\n<Rank>. <Name> was run down." (rate-limited).
- **Look:** the body is left as a flattened corpse pressed into the ground in the vehicle's direction
  of travel, with a dark blood stain and the track's tread pattern running through it, and a short
  smeared trail where the track carried on. Kept at the game's small sprite scale and muted palette,
  like its other casualties; no flying body parts. Corpse entry keys: `corpse.crushed<N>` (4
  variants, 16 dirs), falling back to a normal corpse with a larger stain when the atlas lacks them.
- **Tests:** a prone pinned enemy under a moving tank dies; a standing calm veteran usually dodges;
  a friendly is never crushed; a stationary tank crushes no one; determinism green.
