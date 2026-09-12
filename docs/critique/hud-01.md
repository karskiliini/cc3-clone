# In-Battle HUD Critique vs. Original Close Combat III

Reference captures: `ref/ref_cc3_1479.png` (no team selected — full bottom
panel, team grid, empty combat-message pane, bottom strip), `ref_cc3_1481.png`
(zoomed-out, VL flag "Hill 227", vehicle-crew soldier monitor),
`ref_cc3_1482.png` (soldier monitor with Dead/Pinned states, ammo counts),
`ref_cc3_1483.png` (mid-firefight, KIA rows, Firing/Reloading colour states),
`ref_cc3_1484.png` (village VL, vehicle-crew "Main Gun / Operational" header),
`ref_cc3_1485.png` (VL capture, morale states, ammo bar fill levels), plus
`docs/reference/cc3-manual-notes.md` (Combat Screen / Orders sections).

Ours: `ref/crit_hud_1.png` (running battle, HUD idle), `crit_hud_2.png` (team
selected — team-grid highlight + soldier monitor), `crit_hud_3.png`
(right-click command menu), `crit_hud_4.png` (Alt+Fire LOS line),
`crit_hud_5.png` (zoomed out), plus 2× crops `crop_bottompanel_2x.png` and
`crop_soldiermonitor_2x.png`. All screenshots are 1024×768, so reference and
ours are directly pixel-comparable without rescaling.

**Important caveat / bug that limited this pass:** every one of three test
runs (Auto-deploy → Begin → idle) reverted to the Main Menu on its own
roughly 8–12 real seconds after Begin, with all teams still at their default
Ambush/Defend orders and no visible casualties. That is far too early for a
20-minute battle-length setting to time out, and no side had been wiped out.
This is very likely `stepVictory()` (`src/sim/victory.ts`) mis-firing one of
its end conditions (morale-below-10 check, or the `teams.every(t =>
t.outOfAction)` check evaluating true against an empty/degenerate team list)
rather than an actual battle conclusion — see Top Fix #1. Because of this,
several stateful things (KIA colour states, low-ammo colour states, order-dot
colours/arcs, Truce/Flee outcomes, message-log content) could not be
observed in a long-running battle and are marked **unverified** below rather
than scored.

---

## 1. Bottom panel background / bevels — Needs work

Ref: `ref_cc3_1479.png` bottom ~160px. Ours: `crit_hud_1.png` / same region.

- Base colour and panel split (team grid left ~0–620px, message pane right
  ~620–1024px, bottom strip ~730–768px) match closely. **Good.**
- The reference team-grid boxes have a visible bevel: a faint lighter edge
  top/left inside each cell and a darker seam bottom/right, giving each box
  slight 3D depth against the surrounding dark maroon field. Ours renders
  each cell as a flat rectangle — the only separators are 1px straight
  lines, no light/dark bevel pair. At full-panel scale this reads as flatter
  and more "web UI" than the original's riveted-metal console feel.

## 2. Team grid boxes (icon / name bar / status word) — Needs work

Ref: `ref_cc3_1479.png` (idle: Ambushing/Defending only), `ref_cc3_1483.png`
(mid-combat: Firing/Reloading/KIA/Moving Fast).

- **Name-bar colour coding — Needs work.** In the reference, the coloured
  bar behind the team name is not a fixed colour: idle screenshot 1479 shows
  both green and cyan/teal bars in the same idle Ambush/Defend state (e.g.
  "Group Leader" and "StuG IIIC" green, "Light Infantry" teal — every
  occurrence of "Light Infantry" is teal, suggesting the colour is tied to
  team role/type, not just morale). In active combat (1483) the bar clearly
  tracks unit state: green = OK, yellow = degraded, red = KIA (team wiped),
  white/neutral for "Moving Fast". Ours (`crop_bottompanel_2x.png`) renders
  **every** name bar the same flat green regardless of role or activity
  (Ambushing and Defending both green) — the colour-coding channel that
  carries "is this team dead/suppressed/OK" at a glance is not doing
  anything visually distinct yet in the states we could reach.
