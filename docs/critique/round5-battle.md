# Round 5 Battle Critique — Art Direction and Gameplay

Reviewed live this session against `ref/ref_cc3_1477.png` (menu), `1478` (requisition), `1479`
(summer), `1482`/`1484` (winter), plus `docs/reference/cc3-manual-notes.md`. Previous rounds:
`round2-battle.md` (5.5/10), `round3-battle.md` (7/10), `round4-battle.md` (7/10).

No source was edited. Two battles were fought end to end:

- **Summer — Border Crossing**, German, Veteran, ~11 min of battle time. Full advance across the
  map, Move Fast + Fire orders, two 8 cm mortar fire missions onto the South Farm buildings,
  force annihilated (40 losses / 12 kills), ended via Flee → debrief.
- **Winter — Moscow Outskirts**, German, ~2.5 min of contact plus terrain survey of the woods,
  river, bridge and village.

Screenshots: `ref/wf13/r5_*.png` (49 files). All captured at exactly 1024×768 by POSTing
`canvas.toDataURL()` to a local sink, so every pixel value and measurement below is at 1:1.
Colour statistics were computed with numpy over matched crops of ours and the reference.

---

## 1. Overall likeness score: **7.5 / 10** (up from 7.0)

This is a real but narrow gain. Four things genuinely improved — crater/foxhole art, zoom-2
sprite rendering, the winter bare-tree scatter, and visible crew-served weapons — and the
simulation underneath is now far deeper than the presentation. But the two headline features
added since round 4, **real terrain elevation** and **structure damage**, are effectively
invisible in play: I measured 2–6 m of relief across a whole screen (proved with the depth map),
and 12+ mortar rounds onto a wooden farm building produced 33 craters and **zero** wall
conversions and zero breach/collapse messages. You cannot score a feature the player never sees.

Meanwhile several new HUD and text defects appeared that were not in round 4 (truncated combat
messages, wrong debrief grading, vehicles missing from the debrief, status words stuck on
"Moving"), and the battle is completely silent.

### The three things that most break the illusion now

1. **Buildings.** Unchanged since round 3 in character and now the single weakest art in the
   game. Every structure is a flat axis-aligned rectangle with a hard 50/50 horizontal split
   between a light roof half and a dark roof half, a 3 px black outline, cream 6×6 px dots for
   windows, and — at zoom 1 — no ground shadow at all (`r5_mortar_hit24.png`, `r5_w02_terrain.png`).
   `1484`'s houses have one continuous roof material, a strong SE cast shadow, a visible ridge,
   and eaves. Ours read as texture-mapped quads dropped on the map.
2. **Terrain local contrast.** Everything is 2.5×–6× flatter than the reference. Measured mean
   horizontal luminance delta per pixel: grass **17.4** vs reference **21.8**; summer dirt road
   **6.1** vs **16.5**; winter snow **6.7** vs **43.5**. The map reads as a smooth vector fill
   with a fine dither over it, not as painted ground. The dirt road is the worst offender: a
   near-uniform ochre ribbon (`r5_monitor.png`, which accidentally captured a 3× blow-up of one).
3. **The battlefield is silent and psychologically invisible.** `game.audio.ctx.state` is
   `running` at volume 0.7, but `ambientOn: false`, zero engine voices, and the play counter did
   not advance across 6 s of an active firefight. Separately, nothing in `unitRender.ts` or
   `soldierArt.ts` reads `mind.state` or `morale` — a panicked, pinned, cowering or berserk man
   is drawn identically to a calm one, and a corpse is drawn identically to a living soldier at
   zoom 1. A CC3 battlefield is loud and legible; ours is a mute diagram.

---

## 2. Per-area verdicts

### Terrain — ground / grass / crops — **Needs work**

`src/render/terrainRender.ts` → `groundColorFbm()` (ramp selection) and `paintGroundAndFeatures()`;
ramps `LOCAL_RAMPS.summer.grass = ['#424617','#53591e','#646a25','#737a2c','#858d38']`.

| crop | ours | `ref_cc3_1479.png` |
|---|---|---|
| open grass, avg | `#606426` | `#756224` |
| open grass, lum σ | 23.3 | 32.6 |
| open grass, local contrast | 17.4 | 21.8 |
| wheat/crops, avg | — | `#a9811e` (σ 27.6, lc 25.6) |

Two concrete problems.

**(a) The hue over-corrected.** Round 4 told you to pull the grass "back to green". You did, and
it has gone past the reference. CC3's Border-Crossing-style summer grass is a *dry brown-olive*
with R−G = **+19** (`#756224`). Ours is now R−G = **−4** (`#606426`) — a true yellow-green. The
reference is warmer and browner than we are, not cooler. Push the ramp back toward ochre: raise
the red channel of the mid stops by ~15 and drop green by ~5, i.e. roughly `#53591e → #5b5420`,
`#646a25 → #706128`, `#737a2c → #7f6c2e`.

**(b) The grain is dither, not brushwork.** `r5_03b_topright.png` is a 4× blow-up of open grass:
uniform isotropic salt-and-pepper with no clumping and no directional strokes. Round 3 raised
this, round 4 said the low-frequency blotch octave had landed, and the blotches *are* there at
the 100–160 px scale — but the 5–15 px scale that the eye actually reads as "grass" is missing.
`fbmClump` (÷5, 3 octaves) exists in `src/render/noise.ts` and `tuftShade()` exists in
terrainRender.ts at chance 0.22 / amplitude 0.1. Raise `tuftShade` to chance ~0.45 and amplitude
~0.22 and add one `fbmClump` octave into the grass branch of `groundColorFbm`.

Crops are the best ground in the game: warm gold with a genuinely irregular scalloped boundary
into grass at zoom 2 (`r5_bldg_ex0.png`). **Good** — leave them alone.

### Terrain — roads — **Needs work (regressed in character since round 3)**

