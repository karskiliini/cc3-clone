# Live-battle effects critique — Border Crossing, 1941, German auto-deploy

Method: dev server at localhost:5173, Playwright automation. Reached Deploy via
Play A Game → Border Crossing → Next ×2 → Auto → Begin, then issued Move Fast
orders to two rifle squads (into a wood and across a wheat field) and a Move
order to a PzKw III J tank, and watched ~2-3 minutes of the resulting firefight
around a farm ("North Farm" VL). Screenshots saved to `ref/crit_fx_*.png`
(prefixed by stage: `fast*`/`pak*`/`mortar*`/`corpses*`/`t*s` etc.); references
used: `ref/ref_cc3_1482..1485.png`, `docs/reference/cc3-manual-notes.md`.

Code paths reviewed: `src/render/effects.ts` (flashes/tracers/explosions/
burning-vehicle smoke), `src/render/unitRender.ts` (soldiers, corpses, order
lines/arcs, status bars, flags), `src/sim/combat.ts` (pushes the effect
records), `src/ui/hud/*` (message panel, team grid, soldier monitor).

## Per-element verdicts

**Muzzle flashes** — Not observed (code present but never caught on screen).
`effects.ts` draws a 2x2 `#fff6c8` core plus a 4x1/1x4 `#ffe08a` cross at the
shooter, but `FLASH_LIFE = 0.1` seconds. At the sim's frame rate that's roughly
one rendered frame; across ~40 screenshots taken during active, continuous
firefights (`crit_fx_pakburst*`, `crit_fx_mortarburst*`) not one caught a
flash. Verdict: **Needs work** — not necessarily invisible in real 60fps play,
but far more fleeting than CC3's flashes, which stay legible for several
frames. Recommend raising `FLASH_LIFE` to ~0.25-0.35s and/or drawing 1 extra
"linger" frame at half alpha.

**Tracers (small arms vs MG vs tank gun)** — Not observed on screen despite
many confirmed kills by rifle squads, MG, PaK 38 and mortar in the same
windows. Code (`drawTracers`) differentiates only `shell` (2px, `#ff9a3c`,
0.9 alpha) vs everything else (1px, `#ffe08a`, 0.8 alpha) — small-arms and MG
tracers are visually identical, no distinction by weapon class. `TRACER_LIFE
= 0.15s` is even shorter than the flash. Verdict: **Needs work**. The
original clearly shows tracer streaks (yellow for small arms/MG) that are
visible for a beat each burst; ours are coded correctly in principle (right
colors, right endpoints) but the lifetime is too short to ever be perceived,
and there's no MG-vs-rifle distinction (rate/width) at all.

**Bullet impacts** — Not clearly observed. `combat.ts` pushes an explosion
of `kind: 'small'` (a flat 4x4 `#8a8a86` square, 0.8 alpha, faster fade) for
some impacts, but never caught it in ~90 screenshots. Verdict: **Not
observed** — can't confirm it renders distinguishably from a HE puff; same
short-lifetime issue likely applies.

**Grenade/mortar/HE explosions** — Not caught mid-burst, but craters (the
persistent aftermath) were clearly visible and match the reference well: small
round tan/brown starburst patches on the terrain near "North Farm"
(`crit_fx_mortar_view.png`, `crit_fx_pakburst2.png`) resembling
`ref_cc3_1485.png`'s craters. The transient HE flash/smoke-ring code
(`drawExplosions`, kind `he`) looks reasonable on paper (expanding gray ring +
orange core + 6 ember pixels, `EXPLOSION_LIFE = 1.0s` — an order of magnitude
longer than flashes/tracers) but was never actually seen rendering in a
screenshot despite an active mortar barrage ("Krämer ... Firing", multiple
"Enemy soldier killed by 8cm Mort" messages). Verdict: **Needs work** —
craters (Good) but the explosion animation itself unconfirmed; worth a
deliberate visual smoke test since 1s life should have been catchable.

**Smoke rounds / smoke clouds** — Not observed in this session (no Smoke
order was issued, and none occurred by AI in this window). Code exists
(`kind: 'smoke'` explosion → expanding `#c9c9c0` circle, r 4→14px, 0.5 alpha,
1s life) but is untested here. Verdict: **Not observed**.

