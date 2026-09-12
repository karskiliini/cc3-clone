# Terrain art critique — pass 01

Comparing our rendered terrain (dev server, `tools/mapPreview.html`, zoom 1, TILE_PX=20) against
the original Close Combat III's hand-painted maps (`ref/ref_cc3_1479.png`, `_1481`–`_1485.png`).

Screenshots taken this session, referenced below:
- `ref/crit_terrain_border.png` / `_thumb.png` — Border Crossing, summer
- `ref/crit_terrain_village.png` / `_thumb.png` — Ukrainian Village, autumn
- `ref/crit_terrain_steppe.png` / `_thumb.png` — Kursk Steppe, summer
- `ref/crit_terrain_forest.png` / `_thumb.png` — Belarus Forest, summer
- `ref/crit_terrain_berlin.png` / `_thumb.png` — Berlin Streets, winter
- `ref/crit_crop_roadjunction.png`, `crit_crop_fieldedge.png`, `crit_crop_building.png`,
  `crit_crop_river.png`, `crit_crop_berlin_ruin.png`, `crit_zoom_grassdots.png` — 2×–8× crops
- `ref/crit_trees_summer.png`, `crit_trees_winter.png` — the `getTreeSprite` asset sheet

Overall verdict: **the game is currently much greener/flatter/emptier than the original**, which
reads as thick, glossy, textile-like paint with strong directional grain (wheat, roof planking,
tree canopy) and hard local contrast around every man-made object. Ours has decent large-scale
brushed mottling (the fbm ground pass is a real win — it beats a flat-fill look) but is let down by
(a) a scattering bug that litters grass with black squares, (b) tile-grid features (crops/mud/
rubble) with hard staircase edges where the original is all soft irregular blobs, and (c) buildings/
rubble that don't yet read as 3D structures/debris.

---

## 1. Per-feature critique

### Open ground / grass texture
**Verdict: Good, close to 1:1.** `groundColorFbm` (terrainRender.ts) gives grass a genuine two-band
mottled brush look (`ref/crit_zoom_grassdots.png` background, `crit_crop_fieldedge.png`) that's a
believable match for ref_cc3_1479's meadow. Colour is a little flat/uniform-hue compared to the
original, which has more yellow-green vs blue-green variance and occasional brighter sunlit
patches; current summer `grass` ramp is `#4f5e2b → #8d9a56` (palette.ts/terrainRender.ts
`LOCAL_RAMPS.summer.grass`) — all mid-value olive, no bright highlight stop. Add a 5th ramp stop
around `#a8b06a` for sunlit crests and let `reliefFactor` push more pixels into it.

### Fields / crops
**Verdict: Needs work.** Where crops are actually painted with the crop stripe logic
(`paintGroundAndFeatures`, the `covCrop > 0.5` block) the wheat striping reads reasonably (see the
small wheat wedge in `crit_terrain_steppe.png`), but the *macro shape* of every crops/mud/tallgrass
patch is a hard, tile-stepped silhouette — see `crit_crop_fieldedge.png` and `crit_crop_river.png`:
the mud patch boundary is a literal staircase of ~1-2 tile (20–40px) steps, not the soft amoeba
edges of ref_cc3_1479's wheat field (which has a feathered, almost airbrushed edge several pixels
wide with no straight run longer than a couple of pixels). The pixel-level blend in
`paintGroundAndFeatures` only feathers ~6px around whatever silhouette `buildGrid`/`sampleGrid`
already committed to — it never reshapes the underlying tile-grid silhouette that `MapPainter.patch`
/`.field` stamped in `src/data/maps/*.ts`. Roads and rivers don't have this problem because they use
the vector distance-field path (`buildAreaField`/`sampleVecArea`) instead of tile-grid coverage.