- **Status word colour — partial match.** Reference status text is
  colour-coded per activity: "Ambushing"/"Firing" green, "Defending" white,
  "Reloading" white/yellow, "Moving Fast" red-bold, **"KIA" red-bold on a
  darker red bar**. Ours shows "Ambushing" and "Defending" both in plain
  white — matches "Defending" but not "Ambushing" (should be green per
  1479/1483). KIA/Reloading/Moving Fast states were not reachable this pass
  (battle ended before any casualties) — unverified.
- **Icons — Needs work.** Reference icons are small coloured sprite art:
  visible helmet/uniform colour, weapon silhouette, a tiny tank silhouette
  for vehicle teams. Ours renders a flat, monochrome grey glyph (soldier
  outline + a single diagonal line for a weapon) with no colour variation
  between infantry/MG/mortar/vehicle icon types beyond silhouette shape.
  Noticeably less detailed and reads as a placeholder icon set next to the
  reference's small but legible sprite icons.
- **Font — Good, close.** Bold sans, similar size (~11–12px) and weight for
  both name and status text; case and line-wrapping match.
- **Fix approach:** drive name-bar colour and status-word colour off a
  shared per-team state enum (ok=green, suppressed/low-ammo=yellow,
  panicked/moving=orange-red, dead=red on dark-red bar) instead of a single
  static green/white pair, and set "Ambushing" specifically to green text.

## 3. Combat Messages block — Good (structure), unverified (content)

Ref: `ref_cc3_1479.png` right column, header "Combat Messages" bottom-right
in bold orange-red on the dark maroon field, italic-ish condensed font.
Ours: `crit_hud_1.png` right column — header text, position (bottom-right of
the message pane, ~x780–900, y758), colour (orange-red), and weight all
match well. **Good.**