`src/render/terrainRender.ts` → `SUMMER_ROAD_RAMP = ['#7a5c1e','#8f6e26','#a07a2c','#b08a36']`,
`paintLineVector` / `strokePolylineWorld`.

| | ours | ref |
|---|---|---|
| avg | `#917128` | `#a3793a` |
| lum σ | 15.6 | 31.1 |
| local contrast | **6.1** | **16.5** |

`r5_monitor.png` (3× blow-up of a road at zoom 2) shows the problem plainly: a flat ochre slab,
two faint darker rut streaks, a handful of random dark 3×3 specks, and a hard aliased edge with
visible 2–4 px stair-steps straight into the grass. Round 3 called the road "the biggest single
win"; the geometry still is, but the *surface* is now the flattest thing on the map. Reference
roads carry bright gravel highlights (up to `#cd9a63`) against dark wet ruts (`#8a6327`) — a 67
level swing per pixel-pair. Ours swings 6.

Also our road is too yellow: R−B = 105 for us vs 105 for the reference but our green sits 17
lower relative to red, giving a mustard cast where the reference is a warm tan.

Fix in `paintLineVector`: widen the ramp (add a `#c8a068` gravel stop and a `#6a4e18` wet-rut
stop), stamp 2–5 px gravel specks at ~8 % density, and feather the verge over `VEC_FEATHER_PX`
with a dithered rather than hard boundary.

### Terrain — water / ice — **Wrong**

`ICE_RAMP = ['#6e8290','#7d919e','#8fa2ae','#a6b6c0']`, `WATER_RAMP`, in terrainRender.ts.

`r5_w_ice.png`: the Moscow river is a ~30 px flat blue-grey stripe (`#98aab6` at centre) with
hard edges, no texture, no ice cracks, no dark open-water channel, no dirty bank. `1482`'s river
is a granular ice sheet (avg `#6e655b`, lum σ 48.6, local contrast 26.3) with visible floe
structure and brown mud banks. Ours has essentially zero internal variation. This is the one
area that has not moved since round 3 flagged water as "unverified".

Add an ice-plate cell noise (8–20 px cells, ±12 levels), a darker channel down the thalweg, and
a 3–4 px `BARE_EARTH {84,68,52}` bank fringe where snow meets water.

The **bridge** (`r5_w_ice.png`, centre) is a solid brown `#6a5232` rectangle, 100×75 px, with the
word "Bridge" on it. No planking, no rails, no shadow, no approach ramps. `paintBridge()` in
terrainRender.ts. **Wrong.**

### Elevation and hillshading — **Needs work (the feature does not read)**

`src/sim/heightField.ts` (`HF_RES 4`, 0.5 m samples) and `reliefFactor(X,Y,seed)` in
terrainRender.ts (`RELIEF_AMP 0.18`, `RELIEF_FULL_GRADE 0.35`, NW light, evaluated per 4×4 px block).

The machinery is correct. The *content* is not. The depth map (`r5_overlay_depth.png`,
`r5_w_depth.png`) is the proof: across a full 51×31-tile screen on Border Crossing the height
spans roughly the 4 m → 12 m ramp bands, and on Moscow Outskirts roughly 2 m → 6 m. That is a
grade of about 8 m over 100 m of ground — **8 %, against a `RELIEF_FULL_GRADE` of 35 %**. The
shade term therefore lands near `1 ± 0.04`: a ±4 % brightness swing, well under the terrain's own
dither amplitude. In the normal view both maps read as perfectly flat (`r5_overlay_off.png`).

Consequently "crest-blocking line of sight" and "slope movement" cannot be doing meaningful work
on these maps — there are no crests. Nothing I ordered was ever masked by ground.

Two fixes, in order: (1) put real relief in the map data — `elevation` in
`src/data/maps/border_1941.ts` and `winter_1941.ts` needs 15–25 m of range with ridge lines and
a proper river valley, not 4 m of swell; (2) once it is there, drop `RELIEF_FULL_GRADE` to ~0.18
so ordinary rolling ground still shades, and consider a second, much wider-baseline shade term
(sample the height field over ~20 m rather than 4 m) so broad landforms read at zoom 0.5.

### Buildings and structure damage — **Wrong**

`paintRoof()` (terrainRender.ts ~1594), `paintBuildingShadow()`, `paintInterior()`,
`TerrainRenderer.paintStructureDamage()` (~3064), `paintCavedRoofEdges()` (~3113);
`src/sim/structures.ts`.

Art (`r5_bldg_ex0.png`, `r5_w_zoom2.png` at zoom 2, `r5_mortar_hit24.png` at zoom 1):

- Every roof is split **exactly 50/50** by a razor-sharp horizontal line into a light upper band
  and a dark lower band. It reads as two materials butted together, not as a pitched roof. The
  shingle/plank striping from `getRoofPattern` *is* present but is far too low-contrast to
  survive at zoom 1. `1484` roofs are one hue with a soft ridge highlight and a much stronger
  eave shadow.
- **No cast shadow at zoom 1** on the summer farm buildings at all; a shadow does appear on the
  winter stone building at zoom 2 (`r5_w_zoom2.png`), so `paintBuildingShadow` is conditional on
  something — probably height or material. It should be unconditional and visible at every zoom.
- Windows are cream 6×6 px squares scattered round the perimeter. They read as rivets.
- Roof-off interiors when occupied **work and are legible** (`r5_w13.png`, four men on a brown
  plank floor) — genuinely good, but the interior is bare planking with no walls, no window
  openings and no furniture, so it reads as a brown box.
- The depth map draws roofs as a *sloped* orange→red gradient (`r5_w_depth.png`) while the normal
  view draws them as a hard two-tone band. The height model and the art disagree about roof shape.

Damage — **not observable**. Two 8 cm mortars firing for ~3 minutes onto the South Farm wooden
building (`STRUCTURE_HP.buildingWood 60`, `ROOF_HP.wood 50`, `MORTAR_ROOF_MULT.wood 1.5`):

