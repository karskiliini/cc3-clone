# Sprite Art Critique vs. Original Close Combat III

Method: compared `ref/ref_cc3_*.png` (original game, top-down, ~10 px/m) against our
`tools/spritePreview.html` at 1x/3x (screenshots saved as `ref/crit_sprites_*.png`) and
against one live in-game screenshot at 1024x768 (`ref/crit_game_1.png`, plus crops
`ref/crit_game_vehicles_crop.png` and `ref/crit_game_soldiers_crop.png`). The in-game flow
dropped straight into a deployed battle from "Play A Game" with no extra clicks needed, so
the live check worked fine — no broken-flow caveat needed here.

Original lighting reference: light from upper-left (NW), soft cast shadow toward
lower-right (SE), muted desaturated palette (snow scenes especially), 1-px anti-aliased
edges rather than hard outlines.

---

## 1. Soldiers (standing / crouching / prone / dead — both sides, all seasons)

**Verdict: Needs work** (standing, in-game scale) / **Wrong** (crouching, prone, dead — preview scale)

- In actual gameplay (`crit_game_soldiers_crop.png`), **standing** soldiers read fine at
  1x: recognizable humanoid silhouette, rifle diagonal, helmet dot. This is the best
  category in the set.
- In the sprite-sheet preview, **crouching** poses for every faction/season are just a
  soft amorphous blob (a rounded blotch with a lighter blotch inside) — no head, no
  rifle, no stance direction. At 1x this is indistinguishable from a rock, a shell
  crater, or another crouching soldier facing a different way. Original crouching
  figures (ref_1482/1484) are small but still show a distinct kneeling silhouette with
  a weapon line.
- **Prone** poses are a vertical bar with a tiny highlight fleck — no rifle line, no
  visible legs/arm spread, no direction cue beyond overall bar orientation. Original
  prone figures show a clear elongated body + weapon line at a shallow angle, and are
  noticeably flatter/longer than ours.
- **Dead** poses are just a dark rectangle with a red smear in the middle (presumably a
  wound decal) — reads as "dead thing" but not specifically as a fallen soldier; no
  limb spread, no weapon dropped beside the body as in the original's dead poses.
- Palette: German summer (~olive `#5c6b45`), German winter (near-white `#e8e8e0`
  smock), Soviet summer/autumn (khaki-brown `#7a6a45`) are all reasonable faction hue
  choices and match the original's general scheme. However every pose within a
  faction/season uses almost the same 2–3 tones — there's no separate flesh tone for
  the face/hands (original has a small pale/tan fleck for the face), and no dark-brown
  weapon-metal tone distinct from the uniform tone.
- No visible highlight direction — the little accent fleck used for "highlight" sits in
  different, seemingly random corners of each frame rather than consistently upper-left
  (NW) as in the original.
- Readability at 1x on grass: standing = good, crouching/prone/dead = poor (blend into
  terrain speckle almost completely, worse than the original's already-subtle prone
  figures because ours have no weapon line to anchor the eye).

## 2. Vehicles

**Verdict: Wrong** (silhouette/detail) — this is the single biggest gap versus the original.

Checked in the live crop (`crit_game_vehicles_crop.png`): PzKw III J, PzKw IV F1, and
SdKfz 251 are, at gameplay scale, **the same shape**: a rounded dark-grey/blue-grey
rectangle, a lighter circular "turret" blob with two dark dots, and one thin diagonal
barrel line. Aside from overall size there is nothing distinguishing a halftrack from a
medium tank from another medium tank.

- **PzIII/PzIV**: hull colour is a cool blue-grey (~`#6b7a8c`); the original's early/mid
  war grey is a warmer neutral grey (~`#6a6a5e`) with a hint of green, never blue. No
  visible tracks (the original shows a lighter tan/brown track band with wheel dashes
  along both hull edges), no glacis plate line, no visible hull machine-gun bump, no
  driver-vision-port marks, no fender stowage boxes.
- **StuG/Panther/Tiger**: use a tan base (`#c9a86a`-ish) with two olive diagonal camo
  stripes (`#6b7a4a`-ish) — this is a reasonable dunkelgelb ambush-scheme approximation
  and the best-looking vehicle family in the set, but the camo stripes are identical in
  angle/spacing across all three very different-sized hulls, so they don't read as
  hand-placed camo, just a repeating shader pattern.
- **Halftrack (SdKfz251)**: currently rendered with a round turret + barrel exactly like
  a tank. A halftrack should show an open-topped troop compartment (lighter interior
  rectangle), no turret, a front wheel pair distinct from the rear track, and a
  pintle-mounted MG at most — right now it is a smaller tank, which will actively
  mislead players about what unit they're looking at.
