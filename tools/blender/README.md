# Blender sprite pipeline

All sprites are rendered headless by Blender 5.x from **original procedural models** (Python/bpy,
primitives only, no third-party assets). Outputs are PNG atlases + JSON under `public/sprites/`
following the atlas contract in `docs/superpowers/specs/2026-09-17-soldier-animation-design.md` §5.

| File | Purpose |
| --- | --- |
| `common.py` | shared scene: ortho camera tilted 12° toward screen-north, sun az 315°/el 45° + sky fill, transparent film, shadow catcher, 2× supersample + downsample, `render_cell` / `render_grid`, `AtlasPacker` (PNG + JSON). API documented in its docstring. |
| `kit.py` | reusable kit models (weapons, helmets, packs, crew props) – the same builders feed the soldier figure and the ground items. |
| `soldiers.py` | the infantryman rig, all poses/animations, soldier atlases and body-part atlases. |
| `items.py` | ground items atlas (`items_<scale>`). |
| `contact_sheet.py` | contact sheets over the game's painted grass/snow (plain python3 + Pillow). |
| `vehicles.py`, `vehicles_common.py` | tanks and vehicles (per-vehicle atlases, see below); `vehicles_common.py` also serves `weapons.py` (crew weapons). |
| `menu.py` | the menu poster backdrops `public/menu/poster.png` (Soviet rifleman pointing, burning town) and `poster_plain.png` (the town alone, behind the working screens): perspective Cycles render, metaball figure, graded to one maroon-to-flame palette in numpy. `npm run sprites:menu` (~25 s, 4 threads). |

## Commands

```sh
npm run sprites                 # everything (soldiers, parts, items, vehicles, weapons)
npm run sprites:soldiers        # soldiers_* and parts_* : 4 palettes x 2 scales, 4 parallel Blender jobs
npm run sprites:items           # items_1, items_2

# partial / resumable (entries are cached as strips in tools/blender/.cache/<atlas>/)
blender -b -P tools/blender/soldiers.py -- --side german --season summer --scale 1 --only standing.walk
blender -b -P tools/blender/soldiers.py -- --kind parts --side soviet         # only the parts atlases
blender -b -P tools/blender/soldiers.py -- --pack-only                        # re-pack atlases from the cache
blender -b -P tools/blender/soldiers.py -- --list                             # print entry keys + frame counts
```

`--only` takes comma separated fnmatch patterns or key prefixes and re-renders just those entries,
then re-packs the atlas from the cache. Without `--only`/`--force`, cached entries are skipped, so an
interrupted build resumes. `--force` re-renders everything selected. `--jobs N` runs the atlases in N
parallel Blender processes. `--samples` sets Cycles samples (default 8, ×4 by the 2× supersampling).

Renderer: Cycles on CPU with few samples (it has a real shadow catcher; Eevee in 5.x does not). Every
render is one grid image of 16 facings × up to 6 frames, so an entry costs ~1–3 s.

## Contact sheets

```sh
python3 tools/blender/contact_sheet.py --atlas soldiers_german_summer_1 --only "standing.*" --mode dirs
python3 tools/blender/contact_sheet.py --atlas soldiers_soviet_winter_2 --mode frames --dirs 2,10 --mag 3
python3 tools/blender/contact_sheet.py --atlas items_1 --mode strip
```

`dirs`: each entry, all 16 directions at 1× over grass and snow, then magnified (4× at scale 1);
`frames`: every frame of each entry for a few directions; `strip`: one compact row per entry.
Sheets go to `ref/wf21/`. Backdrops: `ref/wf18/full_steppe_grass_z1.png`, `ref/wf18/full_moscow_snow_z1.png`.

## Soldier atlases (`soldiers_<german|soviet>_<summer|winter>_<1|2>`)

* `crew.bailout` / `crew.mount` (6 frames, `progress: true`, `hullHeightM: 1.5`): the man is baked 1.5 m above
  the ground on the hull frames (≈4 px up-screen at scale 1), no shadow on the hull frames, a growing ground
  shadow on the three ground-side frames (`shadow_rows` in soldiers.py renders the entry twice and mixes rows).