```
tiles in the 17×15 block around the target, before → after 20 s of sustained fire
buildingWood 26 → 26      crater 10 → 11      craters on map 31 → 33
messages: no "Wall breached.", no "... has collapsed.", no "We're being buried in here!"
```

Rounds group in the field around the building, not on it. `mortarBaseDispersionM(distM) = 3 +
distM/100` gives ~3.9 m σ at this range and `MORTAR_TIER_WALK.area` bottoms out at 1.4×, so
σ ≈ 5.5 m against a ~10 m building — under half the rounds should land on it, and none did
damage. Either `applyBlastDamage` is not being reached from a mortar `sizeM: 2.5` blast
(combat.ts:445), or the roof path is not wired to mortar impacts. This is the highest-value
thing to debug: an entire subsystem (`src/sim/structures.ts`, 5 casualty tables, breach/cave-in/
collapse art) is currently dead weight.

### Craters, foxholes, trenches — **Good** (best art in the game)

`src/render/craterArt.ts` — `paintCrater`, `fillCrater`, `shadeField` (light `-0.46/-0.46/0.76`).

`r5_overlay_off.png`, `r5_building_after.png`, `r5_w_woods.png`. Shell holes are irregular
6-harmonic outlines with a raised light-brown lip, a dark NW shadow crescent, radiating ejecta
clods, and — on snow — brown earth thrown over white. They have real form and real light. This
is the one place where the game clearly out-draws the reference.

Two notes: craters read **~50–60 px across at zoom 1** against ~25 px in `1479`, so a single
mortar mission visually cratered the whole farm; consider trimming `craterExtentPx` (shell:
`R*3.3+0.4` m fresh) by ~25 %. And I never saw a foxhole or a trench rendered in play on either
map despite `stampFoxhole`/`paintTrenches` existing and Moscow Outskirts carrying 1 % `trench`
tiles — worth a dedicated check.

### Trees / decor — **Good on winter, Needs work on summer**

`paintWoodsChunk` / `woodsCandidate` / `drawCrown` / `drawCrownShadow` in terrainRender.ts;
`src/render/sprites.ts` (`TREE_SPRITE_WORLD_PX 28`, `TREE_VARIANTS 8`); `decorSprites.ts`.

**Winter is a genuine fix** and closes round-4 item #2. `r5_waypoints.png` shows a stand of bare
trees drawn as radiating branch spokes with long thin SE cast shadows, mixed with snow-laden
conifer clumps. That is the right idea and it reads close to `1482`. Two residual differences:
(a) our bare trees are too *linear* — 6–10 straight spokes each, so they read as asterisks, where
`1482`'s bare clumps are dense round twig masses that read as solid brown blobs; (b) the stand is
a hard-edged **oval patch** with plain snow outside it, where `1482` scatters bushes evenly across
the whole frame. Feather `woodsParams` density outward over ~10 tiles and scatter isolated
`scatteredtrees` into the surrounding snow.

Summer trees are unchanged: dark green rounded blobs (`#3f4a1f` sampled, vs reference canopy
`#5f551a`) in regular pairs, too dark and too green — the reference canopy is an olive-brown.
Their `drawCrownShadow` (alpha 0.72) is not reading at zoom 1 (`r5_overlay_vision2.png`).

Ground decor (`decorSprites.ts`, 182 items on Moscow Outskirts) was essentially never visible —
the central two-thirds of both maps are empty.

### Fences, hedges, walls — **Wrong**

`paintFence` (`#5a4326`, 2 px band), `paintHedge`, `drawBand` in terrainRender.ts.

The most distracting artefact on screen. Fences render as **perfectly straight brown ruler lines**
5–6 px wide running 1000 px across the map with evenly-spaced dark square posts (`r5_w_zoom2.png`,
`r5_w13.png`). Hedges render as 7–8 px dark-green ropes (`r5_overlay_vision2.png`). The South Farm
compound is a 1 px grey wireframe rectangle (`r5_mortar_hit24.png`). None of them have per-post
shadows, height variation, gaps, or lean. In `1479`/`1484` field boundaries are broken, bushy and
irregular. Jitter post positions ±0.4 tiles, give each post its own 3 px SE shadow, and break
the line with 1–2 tile gaps every 8–15 tiles.

### Snow — **Needs work (improved, still far too flat)**

`LOCAL_RAMPS.winter.snow = ['#c4c9d1','#d6dae0','#e6e9ee','#f2f4f7']` plus `SNOW_DRIFT_SHADOW
{164,178,202}`, `SNOW_CREST`, `SNOW_LEE_SHADOW`, `SNOW_RUT`, `DEAD_GRASS`, `BARE_EARTH`.

| | ours (zoom 1) | ours (zoom 2) | `ref_cc3_1482.png` |
|---|---|---|---|
| avg | `#cec9cc` | `#e5e9ef` | `#b2aaa5` |
| lum σ | 45.3 | 10.1 | 63.8 |
| local contrast | **6.7** | **4.3** | **43.5** |

Round 4's "snow is flat" is only half fixed. The drift banding and wind shading are now visibly
there at zoom 1 (`r5_w02_terrain.png`, the scalloped ridges across the middle) and the granular
texture at zoom 2 is pleasant. But the numbers are brutal: **6.5× less local contrast than the
reference**, and we are 28 levels brighter and much cooler (ours neutral `#cec9cc`, reference
warm `#b2aaa5`). The reference sells snow with dirt: exposed earth along every track and bank,
brown dead grass poking through, hard blue drift shadows. Ours has a faint brown speckle and
otherwise reads as blank paper. Drop the whole ramp 20–25 levels, warm it by +8 red, and push
`SNOW_RUT {110,94,76}` and `DEAD_GRASS {146,122,82}` up to 3–4× their current coverage.

Vehicle tracks in snow are 1 px dashed grey lines, far too thin and too regular, and several of
them **loop back on themselves** for no reason (`r5_w_woods.png` at x≈620–700 and x≈250–290) —
that looks like a spline artefact, not a track.