- **Soviet armor family** (BT-7, T-34/76, T-34/85, KV-1, IS-2, T-26, T-70, SU-76, SU-85):
  all share one olive-green hull tone and near-identical box silhouette scaled up or
  down, distinguished mostly by a white star and turret-oval size. In the original,
  T-34's sloped glacis and rounded turret, KV-1's tall slab sides, and IS-2's flat
  pike-nose front are all visually distinct silhouettes even at 1x. Currently a
  BT-7 and an IS-2 differ only in scale, not shape.
- **Turret/hull composition**: previewed separately so pivot placement can't be fully
  verified from the sheet, but in the live crop the turret sits dead-centre on the hull
  for every vehicle; the original consistently offsets turrets slightly toward the rear
  third for most mediums/heavies (mantlet overhangs the front glacis).
- **No visible road wheels** anywhere — the original always shows 5–8 wheel discs (or a
  wheel/idler count matching the real vehicle) along the track run; ours use a plain
  dashed tick pattern that reads as a hatch strip, not wheels.
- **Barrel thickness is uniform** across all vehicle types (Tiger's 88mm reads the same
  width as PzIII's 50mm or the halftrack's MG) — no caliber differentiation.
- **Knocked-out vehicles**: a plain black square is overlaid on the hull center — this
  reads as "hole", not "wrecked/burning". The original shows scorch/soot darkening
  across the whole hull, a distinctly burnt palette, and (per `ref_1484`) an actual
  smoke plume sprite for freshly-killed vehicles; nothing in our sheet corresponds to a
  smoke/fire overlay for vehicles (only static "smoke puff" terrain effects exist).
- Lighting: flat-shaded, no NW highlight edge / SE shadow anywhere on any hull —
  vehicles look like they're lit from directly above, which is the most visible
  divergence from the original's rendering style.
- Readability at 1x: on grass, tanks read as "a grey/tan blob with a dot," acceptable
  for spotting but not for identifying; on snow (not tested live, but per preview the
  Soviet/German palettes have no snow-camo winter vehicle variant at all — worth
  confirming this is intentional/not-yet-built).

## 3. Team / unit-type icons (force-pool panel)

**Verdict: Needs work**

- Original (`ref_1478.png`) uses clean white side-view silhouettes (soldier profile
  with rifle, gun-carriage profile, tank profile) on a dark maroon panel — highly
  legible at icon size and immediately distinguishes "this is an anti-tank gun" from
  "this is an MG team" from across the panel.
- Ours are small top-down grey stick-figure pairs/trios on olive-green swatches. They
  are legible as "there are 2-3 little grey people" but much less differentiated by
  role — the rifle/SMG/MG icons in particular look nearly identical (a pair of
  vertical grey pegs), and "atgun"/"sniper"/"mortar" rely on one thin line to convey a
  totally different weapon system. The side-view convention from the original conveys
  weapon shape (long AT gun barrel and shield vs. a squat mortar tube vs. a rifle
  slung on a shoulder) far better than our top-down abstraction does.
- Halftrack/tank/spg icons are flat grey rectangles, basically indistinguishable from
  each other except size, mirroring the vehicle-silhouette problem above.

## 4. Flags

**Verdict: Good enough / minor**

Small flag-on-pole with a coloured panel (German=red/black split, Soviet=orange/red,
neutral=white) is a reasonable, legible abstraction at 1x. Not directly comparable to a
reference frame (none of the supplied refs show a clear flag close-up), but nothing here
looks broken. Could use a 1-px darker pole-base shadow to sit better on grass/snow.

## 5. Trees

**Verdict: Needs work**

- **Summer** trees are 3–4 overlapping perfect circles of solid green (`#2f5a2f`-ish)
  with one lighter fleck — reads as "shrub" rather than the original's fluffy,
  irregular, mottled canopy (`ref_1479`) which has visible internal texture (lighter
  and darker green patches suggesting individual clumps of foliage) and a soft
  scalloped outer edge rather than crisp circle arcs. Ours also lack any cast shadow,
  which the original always shows (a dark green-black blob offset SE of the canopy).
- **Autumn** trees reuse the same circle-cluster construction in orange/yellow —
  consistent with summer's approach but same complaint (too geometric, arcs visible).
- **Winter** trees are the weakest: thin grey/tan skeletal branch-lines fanning from a
  trunk, almost no canopy fill. The original's winter trees (`ref_1481/1483/1485`) are
  dense brown/tan mottled "cauliflower" clumps that still read as a solid canopy mass
  dusted with snow — they are bushy, not skeletal. Ours will nearly disappear against
  snow terrain at 1x because they're mostly thin dark lines on a light background,
  whereas the original's clumped canopy has enough fill to stay visible.