**Burning / knocked-out vehicles** — Not observed (no vehicle was destroyed
during the session; both German tanks survived their Move order unengaged).
Code review: `drawBurningVehicles` draws a 3x3 flicker pixel (`#ffcf6a`/
`#ff8a3c`) plus 3 rising smoke puffs via `getSmokePuff(16)` with vertical
drift and fade. This is much sparser than the reference
(`ref_cc3_1483.png`, `ref_cc3_1485.png` show a large sustained fire+smoke
plume, often taller than the vehicle itself, with visible flame color at the
hull). Verdict: **Needs work** (by inspection) — a 3px flicker and 3 puffs at
16px each will read as a faint campfire rather than the "vehicle brewing up"
plume in the reference; scale the puff sprite/count up and add a small
flame-colored triangle/blob at the hull, not just a 3x3 flicker.

**Craters** — **Good.** Round tan/brown patches persist correctly on
terrain at mortar/AT-gun impact sites and read close to the reference's
starburst craters (`ref_cc3_1484.png`).

**Corpses / blood** — Partially good. Dead soldiers render as a distinct
lighter/tan prone sprite (`getSoldierSprite(..., 'dead', ...)`) and correctly
persist at the position of death — confirmed visually after a PaK 38 crew was
wiped out (`crit_fx_corpses1.png` shows the prone corpse cluster at the old
gun position, tan/beige and clearly different from live soldier sprites).
No blood/blood pool decal at all, and no color distinction between own/enemy
dead. Reference doesn't show much blood either at this zoom, so this is a
**Good** call for the corpse sprite itself, but flag the missing "Dead"
name-tag/label that the original overlays on the soldier monitor entry
(we do get "Dead" text in the soldier monitor list, so that part is fine —
see soldier-monitor section).

**Soldier walk/run/crawl animation and posture changes** — **Good.** Verified
directly: on Move Fast order, soldier icons visibly switched from standing
"idle" posture to a running posture (small green running-man sprites,
`crit_fx_fast4_order1done.png`, `crit_fx_fast7_order2done.png`) and the
soldier-monitor activity word changed to "Running" for every crew member in
sync with the order. `unitRender.ts` also derives `prone` stance automatically
for incapacitated soldiers. Two-frame walk cycle (`frameOf`) is minimal
(matches CC3's own simplicity) — no complaint.

**Order lines / dots / arcs** — **Good**, and colors matched the manual
exactly on inspection: Move `#3c6cff` (blue), Move Fast `#b040e0` (purple),
Sneak `#f0e040` (yellow), Fire `#e02020` (red, or `#e08a2c` orange for bare-
point suppression fire), Smoke `#a0a0a0` (gray), Defend arc `#3c6cff` (blue),
Ambush arc `#30c030` (green) — all confirmed against
`ORDER_DOT_COLOR` in `src/shared/types.ts` and visually: the finalized Move
Fast order line rendered purple (`crit_fx_fast4_order1done.png`), the tank's
Move order rendered blue (`crit_fx_fast10_tankorder.png`). One inconsistency:
immediately after picking "Move Fast" from the context menu but before the
final destination click, the line tracking the cursor rendered **yellow**
(`crit_fx_08_movefast_line.png`), not purple — i.e. the live "aiming" preview
segment doesn't yet use the order's own color, only the committed line does.
Minor but worth fixing so the preview matches the final color from the first
frame.

**Selected-team status bars** — **Good.** A 12x3 tri-color bar appears above
each living soldier of the selected team (green `#5fbf4a` healthy, yellow
`#e0c04a` pinned/wounded/cowering, red `#c8402c` incapacitated/panicked/
routed/berserk) — matches the manual's "colored name bars indicate morale/
status" concept, confirmed on-screen as small green ticks over the selected
squad. Team-grid boxes at the bottom also flip background/text color by
order/activity state (e.g. red "Moving Fast"/"KIA", yellow "Firing", matches
`crit_fx_fast4_order1done.png`, `crit_fx_redoE.png`).

**VL flags** — **Good.** A small flag icon plus outlined name label ("North
Farm") rendered at the objective, matching the manual's flag mechanic
(`crit_fx_mortar_view.png`). Contested-flag split-color code exists
(`drawFlags`) but wasn't observed triggering (no VL was contested this
session).

**Message panel content** — **Good.** The bottom-right "Combat Messages"
panel populated with specific, CC3-flavored lines during the fight: "Enemy
soldier killed by 5cm PaK", "Gefr. Seidel has been killed", "Enemy team is
routing", "Rifle Squad has broken", "Schtz. Werner has been incapacitated" —
this closely matches the reference's message style (`ref_cc3_1482.png`,
`ref_cc3_1485.png` show similar "lost target", "is panicking", "Mark IVD is
Burning" phrasing). No complaints.

**Soldier-monitor state words** — **Good.** Confirmed live transitions:
"Ambushing" → "Running" (Move Fast issued), "Healthy" → "Dead" (crew killed),
"Assisting" role labels for loader/assistant positions, "Main Gun:
Operational" header for tank crews — matches manual vocabulary (Healthy,
Incapacitated, Panicked, Dead, Ambushing, Assisting, Firing all seen
verbatim). One team went to "Assisting" / a squad showed "has broken" in the
message feed, consistent with manual's morale-state list.

