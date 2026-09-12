# Menu UI Critique vs. Original Close Combat III

Comparing our screenshots (`ref/shot_*.png`) against the original game captures
(`ref/ref_cc3_1477.png` = Main, `ref/ref_cc3_1478.png` = Requisition) and
`docs/reference/cc3-manual-notes.md`. Debrief screen was not re-captured this
pass (only reachable after playing a full battle to completion) — noted as a
follow-up, not scored.

---

## 1. Main Menu — **Wrong** (poster/buttons), typography Needs work

Ref: `ref_cc3_1477.png` vs ours: `shot_mainmenu.png`

- **Poster painting — Wrong.** The original fills the left ~45% of the screen
  with a painted WW2 soldier leaning toward the viewer, pointing, lit by an
  orange fire glow behind him, over a torn-paper poster edge. Ours shows two
  disconnected dark shapes: a small half-dome near the top and a large plain
  ellipse crossed by one diagonal line lower down, both flat solid fills with
  no shading. This reads as two abstract blobs, not a person — there's no
  head-on-shoulders relationship, no torso bulk, no arm/hand gesture. It does
  not read as a poster figure at all.
  - **Fix approach**: build the silhouette from a small number of *stacked,
    touching* shapes rather than floating ones: a dome (helmet) sitting
    directly on a wider trapezoid (shoulders/torso), with a capsule shape
    (angled rectangle + circle "fist" at the tip) jutting from the shoulder
    across the torso's silhouette edge to preserve the iconic pointing-arm
    gesture. Fill solid near-black-maroon (`#2a1610`), add a 1–2px warm rim
    highlight (`#8a3d18`) along the top/right contour only, since the fire
    glow in the original is behind the figure.
- **Colour ramp / fire glow — Needs work.** Original: near-black brick band
  at top (~90px tall, visible mortar lines) darkening the poster, then a warm
  amber glow (`~#ff9a3c`) concentrated low-center/right behind the figure's
  raised arm. Ours: brick band is a thin ~40px strip, and the orange radial
  glow is centered mid-screen rather than pooling low behind where the
  figure would stand — it reads as a generic vignette, not a fire behind a
  soldier.
- **Logo typography — Needs work.** Original "CLOSE || COMBAT" is a heavy
  condensed slab/stencil-weight face with a beveled orange divider (two
  thick bars with small rivet dots). Ours uses a lighter-weight generic bold
  sans at smaller size, and the "||" is just two plain thin orange
  characters with no bevel/rivets — the logo reads as a placeholder next to
  the original's poster-grade lockup.
- **Buttons — Wrong shape.** Original buttons are torn-metal/flag banners:
  jagged left/right edges (like ripped strips), diagonal gunmetal gradient
  sheen, white bold embossed text with dark outline, and each row **staggers
  to the right** as you go down (fanned-stack look). Ours are plain rounded
  rectangles, straight edges, flat top-to-bottom bevel, no stagger — all four
  buttons share the same left edge. This is the single biggest stylistic gap
  after the poster.
- **Bottom strip — Needs work (minor).** Layout/grouping (Quit/Main/Revert
  cluster, gap, Briefing/History/Map/Soldiers cluster, gap, Options, gap,
  Next) is close to the original. Contrast issue: "Boot Camp (Training)" in
  the main list and "Briefing/History/Map/Soldiers" in the strip are dimmed
  to indicate unavailability, but the dimming is subtle enough that at a
  glance it can read as a rendering bug rather than a deliberate disabled
  state — see fix list item 12.
- **Help line — Good.** Matches original placement/style closely.

## 2. Requisition — **Needs work**

Ref: `ref_cc3_1478.png` vs ours: `shot_requisition.png`

- **Rotated "FORCE POOL" / "ACTIVE ROSTER" stencil text — Good, partial.**
  Present and rotated correctly on the outer edges in orange. Original uses
  a distinct industrial *stencil-cut* face (blocky letterforms with the
  characteristic gaps in closed counters like A/O/R); ours rotates a plain
  bold sans, so it reads as "sideways bold text" rather than a stencil label.
- **Green soldier-strength squares — Good.** Present on the Active Roster
  rows and match the original's concept (small green pip row per team)
  reasonably well.
- **Subtype colour — Needs work.** Original subtype line (e.g. "Mark IIIH")
  is warm yellow/orange. Ours renders subtype/loadout text (e.g.
  "mg40, mg34") in dim gray, which flattens the row hierarchy — name, then
  subtype, then price no longer have distinct colour coding.
- **"Low Points" red warning — Missing.** The original shows a bold red
  "Low Points" label next to under-strength teams in the Force Pool. This
  does not appear anywhere in our Requisition screen. It's a distinctive,
  functionally important warning (players need to know a team isn't at full
  strength before taking it) and should be added.