## 6. Cursors

**Verdict: Good enough**

Arrow/crosshair/hand/no/move/wait cursor set is clean and functional; no original
reference frame to compare 1:1 against, and nothing here looks broken or illegible.

## 7. Visibly broken / technical issues

- **Halftrack sprite is a mis-shaped tank**, not a rendering bug per se, but functionally
  broken from a readability standpoint — it will be misread as a light tank in play.
- **No burning/smoke overlay found for freshly-destroyed vehicles** in the sheet — only
  static knocked-out hulls (black square) and standalone terrain "smoke puffs" exist;
  if there's no code path connecting the two, destroyed vehicles will never appear to
  be on fire the way `ref_1484`'s burning tank does.
- No rotation-artefact or clipping bugs observed in either the preview sheet or the live
  screenshot — sprites render at expected sizes and don't clip their bounding boxes.
- No sprite frames returned as broken images/placeholders; every category populated.

---

## TOP 10 fix list (ranked, actionable)

1. **Halftrack (SdKfz 251)**: remove the turret/barrel entirely; redraw as an
   elongated open-top hull, lighter interior rectangle for the troop bay, front road
   wheels (2) distinct from rear track run, optional pintle MG as a 1-px stub — must
   stop reusing the tank turret+barrel silhouette.
2. **All tank hulls**: add a track band 2–3 px wide along both long edges in a
   colour ~15% darker than the hull, with 5–8 evenly spaced 1-px-lighter wheel discs
   per side (count scaled to vehicle size) — currently there is no wheel/track detail
   at all, just a dashed hatch-strip tick pattern.
3. **PzIII/PzIV hull colour**: shift from blue-grey (`#6b7a8c`) to a warmer neutral
   grey-green (`#6a6a5a`, shadow `#4d4d42`) to match the original's panzer-grey, which
   reads as grey/green, never blue.
4. **Turret pivot**: move turret anchor to the rear third of hull length (currently
   dead-centre) so the mantlet/barrel overhangs the front glacis by 2–4 px, matching
   the original's silhouette on all mediums/heavies.
5. **Differentiate Soviet armor silhouettes**: T-34 gets a sloped glacis (angled
   1-px hull-front taper) and rounded turret; KV-1 gets taller, slab-sided hull (add
   1–2 px height, square turret corners); IS-2 gets a flat pike-nose front (angled
   nose wedge) — right now BT-7 through IS-2 are the same rectangle at different
   scales.
6. **Knocked-out vehicles**: replace the flat black "hole" square with a full-hull
   scorch pass (desaturate + darken the whole hull ~40%, add irregular black soot
   patches near the turret ring and engine deck) plus wire up the existing smoke-puff
   sprite as an animated overlay for the first few seconds after a kill, matching
   `ref_1484`'s burning-tank look.
7. **Crouching soldier poses**: redraw as a distinct kneeling silhouette (visible
   head, one knee down, rifle held at a diagonal) instead of the current
   featureless blob — add a 1-px darker weapon line at minimum so facing is
   readable at 1x.
8. **Prone soldier poses**: lengthen the body bar and add a thin weapon line
   extending ~3–4 px beyond the body silhouette at a shallow angle, plus a small
   head-end fleck, so prone units don't collapse into a single anonymous smear.
9. **Winter trees**: rebuild as filled mottled canopy clumps (like the summer/autumn
   circle-cluster approach but in muted tan/brown `#8a7a5c` + `#6b5f45` with a light
   snow-dust fleck on top), not skeletal branch-lines — current version nearly
   vanishes against snow terrain.
10. **Team-pool icons**: switch from top-down grey-peg pairs to side-view silhouettes
    (soldier profile with weapon type visible — sling rifle vs. SMG vs. long AT-gun
    barrel-and-shield vs. squat mortar tube) on the dark panel background, matching
    `ref_1478`'s approach, so unit types are distinguishable from across the
    force-pool list rather than all reading as "grey pegs, different quantity."

---

## Files referenced

- Reference stills: `/Users/marski/work/cc3_clone/ref/ref_cc3_1478.png` … `ref_cc3_1485.png`
- Our sprite sheet captures: `/Users/marski/work/cc3_clone/ref/crit_sprites_0.png`
  through `crit_sprites_7000.png`
- Live in-game captures: `/Users/marski/work/cc3_clone/ref/crit_game_0.png`,
  `crit_game_1.png`, `crit_game_vehicles_crop.png`, `crit_game_soldiers_crop.png`
