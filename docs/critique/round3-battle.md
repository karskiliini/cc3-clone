# Round 3 Battle Critique — Whole-Screen Likeness Review

Reviewed against `ref/ref_cc3_1479.png` (summer, Pavlov's House), `ref_cc3_1482.png` (winter forest), `ref_cc3_1483.png` (winter armor), `ref_cc3_1484.png`/`ref_cc3_1485.png` (winter village/road), with round-1 and round-2 fixes already applied (painterly terrain + grain/relief, vector roads, buildings with roofs/walls, ruins, zoom-aware chunk baking, hand-authored soldier/vehicle pixel art, painted team icons, bold effects, modern controls, sixth winter map). Screenshots captured live this session at `ref/crit3_*.png` (dev server, own Playwright page, closed at end — a second page belonging to another agent testing Operation flow was left untouched).

No source was edited for this review.

---

## 1. Overall likeness score: **7 / 10** (up from 5.5/10 in round 2)

This is a real, substantial jump. At default zoom, a screenshot of ours now reads unmistakably as CC3 — the terrain finally has grain and relief instead of a color wash, roads are proper filled bands, buildings have visible roofs/walls with cast shadow, and soldiers/vehicles have enough shading and silhouette to read as *soldiers* and *tanks* rather than blobs. The single biggest round-2 complaint ("soft-focus color wash, not a painted map") is fixed. The HUD, which was already the strongest area, is untouched and still good.

Three things still break the illusion, in order of how often they'll be seen:

1. **Terrain grain reads as digital noise, not paint.** The fbm-based mottling added since round 2 (`groundColorFbm` in `src/render/terrainRender.ts`) is a big improvement over the flat wash, but it is still an isotropic per-pixel speckle at every zoom level (`ref/crit3_summer_zoomin.png`, `ref/crit3_summer_00b.png`) — reference grass (`ref_cc3_1479.png`) has directional brush-stroke clumps of varying size (small clover-like tufts, larger darker shadow-clumps), not uniform salt-and-pepper grain. Ours is closer than round 2 but still has a "TV static over a green filter" quality up close, most visible in `ref/crit3_summer_zoomin.png`'s open ground.
2. **A visible chunk-seam artifact during the pre-battle deployment view.** `ref/crit3_debrief_poll.png` (captured while the battle was still in its deployment/idle phase, before "Begin" registered) shows a hard vertical seam around x≈605 where the grass tone jumps from warm yellow-green to cooler blue-green with a razor-sharp boundary — this is the "not-yet-baked chunk falls back to a low-res whole-map render" path described in `src/render/terrainRender.ts` lines 16-21 (`chunks not yet baked are filled in from a cheap whole-map low-res canvas`) meeting an already-baked full-res chunk with a different color/seed sample. Once the battle actually started (`ref/crit3_seam_check.png`, same camera position, ~10s later) all chunks had baked in and the seam vanished — so this is a real, reproducible bug in the lazy-bake fallback, not a one-off render glitch, and it means any player who looks at the map before combat begins (which is exactly when the deployment screen is meant to be studied) sees a visible tile-grid crack.
3. **Vehicles and soldiers still under-perform their reference counterparts at rest/idle.** They are dramatically better than round 2 (visible tread, hull highlight/shadow, a proper barrel — see `ref/crit3_summer_zoomin.png`'s PzKw IV), but next to `ref_cc3_1484.png`/`ref_cc3_1485.png` the reference tanks have a stronger, more saturated highlight-to-shadow swing and a visible commander-hatch/pintle-MG silhouette bump that ours lacks; soldiers (`ref/crit3_summer_00b.png`) are readable as soldiers now but still slightly under-scaled/under-saturated relative to the punchy small figures in `ref_cc3_1479.png`.

---

## 2. Per-area verdicts, vs. round 2

### Terrain — ground (open/grass) — **Improved, no longer failing**
File: `src/render/terrainRender.ts` (`groundColorFbm`), `src/render/noise.ts`, ramps in `src/render/palette.ts`.
- Round 2: "soft-focus color wash… airbrushed." Round 3: `ref/crit3_summer_00b.png` and `_zoomin.png` show real fine-grain mottling — this is fixed at the macro level (no more single continuous 700px gradient).
- Remaining gap: the grain frequency is close to uniform across the whole field rather than clustering into visually distinct clumps of different sizes the way the reference's brush-stroke texture does — reference grass has an almost cellular/blotchy look (patches of 10-20 reference-pixels of consistent tone) vs. ours reading as fine, even speckle. Consider mixing in one lower-frequency "blotch" octave at higher amplitude than the current fine grain so the eye catches large & small texture together, matching `ref_cc3_1479.png`'s field north of the road.

### Terrain — fields/crops — **Now visible and good**
`ref/crit3_summer_zoomout1.png` and `_zoomout2.png` (South Farm area) show a warm gold crop patch with visible internal texture, matching `CROPS_RAMP` intent and reading close to `ref_cc3_1479.png`'s wheat fields. This was "unverified" in round 2; now confirmed working. No action needed.

### Terrain — roads — **Fixed, biggest single win**
Round 2's #1 bug ("hairline road" on Border Crossing) is gone: `ref/crit3_summer_00b.png` shows a wide (~15-20px at default zoom) tan dirt road with visible rut/tread striations and soft blended edges into grass, essentially matching `ref_cc3_1479.png`'s road band. `src/data/maps/border_1941.ts` line 68 now uses `p.road(mainRoad, 3, 'dirtroad')` (width 3 tiles) vs. round 2's presumed under-width call — confirmed fixed by direct comparison. Berlin's paved road width (`p.road(...,5,'pavedroad')`, `p.road(...,7,...)` for the tram avenue, `src/data/maps/berlin_1945.ts` lines 16-18) also reads as a proper street band in the Moscow Outskirts capture (`ref/crit3_winter_00.png`), no more corduroy/knit artifact from round 2.

### Terrain — buildings — **Now visible, good roofs/walls, but flat compared to reference**
`ref/crit3_summer_zoomout1.png`/`_zoomout2.png` (South Farm, two buildings inside a fenced compound) show distinct sloped-roof shading (lighter roof plane, darker wall band) and a soft cast shadow — a real structure, not a flat block, which addresses round 2's "cannot verify" flag. `ref/crit3_winter_00.png`'s snow-roofed building (top-right) shows the roof's snow-load gradient reading correctly against `ref_cc3_1484.png`'s cabins. Compared to the reference, ours still reads more like a "toy block with a roof texture" than a building with real depth — the reference's roofs have visible individual shingle/plank striping and a stronger AO line where roof meets wall; ours is a smooth two-tone gradient. Second-order polish item, not urgent.

### Terrain — ruins/rubble — **Present in data, not captured this session**
`src/data/maps/berlin_1945.ts` has `p.ruin(...)` calls (lines 30, 37, 38, 40) and rubble patches/barricades (lines 58-63, 78-83) with a comment citing `ref_cc3_1484/1485.png` for density — this directly answers round 2 finding #8 (rubble reading as "pink splatter"). This session tested Moscow Outskirts, not Berlin Streets, per the instructions' either/or, so the ruin/rubble render itself is **unverified this round** — recommend a follow-up screenshot on Berlin Streets specifically to close this out, since it was flagged twice now.

### Terrain — trees — **Improved but still sparse in the played area**
`ref/crit3_summer_zoomin.png` shows two trees with a visible NW highlight and darker core — better shading than round 2's flat disc. Density in the captured Border Crossing viewport is still low (2-3 trees across ~700px of grass) vs. `ref_cc3_1479.png`'s denser tree line. Winter map (`ref/crit3_winter_00.png`) has a genuinely dense, well-shaded forest mass at top-left that reads close to `ref_cc3_1482.png` — the winter tree/bush density fix has clearly landed; the summer map's scatter density has not been revisited to match.

### Soldiers — **Much improved, close to passing**
File: `src/render/soldierArt.ts`, `src/render/unitRender.ts`.
- Round 2: "4-6px blobs, no visible weapon line." Round 3 (`ref/crit3_summer_00b.png`, `_zoomin.png`, `_teamselected.png`): soldiers now show a distinct helmet dome with highlight, a visible weapon diagonal, and side-appropriate uniform tone against the grass — a real improvement, and the file's stated hand-authored-grid approach is visibly working.
- Remaining gap: at default zoom the uniform color still sits close in value to the mid-tone grass ramp in a few frames (e.g. the "Running" squad in `ref/crit3_summer_00b.png` blends slightly into shadowed grass), and there's no outline/rim-light separating silhouette from ground the way the reference's higher-contrast paint job achieves. Lower priority than round 2 (this was the #1 fix and is largely done) but not fully closed.

### Vehicles — **Much improved, shading now visible**
File: `src/render/vehicleArt.ts`.
- Round 2: "nearly flat mid-grey, no NW highlight/SE shadow despite code comments." Round 3 (`ref/crit3_summer_zoomin.png`'s PzKw IV, `ref/crit3_winter_00.png`'s tanks): a clear lit-hull/shadowed-hull split and a distinct dark tread band with wheel hints are now visible — the shading described in the file's own header comment is actually rendering now. This is a genuine, confirmed fix of round 2 finding #4.
- Remaining gap: compared to `ref_cc3_1483.png`/`ref_cc3_1485.png`, reference tanks have a stronger specular highlight on the turret roof and a visible raised commander's cupola/hatch silhouette; ours is a correct but slightly flatter/smaller-contrast rendition. Diminishing-returns polish, not a priority fix.

### Effects (tracers/muzzle flash/explosions) — **Confirmed working, good**
File: `src/render/effects.ts`. `ref/crit3_summer_00.png` (the aborted first summer run) and `ref/crit3_summer_15.png` both show live magenta/purple tracer lines and a dead/casualty marker rendering during actual combat — round 2 could not confirm this ("not exercised this session"); now confirmed present and visually bold (star-shaped muzzle flash per the file's design intent). Fire/smoke gradients were not seen in frame this session (no vehicle kill captured) — still technically unverified for that specific effect, but the mechanism clearly fires for small-arms tracers and death markers.

### HUD panel / soldier monitor / combat messages / minimap — **Unchanged, still good**
No regressions found. `ref/crit3_summer_00b.png`, `_teamselected.png`, and the winter captures show the same faithful bottom-strip layout, color-coded status words (green/yellow/red), soldier monitor rows, and combat message coloring praised in round 2. The minimap (`ref/crit3_summer_00b.png` inset) now shows visibly more field/road pattern than round 2's near-solid blob, inheriting the terrain-texture fix for free as round 2 predicted it would.

### Menus (main menu, battle setup, requisition) — **Good, unreviewed area, holds up well**
`ref/crit3_mainmenu.png`, `ref/crit3_playagame_click.png` (map select with a genuinely nice painted mini-thumbnail per map), and `ref/crit3_requisition.png` (force-pool / active-roster two-column layout with unit icons and point costs) are all clean, legible, and structurally in the spirit of a CC-era requisition screen. No likeness complaints here; this is new ground not covered in round 1/2 critiques and it's solid.

### Debrief screen — **Exists and is reasonably built, but easy to miss**
`src/ui/screens/debrief.ts` implements a proper win/loss/draw debrief with comparative rating rows (arrows, colors) — this is good, CC-appropriate design. However the transition is on a hard 2-second timer after `state.phase === 'ended'` (`src/ui/screens/battle.ts` line ~173, `if (this.endedElapsed > 2)`) with no way to pause on it once it's showing (the `BottomStrip`'s "Back"/"Next" are the only way to leave, but nothing holds the player *on* the results before it's reachable) — this session's automated capture window twice landed on either the live battle or the post-debrief main menu and never the debrief screen itself in a screenshot, which suggests the window a player has to actually read casualty stats before advancing is comfortable, but a fast click can skip past it entirely. Not a likeness issue, but worth a design look if it hasn't already been reviewed.

---

## 3. TOP 15 ranked fixes (by impact on overall likeness)

1. **Fix the chunk-bake seam visible during pre-battle deployment** (`src/render/terrainRender.ts`, the "lazily baked… low-res whole-map fallback" path, lines ~16-21) — reproduced in `ref/crit3_debrief_poll.png`; the fallback low-res fill and the full-res bake disagree on tone at the boundary. This is the single clearest outright bug found this round and it happens on a screen (deployment) players are meant to study carefully.
2. **Break up the ground-grain texture into varied-size blotches instead of uniform speckle** (`groundColorFbm`, `src/render/terrainRender.ts`) — mix in a lower-frequency, higher-amplitude "clump" octave so grass reads as painted brush-strokes, not TV static, matching `ref_cc3_1479.png` at close zoom.
3. **Re-verify Berlin Streets ruins/rubble render** (flagged twice now — round 2 called it "pink splatter," code now has real `p.ruin`/rubble-patch calls in `src/data/maps/berlin_1945.ts` citing the correct reference images) — take a dedicated screenshot centered on a ruin footprint to confirm the fix actually reads as broken masonry.
4. **Increase summer map tree/scatter density** to match winter's already-fixed density — `border_1941.ts`'s decor scatter calls are visibly sparser than the reference's tree line in `ref_cc3_1479.png`, and sparser than this session's own winter forest capture.
5. **Add a silhouette rim-light/outline to soldier sprites** (`src/render/soldierArt.ts` / `drawSoldiers` in `src/render/unitRender.ts`) so uniform color doesn't blend into mid-tone grass shadow at default zoom — last-mile polish on round 2's #2 fix, which is otherwise done.
6. **Push vehicle highlight/shadow contrast further and add a cupola/hatch bump** on turreted vehicles (`src/render/vehicleArt.ts`) to match the stronger specular pop in `ref_cc3_1483.png`/`ref_cc3_1485.png` — the shading mechanism works now, it just needs more contrast.
7. **Add finer roof detailing (shingle/plank striping, sharper roof/wall AO line)** to building rendering — currently a clean but smooth two-tone gradient versus the reference's more textured roofs.
8. **Confirm fire/smoke and vehicle-kill effects render as designed** — tracers and casualty markers are confirmed good; the fireball/smoke-ball sequence in `effects.ts` (lines ~180-213) was not seen live this session and should get a dedicated screenshot during an actual vehicle kill.
9. **Consider a soft "hold" on the debrief screen** so results aren't skippable in a single stray click — not a visual-likeness issue but a UX fidelity point relative to how CC3's after-action report is meant to be read.
10. **Team-grid icon fidelity** (`tintedTeamIcon` in `src/ui/hud/hudChrome.ts`, painted icons in `src/render/teamIconArt.ts`) — the new hand-authored painted-miniature icons are a clear step up from round 2's flat tint; do a side-by-side crop against the reference's team-grid icons to see if further detail is warranted, but this is now low priority.
11. **Water tiles remain unverified** — no water was in frame across either summer or winter maps this session (the winter Moscow map's stream/water feature was not visited); take a dedicated shot to confirm the `WATER_RAMP`/`ICE_RAMP` implementations actually render as intended.
12. **Cursor remains generic** (`src/render/cursor.ts`) — unchanged since round 2, still a plain arrow vs. the original's more characterful reticle; cosmetic, lowest priority.
13. **Double-check requisition-screen unit icons at higher fidelity** — functional and clean (`ref/crit3_requisition.png`) but worth a pass to see if they can share the new painted-miniature style from `teamIconArt.ts` for more visual consistency across menus vs. in-battle HUD.
14. **Spot-check crop-field edge blending at the crop/grass boundary** — `ref/crit3_summer_zoomout1.png` shows a reasonably soft edge, but compare directly against `ref_cc3_1479.png`'s sharper field/grass tonal break to see if the terrain-blend radius needs tightening specifically at that boundary (currently reads slightly softer/blurrier than reference).
15. **Re-run the Border Crossing summer map through a full uninterrupted engagement** (this session's battles ended in under a minute both times the German force actually engaged) to get a longer-duration visual read on sustained combat — useful for confirming effects/casualty accumulation reads well over time, not just at first contact.

---

## 4. Broken / ugly things found this session

- **Chunk-bake seam** (see §3 #1) — hard vertical color discontinuity at ~x=605 visible during the pre-battle deployment view on Border Crossing, screenshot `ref/crit3_debrief_poll.png`. Disappears once the chunk finishes baking after battle start (`ref/crit3_seam_check.png`, same camera position). Root cause per the file's own comments: the low-res whole-map fallback used for not-yet-baked chunks doesn't tonally match the full-res bake it's standing in for.
- **Battles can end abruptly within under a minute of "Begin."** Both timed summer and winter attempts this session resolved to a KIA/panic rout and returned to the main menu inside ~30-45 seconds of real time once the AI-controlled side actually engaged. This may be intentional (small forces, Veteran difficulty, "Auto" possibly fast-forwarding), but from a critique standpoint it made it hard to observe sustained mid-battle visuals (nothing on fire, no prolonged firefight) — worth a design sanity check on default force size/difficulty for a "watch the AI play" flow like this one, even though the underlying DebriefScreen the game transitions to is properly built.
- **No other rendering artifacts, overlaps, or wrong-text issues were found** this session — a marked improvement over round 2, which had an outright unexplained flat-green rectangle bug on the Berlin map (round 2 finding #5). That artifact was not reproduced or seen this round (though Berlin Streets specifically wasn't revisited — see TOP-15 #3 — so treat as "not seen," not "confirmed fixed").

---

## 5. Comparison summary: round 2 → round 3

**Improved / fixed:**
- Ground terrain: soft blur → real painted-grain texture (still not perfect, but round 2's #1 complaint is resolved).
- Roads: hairline bug on Border Crossing → proper wide textured band (round 2's #3 fix, confirmed).
- Vehicles: flat grey boxes → visible hull shading, tread, highlight (round 2's #4 fix, confirmed).
- Soldiers: illegible blobs → readable helmet/weapon/uniform silhouettes (round 2's #2 fix, largely confirmed, minor contrast gap remains).
- Buildings: unverified → now visible with roof/wall shading (round 2's ask to re-shoot, addressed).
- Crops: unverified → now visible and matching intended ramp.
- Minimap: blobby → visibly more detailed, for free, from the terrain fix.
- Team icons: flat tint → hand-authored painted miniatures.
- Effects: unverified → confirmed working (tracers, casualty markers).
- New areas (menus, requisition, debrief) are solid on first look and weren't previously critiqued.

**Regressed / newly found:**
- The chunk-bake seam (§4) is a new artifact not present in round 2's findings — a side effect of the new zoom-aware lazy-baking system introduced since round 2. Net positive trade (round 2's flat/blurry map was worse overall) but it's a real new bug to fix.
- Winter's specific green-rectangle bug from round 2 could not be re-confirmed as fixed or not, since Moscow Outskirts was tested instead of Berlin Streets this round — flag as still open pending a direct re-check.

**Unresolved from round 2 (carried forward, lower severity now):**
- Water tiles still unverified (no water map feature encountered in either session).
- Cursor still generic/unchanged.
- Tree density on summer maps still short of the reference's tree line, despite winter's density clearly being fixed.

**Net assessment:** round 2 → round 3 is the single biggest jump in likeness so far — the terrain rendering overhaul was worth the investment and cascades into better minimap, better readability, and a battlefield that finally "feels like" CC3 at a glance. The remaining gaps are now second-order polish (grain character, highlight contrast, one baking-seam bug) rather than fundamental "this doesn't look like the game" problems.

---

## Screenshots referenced

- Summer: `ref/crit3_summer_00.png`, `_15.png`, `_00b.png`, `_zoomin.png`, `_zoomout1.png`, `_zoomout2.png`, `_teamselected.png`, `_battlestart.png`
- Winter (Moscow Outskirts): `ref/crit3_winter_00.png`, `_20.png`, `_40.png`, `_afterspace.png`, `_zoomin.png`, `_zoomout.png`
- Menus: `ref/crit3_mainmenu.png`, `_playagame_click.png`, `_requisition.png`, `_maplist_moscow.png`
- Bug evidence: `ref/crit3_debrief_poll.png` (seam), `ref/crit3_seam_check.png` (same view, seam gone post-bake)

File path for this critique: `docs/critique/round3-battle.md`
