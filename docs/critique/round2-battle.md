# Round 2 Battle Critique — Whole-Screen Likeness Review

Reviewed against `ref/ref_cc3_1479.png` (summer, Pavlov's House), `ref_cc3_1482.png`/`ref_cc3_1484.png`/`ref_cc3_1485.png`/`ref_cc3_1483.png` (winter, forest + village fighting), with round-1 critiques already applied. New screenshots captured this session live at `ref/crit2_summer_*.png` and `ref/crit2_winter_*.png` (dev server, summer Border Crossing map and winter Berlin Streets map, default zoom + one zoom-in + one zoom-out step, with units actually moving/fighting).

No source was edited for this review.

---

## 1. Overall likeness score: **5.5 / 10**

At a glance, a screenshot of ours reads as "a top-down WW2 tactics game with a CC3-style HUD," and the bottom panel is now close enough in layout and color that a fast glance recognizes the genre. But it does **not** read as *the same game* the instant you look at the actual battlefield (the 80% of the screen that matters most). The three things that most break the illusion:

1. **The terrain is a soft-focus color wash, not a painted map.** Reference terrain has crisp local texture at every scale — individual wheat-stalk brush-strokes in fields, distinct dirt-rut lines in roads, a hard tonal edge where a field meets grass. Ours (`crit2_summer_00.png`, `crit2_summer_zoomin.png`) is dominated by large, blurry noise blobs; roads are drawn as a single 1–2px hairline instead of a filled band with a visible surface; and there is no hard-edged field/grass boundary anywhere in the captured shots — the whole ground reads like a slightly-varied flat color rather than farmland.
2. **Soldiers and vehicles are illegible at both play zoom levels.** In every summer/winter capture, infantry are 3–5px grey-green smudges with no readable helmet, weapon, or facing, and vehicles are flat grey boxes with only a faint tread hint — versus the reference's small but crisp green figures (visible rifle line, helmet highlight) and shaded 3/4-lit tanks with a distinct gun barrel and hull highlight. At the default zoom this is the single biggest "this isn't CC3" tell, because reading unit disposition at a glance is the core of the genre.
3. **The urban/winter map lacks CC3's structural density and has a glaring rendering artifact.** The reference winter shots are dense with distinct tree canopies, snow-loaded branches, cabins with visible roofs/walls, and rubble that reads as broken masonry. Our Berlin Streets capture (`crit2_winter_00.png`) shows an empty, flat grey street grid, rubble that reads as a soft pink/red paint spatter rather than debris, and — worth flagging as a straight bug — a hard-edged, flat olive-green rectangular block with a sharp black border sitting on the right edge of the viewport with no relationship to any terrain the map data defines (see §4).

The HUD chrome (team grid, soldier monitor, combat messages, minimap, Anti-Pers/Anti-Tank bars) is the strongest area and is genuinely close to the original in layout, color, and information density — that part of round 1's work held up well. The battlefield rendering is what still gives it away.

---

## 2. Per-area verdicts

### Terrain — ground (open/grass)
**Verdict: Needs work.** File: `src/render/terrainRender.ts` (`groundColorFbm`, `TERRAIN_COLORS`/`LOCAL_RAMPS` in `src/render/palette.ts` + local ramps at top of `terrainRender.ts`).
- Summer `grass` ramp is `['#4f5e2b','#66743a','#7a8748','#8d9a56','#a8b06a']` (local ramp) — reasonable hues, but the fbm noise field (`fbm`/`fbm64` in `src/render/noise.ts`) that selects the ramp position has too large/soft a spatial frequency: in `crit2_summer_00.png` the grass field north of the road is one continuous diagonal color gradient across ~700px with no fine-grained "clump" texture at all. Reference grass (`ref_cc3_1479.png`) has visible mottling at a ~4–8px grain even from altitude.
- Fix: add a second, higher-frequency fbm octave (or run `fbm14`, which already exists and appears unused for ground) mixed at low amplitude into `groundColorFbm` so grass reads as clumpy rather than airbrushed. Also increase local contrast — the current ramp's max-min delta per channel is small (`#4f5e2b`→`#a8b06a` is only really 2 "tiers" apart pixel-to-pixel because of the wide fbm wavelength).

### Terrain — fields (crops)
**Verdict: Missing / not visible.** The `CROPS_RAMP` (`#8f7d3a…#d9c465`) exists and matches the reference's gold wheat hue well, but none of the 6 summer captures show a crops patch large enough to judge texture (the Border Crossing map's move destinations kept units on grass/road). Round-1 critique flagged field texture; can't confirm the fix from this session's captures — needs its own targeted screenshot with camera panned to a crops tile. Treat as **unverified**, not passed.