### Soldiers — **Needs work**

`src/render/soldierArt.ts` (10 px/m; standing sprite 27×27 px at 1×, 54×54 at 2×);
`drawSoldiers()` in `src/render/unitRender.ts` (~line 369).

Good news first: **zoom 2 is fixed.** Round 4's "nearest-neighbour blocky grey capsules" is gone
— `r5_zoom2_squad.png` and `r5_zoom2_crop.png` show crisply re-rasterised figures with readable
helmets, weapon diagonals, belt kit and prone poses. Round-4 fix #3 is closed. Formations have
also loosened: no parade-ground rows anywhere in either battle (`spawn.ts` wedge/skirmish roll,
`settleTile` sub-tile jitter). Round-4 fix #4 is half closed.

What is still wrong:

1. **No mental state is drawn.** `grep` confirms nothing under `src/render/` reads `mind.state`
   or `morale`. In the summer battle I had 7 cowering, 4 broken, 1 panicked and 2 shaken men on
   screen at once and could not identify a single one of them without opening the monitor. The
   only map-level cue is `teamBarColor` in `src/ui/hud/hudChrome.ts` — a 30×4 px bar, **zoom 1
   only**, which goes `HUD.yellow #e8d83c` for Pinned/Cowering and `HUD.red #d02020` for
   Broken/Panicked/Routed. That is a team-level average, not a man. Add to `drawSoldiers()`: a
   hunched/head-down pose for cowering, a dropped-weapon arms-up pose for panicked, and a small
   suppression stipple or shudder offset scaled by `s.suppression`.
2. **Corpses look like living soldiers.** `r5_overlay_off.png` has ~20 dead and incapacitated men
   drawn as the same dark grey shapes as the living ones. `deadFigure` exists in soldierArt.ts but
   at zoom 1 it is indistinguishable. `1479` shows the dead as clearly darker splats. Also, blood
   is a single **2×2 px `#5a1a12` rect at alpha 0.6** (`TerrainRenderer.drawOverlays`,
   terrainRender.ts:3407) — that is the entire blood system, and it is invisible.
3. **Both sides are identical on winter maps.** `uniformColors('german','winter')` and
   `uniformColors('soviet','winter')` both return uniform `#cacbc4`; only the helmet differs
   (`#454b4e` vs `#7b7e48`, a 2–3 px patch) plus a translucent friendly rim
   `rgba(200,160,40,0.5)`. At 10 px you cannot tell friend from foe. Give the Soviets a warmer
   smock (`#c6c0b0`) and widen the friendly rim to a full 1 px opaque ring.
4. **Summer uniforms are drab.** `#5d686c` German against `#606426` grass is a value match with
   no hue separation; figures read as grey smudges (`r5_s6.png`). `1479`/`1482` figures are
   punchy and saturated.

### Vehicles — **Good**

`src/render/vehicleArt.ts`. Hull/turret shading, cross and star markings, distinct track bands,
cupola bumps and a reserved 6 px SE shadow pad all read correctly at zoom 1 and 2
(`r5_s6.png`, `r5_w13.png`). Knocked-out hulls go dark and get a fire/smoke wisp. Round 3's
contrast complaint is closed.

Two gaps: no winter whitewash variant (German tanks on Moscow Outskirts are the same grey-green
as in summer, where `1483`/`1485` show whitewashed hulls), and I observed two Soviet tanks
(`BT-7` and `KV-1`) occupying **exactly the same tile (143,75)** for an extended period — vehicle
stacking is not prevented.

### Crew-served weapons — **Good**

`src/render/weaponArt.ts`, `src/sim/crewWeapon.ts`.

New since round 4 and it works. The MG34 on its Lafette tripod with an ammo box, the 8 cm mortar
tube on its baseplate, and the PaK 38 all render as recognisable pieces of ordnance with their
crews in distinct poses around them (`r5_zoom2_squad.png`, `r5_overlay_vision2.png`). The
`packed`/`half`/`ready` variants change the silhouette. Setup/aim/load states surface as text in
both the team grid and the soldier monitor ("Setting up", "Aiming", "Loading", "Firing"), and the
gun-takeover chain ("Schtz. Kaiser mans the gun", "The crew abandons the gun!") is legible and
dramatic. The monitor correctly shows the gunner's ammo as `HE / 3 rds.`

Only complaint: at zoom 1 the weapon is small enough to be mistaken for a fourth crewman.
`ART_SCALE.mortar` is already 1.5; consider bumping `lafette` and `atgun` similarly.

### Effects — **Needs work**

`src/render/effects.ts`.

- **Explosions are the weakest effect.** `r5_bldg_ex0.png` at zoom 2 shows a hard-edged flat
  orange **disc** ~70 px across with a pale grey core and a brown crescent underneath. It reads
  as a sticker. `drawExplosions` is documented to layer dark `#6a2a14`, orange `#d86a2c` and
  yellow `#ffd070` blobs plus 6–8 debris streaks and a growing smoke ball over `EXPLOSION_LIFE_HE
  0.9 s` — almost none of that survives to the frame. CC3 mortar impacts are a brief white flash
  followed by a dirty grey-brown smoke column, not a solid orange circle.
- **Mortar shells have no visible flight.** `drawTracers` deliberately skips mortar tracers, so
  there is no arc, no time-of-flight cue, and nothing connecting the firing tube to the impact.
  The player has no way to see that an indirect mission is in progress except by reading the
  team-grid text.
- Small-arms tracers (`#ffe08a`, w2, `TRACER_LIFE 0.35 s`) and the star-shaped muzzle flash are
  fine but so short-lived that across dozens of captures during active firing I caught them only
  twice. Consider `TRACER_LIFE 0.5 s` and a brighter mg tracer.
- Burning vehicles (`r5_w13.png`) are a small orange smudge with one thin plume — much weaker
  than the three-layer flame plus 11-puff column that `drawBurningVehicles` describes.