- **Icons and colour stripe — Needs work.** Original icons are ~28px with an
  adjacent multi-segment colour-coded "barcode" stripe hinting at squad
  composition. Ours uses a much smaller (~16px), monochrome icon with no
  stripe — rows carry noticeably less information at a glance.
- **Active Roster action buttons — Needs work / functional gap.** Original
  has four buttons over the roster: Refit, Rest, Rename, Retire. Ours shows
  three: Details, Retire, Revert — Refit and Rest and Rename are missing
  entirely, and "Revert" (a bottom-strip nav action in the original) has
  been substituted in their place. Either implement Refit/Rest/Rename or,
  if deliberately deferred, keep them visible-but-disabled so the row
  doesn't silently lose functionality.
- **Regular/Armor tabs — Needs work.** Original's active tab inverts to a
  light background with black text plus a small dropdown caret; inactive
  tab is dark with white text. Ours uses a same-style dark button for both,
  distinguished only by a yellow vs. grey text colour — much lower contrast
  between active/inactive states, and no dropdown affordance.
- **Info panel — Good (unverified live).** The description box under Force
  Pool exists with the expected placeholder copy ("Select a unit from the
  force pool to see its description."); we did not confirm it populates
  correctly on row selection — worth a follow-up interaction test.
- **Panel frames — Needs work.** Original panels have a beveled inset border
  (light top/left, dark bottom/right) plus corner rivets, giving real depth
  against the brick/leather backdrop. Ours are flat 1px borders — noticeably
  flatter than the original's metal-panel feel.

## 3. Battle setup (map/force select) — **Needs work** (no direct original ref, judged for internal consistency)

Ref: ours only — `shot_battle.png`. No matching original screenshot was
supplied for this exact screen, so this is judged against the visual
language the other screens establish, plus the manual's terminology.

- Terminology is correct: Side (German/Soviet), Year stepper, Difficulty
  ("Veteran" — matches manual's Recruit/Veteran/Hero), Battle Length. Good.
- Visually this screen is the plainest of the set: section headers (SELECT A
  MAP, FORCE, SIDE, YEAR, DIFFICULTY, BATTLE LENGTH) and controls are all
  flat grey rounded rectangles with no rivets/bevel/stencil treatment at all
  — it doesn't yet share a visual language with Requisition's stencil labels
  or the Main Menu's (target) torn-metal buttons. Once the shared button/
  panel style from the fix list is built, apply it here too for consistency
  rather than leaving this screen as plain grey controls.
- Map thumbnail and description text render cleanly, no overlap issues.

## 4. Operation Briefing — **Needs work**

Ref: ours only — `shot_operation_briefing.png`.

- Campaign banner ("BATTLE 1 OF 5: Operation Barbarossa — June 1941" plus
  scenario blurb) is a reasonable, readable addition not present in the
  single-battle Requisition screen — Good.
- Inconsistency: this screen reuses the Requisition two-column layout but
  **drops the rotated "FORCE POOL"/"ACTIVE ROSTER" stencil labels** that
  appear on the plain Requisition screen. Same widget, missing a signature
  element — should be added back for consistency.
- "Requisition Points Remaining: **-85**" is shown in red. Good use of red
  for an over-budget state, consistent with the "Low Points" warning colour
  language recommended above — but verify this isn't the *default* state a
  campaign battle opens in; a fresh Operation stage opening already 85
  points over budget will read as broken/unfair to a player unless that is
  an intentional "trim your roster before continuing" design.
- Same icon-size / subtype-colour / button-set gaps as Requisition apply
  here since it's the same component.

## 5. Options — **Good**, minor consistency notes

Ref: ours only — `shot_options.png`.

- Layout is clean: GAME OPTIONS / REALISM columns, yellow section headers,
  consistent ON/OFF toggle buttons and +/- steppers. Content matches the
  manual's realism list (Always See Enemy, Never Act On Initiative, Always
  Have Full Enemy Info, Always Obey Orders) — correct set, correct labels.
- Same flat 1px panel border as Requisition/Battle — once the beveled panel
  treatment is built, apply it here too.
- No overlap or readability issues found.

## 6. Debrief — Not captured this pass

Only reachable after a battle plays to completion; not screenshotted in this
round. Flagging as a follow-up: capture and compare against the manual's
described Debriefing fields (Force strength, Casualties, Land gained, arrow
over/under-performance ratings) once reachable.

---

## Broken / notably wrong (quick list)

- Main menu poster figure reads as two unrelated dark blobs, not a soldier —
  see fix list #1/#2.
- Main menu buttons have zero stagger (original clearly fans each row to the
  right) — flat/uniform instead.
- Requisition is missing the red "Low Points" warning entirely — a
  functionally meaningful state, not just decoration.
- Requisition Active Roster header lost 2 of 4 original actions
  (Refit, Rest) and substituted a nav action (Revert) in their place.
- Operation Briefing drops the rotated FORCE POOL/ACTIVE ROSTER labels that
  the otherwise-identical Requisition screen has — inconsistent, looks like
  an oversight rather than a design choice.
- Operation Briefing's default "-85" Requisition Points Remaining should be
  double-checked — if it's the screen's initial/default state rather than a
  result of player edits, that's confusing.
- "Boot Camp (Training)" (main menu) and "Armor" tab (Requisition) use a
  dimming so subtle it can be mistaken for a contrast bug rather than a
  disabled/inactive affordance.

---

## TOP 12 fix list (ranked, executable, with exact values)

1. **Rebuild the main-menu poster silhouette as one stacked figure.** Dome
   (helmet) directly on top of a trapezoid (shoulders/torso, wider at top),
   with a capsule arm + circular "fist" angled up-and-out from the shoulder
   crossing the torso edge (preserve the pointing gesture). Fill
   `#2a1610`, add a 1–2px rim highlight `#8a3d18` along the top/right edge
   only. Position roughly `x: 60–480, y: 140–620` in a 1024×768 canvas.
2. **Replace all menu buttons (main-menu list + bottom strip) with a
   torn-banner shape**: irregular polygon left/right edges (~6–8px random
   jitter per edge segment), diagonal gunmetal gradient `#3a3a3a → #1a1a1a`,
   2px outline `#0d0d0d`, 3px offset black drop shadow at 40% opacity, white
   bold text with a 1px dark outline/emboss.
3. **Stagger the main-menu list buttons horizontally.** Shift each
   successive row +28px right: e.g. `x = 460` (Play A Game), `488` (Boot
   Camp), `516` (3rd item), `544` (4th item), same y-spacing as now.
4. **Fix the poster colour ramp.** Darken/extend the top brick band to
   ~90px tall, near-black `#150d0a`, with visible mortar-line texture.
   Concentrate the amber glow (`#ff9a3c` falloff) low-center/right, behind
   where the figure's raised arm sits, rather than a generic mid-screen
   vignette.
5. **Strengthen the logo.** Increase "CLOSE || COMBAT" to a heavier
   condensed bold face (Oswald/Anton-style), ~34–38px. Render the "||"
   divider as two 6px-wide beveled orange bars (`#e0611c`) with 2px rivet
   dots at top/middle/bottom.
6. **Add the "Low Points" warning to Requisition rows.** Bold, 11–12px,
   colour `#ff3b30`, placed after the subtype text and before the cost
   column, shown whenever a Force Pool team is below full/authorized
   strength.
7. **Recolour Requisition subtype text.** Change from grey to warm
   yellow/orange `#e8a33d`, bold-italic, ~11px, directly under the unit
   name line.
8. **Enlarge Requisition/roster icons and add the composition stripe.**
   Icon size 16px → 26–28px square with a 1px dark border; add a 4-segment
   colour-coded stripe (each segment ~3×14px) between icon and name text.
9. **Give all panels a beveled, riveted frame.** 2px light edge `#6b3a22`
   on top/left, 2px dark edge `#170a06` on bottom/right, plus a 4px corner
   rivet dot (`#0d0d0d` fill, 1px lighter highlight) at each corner. Apply
   uniformly to Force Pool, Active Roster, Info panel, Options panel, and
   Battle-setup panels.
10. **Fix the Regular/Armor tab states.** Active tab: light background
    `#e8dcc8`, black bold text, small `▼` caret at 10px right padding.
    Inactive tab: dark `#2a2a2a` background, white text. Restore the
    Active Roster header to 4 actions (Refit, Rest, Rename, Retire) —
    implement them or render them visibly-disabled rather than omitting.
11. **Add rotated stencil labels to Operation Briefing.** Reuse the
    Requisition screen's vertical "FORCE POOL"/"ACTIVE ROSTER" labels
    (orange `#ff7a1a`, condensed/stencil face, 2px letter-spacing) on the
    Operation screen's identical two-column widget, currently missing them.
12. **Fix low-contrast disabled states.** For "Boot Camp (Training)" (main
    menu) and inactive tabs/buttons generally, use a clear disabled
    treatment — 45% opacity plus desaturation — instead of a small text-
    colour dim, so disabled vs. enabled is unambiguous at a glance.

---

**File written to:** `/Users/marski/work/cc3_clone/docs/critique/menus-01.md`