### Terrain — roads
**Verdict: Wrong today — needs a fix.** File: `src/render/terrainRender.ts`, `buildAreaField`/`sampleVecArea` + `ROAD_RAMP`/`PAVED_RAMP`.
- In every summer capture the road that crosses the middle of the map (the one from the reference's "along the stream" road in `ref_cc3_1479.png`) renders as a **single dark hairline** (`crit2_summer_00.png`, the diagonal near y≈330–420) rather than a filled band with visible width and rut texture. The reference road is a broad (~15–20px at that zoom) tan band with visible tire-track striations and soft edges into the grass.
- In the winter Berlin map the paved streets (`ROAD_RAMP`/`PAVED_RAMP` via `p.road(...,5,'pavedroad')` in `src/data/maps/berlin_1945.ts`) DO render as a wide band, but the texture inside the band is a diagonal-hatch/corduroy pattern (visible in `crit2_winter_00.png`) that reads more like a knitted fabric than asphalt with tire tracks or snow drift. Compare to the thin, naturalistic snow-edged road in `ref_cc3_1484.png`.
- Fix: for the "thin road" case, check why `sampleVecArea`'s coverage falls off so fast off the vector's centerline for the Border Crossing map's road definition (likely a `width` parameter passed too small, or halved incorrectly, in whatever calls `p.road(...)` for `border_1941.ts`) — grep confirms `border_1941.ts` exists at `src/data/maps/border_1941.ts`, check its `p.road(...)` width argument against `berlin_1945.ts`'s `5`.
- For the hatch texture, reduce the directional noise frequency used for dirt-track striations so it doesn't read as a regular diagonal weave.

### Terrain — buildings
**Verdict: Present but flat.** `buildingStone`/`buildingWood` ramps exist (`#5b5b60…`, `#6b4b2e…`) and the Berlin map's `p.block`/`p.building`/`p.ruin` calls place plenty of structures, but none were visible within the captured viewport this session (camera stayed centered on the Soviet deploy zone near open streets). Cannot fully verify roof/wall rendering quality this round — flag for a targeted re-shot centered on `x:48,y:8` (first `p.block` in `berlin_1945.ts`).

### Terrain — trees
**Verdict: Weak — trees don't read as trees at battle zoom.** File: `src/render/decorSprites.ts` (`getTreeSprite`), used from `terrainRender.ts`. In `crit2_summer_zoomout2.png` and `crit2_summer_00.png` there is exactly one visible tree near "Pavlov's House"-equivalent terrain, rendered as a small dark-green disc with almost no internal shading — versus the reference's trees, which have a lit NW canopy edge, a darker core, and enough size (~40–50px at that zoom) to be an obvious landmark. Reference winter shots (`ref_cc3_1482.png`) are dominated by dozens of snow-capped round bushes/trees that give the map most of its visual character; our Berlin Streets capture has zero trees visible in the played area (city map, so may be correct — but the summer map is clearly under-treed compared to `ref_cc3_1479.png`'s dense tree line along the bottom-right).
- Fix: increase tree density/scatter radius in `border_1941.ts`'s decor scatter calls, and add a brighter highlight ring to `getTreeSprite` in `decorSprites.ts` to make individual trees pop against the grass ramp.

### Terrain — water
**Verdict: Unverified.** `WATER_RAMP`/`ICE_RAMP` exist and look plausible on paper (`#3c5566…#6a8698` summer, `#b8c4cc…#d6dee4` ice), but no water tile appeared in any of this session's captures. Not scored.

### Soldiers
**Verdict: Fails the "read at a glance" test.** File: `src/render/soldierArt.ts` (hand-authored grids), `src/render/unitRender.ts` (`drawSoldiers`).
- At `zoom=1` (`TILE_PX=20`, 10px/m), soldiers in every capture are indistinct 4–6px blobs with no visible weapon line, no clear green-vs-feldgrau side differentiation, and stance/facing is unreadable without the selection ring. Compare `crit2_summer_zoomin.png` (three loose German riflemen north of the road) to `ref_cc3_1479.png`'s squad clusters near Pavlov's House, which are small but unmistakably soldier-shaped with visible helmet dot and weapon diagonal even at the same on-screen scale.
- Likely cause: `soldierArt.ts`'s color palette (`BOOT #2a2620`, `WEAPON #2b2b28`, `SKIN #c9a37c`, and presumably a uniform color further down the file) is too close in luminance to the ground ramp's mid tones, so the sprite blends into the grass instead of popping. The reference uses a much higher-contrast, more saturated uniform green/feldgrau that reads against any ground color.
- Fix: bump uniform saturation/value in `soldierArt.ts`'s palette constants, and add a 1px dark outline (already used for the HUD's outlined VL labels, `drawOutlinedLabel` in `unitRender.ts`) around the soldier silhouette so it separates from noisy ground texture at all zoom levels.