### HUD — **Good**

`src/ui/hud/*`. The bottom strip is the most faithful part of the game and matches `1479`/`1482`
closely: 5×3 team grid at (0,632) with 123×31 boxes, the coloured status word under each team
name, the Chat/Options/zoom/Map cluster at the left, the Anti-Pers / Anti-Tank ammo ladders with
`2 4 8 16 32 64` ticks, the Truce/Flee buttons, and the Combat Messages panel at x 620.

The **soldier monitor** (`r5_monitor.png` at 3×) matches `1482`'s structure row for row: boxed
name cell, bold role cell (Leader/Gunner/Assist/Soldat), a Healthy/Incap./Dead cell in
green/red, then activity, weapon glyph, and a boxed round count. Round 4 called this a big win
and it holds up.

Four fixable gaps against the reference:

- Our role cell is noticeably **larger and bolder** (bold 11 px Arial on a light plate) than
  `1482`'s small thin type on dark maroon. Ours is less dense.
- No `AP` / `HE` ammo-type label between the weapon glyph and the count on rifle rows (reference
  shows `⟍ AP | 1242 rds.`).
- The weapon glyph is a 2 px diagonal tick; the reference glyph is a recognisable gun silhouette.
- No scroll chevron on the left edge of the monitor (`1482` has a ▼).

### Overlays — **Needs work**

- **Depth map (Tab)** — `src/render/depthOverlay.ts`. **Good.** Well-designed 14-stop ramp, a
  clear legend at (8,8) reading `DEPTH MAP (Tab)` with `-2 -1 0 1 2 6 12 20 30+ m`, craters read
  as dimples, buildings as orange/red blocks. It is the single most informative view in the game
  and it is what proved the elevation problem. Only ask: add contour lines, because at the actual
  2–6 m range of these maps the whole screen is one colour band.
- **Vision overlay (L)** — `src/render/visibilityOverlay.ts`. **Needs work.** It draws only
  *blocked* and *obscured* regions (`BLOCKED_ALPHA 0.42`, `OBSCURED_RGB [18,70,22]`) plus a small
  facing wedge. On open ground nothing is blocked, so the overlay draws **almost nothing** and
  the player reasonably concludes it is broken (`r5_overlay_vision2.png` — one faint 70 px green
  arc, and that is the whole overlay). Worse: with a wiped-out team selected it draws nothing at
  all while the message log still prints "View overlay on" (`r5_overlay_vision.png`). Add a
  positive cue — a light tint over ground the selected team *can* see — and suppress or reword the
  toggle message when the selection has no living spotters.
- **Order markers** — `src/render/orderMarkers.ts`. **Needs work.** Always-visible markers and
  shift-click waypoints both work (`r5_waypoints.png`: a three-vertex blue zigzag with a dot at
  each waypoint and a filled dot at the destination — legible and useful). But the route is drawn
  as a **solid 1 px line**, which reads as a laser pointer. The manual and `1479` use a *series
  of spaced dots* in the order colour (Move blue, Move Fast purple, Sneak yellow). Also the line
  is drawn straight through obstacles rather than following the pathfound route.

### Menus — **Good**

- **Main menu** (`r5_00_menu.png` vs `1477`): structure, stair-stepped button placement, the
  torn-metal plate shape, the bottom nav strip and the help line all match. The background is the
  gap — `1477` is a photographic soldier pointing at the camera over a hot orange glow; ours
  (`drawHeroSoldier` in `src/render/menuArt.ts`, `SIL_DARK '#1d0c08'`, `SIL_RIM '#7a3216'`) is a
  flat silhouette on a radial gradient. Also our button plates lack the reference's bright white
  top-edge highlight and ragged right-hand flap.
- **Battle setup** (`r5_01_playagame.png`): clean, with a genuinely nice painted map thumbnail.
  The FORCE panel is ~60 % empty black below "BATTLE LENGTH".
- **Requisition** (`r5_02_requisition.png` vs `1478`): structurally excellent — two columns, the
  vertical stencil FORCE POOL / ACTIVE ROSTER titles, Regular/Armor dropdowns, red "Low Points",
  green strength pips, the Refit/Rest/Details/Retire row. Missing vs the reference: empty roster
  slots with rank-gating text ("Must be 1st Sergeant to fill this slot"), the ladder graphic, the
  textured panel backgrounds, and Info/Details buttons in the description pane.
- **Debrief** (`r5_debrief.png`): see §5 — the layout is good, the content is wrong.
- **Wrong text, every screen:** the logo reads `CLOSE ‖ COMBAT` with **two** bars. `1477` has
  three. This is *Close Combat III*. `drawLogo` in `src/ui/chrome.ts`.
- **Wrong text, every screen:** the bottom help line is the static string "Right-click on screen
  elements to display more detailed help." In `1478` that line is **context-sensitive** ("The
  force pool lists the teams from which you select your active roster…"). `BottomStrip` in
  `src/ui/screens/common.ts`.

### Audio — **Wrong**

`src/audio/sfx.ts`, `synth.ts`.

Measured mid-battle with a live firefight on screen:

```
game.audio.ctx.state = "running"    masterVolume = 0.7
ambientOn = false    ambientVoice = false    engines = 0
recentPlays: 2 → 2 across 6 s of active combat
```

No shot, no explosion, no engine, no wind. 17 sound generators exist and are never heard. Known
causes from the code: `unlock()` is only called from `mainMenu.ts:31`, so entering a battle
without touching the main menu leaves the context suspended; `case 'kill'` in `battle.ts:521` is
deliberately silent so the `scream` generator never fires; `teamBroken` is silent; and
`startEngineVoice` / `startAmbientWind` in synth.ts have no call site anywhere in the battle loop.
A CC3 battle is defined by its soundscape. This is the cheapest large fidelity win available.

---

## 3. Does it PLAY like Close Combat III?

