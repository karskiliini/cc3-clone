# 3D tall grass and crops around vehicles — design

Date: 2026-10-08. Branch: vehicles-3d-p1 (follows the 3D vehicles P1, item 050).

## Intent

The user: "the tall grass can also be modeled with 3d, so the tanks driving in a grass field can look
more realistic". Chosen option A: local patches of 3D blades around each vehicle standing in tall
growth, bending away from the hull and flattened in its wake, fading into the painted field. Crops
(wheat) get the same treatment with their own blade shape and colour.

Success: a 3D tank in tall grass or wheat reads as standing *in* the growth — blades in front of the
hull hide its lower part, blades behind are hidden by it, the hull visibly parts the growth, and its
wake lies flat — with no visible edge where the 3D patch meets the painted terrain.

Constraints: render side only (the sim and its determinism are untouched); stable from frame to
frame (no popping or shimmer as a vehicle moves); sprite vehicles keep today's 2D look; no hidden
enemy betrayed (same visibility rule as the existing grass effects).

Out of scope: 3D grass around infantry (the 2D tufts stay), wind sway, grass bending in reaction to
shells, changing the painted field or the 2D wakes.

## What is drawn

- **Patch.** Each 3D-drawn vehicle on a `tallgrass` or `crops` tile gets a patch of 3D blades within
  `PATCH_PAD_M = 5` m of its hull rectangle (rounded rectangle: hull half-length/width + pad).
- **Fade.** Over the outer `FADE_M = 2.5` m of the patch, blade survival falls smoothly from 1 to 0
  (dithered discard, see Rendering), so the 3D blades thin out into the painted blades.
- **Grass blade** (`tallgrass`): height 0.6–0.9 m, base width 4–6 cm, tapering to a point, gently
  curved (tip offset 15–30 % of height in a hashed direction), colours from the season's
  `BLADES[season].tallgrass.up` (darker at the base, a lighter tone toward the tip).
- **Wheat stalk** (`crops`): height 1.0–1.2 m, straighter (tip offset ≤ 8 %), narrow stem with a
  thicker ear over its top 15 %, colours from `BLADES[season].crops.up`, ear one step lighter.
- **Winter** uses the winter palette (dry, snow-dusted stalks), as the 2D fringe does.

## Field: where blades stand

Blades are anchored to the world, not to the vehicle. The ground is divided into square cells of
`CELL_M = 0.2` m (25 blades/m²). Each cell holds at most one blade; its offset inside the cell,
height, curve direction, width and colour index come from `hash2` of the cell coordinates (plus a
per-attribute salt). A cell gets a blade only if `tallGrowthAt` (tile lookup) is `tallgrass` or
`crops` at the blade's position; the growth kind picks the blade type. As a tank drives, the same
cells keep the same blades, so nothing pops.

## Bending

A pure function `bendBlade(blade, hulls, crushed)` returns the blade's lean (direction + angle from
vertical) and height scale. Rules, strongest wins:

1. **Under a hull** (inside the footprint grown by 0.15 m): lies flat (height scale 0.08, lean along
   the hull's facing). Mostly hidden under the hull anyway.
2. **Crushed ground** (see Crush map; level ≥ 0.5): lies flat along the stored travel direction
   (height scale 0.12).
3. **Near a hull** (within `PUSH_M = 1.0` m outside the footprint): leans away from the nearest hull
   edge, angle `70° · (1 − d / PUSH_M)²`. If the vehicle is moving (speed > 0.3 m/s) blades ahead of
   the bow lean forward instead (bow wave), same falloff.
4. Otherwise: the blade's own rest curve.

Only the vehicles whose patches include the blade count (a blade near two hulls takes the stronger
push).

## Crush map

The 2D wake is a painted canvas; reading it back would be slow. Instead `GrassFx` keeps, alongside
its trail canvas, a `Uint8Array` over the map at `CRUSH_CELL_M = 0.5` m (a 400×400-tile map →
1600×1600 = 2.5 MB), and each `stamp` writes the same rut-and-band area into it (255 = flattened)
plus a quantised travel direction (a second `Uint8Array`, 0–255 → 0–2π). It is reset with the trail
(new map, time jump back). Same visibility rule as the trail: only vehicles the player sees stamp.
The 3D field samples it via `GrassFx.crushAt(pos)` → `{ level 0..1, dirRad } | null`.

## Rendering

- New `src/render/vehicle3d/grassPatch.ts`:
  - `bladesFor(state, hulls, crush, budget)` — pure: walks the cells of every patch (nearest
    vehicles to the view centre first), applies growth, fade, bending, and returns per-blade
    instance data (position, yaw, lean, height, width, colour, fade). Stops at the budget.
  - `GrassLayer` — two `InstancedMesh`es (grass, wheat) with fixed capacity, added to
    `VehicleScene.scene`; `update(blades)` writes instance matrices and colours and sets `count`.
- **Geometry.** Grass: a tapered strip of 3 segments (6 triangles, enough for the curve). Wheat: 2-segment stem + an ear quad pair. Built once,
  unit height, bent per instance in the vertex shader from the instance's lean and curve.
- **Material.** `MeshLambertMaterial` with vertex/instance colours, `side: DoubleSide`,
  `receiveShadow` (the hull's shadow falls on the blades), no `castShadow`, and an
  `onBeforeCompile` patch adding the bend and a per-instance fade: the fragment is discarded when a
  screen-space ordered-dither value exceeds the fade. The 2× supersample box-downsample turns the
  dither into a soft fade; no transparent sorting.
- **Depth.** Blades are drawn in the same pass as the vehicles, so the depth buffer gives correct
  occlusion against hulls and turrets both ways.
- **Ground shadow pass.** Blades are not added to the shadow scene (the painted field has its own
  shading); hull shadows are unchanged.
- **Budget.** `MAX_BLADES = 40000` across both meshes. One stationary tank's patch is ~(7+10)×(3+10)
  m ≈ 220 m² ≈ 5500 blades, so ~7 vehicles fully in growth fit; beyond that the farthest patches
  from the view centre are dropped whole (they fall back to the 2D fringe, see Hand-over).

## Hand-over with the 2D grass

- `drawVehicles` (unitRender) already knows which vehicles were drawn in 3D this frame. After a
  successful `gl.out.draw` it records their ids — minus any patch dropped by the budget — in a
  per-frame set the battle screen passes to `GrassFx.drawStanding`, which skips the 2D fringe for
  those vehicles. Vehicles drawn as sprites (no model yet, no WebGL, `?vehicles=sprites`, lost
  context, failed draw) keep the 2D fringe.
- The grass layer is filled before `gl.out.draw` from the frame's 3D looks; a failed draw falls
  back to sprites and the 2D fringe for everything, as today.
- Painted wakes (`drawTrails`) and infantry tufts are unchanged.
- Knocked-out hulls in growth get a patch too (blades flattened under and around the wreck, no bow
  wave).

## Known limitation

`tallGrowthAt` is per tile (2 m) while the painted field's edge is soft (noise lobes). At a field
edge the 3D blades may stand up to ~1 m beyond or short of the painted blades. The edge fade and the
patch's small size keep this mild; if it shows, a later step can sample the terrain renderer's
tall-grass coverage grid instead.

## Testing

Node (vitest), no WebGL:

- Field: the same cell always yields the same blade; no blade on a non-growth tile; crops tiles
  yield wheat, tallgrass tiles yield grass; density ≈ 25/m².
- Bending: under the footprint → flat; at 0.2 m outside a hull edge → leans outward (away from the
  hull) more than at 0.8 m; ahead of a moving bow → leans forward; on a crushed cell → flat along
  the stored direction.
- Fade: 1 well inside the patch, 0 at its outer edge, monotonic between.
- Budget: never more than `MAX_BLADES`; nearest vehicle's patch is complete when the budget cuts;
  dropped vehicles are reported.
- Crush map: a `GrassFx.update` that lays a wake marks the cells under it as crushed with the travel
  direction; a hidden enemy lays nothing; a map change resets it.
- Hand-over: `drawStanding` skips the fringe for vehicles in the 3D set and draws it for others.
- `GrassLayer.update` sets instance counts and capacity limits (three objects work in Node, as in
  the existing `VehicleScene` tests).

Visual: a headless capture (tools / Playwright recipe) of a tank parked and driving through
tall grass and through wheat, summer and winter, before vs after, shown to the user.