### Vehicles
**Verdict: Readable shape, no material read.** File: `src/render/vehicleArt.ts`.
- Silhouettes are correctly proportioned (tracks, hull, turret barrel all present per the file's own comments) but in every capture (`crit2_summer_00.png`, `_zoomin.png`) tanks render as nearly flat mid-grey with only a faint tread line — no NW-lit highlight edge, no shadow gradient on the hull deck despite the file's stated intent ("NW lighting and a soft SE cast shadow"). Reference tanks (`ref_cc3_1484.png`, `ref_cc3_1485.png`) have a visible lit top face vs. shadowed side, giving them volume.
- Fix: verify the `darken()` calls (`src/render/pixelUtil.ts`) are actually being applied per-facet in the hull-family builders in `vehicleArt.ts` — the flatness suggests the shading step is either being skipped or washed out at render scale.

### Effects (tracers/muzzle flash/explosions/smoke)
**Verdict: Not exercised this session — spot-check needed.** `src/render/effects.ts` has plausible tracer/flash/explosion color constants (`#ffe08a` tracer, `#ff9a3c` flash, `#5a1c10`→`#ff8a3c`→`#fff2c0` fire gradient) that look right on paper, but none of this session's captures caught an active firefight with visible tracers (AI mostly moved/assisted rather than fired in the captured windows). Re-verify visually in a follow-up pass; not scored.

### HUD panel (bottom strip / team grid)
**Verdict: Good — closest match to the original.** Files: `src/ui/hud/bottomStrip.ts`, `src/ui/hud/teamGrid.ts`, `src/ui/hud/hudChrome.ts`.
- Layout constants (`GRID_X/Y`, `BOX_W=123`/`BOX_H=31`, `AP_BAR`/`AT_BAR` at y=732/749, right-hand `RIGHT_BTN` at x=585) line up closely with the reference's bottom panel proportions in every capture. Colors (`HUD.face`/`bevelLight`/`bevelDark`, team-status word colors) read correctly: green "Ambushing"/"Idle", yellow "Pinned", red "Panicked"/dead states all match reference behavior in `crit2_winter_engage_10.png` ("Panicked" MG34 HMG row, red bar) and `crit2_summer_zoomin2.png` (dead-soldier red rows in the soldier monitor).
- Minor: the reference's team-grid icons are small painted portraits (rifle squad icon shows visible soldier silhouettes); ours (`tintedTeamIcon` in `hudChrome.ts`) uses a flat 55%-alpha color tint over a generic icon — serviceable but noticeably flatter/more abstract than the reference's icons. Low priority.

### Soldier monitor
**Verdict: Good structurally, text-heavy vs. reference.** File: `src/ui/hud/soldierMonitor.ts`. Row layout (name/role/health line 1, activity/weapon-glyph/ammo line 2), colors (`HUD.green` healthy, `HUD.yellow` wounded, `HUD.red` dead/incap) all match the reference's soldier monitor behavior seen in `ref_cc3_1482.png`/`ref_cc3_1484.png` (dead soldiers red, "Healthy" green). This is one of the more faithful panels. No changes recommended beyond the icon-tint note above (shared code path).

### Messages (Combat Messages column)
**Verdict: Good.** File: `src/ui/hud/combatMessages.ts`. In `crit2_summer_zoomin2.png` and `crit2_winter_20.png`, message coloring (yellow "warn", red "bad"/KIA, green default) and the "Report (#)" numbering match the reference's message log style well (`ref_cc3_1483.png` shows the same "Report / Strategic Fire lost target." pattern). No action needed.

### Inset map (minimap)
**Verdict: Close but under-detailed.** File: `src/ui/hud/minimap.ts`. Structurally correct (168×118 rect at (0,512), yellow viewport rectangle, VL crosshair marks, blue-friendly/red-spotted dots) — matches reference minimap behavior. The thumbnail itself (`terrain.thumbnail(164,114)`) reads much flatter/blobbier than the reference's minimap, which shows visible field/road patterns even at thumbnail scale; ours is close to solid color per screenshot. This inherits directly from the "ground is a soft blur" issue above, so fixing terrain texture should fix this for free.

### VL flags / labels
**Verdict: Functionally present, never observed in capture.** `src/render/unitRender.ts`'s `drawFlags`/`drawOutlinedLabel` (bold white text, 1px black outline, 1.6x-scaled flag sprite) looks correct in code and matches the reference's outlined-label style (e.g. "to Smolensk" in `ref_cc3_1484.png`), and we did see place-name labels ("North Farm", "South Farm", "Orchard", "Crossroad") render correctly in `crit2_summer_zoomout2.png` with the right outlined-white-on-black look. No VL flag sprite itself was in frame this session — labels look right, flags unverified.

### Cursor
**Verdict: Acceptable but generic.** File: `src/render/cursor.ts` + `buildCursor` in `src/render/sprites.ts`. The default arrow is a plain white-fill/black-outline 11px arrow (`#f0f0ec` fill) — functionally fine, but CC3's actual cursor has more character (a small stylized reticle/hand with the game's gold accent). Low priority; not a likeness-breaker since cursors are rarely what a player compares against reference screenshots.