Partly. The model underneath is closer to CC3 than anything in rounds 2–4, and in places it is
more detailed than the original. The *presentation* of that model is where it falls down.

**Order responsiveness — good.** Select, hotkey, click: the order applies on the same frame and
the team status word changes immediately. `MENU_GROUPS` in `commandMenu.ts` matches the manual's
three categories exactly, `ORDER_HOTKEYS` (z x c v b n m) are correct, and shift-click waypoints
work. The `canObey` model in `src/sim/orders.ts` — `p = 0.5 + motivation/200 + experience/400 −
fear/150`, failure parking the order and setting `mind.hesitation = rng.range(1,3)` s — is exactly
the right idea and is a genuine CC3-ism (your men sometimes do not go). But **the player is never
told it happened**: a hesitating team simply shows "Idle". CC3 barked back at you. Add a message
and a distinct status word ("Hesitating" / "Won't move").

**Do soldiers behave like individuals? — yes, in the sim.** `mind.ts` gives each man a trait
(steady/nervous/brave/reckless/cautious/stoic), up to 8 spatial beliefs about where threats are,
a nine-state escalation ladder (calm→alert→wary→shaken→pinned→cowering→panicked→broken, plus
berserk), belief sharing between neighbours, leader-scaled recovery timers, gun takeover, leader
succession and rallying. Across the summer battle I watched the histogram spread from
`{calm: 104}` to `{calm: 22, alert: 19, wary: 9, cowering: 7, broken: 4, shaken: 2, panicked: 1}`.
Men panicked, rallied, took over a gun, took command, and ran. That is CC3's whole point and it
is working.

**Is the psychology visible and legible? — no.** This is the biggest gameplay failure.
The only channels are (a) the 30×4 px team bar colour, zoom 1 only, team-average; (b) the soldier
monitor, which shows one team at a time and only its first four men; (c) the message log. The map
itself — the surface the player actually looks at — carries no information about any man's state.
The messages are the best channel and they are genuinely good writing:

```
Rifle Squad / Schtz. Köhler is panicking.
5cm PaK 38 / Schtz. Kaiser mans the gun.
MG34 HMG  / Schtz. Schmidt takes command.
PzKw IV F1 / Gefr. Lehmann has rallied.
```

…but they scroll away in a four-row window and half of them are cut off mid-word (§5).

**Pacing — wrong at the opening, right in the middle.** Both maps are 200×150 tiles and both
deploy the Germans around x ≈ 13–47 and the Soviets around x ≈ 167–194. That is a **125–150 tile
(250–300 m) no-man's land on a 200-tile map**, plus a German force smeared across y = 17–138 —
2.3 screens tall — so you cannot see your own army at once. The result is the round-4 complaint
in sharper form: I played 160 s of Border Crossing before a single German casualty and had
2 dead at t = 163 s. Once contact was made the middle game was excellent — attrition, panic,
routs, a tank brewing up, victory locations changing hands. CC3 maps put the forces two to four
hundred metres apart on a map you can survey in three screens. Halve the deployment separation
and tighten each side's deploy zone to roughly one screen.

**Does high ground matter? — no.** See §2 Elevation. There is 2–6 m of relief on screen; no
crest ever masked anything. **Does cover matter? — yes.** `coverSeek.ts` visibly works: panicked
men sprint up to 25 tiles to the best cover, pinned men crawl 3 tiles, and `settleTile` scatters
arrivals without snapping to tile centres. Squads that crossed the open ground under fire were
destroyed; the ones that hugged the hedge line survived longer. The "is looking for cover"
message fires (180 s cooldown per team). This part reads correctly.

**Can the player understand what is happening and why?** Partly. The team grid + message log +
soldier monitor together do tell the story, but you have to read three text panels because the
map shows almost nothing beyond position. Specifically confusing or frustrating in play:

- A team that has arrived shows **"Idle"**. A team that refused an order also shows **"Idle"**.
  A team with no order shows **"Idle"**. Three different situations, one word.
- Vehicle teams that arrived 60 s ago still show **"Moving"** (teams 50/57/64 sat 0.5 tiles from
  their target for a minute, status never settled). The arrival threshold for vehicles is wrong.
- The same unit class is reported two ways: one `PzKw III J` showed **"KIA"** in the team grid
  while the other showed **"Destroyed"**.
- `"PzKw IV F1 / PzKw IV F1 has been knocked out."` — the team name is printed twice, and this
  exact message appeared **twice in a row**.
- Pressing `L` prints "View overlay on" and nothing visible changes (§2 Overlays).
- The order route is a solid line, so with several teams ordered the map fills with crossing
  coloured lines rather than CC3's discreet dotted paths.

---

## 4. Top 15 fixes, ranked by impact

1. **Make structure damage actually happen.** 12+ mortar rounds, 33 craters, zero
   `buildingWood`→`rubble`, zero breach/collapse messages. Trace `combat.ts:445` (`mortar →
   {sizeM: 2.5, kind:'shell'}`) into `structures.ts applyBlastDamage → damageTile / damageRoof`.
   An entire subsystem is currently unreachable.
2. **Put real relief into the map data.** `elevation` in `src/data/maps/border_1941.ts` and
   `winter_1941.ts` currently yields 2–6 m across a screen; it needs 15–25 m with ridges and a
   cut river valley, or elevation, crest LOS and slope movement are all invisible. Then drop
   `RELIEF_FULL_GRADE` (terrainRender.ts `reliefFactor`) from 0.35 to ~0.18.
3. **Turn the sound on.** `game.audio` is running and mute. Call `unlock()` on battle entry, wire
   `startEngineVoice` and `startAmbientWind` from the battle loop, and un-silence `case 'kill'`
   and `teamBroken` in `battle.ts:521`. `src/audio/sfx.ts` already has all 17 generators.
4. **Draw mental state on the soldier.** `drawSoldiers()` in `src/render/unitRender.ts` never
   reads `s.mind.state` or `s.suppression`. Add a cowering pose, a panicked pose, a suppression
   stipple, and make `deadFigure` unmistakably darker/flatter than a living man at zoom 1.