* New entries are appended at the END of `build_entries()` so existing `start` indices never move.
* Gaits (`standing.walk`, `standing.run`, `crouched.sneak`, `prone.crawl`, their mood variants, `crew.carry.*`,
  `crew.haul`, `crew.drag`) have 8 frames (render grid 16 x 8, `MAX_FRAMES`); the game steps them by
  ground speed / the entry's own `strideM`, so the feet do not slide. `*.throw` has 6 frames (cock, wind-up,
  release, follow-through, recover x2; the grenade is in the hand for the first two) over the game's 0.9 s.
* First aid (sim/medic.ts): `kneeling.bandage` (4-frame loop, kneeling over a man in front of him, rifle laid
  down), `crew.drag` (stepping backwards, bent, hands on the casualty's straps; `dragM` = 1.3 m) and
  `prone.dragged` (the casualty on his back, head toward +Y, i.e. toward the man pulling him). The game
  places the casualty `dragM` in front of the dragging figure.
* `standing.drop` (6 frames, `progress`, all weapon variants): standing -> step and crouch -> right knee ->
  both knees, hand down -> on the hands -> flat. The game plays it forwards to go prone and backwards to
  get up (soldierAnim `postureDropProgress`, 0.45 s; from/to a knee only the lower part).
* Soldier and parts sheets are written as LOSSLESS WebP (`to_webp`, system python + Pillow; the JSON's
  `image` field names the file, loaders fall back to `<name>.png`). Scale-2 soldier sheet ~22 MB PNG -> ~9 MB.
* Look: soldiers are lit softer than vehicles (`soldier_light`: less blue sky fill, sun x0.9), cloth has
  almost no specular, uniforms and helmets are mid/low value so squads read darker than the terrain;
  a 1 px dark rim (render time, `OUTLINE_ALPHA`) plus a slightly darker last row of figure pixels
  (pack time, `EDGE_DARKEN`) keep the silhouette crisp at 1:1.
* cell 36×36 px at scale 1 (72 at scale 2), anchor (18,19) (×2), 16 dirs, 96 columns.
* The figure is drawn **1.3× life size** (`figureScale` in the JSON; head/helmet a further 1.15×) so a
  standing man with rifle reads at about 17 px like the old code-drawn sprites; ground scale stays
  10/20 px per metre.
* Keys: `<posture>.<action>[.<mood>][@smg|@lmg|@none]`. The unsuffixed key shows the bolt rifle;
  `@rifle` aliases exist wherever other weapon variants do. Aliases (JSON entries with an `alias`
  field sharing another entry's cells) fill the game's fallback chains.
* Extra JSON fields: per entry `strideM` (gaits), `progress: true` (task animations: frame = progress),
  `landed` (ragdoll flight i ends in the orientation of `ragdoll.landed<i>`), `alias`; top level `side`,
  `season`, `pxPerM`, `figureScale`, `tiltDeg`, `weapons`.
* Ragdoll flights carry no shadow and almost no baked height (the game adds the arc and the shadow).

## Parts atlases (`parts_<side>_<season>_<1|2>`): cell 18 px (36), anchor centre, `part.<kind><0..2>`.
Body parts: torso, head, arm, leg, boot (1.3× like the men). Vehicle debris (appended, TRUE scale, same pixels in every
palette, `debris: true`): plate0..2 (torn armour), wheel0..2 (tyred road wheel, bare road wheel, sprocket),
hatch0..2 (round cupola hatch, rectangular hatch, engine grille). `part.<kind>` aliases variant 0.
## Items atlas (`items_<1|2>`): cell 28 px (56), anchor centre, `item.<id>`, direction 0 = long axis north.

## Render timings (Apple M5 Pro, Cycles CPU, 8 samples × 2× supersampling)

| Atlas | Entries / cells | Uncontended |
| --- | --- | --- |
| `soldiers_*_1` (3456×3132 px, ~8 MB) | 160 rendered entries, 521 frames × 16 dirs = 8336 cells | ≈ 0.3 s per entry, 1.5–4.5 min per atlas |
| `soldiers_*_2` (6912×6264 px, ~22 MB) | same | ≈ 0.7–1.7 s per entry, 3–4.5 min per atlas |
| `parts_*` | 15 entries | 3 s / 6 s |
| `items_1`, `items_2` | 31 items | 2 s / 7 s |

A full `npm run sprites:soldiers` (8 soldier + 8 parts atlases, 4 parallel jobs) is about 15–20 min on an
idle machine. (The first full build here took ~57 min because other render jobs had the machine at
load 26.) Keep `--jobs` ≤ cores/4: each Cycles process is itself multi-threaded.

Pack-time post-processing (`grade()` in soldiers.py, applied when packing, not cached): contrast/lift on
figure pixels per scale (`GRADE`), 6-bit colour, smoothed + quantised shadow alpha (cuts the PNGs from 57 MB to 22 MB).
Render-time: 1 px dark rim around the figure (`OUTLINE_ALPHA`).

## Contact sheets delivered (ref/wf21/)

* `soldiers_<side>_<season>_<1|2>_dirs_core_00.png` – postures + two moods, 16 dirs, 1× on grass and snow + 4×/2×
* `soldiers_<side>_<season>_1_strip_all_0[0-3].png` – every entry, 16 dirs, 3×
* `soldiers_german_summer_2_frames_standing_*.png`, `soldiers_soviet_summer_2_frames_low_*.png`,
  `soldiers_german_summer_2_frames_crew_*.png` – every frame of each animation
* `parts_<side>_<season>_2_strip_all_00.png`, `items_<1|2>_strip_all_00.png`

## Grid anchors (fixed 2026-09-17)

Blender 5.2 foreshortens ground-y by cos(12°) = 0.978 regardless of the pixel aspect, so objects placed
with `ctx.cell_origin(col, row)` in grid rows away from the image centre missed their anchor by 2.2 % of
the offset (±4 px over a 6-row grid at scale 2, i.e. a 1.6 px step between animation frames).
`cell_origin(..., exact=True)` now compensates; soldiers.py and items.py use it and all their atlases
were re-rendered. The default (`exact=False`) is unchanged for vehicles_common.py, which measures and
applies its own `ground_y_factor`. Within a cell, ground-y is 0.978 × px_per_m (2 % short), by design now.

## Vehicle atlases (`vehicles_<def>_<1|2>`, `vehicles_<def>_winter_<1|2>`)

```sh
npm run sprites:vehicles                                        # all vehicles, both scales, summer
blender -b -P tools/blender/vehicles.py -- --season winter      # whitewashed live looks
blender -b -P tools/blender/vehicles.py -- --only t34_76,kv1 --scale 1 --force
VEH_OUT=/tmp/look blender -b -P tools/blender/vehicles.py -- --only pz4gh --scale 1 --dirs 16 --states ok --force
python3 tools/blender/vehicles_common.py sheet-vehicles --scale 1 --zoom 3 --only t34_76,pz4gh
```

* 64 facings; entries `<def>.hull.{ok,ko,blown,trackL,trackR}` and `<def>.turret.{ok,ko,blown}` (blown only
  for turreted vehicles); `turretPivotM` (+y forward) places the turret on its ring. The winter atlas holds
  only `hull.{ok,trackL,trackR}` + `turret.ok`; the game takes the burnt wreck looks from the summer atlas. The 1941 Dunkelgrau vehicles (Pz III J, Pz IV F1, SdKfz 251)
  get no winter atlas: they fought the Moscow winter unwashed.
* Paint (`vehicles_common.paint_material`): Dunkelgrau (1941-42: Pz III J, Pz IV F1, SdKfz 251) or
  Dunkelgelb with Olivgruen / Rotbraun bands (1943+), Soviet 4BO; bevel-shader rounded edges with lighter
  worn paint, cavity AO, mottling, rain streaks, dust on the lower hull; winter lime wash (patchy, worn off the
  edges). Burnt finish + sooty engine deck for ko / blown.
* Render: Cycles (GPU when available), 3x supersample, 1 px pixel filter; pack-time `clean_cell` sharpens
  the colour a little and darkens the silhouette rim (`OUTLINE`) so each part reads on any ground.
* The turret is rendered with the shadow catcher at deck height: it brings its own shadow (gun tube
  included) onto the hull. The hull carries a shadow-less ring drum under the turret.
* `VEH_OUT` redirects atlases + cache (look-dev); `--states` renders only some states. Cache:
  `tools/blender/.cache/vehicles[_winter]_<scale>/` (pass `--force` after changing a model).
* Runtime: `spriteAtlas.drawVehiclePart` / `unitRender.drawVehicleSprite` (no code-drawn fallback; a battle
  preloads the scale-1 atlases of the vehicle types present). The main-gun recoil kick is a render-time
  offset (`lastMainShotAt`).