### Dirt roads
**Verdict: Good.** `crit_crop_roadjunction.png` is close to `ref_cc3_1479`'s cart track: worn
double-rut band, faint centre line, soft wandering shoulder via `sampleVecArea`'s fbm wobble. Minor
gap: the original's ruts are darker/more contrasty and show individual wheel-track breaks/puddles;
ours (`covDirt`'s `rutBand` logic, terrainRender.ts ~L445) is a bit too regular/thin.

### Paved roads
**Verdict: Needs work.** Berlin's road (`crit_terrain_berlin.png`, `crit_crop_berlin_ruin.png`) is a
flat grey band with occasional 2px crack speckle — no cobblestone or slab joints, no curb stones, no
tram rail marks (there's a `tramwire` decor kind that draws nothing — `decorSprites.ts` `build()`
case `'tramwire': return createCanvas(1,1)`, i.e. intentionally invisible, so overhead wires exist in
data but nothing shows on the road itself). Original CC3 Berlin streets show visible sett/cobble
texture and gutter lines.

### Buildings (roofs, shadows, walls)
**Verdict: Needs work.** `crit_crop_building.png`: roofs have plausible plank/tile ridge shading
(`paintRoof`, terrainRender.ts) and a soft drop shadow, but **there is no wall at all** — the roof
rectangle sits directly on grass with nothing between roof edge and ground texture, so buildings read
as flat coloured cards, not volumes. The original (`ref_cc3_1479`, "Pavlov's House") shows a visible
wall/base course distinct from the roof, plus small outbuildings and a name label. `paintEaveNotches`
draws 1×2px "window" ticks that are too small to register at this scale (invisible in the crop).
Also every non-`big` building picks its shingle colour from just 3 (wood) or 2 (stone) hardcoded
variants (`WOOD_ROOF_VARIANTS`, `STONE_ROOF_VARIANTS`) — visibly repeats across a village.

### Woods and single trees (canopy, shadow)
**Verdict: Needs work — and one clear bug.** The tree *asset* itself (`getTreeSprite`, viewed at
`ref/crit_trees_summer.png`) is a decent round blobby canopy cluster, a fair match for
ref_cc3_1479's tree clumps. But for **winter** maps, `paintTrees()` in terrainRender.ts does *not*
use `getTreeSprite('winter', …)` — it calls a completely different function, `paintScrubTree`
(a sparse brown starburst of thin lines), even though `sprites.ts` already has a proper round
snow-covered canopy sprite (see `ref/crit_trees_winter.png`: solid brown/olive cauliflower clumps
with white snow flecks — a close match to `ref_cc3_1482`'s dense winter forest). The in-game winter
result (thin spiky twigs, no shadow, no mass) looks nothing like `ref_cc3_1482`'s or `ref_cc3_1485`'s
dense round snow-crusted tree clumps. This is a straightforward "use the sprite you already have"
fix. Also couldn't get an in-viewport screenshot of a live "woods" tile mass at native res because
`tools/mapPreview.html` always centers the camera on the map midpoint and every map's forest/copse
areas happen to sit off-centre — recommend adding an optional `?cx=&cy=` camera override to
`tools/mapPreview.ts` for future art passes (not required for gameplay, dev-tool only).

### Hedges / fences / stone walls / trenches
**Verdict: Good.** The vector-stroked versions (`paintLineVector`) are smooth, continuous, and
readable; hedges have a plausible dark-outline + light-top-bump read. Not visible in this session's
crops (none of the 5 default camera centres pass through one) but code review shows a sound design
consistent with the roads/river quality bar.

### Water / river / bridge
**Verdict: Good, best-in-class feature.** `crit_crop_river.png` is close to `ref_cc3_1482`/`_1484`'s
river: banded blue-grey with a lighter bank highlight, smooth wandering edge (again thanks to the
vector distance-field path). No complaints beyond matching the wear seen elsewhere (see fixlist #7
re: unifying crops/mud to this same technique).

### Craters
**Verdict: Needs work.** `paintCraterAt`'s radial gradient (dark centre → rim colour, soft NW
highlight/SE shadow ellipses) is tonally close to `ref_cc3_1479`/`_1481`'s craters, but originals
have visible splash/spoil rays radiating a tile or two beyond the rim and sometimes grass regrowth
at the lip; ours is a clean, isolated disc with a jagged-polygon outline and nothing outside it. Not
seen directly in this session's screenshots (no crater fell inside a default camera view) — assessed
from source and the reference set.

### Rubble / ruins
**Verdict: Wrong.** `crit_crop_berlin_ruin.png` reads as a **pink-speckled stain on the pavement**,
not a demolished building. The `covRubble > 0.5` block (terrainRender.ts) only tints pixels toward
either a brick-red fleck (`#8a4a3a`, 4% of area) or grey fleck (`#746f68`, 4%) over a shaded rubble
base — there is no debris silhouette (no broken wall stub, no scattered masonry blocks with their
own cast shadow, no scorch/soot). Close Combat's ruins are recognisable structures-in-collapse
(angled wall remnants, visible floor slab, dark interior). This is the single worst-scoring feature
against the original and needs an actual sprite/shape pass, not just a colour-noise tweak.

### Snow
**Verdict: Good.** `crit_terrain_berlin.png`/village winter thumb show a clean, slightly blue-white
mottled snow that's a fair match for `ref_cc3_1482`–`_1485`. `dirty snow near roads` blending
(`covDirty` in `paintGroundAndFeatures`) is a nice touch the original doesn't obviously need to fake
since it's painted by hand.

### Decor (haystacks, wells, carts, poles, bushes, etc.)
**Verdict: Wrong for `bush`; Needs work for the rest.** See the black-square finding below — `bush`
is the dominant decor kind by count and is currently a rendering bug. The other decor sprites
(`buildHaystack`, `buildWell`, `buildCart`, `buildPole`, etc. in decorSprites.ts) are tiny (3–8px)
flat-shaded silhouettes; reasonable as thumbnail-scale abstractions but noticeably cruder than the
original's haystacks/wells/carts, which have visible volume, shading and (for carts/wells) a couple
of colour materials. Low priority relative to the bush bug and rubble.

### Overall colour / tone / contrast vs. the original
**Verdict: Needs work.** The original is warmer and higher-contrast: darker tree/hedge shadows,
brighter crop yellows (`#d9c465`-ish golds already close, good), and a generally "thicker paint"
look from stronger local value contrast per feature (a road reads clearly darker than the grass next
to it, a roof clearly darker than its own wall). Ours currently has roughly correct hue but ~10–15%
too little value contrast between adjacent feature types outside of roads/rivers, which is why the
mud/crops/rubble patches (weak contrast + soft-but-blocky edges) read as "dirty green" rather than
distinct field/rubble.

### Map composition (density, realism of layouts)
**Verdict: Needs work.** Layouts in `src/data/maps/*.ts` (border_1941, village_1942, steppe_1943,
forest_1944, berlin_1945) are sensible at the macro scale (roads connecting, fields clustered, woods
massed in blobs per the "several overlapping blobs" comment in forest_1944.ts) — this part is fine
and doesn't need redesign. The problem is entirely in how `terrainRender.ts` rasterizes those shapes
(see fields/crops/rubble above) and in decor density (`scatterDecor('bush', …, 20–24, …)` per map
*plus* an uncapped 2%-per-tile chance from `paintTrees()` on every plain grass tile — the latter is
the dominant source and is not comparable to anything in the original at all).

---

## 2. What are the small black squares on the grass?

**They are `bush` decor** (`decorSprites.ts` → `buildBush()`), not tufts, not a rendering artifact
in the antialiasing sense — but they are a real bug in effect. `buildBush()` draws two dark-green
ellipses (`#2c3d22` base, `#405c30` highlight) on a 5×5 transparent canvas; `drawDecorItem()` then
stamps an opaque `rgba(10,8,6,0.4)` drop shadow **the full size of the sprite's bounding box**,
offset by only 1px, *before* drawing the bush on top. At the on-screen scale we're rendering at
(zoom 1, ≈5×5 screen px), the dark bush fill and its near-black offset shadow merge into one
indistinguishable near-black square (confirmed via a 8× pixel-exact crop, `crit_zoom_grassdots.png`
— a single flat blackish-green square, no visible leaf/highlight structure at all). **The original
does not have this** — `ref_cc3_1479`'s open grass has zero small foreground clutter; its only
"texture" is the paint mottling itself and occasional visible larger objects (trees, hedgerows,
craters). This is a straight defect to fix, not a stylistic difference.

Two independent sources feed it: `scatterDecor('bush', …, 20, …)` (one call per map, ~20 instances)
and, far more numerous, the per-tile roll in `paintTrees()`:
```
} else if (t === 'grass' || t === 'hedge') {
  if (hash2(wx, wy, seed + 141) < 0.02) {
    drawDecorItem(ctx, 'bush', ox + TILE_PX / 2, oy + TILE_PX / 2);
  }
}
```
At 2% per grass tile this produces one bush roughly every 7×7 tiles map-wide — hundreds per map —
which is exactly the dot density seen scattered edge-to-edge across every summer/autumn screenshot.

---

## 3. Ranked TOP 12 fix list (executable instructions)

1. **Kill the black-square bushes.** In `src/render/decorSprites.ts`, rewrite `buildBush()` to use
   lighter, higher-contrast colours (e.g. base `#5a7a3c`, highlight `#7fa356`, plus a small
   near-white rim-light fleck) and make the canvas big enough (8×8, not 5×5) that the ellipses don't
   nearly fill the whole bounding box the shadow is stamped from — leave at least 1–2px of
   transparent margin so the shadow doesn't visually fuse with the fill. In `drawDecorItem()`, also
   consider drawing the shadow as an ellipse matching the sprite's silhouette instead of a
   full-bbox `fillRect`, so partially-transparent sprites (bush, flowers, rocks) don't get a square
   shadow poking out past their rounded shape.

2. **Cut bush density drastically.** In `src/render/terrainRender.ts` `paintTrees()`, drop the
   per-tile grass/hedge bush roll from `< 0.02` to `< 0.002` (10× fewer) or remove it entirely and
   rely solely on each map's explicit `scatterDecor('bush', …)` call, which already gives ~20
   deliberately-placed bushes per map — matching the original's sparse, intentional-looking
   placement instead of a uniform per-tile roll.

3. **Fix winter trees to use the existing round canopy sprite.** In `paintTrees()`
   (terrainRender.ts), replace the `season === 'winter'` branch's call to `paintScrubTree(...)`
   with `getTreeSprite(variant, 'winter')` (same code path already used for summer/autumn), so
   winter woods/scattered-trees render as the dense round snow-crusted clumps already built in
   `src/render/sprites.ts` (see `ref/crit_trees_winter.png`) instead of thin spiky twigs. Keep
   `paintTreeShadow` for the drop shadow, matching the non-winter branch. Either delete
   `paintScrubTree` or repurpose it for something else (e.g. isolated dead bushes in `fence`/`open`
   winter tiles) rather than the main tree render path.

4. **Rebuild rubble/ruins as actual debris shapes, not a colour stain.** In `paintGroundAndFeatures`'s
   `covRubble > 0.5` block (terrainRender.ts), stop relying purely on per-pixel fleck colour. Add a
   post-pass (in the chunk-level "detail" loop, alongside `paintDetail`'s `case 'rubble'` — currently
   missing; rubble falls through to `default: paintGroundTexture`, which does nothing for rubble) that
   draws 2–4 randomly rotated dark grey/brick rectangular "wall fragment" blocks with a 1px highlight
   edge and offset drop shadow per rubble tile cluster, similar in spirit to `paintRoofWeathering`'s
   scatter technique but with bigger (4–10px) shapes and real shadows. This is the single biggest
   fidelity gap versus the reference set.

5. **Give buildings a visible wall/base course.** In `paintRoof` (terrainRender.ts), before/around
   the roof fill, draw a 1–2px "wall" band in a distinctly darker/greyer tone along the footprint
   edge that isn't already covered by the shadow, so the building silhouette reads as roof-over-wall
   rather than roof-over-grass. Increase the eave notch size in `paintEaveNotches` (currently a 1×2px
   `rgba(224,214,164,0.7)` tick) to at least 2×3px so windows actually register at zoom 1.

6. **Smooth the crops/mud/rubble tile-grid silhouette, not just its colour edge.** These three
   terrains are the only "area" features still driven by `buildGrid`/`sampleGrid` boolean
   classification (roads and rivers already upgraded to the vector distance-field path via
   `buildAreaField`/`sampleVecArea`). Either (a) pre-blur the classify grid in `buildGrid` with a
   cheap 3×3 box filter before bilinear sampling so the underlying silhouette itself loses its
   tile-step corners, or (b) migrate `crops`/`mud`/`rubble` patches in `src/data/maps/*.ts` to also
   be authored as `vectors` (polygon/area kind) so they get the same smooth-wobble treatment roads
   get. Visible proof of the current defect: `ref/crit_crop_fieldedge.png` and
   `ref/crit_crop_river.png` (mud patch has a hard staircase edge next to a buttery-smooth river
   edge two tiles away).

7. **Add a highlight stop to the grass/open ramps.** In `LOCAL_RAMPS.summer`/`.autumn` (
   terrainRender.ts), extend `grass`/`open` from 4 stops to 5, adding a bright sunlit top stop
   (~`#a8b06a` summer, ~`#b8a850` autumn) and biasing `reliefFactor`/`groundColorFbm`'s `tt` term
   slightly so more of the NW-facing high ground reaches it. This directly targets the "too flat/
   uniform-hue" contrast gap versus `ref_cc3_1479`.

8. **Texture the paved road.** In the `covPaved > 0.5` block (terrainRender.ts), add a cobble/sett
   pattern (small brightness-varying cells every 3–4px, similar to the existing crack-block logic)
   and a 1–2px darker gutter line at both edges (the existing `nearEdge` kerb darkening is a start
   but reads as a soft vignette, not a curb). Wire the already-defined-but-invisible `tramwire` decor
   kind (`decorSprites.ts`) to actually draw an overhead wire silhouette or rail line, or remove it
   from the Berlin map's decor list if it's not meant to render.

9. **Vary building roof colour more per structure.** In terrainRender.ts, widen
   `WOOD_ROOF_VARIANTS`/`STONE_ROOF_VARIANTS` from 3/2 entries to 5–6, and derive the variant index
   from a per-building hash instead of `bb.id % variants.length` if `id` assignment is sequential in
   scan order (adjacent buildings can currently land on the same modulo bucket).

10. **Add splash/spoil texture to craters.** In `paintCraterAt` (terrainRender.ts), after the radial
    gradient fill, stroke 4–6 short dark radiating dashes just outside the rim (`r*1.0`–`r*1.4`) at
    random angles, and occasionally (10–15% via hash) blend a thin grass-tinted ring at the very
    outer edge to suggest partial regrowth, matching the "splash ray" look in `ref_cc3_1479`/`_1481`.

11. **Differentiate dirt-road ruts more.** In the `covDirt > 0.5` block, increase the rut darkening
    amount (`shade(rc, -0.1)` → `-0.18`) and break the rut bands with occasional small puddle-fleck
    blends (reuse the `buildPuddle` colour) every ~40–60px along the vector, matching
    `ref_cc3_1479`'s visibly wetter, higher-contrast wheel ruts.

12. **Give `tools/mapPreview.ts` a camera override** (`?cx=&cy=` query params feeding into
    `centerCamera`) so future art QA passes can actually screenshot a map's woods mass, hedgerow, and
    farmstead cluster instead of whatever happens to sit at the exact map centre. Not a rendering
    fix, but it blocked a full crop set this session (no "woods edge"/"single tree in situ"/
    "hedge" screenshot was obtainable from any of the 5 default camera positions).

---

## 4. Broken / artefacts

- **Hard staircase (tile-grid) edges on crops/mud/rubble patches** — see fix #6. Confirmed visually
  in `crit_crop_fieldedge.png` and `crit_crop_river.png`: a mud patch boundary steps in ~20–40px
  right-angle jogs immediately next to a smoothly wobbling river edge from the same chunk bake.
- **Black-square bush decor bug** — see section 2 and fix #1/#2. Confirmed via pixel-exact 8× crop
  (`crit_zoom_grassdots.png`): the bush sprite and its shadow are visually indistinguishable, both
  reading as one flat near-black square, present on essentially every summer/autumn screenshot taken
  this session.
- **Dead code path / unused asset**: `getTreeSprite(v, 'winter')` (a good round snow-canopy sprite,
  `ref/crit_trees_winter.png`) is built and cached but never drawn by `terrainRender.ts` — winter
  woods use `paintScrubTree` instead (fix #3). Worth confirming there isn't a second unused branch
  elsewhere before deleting one of the two implementations.
- **`tramwire` decor kind renders nothing** (`decorSprites.ts`: `case 'tramwire': return
  createCanvas(1,1)`), referenced from Berlin's map data presumably expecting a visible wire/rail —
  silently invisible today (fix #8).
- **No missing chunks / no low-res fallback seen** in any of the 5 map screenshots — `mapPreview.ts`
  forces 40 redraw passes specifically to avoid this, and it worked; did not reproduce the
  scrolling-fallback path in this session (would need the actual game view mid-pan to test that,
  which was out of scope here).
- **No visible seams between chunks** in the 5 full-viewport screenshots — the fbm noise is sampled
  in continuous world-pixel space as designed, so chunk boundaries (every 320px) were not detectable
  by eye in `crit_terrain_border.png`/`_steppe.png`/`_forest.png`.
- Building crop (`crit_crop_building.png`) shows a single 1×1px tinted pixel with no clear origin
  near the top of the frame between the two roofs — likely a lone `flowers`/decor pixel or a stray
  eave-notch tick; too small to diagnose further from a screenshot, flagging in case it's a symptom
  of the same shadow/sprite-size mismatch as the bush bug.

File paths referenced throughout: `src/render/terrainRender.ts`, `src/render/decorSprites.ts`,
`src/render/sprites.ts`, `src/render/palette.ts`, `src/data/maps/{border_1941,village_1942,
steppe_1943,forest_1944,berlin_1945}.ts`, `tools/mapPreview.ts`, `tools/spritePreview.ts`.