5. **Rebuild the building roof.** `paintRoof()` in terrainRender.ts: replace the hard 50/50
   light/dark band with a ridge line plus a graded pitch, raise the shingle-stripe contrast so it
   survives zoom 1, draw windows as dark recessed slots rather than cream dots, and make
   `paintBuildingShadow` unconditional and visible at every zoom.
6. **Fix the combat message panel.** Every long line is clipped mid-word with no ellipsis
   ("has been wounde", "has been destroye", "has been knocked o"). Strip the duplicated team name
   from the body line, de-duplicate repeats, and drop the `(35)(36)(37)` index numbers — `1479`
   has none. `src/ui/hud/combatMessages.ts`, `fitHudText`/`clipTextToWidth` in `hudChrome.ts`.
7. **Raise terrain local contrast, especially the roads.** Road 6.1 vs reference 16.5; snow 6.7
   vs 43.5; grass 17.4 vs 21.8. Widen `SUMMER_ROAD_RAMP` with a gravel highlight and a wet-rut
   dark, stamp gravel specks, and darken/warm the whole `LOCAL_RAMPS.winter.snow` ramp by
   20–25 levels while tripling `SNOW_RUT` and `DEAD_GRASS` coverage.
8. **Halve the deployment separation and tighten the deploy zones.** Forces start 125–150 tiles
   apart on a 200-tile map with the German line spread over 120 tiles of height. `deployZones` in
   the map defs and `src/sim/spawn.ts`. This is the single biggest change to how a battle *feels*.
9. **Fix the status vocabulary.** "Idle" currently covers arrived / order-refused / no-order;
   vehicles never leave "Moving" after arriving; "KIA" and "Destroyed" are used
   interchangeably for the same vehicle class. `STATUS_DISPLAY` / `teamStatusLabel` in
   `src/ui/hud/hudChrome.ts` and `computeTeamStatus` in `src/sim/morale.ts`. Add a "Hesitating"
   status and a message when `canObey` fails, so the player learns the mechanic exists.
10. **Fix the debrief.** `r5_debrief.png` graded a 40-losses-to-13, 0-of-8-victory-locations rout
    as **"Minor Defeat"**; the four vehicle teams are missing from "YOUR TEAMS" entirely (so the
    per-team kills sum to 5 against a headline of 12); and the status column prints in-battle
    activity words ("Loading", "Firing") as end-state. `src/ui/screens/debrief.ts`,
    `RESULT_WORDS`, `drawRatingRow`.
11. **Rework explosions.** `drawExplosions` in `src/render/effects.ts` currently resolves to a
    flat orange disc on screen. Lead with a 1-frame white flash, then a dirty grey-brown smoke
    column with debris streaks; drop the saturated orange fill. Also un-skip mortar tracers in
    `drawTracers` so an indirect mission has a visible arc.
12. **Give the vision overlay a positive signal.** `visibilityOverlay.ts` draws only blocked and
    obscured ground, so on open terrain it appears to do nothing; with a dead team selected it
    does nothing at all while still printing "View overlay on". Tint what the team *can* see.
13. **Fix fences, hedges and walls.** `paintFence` / `paintHedge` / `drawBand` produce dead
    straight 2–6 px ruler lines with evenly spaced posts. Jitter post position and height, give
    each post an individual SE shadow, and break the runs with gaps.
14. **Draw order routes as spaced dots, not solid lines** (`orderMarkers.ts` `orderLinePoints`),
    in the manual's colours, and follow the pathfound route rather than the straight chord.
15. **Warm the summer grass ramp back toward ochre and add mid-scale tufting.** Reference
    `#756224` (R−G +19) vs ours `#606426` (R−G −4). Raise `tuftShade` from chance 0.22 /
    amplitude 0.1 to ~0.45 / ~0.22 and mix an `fbmClump` octave into the grass branch of
    `groundColorFbm`.

---

## 5. Broken things, artefacts and performance

**Console: clean.** 197 messages across both battles, **0 errors** and **0 warnings** other than
a `favicon.ico` 404 and one `willReadFrequently` hint caused by my own instrumentation. No
exceptions, no unhandled rejections. This is a marked improvement.

**No crashes, no stuck units.** An early scare — 12 German teams showing `d = 0.00` over 12 s of
sim time — turned out to be correct behaviour (they had arrived at clamped targets). Re-tested
with long-range orders and all 11 teams moved correctly.

**Confirmed defects**

| # | Defect | Evidence |
|---|---|---|
| 1 | Mortar fire causes no structure damage | 26 `buildingWood` tiles before and after 20 s of sustained fire; 33 craters; no breach/collapse message |
| 2 | Combat messages truncated mid-word, no ellipsis | "has been wounde", "has been destroye", "has been knocked o" — `r5_s6.png`, `r5_overlay_depth.png` |
| 3 | Duplicate message, and team name printed twice | `"PzKw IV F1 / PzKw IV F1 has been knocked out."` twice in a row |
| 4 | Debrief grades a rout as "Minor Defeat" | 40:13 losses, 0/8 victory points → "Minor Defeat" (`r5_debrief.png`) |
| 5 | Vehicles absent from the debrief team list | 8 infantry teams listed, 4 vehicle teams missing; kills sum 5 vs headline 12 |
| 6 | Debrief shows in-battle activity as end-state | "Loading", "Firing" in the status column |
| 7 | Vehicle team status never settles after arrival | Teams 50/57/64 at 0.5–0.6 tiles from target, "Moving" for 60 s+ |
| 8 | "KIA" vs "Destroyed" used inconsistently for the same vehicle class | `r5_overlay_depth.png` team grid |
| 9 | Vision overlay reports "on" while drawing nothing | `r5_overlay_vision.png` (dead team selected), `r5_overlay_vision2.png` (live team, one 70 px arc) |
| 10 | Message index numbers `(35)(36)(37)` in the log | Not present in `1479`; look like debug output |
| 11 | Logo reads `CLOSE ‖ COMBAT` — two bars, should be three | Every screen |
| 12 | Static help line where the original is context-sensitive | Every screen |
| 13 | Two Soviet vehicles occupying the identical tile (143,75) | Vehicle stacking not prevented |
| 14 | Vehicle tracks in snow loop back on themselves | `r5_w_woods.png` at x ≈ 620–700 and x ≈ 250–290 |
| 15 | Soldier monitor shows only the first 4 men (`MAX_ROWS 4`) with no scroll affordance | A 10-man squad shows 4 rows; `1482` has a ▼ chevron |

