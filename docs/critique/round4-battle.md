# Round 4 Critique: Art Director Re-Score

This round was checked against `ref/ref_cc3_1477.png` (menu), `1478` (requisition), `1479` (summer), and `1482`/`1484` (winter). Round 3 scored 7/10 (`docs/critique/round3-battle.md`). All screenshots were taken live this session and saved under `ref/wf4/score_*.png`. No code was edited.

> Capture note: in this Playwright context the canvas lays out at 819x614 CSS px, but screenshots are 1024x768. So the documented canvas coordinates only work after dividing by 1.25. With the coordinates used as given, every click missed and the menu never advanced. Other agents driving the browser should use `x/1.25, y/1.25`.

## Evidence
| Shot | File |
|---|---|
| Main menu | `ref/wf4/score_menu.png` |
| Battle setup (Border Crossing / Moscow / Belarus) | `score_setup.png`, `score_setup_moscow.png`, `score_setup_belarus.png` |
| Requisition | `score_requisition.png` |
| Deploy | `score_deploy.png` |
| Summer, units moving | `score_summer_moving.png`, `score_t1.png`, `score_t2.png` |
| Selected team + soldier monitor | `score_selected_monitor.png`, `score_t2.png` (tank crew) |
| Zoom 2 (+) | `score_zoom2.png` |
| Zoomed out, South Farm | `score_summer_combat.png`, `score_zoomout.png` |
| Winter (Moscow Outskirts) | `score_winter_moscow.png`, `_zoomout.png`, `_later.png` |
| Forest (Belarus Forest) | `score_winter.png`, `score_winter_later.png`, `score_winter_zoomout.png` (summer map, despite the filename) |

## 1. Likeness score: **7.0 / 10** (no change from round 3)

Parts of the game now look more like CC3, mainly the HUD and soldier monitor, the roads, and tree scatter. But new problems cancel that out. The grass palette is too mustard, dense forest looks like "bubble wrap", sprites are blocky at 2x zoom, and snow maps are almost flat. At a glance a screenshot still clearly reads as a CC3 tribute. Side by side with `1479` or `1482`, the terrain still looks like a procedural generator rather than a painted map.

## 2. Improved vs round 3
- **Soldier monitor now matches the original's structure.** It uses boxed name/status cells, a bold role cell (Leader/Gunner/Assist/Soldat/Driver), a Healthy column, a weapon icon plus AP, and boxed round counts. Vehicles also get a "Main Gun / Operational" header. This matches `1482`/`1484` much more closely than round 3's plain text rows. Big win.
- **Order hotkey grid** (Z X C V / B N M Esc, bottom right) is laid out like the original command palette.
- **Roads**: a warmer ochre band with twin wheel ruts and softer edges, closer to `1479`. Winter roads show a pale packed-snow band with ruts, and a side track with twin tracks (`score_winter_moscow_zoomout.png`) that reads like the original's sled/track lines.
- **Trees and hedges on summer maps**: clusters of 2 to 5 shaded trees along hedges and the South Farm field edge (`score_summer_combat.png`) replace the round-3 lone discs. This closes round-3 fix #4.
- **Grass texture**: large low-frequency tonal blotches are now mixed with the fine grain, as round-3 fix #2 asked. The field is no longer uniform static.
- **Vehicles**: darker hulls, crosses, and a clearer track band. At default zoom they read as panzers.
- **Winter village**: snow-dusted roofs, a timber house interior shown when occupied, split-rail fences, bare-shrub scatter with cast shadows (`score_winter_moscow.png`). Bare shrubs with long shadows are a good nod to `1482`.
- **No chunk-bake seam** was seen in deploy or battle captures (round-3 fix #1 appears resolved).
- **Menus and requisition** still hold up: the two-column Force Pool/Active Roster, vertical orange titles, Regular/Armor dropdowns, and Refit/Rest/Details/Retire row all match `1478` structurally.

## 3. Regressed / still wrong
- **Grass hue regressed toward mustard/olive-yellow.** `1479` grass is a mid green with warm ochre and brown patches. Ours (`score_summer_moving.png`) is a saturated yellow-olive with fine dithered speckle, and crops barely separate from grass. The two main summer ramps have converged.
- **Dense forest looks like bubble wrap** (`score_winter.png`, Belarus Forest). It is a solid carpet of identical round domes with a repeated highlight crescent, no ground, no shadows between crowns, and no size variation. Soldiers inside it almost disappear. Reference forest (`1482`) is individual crowns with ground visible and strong cast shadows.
- **Zoom 2 is nearest-neighbour upscaling** (`score_zoom2.png`). Soldiers become 2x blocky gray capsules with jagged edges, and trees show stair-stepping. The original redraws at the higher scale. This looks worst at exactly the zoom players use to inspect units.
- **Soldiers move in parade-ground grids.** Auto-deploy and movement keep perfect rows of 3 to 7 men (`score_selected_monitor.png`, `score_zoom2.png`), unlike the loose, staggered clumps in `1479`/`1484`. Soldiers are also neutral gray with no uniform colour. German field-grey should be greener, Soviet khaki browner. The original's green/yellow team tint is also missing, so friendlies are hard to spot.
- **Snow is flat.** The Moscow ground (`score_winter_moscow_zoomout.png`) is an almost uniform light gray with a faint mottle. `1482`/`1484` snow has blue-gray drift shading, wind streaks, and brown earth showing along tracks and banks. There are also no wheel ruts or trampled paths around the buildings.
- **Buildings are still flat boxes.** They have a two-tone roof plus a wall band, but no cast shadow at zoom-out, no shingle texture, and no roof pitch/ridge. `1484` houses have strong SE shadows and textured roofs. The South Farm roofs are plain brown rectangles.
- **Main menu art**: the flat silhouette soldier is a good placeholder, but it is far from the painted portrait and torn-metal flag buttons of `1477`. The buttons are closer, the background is not.
- **Combat effects were barely seen.** In 60 s of summer and winter play there was one kill message and two shell craters, and no tracers were captured. Engagement is slow to start at default force placement, so battles look empty for a long time.

## 4. Top 5 next fixes (ranked by likeness impact)
1. **Pull the summer grass ramp back to green** (`src/render/palette.ts` grass ramp, `groundColorFbm` in `src/render/terrainRender.ts`). Aim for the mid green of `1479` with ochre and brown patches as a secondary noise layer, keep crops clearly gold, and lower the fine dither amplitude by about 40%.
2. **Rebuild dense-forest rendering.** Vary crown radius (0.6x to 1.4x), jitter positions, leave ground gaps, add a SE cast shadow per crown, and randomise or rotate the highlight so it doesn't repeat. For winter, use bare, brown-crowned trees with long shadows as in `1482`.
3. **Re-render sprites at zoom instead of scaling bitmaps.** Draw soldier, vehicle, and tree art at `zoom x base size` (or bake 2x variants) with smoothing appropriate to painted art, so zoom 2 stays crisp.
4. **Loosen infantry formations and tint uniforms.** Use staggered, jittered spacing (no rows) for deploy and move destinations. Give soldiers side-specific uniform hues (German field-grey-green, Soviet khaki) and a faint team-colour rim so they separate from grass and forest.
5. **Add snow and building depth.** Add blue-gray drift/shadow noise and exposed-earth streaks to the snow ramp, trampled paths and ruts around structures, SE cast shadows under buildings at every zoom, and roof ridge lines with plank/shingle striping.

(Carried forward and not re-verified this round: Berlin ruins, water/ice close-up, vehicle kill fire/smoke, cursor.)
