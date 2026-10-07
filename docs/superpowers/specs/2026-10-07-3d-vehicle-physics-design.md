# 3D Vehicles with Deterministic Hull Physics

**Date:** 2026-10-07
**Status:** Design agreed in conversation; written spec under review
**Backlog:** item 050 (umbrella), sub-projects P1–P5

## Intent

Vehicles become real 3D meshes that physically ride over the world. A tank that runs over a tree, a rock, a log or a crater rocks, pitches and rolls realistically, and that tilt matters in play. Large blasts and anti-tank mines can rock a vehicle or turn it over.

**User-stated requirements**
- Vehicles are actual 3D meshes made in Blender. Low-poly is fine for now.
- **Every vehicle type stays identifiable by looking**, as the current sprites are.
- The physics is gameplay, not decoration (option B): it lives in the deterministic sim and holds in lockstep multiplayer.
- Vehicles interact physically with all of these:
  - felled trees lying as logs
  - standing tree trunks
  - rocks and boulders
  - craters, trenches, rubble, walls and hedges, and slopes
  - other vehicles' wrecks
- Large explosions can rock a vehicle or even topple it.
- Driving onto an anti-tank mine may easily topple a smaller vehicle.
- Implementation follows the recommended approaches: our own physics on `dmath`, and three.js rendering into an offscreen canvas.

**Assumptions** (to be corrected at spec review)
- three.js is acceptable as the project's first runtime dependency.
- The old sprite atlases stay as a fallback until P1 has proven itself.
- Seeded battle outcomes and balance-harness numbers will change once, as they did when `dmath` was introduced.

## Decomposition

The work is too large for one plan. Each sub-project gets its own plan, implementation and verification, done in this order:

| # | Sub-project | Depends on |
|---|---|---|
| P1 | **3D vehicle meshes and renderer** | – |
| P2 | **Deterministic hull physics core**: suspension over the height field, pitch, roll and yaw in the sim, and their gameplay effects | P1 (to be seen) |
| P3 | **Physical obstacles**: rocks and boulders, standing trunks, felled logs, rubble, walls and hedges | P2 |
| P4 | **Blasts and toppling**: HE impulse and AT mines | P2 |
| P5 | **Vehicle against vehicle**: contact, pushing wrecks, partial climb-on | P2 |

P1 and P2 are specified here in full. P3–P5 are fixed in outline, and each gets a short addendum spec before its plan.

## Architecture

- **The sim owns every vehicle's 3D pose:** position, height, heading, pitch and roll. The renderer only draws it.
- **Steering stays as it is.** The path follower, `speed`, the hull-turn and turn-radius rules, give-way and short halts keep producing *desired* speed and turn. P2 turns that output into **traction and steering forces** on a rigid body instead of a direct move.
- **`Vehicle.pos` and `Vehicle.hullFacing` stay, derived from the body each tick.** LOS, combat, AI, spotting and the UI keep working unchanged.

New code:
- `src/sim/hullPhysics.ts`: the body, suspension, integration, and the tipped-over and hung-up states (P2)
- `src/sim/obstacles.ts`: obstacle objects and the ground probe against them (P3)
- `src/render/vehicle3d/`: the three.js scene, the mesh cache and the composite into the 2D canvas (P1)
- `tools/blender/vehicles_lowpoly.py`: glTF export of the existing procedural vehicle models (P1)

## P1 — 3D vehicle meshes and renderer

### Meshes
- **Source models.** The meshes are built from the **same procedural Blender models** (`tools/blender/vehicles_common.py`, `vehicles.py`) that produce today's atlases, so each vehicle keeps its identity: turret shape and position, gun length and muzzle brake, hull slope, road wheels and return rollers, skirts and fenders, stowage, camouflage and national markings.
- **Size.** They're decimated to about 1.5–3k triangles. Textures and vertex colours are baked into one small texture per vehicle.
- **Output.** One `public/models/<defId>.glb` per vehicle, with named nodes:
  - `hull`
  - `turret`, whose pivot is the turret ring
  - `gun`, whose pivot is the trunnions, for elevation
  - `wheels_L` and `wheels_R`, for suspension travel and spin
  - turretless vehicles leave out `turret`, and casemate guns pivot in the hull
- **Command:** `npm run models:vehicles`.

### Renderer
- **One shared WebGL context.** `src/render/vehicle3d/` owns a single three.js `WebGLRenderer` on an `OffscreenCanvas` (or a hidden canvas) at the logical 1024×768 resolution.
- **Camera.** It's orthographic and matches the sprite renders: the same view angle, the same scale (10 px/m × camera zoom) and the same light direction.
  - Rendering is nearest-neighbour, with no anti-aliasing, to keep the pixel look.