**Performance — good.** 300 frames of continuous panning at each zoom, frame time in ms:

| zoom | mean | p50 | p95 | max |
|---|---|---|---|---|
| 0.5 | 8.53 | 8.3 | 10.5 | 24.9 |
| 1 | 8.50 | 8.3 | 9.8 | **67.0** |
| 2 | 10.78 | 8.3 | 10.0 | **171.3** |

p50 is pinned at 8.3 ms (display-capped), and p95 stays under 10.5 ms at every zoom — smooth.
The problem is the tail: panning into unbaked terrain produces one-off stalls of 67 ms at zoom 1
and **171 ms at zoom 2**, a visible ~20-frame freeze. `BAKE_BUDGET_MS 10` / `BAKE_BUDGET_COLD_MS
40` in `TerrainRenderer.bakeChunk` is being exceeded by more than 4×; either the budget check is
not preempting mid-chunk or a single 320×320 chunk cannot be split finely enough. With
`MAX_CACHED_CHUNKS_BY_ZOOM {2: 16}` — only 16 chunks at zoom 2 — the cache thrashes as soon as
you pan, so this fires repeatedly rather than once.

**Not reproduced this round:** the round-3 chunk-bake seam (no seam seen in deploy or battle on
either map), and the round-2 flat-green-rectangle bug on Berlin (Berlin Streets was not played
again — still not confirmed fixed).

---

## 6. Round 4 → round 5 ledger

**Improved**

- **Zoom 2 sprite rendering.** Round-4 fix #3 closed. Soldiers, crew weapons and vehicles are
  re-rasterised at scale, not nearest-neighbour upscaled. `r5_zoom2_squad.png`.
- **Craters and foxholes redrawn.** Now the best art in the game; real light, irregular outlines,
  ejecta, brown earth over snow.
- **Winter forest.** Round-4 fix #2 closed for winter: the "bubble wrap" is gone, replaced by bare
  branch stars with long SE shadows mixed with snow conifers. `r5_waypoints.png`.
- **Formations loosened.** Round-4 fix #4 half closed — no parade-ground rows anywhere.
- **Snow has structure.** Round-4 fix #5 half closed: drift banding, wind shading and dead-grass
  speckle are visible where round 4 saw uniform grey.
- **Crew-served weapons are visible and legible**, with set-up / aim / load surfaced in text.
- **Mortar indirect fire works** — walk-in, spotter delay, accumulating craters.
- **The psychology simulation is deep and produces good narrative** in the message log.
- **The depth map is an excellent new tool**; waypoints work; order responsiveness is immediate.
- **Console is clean** and frame time p95 is under 10.5 ms at every zoom.

**Regressed or newly found**

- **Grass hue over-corrected past the reference.** Round 4's advice to "pull back to green" was
  measured against the wrong target: `1479` grass is a brown-olive `#756224`, ours is now a
  yellow-green `#606426`. This is a regression in colour accuracy caused by round-4 fix #1.
- **Road surface flattened** to local contrast 6.1 against the reference's 16.5 — the weakest
  texture in the game where round 3 called it the biggest win.
- **Six new HUD/text defects** not present in round 4: truncated messages, duplicated messages,
  message index numbers, wrong debrief grading, vehicles missing from the debrief, and vehicle
  status stuck on "Moving".
- **171 ms frame stalls at zoom 2** when panning into unbaked chunks.

**Still open from round 4**

- Buildings are still flat boxes (round-4 fix #5, buildings half) — unchanged.
- Soldier uniforms still read as grey smudges at zoom 1, and on winter maps both sides now wear
  the identical `#cacbc4` smock.
- Water and ice still unverified-then-wrong: a flat painted stripe.
- The main menu background is still a flat silhouette against `1477`'s painted portrait.
- The cursor was not re-examined (carried from round 3).

**Net assessment.** Round 4 → round 5 added a great deal of machinery and a little visible
quality. The simulation is now clearly ahead of the renderer: nine mental states, belief sharing,
gun takeover, command latency, cover seeking, indirect fire tiers and a full structure-damage
model are all implemented, and the player can see almost none of it. The fastest route from 7.5
to 8.5 is not more systems — it is connecting the three systems you already have to the screen:
draw mental state on the man, make blast damage reach the buildings, and turn the sound on.

---

## Screenshots referenced

`ref/wf13/` — menus `r5_00_menu.png`, `r5_01_playagame.png`, `r5_02_requisition.png`,
`r5_debrief.png`; summer `r5_03_deploy.png`, `r5_s1..s7.png`, `r5_zoom2_squad.png`,
`r5_zoom2_crop.png`, `r5_monitor.png`, `r5_hud_full.png`, `r5_mortar_hit*.png`,
`r5_bldg_ex*.png`, `r5_building_before/after.png`, `r5_overlay_vision.png`,
`r5_overlay_vision2.png`, `r5_overlay_depth.png`, `r5_overlay_off.png`; winter
`r5_w00_setup.png`, `r5_w01_deploy.png`, `r5_w02_terrain.png`, `r5_w10..w14.png`,
`r5_w_zoom2.png`, `r5_w_woods.png`, `r5_w_ice.png`, `r5_w_depth.png`, `r5_waypoints.png`.

File path for this critique: `docs/critique/round5-battle.md`