## Top 12 fix list (ranked, executable)

1. In `src/render/effects.ts`, raise `FLASH_LIFE` from `0.1` to at least
   `0.25` and `TRACER_LIFE` from `0.15` to at least `0.3`, so a fired shot is
   visible across multiple render frames instead of vanishing inside one.
   This is the single highest-impact fix — muzzle flashes and tracers were
   never once observed across ~90 screenshots of active firefights.

2. In `drawTracers` (`src/render/effects.ts`), give MG tracers a distinct
   look from rifle tracers — e.g. slightly thicker line (`lineWidth = 1.5`)
   and a brighter/more saturated yellow, or draw 2-3 short parallel tracer
   segments for automatic weapons — driven by a new `kind: 'mg'` in
   `state.tracers` set from `src/sim/combat.ts` wherever the firing weapon's
   `type` indicates a machine gun.

3. In `drawBurningVehicles` (`src/render/effects.ts`), scale up the burning-
   vehicle effect: increase `puffCount` from 3 to 5-6, use a larger smoke
   sprite (`getSmokePuff(28)` instead of `16`) with more vertical rise
   distance (currently only `phase * 8`), and add a small flame-colored
   (`#ff8a3c`/`#ffcf6a`) triangle or blob anchored at the hull center that's
   visible even without the flicker RNG passing threshold, so a burning tank
   reads as clearly on-fire at a glance like `ref_cc3_1483.png`.

4. Fix the order-line preview color: find where the context-menu "Move Fast"
   selection sets up the drag/aim line (likely in an input/order-preview
   module feeding `unitRender.ts`'s `drawOrderLine`, or a separate preview
   line drawn before the order is committed) and make it use
   `ORDER_DOT_COLOR[order.type]` immediately on order-type selection instead
   of a hardcoded/yellow default, so the aiming line matches the final
   committed line color from the first frame (seen: yellow while aiming,
   purple after commit).

5. In `src/sim/combat.ts`, verify the `kind: 'small'` bullet-impact explosion
   actually fires for every non-hit tracer resolution (not just kills) and
   consider giving it a brief (~0.05s) tan puff-dust visual distinct from the
   gray HE ring, since at present it's visually indistinguishable from a
   miss with no visible effect at all in practice.

6. Add smoke-round visual confirmation: force-trigger a Smoke order in a
   manual QA pass and confirm `kind: 'smoke'` explosions in `drawExplosions`
   actually render the expanding `#c9c9c0` circle — this path was never
   exercised in this session and its correctness is unverified.

7. In `drawCorpses` (`src/render/unitRender.ts`), add a subtle side-colored
   (blood-red, 1-2px) ground mark under freshly-dead soldiers for the first
   few seconds, since currently corpses are visually correct but there's zero
   blood/impact residue, making mass casualties (e.g. a wiped-out gun crew)
   read as sleeping rather than killed until you check the soldier monitor.