- **Drawing each frame:**
  - `drawVehicles` sets every visible vehicle's transform from its sim pose: position, height, the heading/pitch/roll quaternion, turret yaw relative to the hull, gun elevation, and wheel travel.
  - It renders the layer once and `drawImage`s it into the 2D canvas at the layer the sprites occupy today.
  - The existing 2D overlays (engine smoke, hatch fire, turret ring effects, selection brackets) are drawn on top as now.
- **Shadow.** A planar shadow is projected onto the ground under each vehicle, dark and semi-transparent like the sprite shadows.
- **Damage states:**
  - A knocked-out vehicle gets a darkened, scorched material.
  - A burning vehicle keeps the existing fire effects.
  - A crushed-ground mark is still drawn in 2D.
- **Fallback.** If WebGL is unavailable or a `.glb` fails to load, `drawVehicleSprite` draws the atlas as today.

### Identifiability check (P1's acceptance gate)
- **Comparison sheet.** A contact sheet (extended `tools/blender/contact_sheet.py` or a `tools/vehicle3dPreview.html`) shows each vehicle's 3D render next to its old sprite.
  - Views: 8 headings, at 1:1 and at 2× zoom, summer and winter.
- **Critic subagent.** It must name every vehicle type correctly from the 3D renders alone and flag any detail that is lost. A failing vehicle gets more detail in the meshes before P1 is done.

## P2 — Deterministic hull physics core

### Body
- **New vehicle state.** `Vehicle.body` (optional; added when the vehicle spawns) holds:
  - the 3D position, with height `z` in metres
  - the orientation as a quaternion
  - the linear and angular velocity
  - suspension travel per contact point
  - flags: `asleep`, `hungUp` and `overturned`
- **New `VehicleDef` fields**, with historical figures where known:
  - `massT`
  - `suspension: { springKNm, damping, travelM }`
  - `cgHeightM` (centre of gravity), used for tipping
- **Inertia** comes from a box of `lengthM × widthM × hullHeightM`.

### Ground contact
- **Contact points:**
  - **Tracked:** 5–8 spring points per side along the road wheels, plus a front and a rear point raised to the track horns, so the nose rides up onto an obstacle instead of hitting it.
  - **Wheeled and halftracks:** one point per wheel; a halftrack's track section is treated like a tracked vehicle.
- **The probe.** Each point probes `groundHeightAt(x, y)`: the existing `heightField` (0.5 m resolution, already including craters, foxholes, trenches, rubble, walls and hedges) combined with P3's obstacle shapes. The probe also returns the ground normal.
- **Forces:**
  - The spring and damper push along the ground normal.
  - Traction and lateral grip follow a friction model scaled by the terrain's existing going values (mud, snow, road).
  - Tracked steering is a different drive force on each track; wheeled steering is a front-wheel angle.

### Integration and determinism
- **Time step.** Each `SIM_DT` (0.1 s) tick runs **10 sub-steps of 10 ms**, using semi-implicit Euler, and the quaternion is renormalised every sub-step.
- **Math.** Only IEEE `+ − × ÷ sqrt` and `dm.*`. No `Math.*` transcendentals and no `**`; the existing dmath ban test covers the new files.
- **Hashing.** `Vehicle.body` goes into `hashState`.
- **Desync rebuild.** It needs no change, because the body is ordinary vehicle state.
- **Sleeping.** A vehicle at rest, level and with no applied force sleeps and isn't integrated. It wakes on drive input, a blast, a collision or ground change under it (a crater, a crushed tile).
- **Cost.** The target is under 0.5 ms per tick for 40 vehicles in Node.

### Gameplay effects
- **Gun limits.** Elevation and depression limits apply in the tilted hull's frame. A hull pitched nose-up over a log can't depress onto a close target, and the fire order and cursor must reflect that (the existing aiming-cross colours stay consistent with the sim).
- **Aim spoiled by motion.** A gun's lay is spoiled while the hull's angular rate is above a threshold; a firing halt waits for the hull to settle.
- **Hit geometry.** The incoming direction of a hit is transformed into the hull frame. The facing, the plate struck (including **belly** when the hull is pitched up toward the shooter) and the effective thickness come from the real 3D orientation. The `armor` record gains `belly` (default: the `top` value).
- **Hung up.** When most contact points are unloaded and the hull rests on an obstacle, there's no traction.
  - The driver tries to rock free by reversing and then driving forward again, for up to N tries depending on crew experience.
  - Each try has a small chance to throw a track (the existing immobilisation).