- Message-line content/colour-coding (e.g. green "capture" messages, orange
  "panicking" warnings seen in the manual's messages system) could not be
  observed — our test battle ended before any message accumulated beyond the
  header. Flag as a follow-up capture once Top Fix #1 is resolved.
- Scroll indicators: reference shows small ornamental tag/ribbon-style
  up/down icons around x≈785, y≈655/730 for scrolling the panel. Ours uses
  plain flat ▲/▼ glyphs in a light box at the same general position
  (visible in `crop_bottompanel_2x.png`, right edge). Functionally
  equivalent, stylistically plainer — low priority.

## 4. Bottom strip (Chat/Options, zoom, Map, selected-team box, ammo bars, Truce/Flee) — Needs work

Ref: `ref_cc3_1479.png` bottom ~38px row. Ours: same region, both screenshots
and `crop_bottompanel_2x.png`.

- **Chat / Options stack, zoom "+"/"-", Map button — Good.** Position,
  order (Chat above Options at far left; "+", "Map", "-" in sequence), and
  button styling all match closely.
- **"No team selected" text — Wrong / not in original.** When nothing is
  selected, ours prints the literal string "No team selected" in the middle
  of the strip (`crit_hud_1.png`, x≈200–290, y≈736). The reference never
  shows this text in that slot in any of the 6 supplied captures — that
  area is reserved for the selected team's small soldier-icon row (visible
  once a team is selected, e.g. `ref_cc3_1479.png`'s bottom-left icon row)
  and is simply blank/icon-only when nothing is selected. A literal
  debug/placeholder-style sentence breaks the 1:1 look and should be removed
  in favour of leaving the area blank until a team is selected.
- **Selected-team box (after selection) — Good.** Once a team is picked,
  ours shows a name/status row with small green ammo pips
  (`crop_bottompanel_2x.png`, bottom-left "Rifle Squad / Ambushing" row with
  a strip of green squares) which is structurally consistent with the
  reference's equivalent row.
- **Anti-Pers / Anti-Tank ammo bars — Good.** Tick labels ("2 4 8 16 32 64"),
  two-row layout, and green fill-colour convention all match the reference
  (`ref_cc3_1485.png` shows the same green/yellow graduated fill idea).
  Colour-graduation by supply level (green→yellow→red as seen filled
  partway in 1485) was only seen fully-green or fully-empty in our short
  test — unverified whether intermediate colours are implemented.
- **Truce / Flee — Good.** Position (far right of the strip) and two-button
  stack match the reference exactly.

## 5. Inset map — Good, minor detail gap

Ref: bottom-left ~165×115px box in all reference captures — textured terrain
overview, yellow view-rectangle, small "+"/star markers.
Ours: same size and position in every screenshot, yellow viewport rectangle
present and it tracks the camera correctly (compare `crit_hud_1.png` vs
`crit_hud_5.png` after zoom-out — the yellow box changes size appropriately).

- Reference inset renders actual terrain colours/texture at tiny scale
  (browns/greens, faint building blocks). Ours renders a flatter,
  more cartoon-solid green field with generic "+" tick marks — recognizable
  and correctly positioned, just visually thinner on detail. Low priority.

## 6. Soldier monitor popup — Good, close match

Ref: `ref_cc3_1482.png` (infantry, Dead/Pinned states), `ref_cc3_1483.png`
(KIA), `ref_cc3_1484.png`/`ref_cc3_1481.png` (vehicle crews with a "Main Gun
/ Operational" title row above the crew list).
Ours: `crit_hud_2.png`, close-up `crop_soldiermonitor_2x.png`.

- **Row structure — Good.** Name (bold white) / Role (grey) / Status
  (colour-coded, "Healthy" green matches reference's green "Healthy") on the
  top line, Activity (green, e.g. "Ambushing") / weapon / ammo count on the
  second line — this layout is a strong match to the reference's two-line
  per-soldier row.
- **Scroll indicators — Good.** Small ▲/▼ markers on specific rows
  (`crop_soldiermonitor_2x.png` shows ▲ by row 2, ▼ by row 5) correspond
  reasonably to the reference's own small ▽/▷ row markers in `ref_1482.png`.
- **Weapon/ammo readout — Needs work.** Reference shows a small weapon
  pictogram (rifle/MG/gun silhouette icon) beside the ammo count, sometimes
  with an ammo-type code ("AP", "HE" in `ref_1484.png`/`ref_1482.png`).
  Ours substitutes plain text for the weapon name ("MP40", "MG34", "Kar98k")
  with no icon glyph — readable, but not the reference's icon-first style.
- **Vehicle-crew header row — Unverified.** `ref_1484.png` and `ref_1481.png`
  show a distinct top row for vehicle crews reading "Main Gun / Operational"
  (weapon system name + status) above the crew list. Our test only reached
  an infantry squad's monitor before the battle reset itself (Top Fix #1),
  so it's unconfirmed whether this vehicle-specific header row exists at
  all in our build — needs a dedicated check once the early-reset bug is
  fixed.
- **Dead/Pinned/Crawling colour states — Unverified**, same reason (no
  casualties occurred before reset).

## 7. Command menu (right-click) — Needs work

No exact original screenshot of this menu was supplied; judged against the
manual's description (three categories: Movement, Targeting, Dig-in) and
general fidelity expectations.

Ours: `crit_hud_3.png` — a flat single-column list: Move, Move Fast, Sneak,
Fire, Smoke, Defend, Ambush, all in plain white text on one dark-maroon
panel with no grouping, no colour swatches, and "Fire" shown underlined
(apparently a hotkey-letter indicator).

- **Missing category grouping.** The manual explicitly describes three
  groups (Movement: Sneak/Move/Move Fast; Targeting: Fire/Smoke; Dig-in:
  Defend/Ambush). Ours lists all seven as one undifferentiated column —
  no separators, no visual break between groups.
- **Missing order-colour preview.** The manual defines a specific colour
  per order type (Blue=Move, Purple=Move Fast, Yellow=Sneak,
  Orange=Fire-suppression, Red=Fire-direct, Gray=Smoke, Green
  arc=Ambush, Blue arc=Defend). None of that colour language appears in the
  menu itself — a small coloured square/dot next to each item previewing
  its order-dot colour would both match the original's information density
  and reinforce the colour meanings elsewhere in the HUD.

## 8. Order lines/dots and arcs — Unverified

Not testable this pass beyond the LOS tool (see §9): the battle reset before
we could issue a Move/Fire/Ambush order and observe the resulting dot colour
or arc rendering. Given the manual's precision here (exact colour per order
type), this needs a dedicated follow-up capture: issue each order type and
confirm dot colour matches Blue/Purple/Yellow/Orange/Red/Gray and that
Defend/Ambush draw the specified blue/green arcs.

## 9. LOS tool (Alt + Fire) — Good, partially verified

Manual: bright green = clear LOS, dark green = obscured, red = blocked.
Ours: `crit_hud_4.png` — holding Alt after pressing the Fire hotkey drew a
solid red line with a red terminus dot from the selected squad toward a
point inside a dense orchard/tree cluster. Blocked LOS through trees showing
red is **consistent with the spec**. We did not get a chance to sweep across
open ground before the reset to confirm bright-green/dark-green also render
correctly — worth a quick follow-up check, but what we saw is correct.

## 10. VL flags and labels — Needs work

Ref: `ref_cc3_1481.png` ("Hill 227"), `ref_cc3_1484.png`/`ref_cc3_1485.png`
("North Farm", "to Smolensk") — victory locations render as small
flag-on-pole sprites, coloured by owning side, with a text label beside
them.
Ours: `crit_hud_2.png`/`crit_hud_5.png` ("North Farm", "Orchard") — the VL
marker is a flat red square/dot, not a flag shape, with the same text-label
convention. The label placement and presence is correct; the icon itself is
a placeholder shape rather than a flag sprite.

## 11. Unit status bars — see §2 (name-bar colour coding)

Covered above; the "status bar" is the same coloured name-bar element on
each team-grid row, so no separate scoring here.

## 12. Cursor — Not scored (low confidence)

No reference screenshot clearly isolates a custom cursor graphic (all
reference shots show what could be either a stock OS arrow or a very
similar custom one). Ours uses a plain default pointer throughout. Given the
uncertainty, not scoring this, but worth a quick check against the real game
for any contextual cursor changes (e.g., during LOS/Fire aiming) since the
manual implies the LOS overlay is itself the main "aiming" affordance rather
than a changed cursor.

## 13. Zoom levels / team-info-bar visibility — **Wrong** (functional bug)

Manual, Combat Screen section: "Team information bars only visible at
normal zoom level (hidden when zoomed in/out)." Ours: `crit_hud_5.png`,
taken immediately after clicking the "−" zoom button — every unit still
shows its full name label ("Rifle Squad", "Sniper", "MG34 HMG", "5cm PaK
38", "SdKfz 251") floating above it, exactly as at normal zoom. This
directly contradicts the documented behaviour and clutters the zoomed-out
view, which is supposed to read as a clean tactical overview. This is a
concrete, easily verified functional gap, not a subjective style note.

---

## Broken / notably wrong (quick list)

- **Battle auto-reverts to Main Menu ~8–12s after Begin** with default
  orders and no casualties, across three separate repeated test runs — see
  Top Fix #1. This is the most serious issue found; it blocks normal play
  and blocked several other checks in this critique.
- **"No team selected" literal placeholder text** shown in the bottom strip
  where the original shows nothing (icon-only area) — reads as a debug
  string left in production UI.
- **Zoomed-out view still shows full team-name labels**, contradicting the
  manual's explicit "hidden when zoomed in/out" rule.
- **Team-grid name bars are always flat green** regardless of unit
  role/activity, removing a real information channel the original uses
  (green/cyan/yellow/orange/red per role/state).
- **VL markers are flat squares, not flag sprites.**
- Command menu has no category separators and no order-colour previews,
  despite the manual defining precise per-order colours.

---

## TOP 12 fix list (ranked, executable)

1. **Fix the premature battle-end condition.** In `src/sim/victory.ts`,
   audit `stepVictory()`'s three "ended = true" triggers — (a) `state.time
   >= state.config.durationS` (confirm `durationS` is actually being set to
   1200s for a "20 MIN" battle-length selection, not a much shorter default/
   test value), (b) the per-side `morale < 10` check (confirm starting
   morale isn't already near this threshold for Auto-deployed teams before
   any shots are fired), and (c) `teams.every(t => t.outOfAction)` (confirm
   this isn't vacuously true for a side whose `teams` filter returns an
   empty/degenerate array). Add a temporary console log of which condition
   fired and `state.time` at trigger, reproduce with Auto-deploy + Begin +
   idle, and fix the false-positive.
2. **Remove the "No team selected" placeholder text** from the bottom strip
   entirely when no team is selected; leave that region blank/icon-only to
   match the reference.
3. **Hide team-name labels at zoomed-out (and zoomed-in) camera levels**,
   matching the manual's "only visible at normal zoom" rule — gate the
   label-draw call on the current zoom tier.
4. **Drive team-grid name-bar colour from unit state**, not a constant:
   green = OK/engaged-well, yellow = suppressed/low-ammo, red = KIA (with
   the bar itself going to a darker red, per `ref_cc3_1483.png`), and set
   the "Ambushing" status word to green text (currently white) to match
   `ref_cc3_1479.png`/`ref_cc3_1483.png`.
5. **Replace the flat VL marker with a small flag-on-pole sprite**, coloured
   by owning side (and split/half-and-half when contested, per the manual),
   matching the flag shapes visible in `ref_cc3_1481.png`/`ref_cc3_1484.png`.
6. **Add category separators to the right-click command menu**: a thin
   divider line between Sneak/Move/Move Fast (Movement), Fire/Smoke
   (Targeting), and Defend/Ambush (Dig-in), matching the manual's three
   named groups.
7. **Add a small order-colour swatch next to each command-menu item**: Blue
   (Move), Purple (Move Fast), Yellow (Sneak), Orange (Fire-suppression) /
   Red (Fire-direct), Gray (Smoke), plus Green/Blue arc icons for
   Ambush/Defend — reusing the manual's exact colour table.
8. **Add colour to the team-grid unit icons.** Give infantry icons a
   uniform colour (helmet/tunic tone) and vehicle icons a distinct tone,
   instead of the current flat monochrome grey glyph, closing the gap with
   the reference's small coloured sprite icons.
9. **Add a weapon pictogram to the soldier-monitor ammo line**, replacing or
   supplementing the current plain weapon-name text (e.g. "MP40"), matching
   `ref_cc3_1482.png`/`ref_cc3_1484.png`'s icon + ammo-count(+type) style.
10. **Verify and, if missing, implement the vehicle-crew "Main Gun /
    Operational" header row** at the top of the soldier monitor for vehicle
    teams, as seen in `ref_cc3_1481.png` and `ref_cc3_1484.png` — this
    could not be confirmed this pass due to fix #1.
11. **Add a beveled edge (light top/left, dark bottom/right, 1px each) to
    each team-grid cell** instead of the current flat 1px divider lines, to
    recover the console's slight 3D panel feel visible in
    `ref_cc3_1479.png`.
12. **Do a dedicated order-dot/arc capture pass** once #1 is fixed: issue
    one of each order type (Move, Move Fast, Sneak, Fire, Smoke, Defend,
    Ambush) and confirm dot/arc colours exactly match the manual's table;
    file any mismatches as follow-up fixes since this pass could not reach
    that state.

---

**File written to:** `/Users/marski/work/cc3_clone/docs/critique/hud-01.md`