8. In `src/render/effects.ts`'s `drawExplosions`, the HE explosion's ember
   particles (`for (let i = 0; i < 6; i++)`) are single pixels — bump to 2x2
   and randomize their radius slightly per-frame (using `hash2`) so the burst
   reads as a puff of debris rather than a static ring of 6 dots.

9. Add a distinct tank-gun muzzle flash: currently `drawFlashes` uses the
   same tiny 2x2/cross flash for every weapon type. For `kind: 'shell'`
   tracers, draw a larger flash (e.g. 4x4 core plus a brighter/longer
   cross) at the firing vehicle's turret muzzle to match the reference's more
   dramatic tank-gun firing look.

10. Confirm and, if needed, extend `EXPLOSION_LIFE` interaction with the
    render loop: an active mortar barrage produced multiple confirmed kill
    messages but no HE burst was ever caught on screen even though its
    `EXPLOSION_LIFE = 1.0s` should be easily catchable at normal frame rates
    — investigate whether `state.explosions` entries are being cleaned up
    before they're drawn (an ordering bug between the sim tick and the render
    tick), since this doesn't fit the "too short to see" explanation that
    applies to flashes/tracers.

11. In `src/ui/hud/teamGrid.ts` / `unitRender.ts`, when a soldier's `health`
    is `wounded`/`incapacitated`, consider color-coding the corpse/casualty
    sprite itself (not just the status bar) so a glance at the map — not just
    the soldier monitor — distinguishes "down but alive" from "dead", closer
    to the original's on-map readability.

12. Double check `drawSelectedTeamBars` only draws for the *selected* team
    (per its own comment) — the manual describes team info bars as visible
    "above each team in normal view" for *all* teams at normal zoom, not only
    the selected one; consider adding a low-key always-on variant (dimmer/
    smaller) for unselected friendly teams so the battlefield reads more like
    the reference's constant colored-bar overlay rather than only lighting up
    on selection.

## Broken / environmental notes

- **No genuine "return to main menu" bug found.** Several times during
  testing the browser tab suddenly showed the main menu instead of the
  battle. In every case this was confirmed via `p.on('console')` /
  `browser_console_messages` to be a real Vite HMR full-page reload
  (`[vite] (client) page reload src/render/terrainRender.ts` etc., and once a
  `server connection lost. Polling for restart...` + WebSocket
  `ERR_CONNECTION_REFUSED` sequence when the dev server process itself
  briefly died), caused by another agent actively editing terrain/map files
  in this same repo during the session (`/tmp/vite.log` shows reloads every
  5-25s for a ~5 minute stretch, e.g. `2.31.44` through `2.34.26`). This is
  purely a shared-dev-server artifact, not an app bug — the app's own logic
  never dropped back to the main menu on its own.
- **Render loop appears to stall when the automation tab isn't the OS-level
  foreground window.** Repeated `page.screenshot()` calls spaced 200ms-1.5s
  apart inside a single script often returned byte-identical images (verified
  via `md5`) for 10+ consecutive captures, even while the combat-message log
  and soldier-monitor state were demonstrably advancing (confirmed by
  separate tool invocations bracketing the frozen run). This looks like
  Chromium throttling `requestAnimationFrame` for a backgrounded/non-visible
  tab under the CDP-driven harness; the sim clearly keeps ticking
  independently of the paint loop. This made it effectively impossible to
  reliably screen-capture short-lived effects (flashes/tracers) in this
  session — a testing-harness limitation, not a confirmed game defect, but it
  does mean fixes #1/#2/#10 above should be verified with a real, focused,
  non-automated browser window before/after.
- No z-order problems, no crashes, and no other console errors observed
  (checked via `browser_console_messages` at `error` level: 0 errors besides
  the expected WebSocket-reload noise above).
- No performance stutter observed in the frames that did render (screenshots
  were crisp, terrain baked in 17-45ms per chunk per the `[terrain] baked
  chunk` logs, well within budget).

Report file: `/Users/marski/work/cc3_clone/docs/critique/effects-01.md`
Screenshots: `/Users/marski/work/cc3_clone/ref/crit_fx_*.png` (see especially
`crit_fx_fast4_order1done.png`, `crit_fx_fast10_tankorder.png`,
`crit_fx_pak_view.png`, `crit_fx_mortar_view.png`, `crit_fx_corpses1.png`).