### Fonts
**Verdict: Good.** `src/ui/hud/hudChrome.ts`'s `setHudFont` uses bold Arial/Helvetica at 9–13px for HUD text, which reads close to the reference's blocky sans-serif HUD labels. The main-menu font (`crit2_summer_00.png`'s "CLOSE COMBAT" / "Play A Game" state, seen when the dev server reloaded to menu) is a bold condensed sans that's a reasonable stand-in for the original's stencil-style logo type, though the original's title uses a more military-stencil face — cosmetic, not urgent.

---

## 3. Top 15 ranked fixes (by impact on overall likeness)

1. **Add fine-grain noise texture to ground rendering** (`groundColorFbm` in `src/render/terrainRender.ts`) — the single biggest fix; the "soft blur" look undermines every other area including the minimap.
2. **Increase soldier sprite contrast/outline** (`src/render/soldierArt.ts` palette + a 1px silhouette outline in `src/render/unitRender.ts`'s `drawSoldiers`) — units are currently the hardest thing to read on the battlefield.
3. **Widen/texture the thin hairline road on Border Crossing** — check `p.road(...)` width argument in `src/data/maps/border_1941.ts` against `berlin_1945.ts`'s working example.
4. **Add hull/turret shading (NW highlight + SE shadow) to vehicles** in `src/render/vehicleArt.ts` — code comments claim this exists; visually it does not read.
5. **Investigate and fix the flat green rectangular artifact** on the winter Berlin Streets map at the right edge of the viewport (see §4) — this is an outright visual bug, not a style gap.
6. **Fix the diagonal-hatch/corduroy texture on paved roads** (winter) — replace with a more naturalistic asphalt/snow-track noise pattern in the `pavedroad` branch of `terrainRender.ts`.
7. **Increase tree density and add canopy highlight/shadow** in `src/render/decorSprites.ts`'s `getTreeSprite`, plus denser scatter calls in `border_1941.ts`.
8. **Verify/fix rubble rendering** on Berlin Streets — currently a soft pink/red splatter (`rubble` ramp `#7a7670…#8a5a52`) rather than debris chunks; needs harder-edged, higher-contrast rubble texture.
9. **Re-check crops/field texture** with a targeted screenshot (unverified this round) — confirm round-1's field fix actually shows striated wheat rows at battle zoom, not just a flat gold tint.
10. **Improve team-grid icon fidelity** (`tintedTeamIcon` in `src/ui/hud/hudChrome.ts`) — flat color-tint icons read more abstract than the reference's small painted unit portraits.
11. **Confirm effects (tracers/muzzle flash) actually fire visibly** during real combat — colors look right in `src/render/effects.ts` but were never confirmed on-screen this session; re-shot with sustained fire needed.
12. **Building/roof rendering spot-check** — never came into frame this session; confirm `buildingStone`/`buildingWood` ramps read as structures, not flat color blocks, especially given finding #5.
13. **Water tile spot-check** — unverified this round; confirm `WATER_RAMP`/`ICE_RAMP` produce a convincing river/lake, not a flat band.
14. **Give the cursor more period character** (gold accent / reticle detail in `src/render/sprites.ts`'s `buildCursor`) — low priority polish.
15. **Menu logo typeface** — nudge toward a more stencil/military face for "CLOSE COMBAT" on the main menu; cosmetic only.

---

## 4. Broken / ugly things noticed

- **Rendering artifact on winter Berlin Streets map**: a hard-edged, flat olive-green rectangular block with a sharp black border sits along the right edge of the viewport in `crit2_winter_00.png` and `crit2_winter_20.png` (screen-space roughly x:960–1024, y:275–560). It has zero surface noise/texture (everything else on the map is noise-shaded) and does not correspond to any terrain type painted in `src/data/maps/berlin_1945.ts` (no green/park/lawn terrain is used anywhere in that file — it's all `snow`/`stone`/`rubble`/`pavedroad`/`crater`). This reads as a genuine rendering bug (possibly an off-map/edge-of-canvas fallback fill, a stray debug rect, or a mis-scaled UI element bleeding into the viewport) rather than a style issue. Recommend a targeted repro: load Berlin Streets, pan the camera so that screen region is centered, and inspect what's drawing there (check `TerrainRenderer` for any per-chunk fallback color, and check nothing in `src/ui/screens/battle.ts` or `src/render/effects.ts` is drawing a stray `fillRect` at that screen position).
- **Roads on the summer Border Crossing map are visually broken** — a filled ~15–20px road band is defined in code (`ROAD_RAMP`) but renders as a nearly invisible 1–2px line in `crit2_summer_00.png`/`crit2_summer_zoomin.png`. This isn't just "less textured than reference," it looks like the road coverage width is wrong for this specific map.
- **Winter rubble reads as pink paint spatter**, not rubble — at a glance it could be mistaken for a blood pool or damage decal rather than a pile of bricks. Worth a second look purely on color choice (`rubble` ramp's third stop `#8a5a52`/`#9a6660` skews pink-brown against grey neighbors).
- **No overlapping-UI or wrong-text issues were observed** in any of this session's captures — the HUD panel, team grid, soldier monitor, and combat messages all stayed within their expected rects with no clipping or z-order problems across ~10 screenshots at two zoom levels.