- **Slopes:**
  - Speed is reduced by the side-slope angle.
  - The path cost (`path.ts`) penalises side slopes beyond a per-vehicle comfort angle and forbids slopes beyond its tipping angle.
- **Overturned.** A roll above 75°, or a pitch above 80° that doesn't recover within 2 s, sets the vehicle as overturned:
  - it's permanently out of action
  - the crew bails out with an injury roll per man
  - the hull stays as a physical wreck (it blocks movement, can be used as cover, and is drawn on its side or roof)
  - the message is "<vehicle> overturned"

### P2 tests
- **Physics:**
  - A hull settles flat on level ground within 2 s, with no creep or jitter, and its energy stays bounded over 10 minutes.
  - Over a 0.4 m log a T-34 pitches into the expected range and levels out after crossing.
  - The nose dips into a mortar crater and climbs out.
  - A halftrack on a 35° side slope rolls over; a KV-1 doesn't.
  - Gun depression fails against a close target while the hull is pitched up, and succeeds once it's level.
  - A belly hit is reported for a hull cresting toward the shooter.
- **Determinism:**
  - `tools/determinismNode.ts --minutes 10` and `tools/determinism.html` give identical hashes in Node, Chromium, WebKit, Chrome and Safari.
  - `test/lockstep.test.ts` and the desync recovery tests pass.
- **Balance.** `test/harness.test.ts` is re-baselined, and the attacker win rate stays within the previous band (about 40–47 %) or the difference is explained.
- **Visual.** A Playwright capture of a tank crossing a log and a crater (per the headless battle capture recipe), reviewed at 1:1.

## P3 — Physical obstacles (outline)

- **Map objects.** `GameMap.obstacles`: a deterministic list of shapes, placed by new map DSL elements and by events.
  - **Rock and boulder:** a sphere or rounded box, radius 0.3–2 m. A small one is a bump; a big one forces a detour or hangs a vehicle up.
  - **Standing trunk:** a vertical capsule with a stiffness and a break force. A vehicle pushing it pitches up; when the force is exceeded the trunk **snaps**, becomes a log lying in the direction of travel, and the tree tile changes as `treeCrushByVehicle` does today. A thick trunk can stop a light vehicle.
  - **Felled log:** a horizontal capsule. It's created when a vehicle snaps a trunk or a shell fells a tree (`trees.ts`), lying in the direction the tree fell.
  - **Rubble, walls and hedges:** they stay in the height field. Breaking through a wall or hedge first rears the hull against the wall height, then the wall flattens (the existing `crushTile`) and the hull drops.
- **Meshes.** Each obstacle kind has a low-poly Blender mesh with a few variants, drawn through the P1 renderer.
- **Spotting and LOS.** Rocks and logs give soldiers low cover (`cover.ts`), and boulders block LOS up to their height.

## P4 — Blasts and toppling (outline)

- **The impulse.** An explosion applies an impulse to every awake or sleeping body within reach. Its strength scales with the charge (`heRadiusM` or the mine charge) and falls off with distance. It acts at the nearest point of the hull, directed away from the burst, with an upward share for ground bursts.
- **Anti-tank mine.** The impulse pushes up through the belly at the track or wheel over the mine. It tips **easily for light vehicles** (armoured cars, halftracks, trucks, light tanks: low mass, high centre of gravity relative to track width), so the vehicle may roll away from the mine side. A heavy tank lurches and loses a track as today (`AT_MINE_DAMAGE`).
- **Large HE (heavy artillery, bombs, demolition charges).** It rocks the vehicle, and a near miss can roll a light vehicle over.
- **Consequences.** Crew injury rolls scale with the peak acceleration. Overturning follows P2's overturned rules.

## P5 — Vehicle against vehicle (outline)

- **Contact.** Hulls are oriented boxes. Contact uses a separating-axis test with an impulse response and friction, so the heavier vehicle pushes the lighter one.
- **Wrecks.** Wrecks are bodies too, so a heavy tank can shove one aside.
- **Climbing partly onto a hull or wreck.** It works through the contact points, which probe the other box's top surface as ground.
- **Existing rule.** "Vehicles never drive through each other" stays. Path planning still avoids hulls; physics only handles real contact.

## Out of scope

- Physics for soldiers, guns or loose objects (the existing ragdoll stays).
- Deformable terrain beyond what the height field already does.
- Buildings as physics objects; they stay impassable, as now.
- Water and fording physics.
