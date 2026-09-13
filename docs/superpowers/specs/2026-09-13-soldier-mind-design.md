# Soldier mind — individual psychology, beliefs and order-following

Date: 2026-09-13. Extends §6.7 of the main design spec. Requested by the user:

> Each soldier is an individual who attempts to follow his order as well as he can, based on his mental
> state and experience. Mental state is affected by morale, motivation, experience, know-how. Morale is
> affected by incoming fire, fatigue, being surrounded, helplessness, being pinned down, noise,
> explosions. That can drive an inexperienced soldier into panic; a panicked soldier can't act. Each
> soldier has his own internal state machine of mental state, order, what he sees and how he can act.
> He remembers where he saw enemies (a hunch). Only when he sees as many dead enemies there as he
> believed, or after a long time, does he feel the enemy is gone. Incoming fire counts as enemy presence;
> if he can tell the direction, he stays alarmed and wary of that direction.

## 1. Data (see `SoldierMind` in `src/shared/types.ts`)

Per soldier: `state` (mental state), `motivation` 0..100 (slow), `stress` 0..100 (fast), `fear` 0..100
(derived), `beliefs[]` (remembered enemy positions), `threatDir`/`threatLevel` (perceived danger
direction), `lastIncomingAt`, `hesitation` (seconds left before acting on a new order), `flags`
(surrounded, helpless).

Know-how = `experience` (0..100, existing). Motivation starts from experience and unit quality
(conscript 30–50, regular 50–70, elite 70–90; leaders +10) and drifts: +0.02/s with the leader alive
within 15 m and side morale > 50; −0.05/s when the leader is dead; −0.1/s while helpless.

## 2. Stress inputs (per sim step, added to `stress`, each scaled by `(1 − cover·0.5)`)

| Event | Stress |
| --- | --- |
| Near miss (round lands within 1.5 tiles) | +6 rifle, +9 MG/SMG round, +14 shell |
| Explosion within 20 m | +30·(1 − d/20) |
| Noise: MG burst or gun/explosion within 100 m (not near miss) | +1 |
| Teammate killed / wounded in sight | +14 / +7 (×2 if leader) |
| Own wound | +25 |
| Enemy tank in sight and no AT weapon in team | +0.6/s |
| Surrounded: high-confidence beliefs on ≥ 3 of 4 quadrants within 60 m | +2/s |
| Helpless: no ammo, or pinned with no cover, or target unreachable | +1/s |
| Fatigue > 70 | +0.5/s |

Decay: −4/s when `threatLevel` < 0.3 and no incoming fire for 10 s; −2/s otherwise; −6/s if the leader is
alive within 10 m and calm.

`fear = clamp(stress·(1.25 − experience/200 − motivation/400) − (morale − 50)/5, 0, 100)`.
`morale` (existing) additionally drifts down 0.3/s while fear > 60 and up 0.2/s while fear < 20.

## 3. Mental state machine (hysteresis, checked every step)

```
calm ─(sees enemy / hears fire)→ alert ─(threatLevel>0.5)→ wary
wary/alert ─(fear>40)→ shaken ─(suppression>60)→ pinned ─(suppression>85 or fear>70)→ cowering
cowering ─(fear>80 and (experience<50 or morale<25))→ panicked ─(morale<10)→ broken (routed)
any ─(teammate killed, experience>70, morale>60, 5%)→ berserk (20 s)
```
Recovery goes back one step at a time with delays: panicked→cowering after fear < 60 for 5 s;
cowering→pinned after suppression < 70; pinned→shaken after suppression < 40; shaken→wary after
fear < 30 for 5 s; wary→alert after threatLevel < 0.3; alert→calm after 20 s without any enemy belief
of confidence > 0.3. Leader alive within 10 m halves all recovery delays; a dead leader doubles them.

Effects:
- **calm**: acts normally.
- **alert**: faces the nearest belief/threat direction when idle; spotting bonus toward beliefs.
- **wary**: moves in crouch (sneak posture within 60 m of a belief), keeps facing `threatDir`, prefers
  waypoints with cover ≥ 0.3 (path via cover: request a path whose cost adds (1 − cover)·2 for tiles
  in LOS of the threat direction — cheap version: bias the formation offset toward cover tiles).
- **shaken**: accuracy ×0.7, hesitation 1–4 s before executing a new order (inexperienced longer),
  may drop from standing to crouching.
- **pinned**: prone, does not move, fires at 30% rate.
- **cowering**: prone, no firing, no movement.
- **panicked**: cannot act at all: ignores orders, does not fire; either freezes prone or runs
  directly away from `threatDir` to the nearest cover ≥ 0.4 within 25 tiles, then freezes.
- **broken**: routes to the friendly edge (existing routed behaviour).
- **berserk**: charges the nearest belief, fires at will, accuracy ×1.2, ignores suppression.

## 4. Following orders "as well as he can"

Each soldier evaluates his team order independently every step:
- Obedience probability per new order = clamp(0.5 + motivation/200 + experience/400 − fear/150).
  On failure the soldier hesitates `hesitation = 1–5 s` (longer for low experience) before retrying.
- Movement orders: the soldier walks his own path; while `wary`/`shaken` he pauses 1–2 s at cover tiles
  when `threatLevel` > 0.5 (bounding by individual), and stops to return fire if fired upon within 60 m
  unless the order is Move Fast.
- Fire/defend/ambush: target choice uses beliefs when no enemy is visible: MG/LMG gunners and rifles
  may put suppressive fire on a belief of kind `fired` with confidence > 0.6 that they have LOS to
  (every 3rd opportunity, to conserve ammo); ambushers hold fire until an enemy is *seen* within 30 m.
- A panicked or cowering soldier does nothing; a pinned one holds.

## 5. Beliefs (memory of the enemy)

`EnemyBelief { pos, count, confidence 0..1, kind: 'seen'|'fired'|'reported', time, deadSeen }`, max 8
per soldier, merged when within 4 tiles of an existing belief.
- Spotting an enemy → belief `seen`, confidence 1, `count` = enemies seen at that spot (cluster within
  4 tiles), `time` now.
- Being fired upon: if the shooter is spotted → belief at the shooter (`fired`, 0.9); otherwise, if the
  soldier has LOS along the incoming direction, set `threatDir` toward the shooter, `threatLevel` 1,
  and add a belief 60 m out along that direction (`fired`, 0.5); if no direction can be judged,
  `threatLevel` 0.6 with `threatDir` unchanged (general alarm).
- Sharing: every 2 s the leader broadcasts his beliefs to teammates within 30 m as `reported`,
  confidence ×0.7; teammates within 10 m share among themselves.
- Decay: confidence −1/120 per second (gone in 2 min if never refreshed); a belief refreshed by a new
  sighting resets. Clear view: if the soldier has LOS to the belief position and sees no enemy there,
  confidence halves every 10 s. Dead enemies: each dead enemy soldier visible within 4 tiles of the
  belief position is counted in `deadSeen`; when `deadSeen ≥ count` the belief is removed and stress
  drops by 10 ("they're dead"). Beliefs are removed at confidence < 0.1.
- `threatLevel` decays 0.1/s; `threatDir` is kept while `threatLevel` > 0.2; any belief with confidence
  > 0.5 keeps `threatLevel` ≥ 0.4 and `threatDir` toward the strongest belief.

## 6. Spotting interaction

`updateSpotting` gives each spotter a bonus (×1.5) for enemies within 15° of his `threatDir` or within
6 tiles of one of his beliefs; soldiers facing away from the threat (>90°) get ×0.6.

## 7. HUD

Soldier monitor activity column shows the mental state word when it is not `calm`/`alert`:
`Wary`, `Shaken`, `Pinned`, `Cowering`, `Panicked`, `Broken`, `Berserk` (colours: wary white, shaken
yellow, pinned/cowering orange, panicked/broken red, berserk magenta). Team status derives from the
majority state as before.

## 8. Tests

- Stress accumulates from near misses and decays; fear depends on experience (same stress → higher
  fear for experience 20 than 80).
- State transitions with hysteresis: calm→alert→wary→shaken→pinned→cowering→panicked and back with
  delays; a panicked soldier ignores orders and does not fire.
- Beliefs: created on sighting and on incoming fire; shared by the leader; removed when enough dead
  enemies are seen; halved under clear view; expire after 2 min.
- Surrounded flag from three-quadrant beliefs; helpless from no ammo.
- Harness: battles still balanced (attacker win rate 40–60%, hit rate 3–8%).

## 9. Automatic, directional cover seeking (user request)

> Soldiers look for cover automatically: any terrain that blocks towards a direction they want to
> defend against. With multiple danger directions, look for cover that protects from all of them.

Directional cover model (`src/sim/cover.ts`):
- `coverFrom(map, tile, dirRad)` returns 0..1 protection against fire arriving from `dirRad`:
  the tile's own omnidirectional cover (trench 0.8, crater 0.5, building interior 0.5, rubble 0.5,
  woods 0.45) plus **linear cover** from the neighbouring tile on the threat side (the tile 1 step
  toward `dirRad`, and the two diagonal neighbours at half weight): stonewall 0.7, buildingStone/Wood
  wall 0.85/0.6, hedge 0.3, fence 0.05, rubble 0.4, scatteredtrees 0.25, a knocked-out vehicle 0.6.
  Linear cover counts fully when the fire direction is within 45° of perpendicular to the feature and
  fades to 0.2 when parallel (manual: "poor protection against parallel fire").
- `coverScore(map, tile, threats)` = Σ over threats of `weight_i · coverFrom(tile, dir_i)` where
  weights are belief confidence / threat level, normalised; ties broken by omni cover.
- Ballistics uses directional cover: `hitChance(...)` takes `coverFrom(map, targetTile, angle from
  target to shooter)` instead of the omni `soldier.cover`; `soldier.cover` becomes the omni value for
  display only.

Behaviour (`src/sim/coverSeek.ts`, called from movement/orders each step, max once per 2 s per soldier):
- Threat set = the soldier's beliefs (confidence > 0.3) + `threatDir` (weight `threatLevel`) + the
  team's Defend/Ambush facing (weight 0.5). If the set is empty, no seeking.
- **Defend/Ambush/idle (not moving)**: search tiles within 6 tiles of the *ordered* position (never
  farther, so the order is still obeyed), score = coverScore − 0.03·distance; move to the best tile if
  its score beats the current tile's by ≥ 0.15; keep the team formation loose (no two soldiers on one
  tile). Re-evaluate when the threat set changes (new belief/direction).
- **Moving/Move Fast/Sneak**: while `threatLevel` > 0.5 the soldier bounds: at each waypoint choose the
  next intermediate stop as the best-scoring tile within 5 tiles along the path direction; Move Fast
  skips bounding (runs straight, per the original).
- **Pinned/cowering**: crawl to the best cover tile within 3 tiles if it improves the score by ≥ 0.2;
  otherwise stay prone.
- **Panicked**: runs to the nearest tile with cover ≥ 0.4 against the strongest threat within 25 tiles.
- Vehicles do not seek cover (crews are inside); AT guns and MGs seek cover keeping LOS to their facing.
- The AI side uses the same behaviour (no special casing).

Tests: coverFrom is higher behind a wall against perpendicular fire than parallel; a defending soldier
with one threat moves behind the wall on the threat side; with two opposite threats he prefers a
trench/crater (omni) over a single wall; a soldier never leaves the 6-tile radius of his ordered spot.

## 10. Tank crews and cover (user request)

> A tank only looks for cover if it notices another tank or is hit by anti-tank weapons, or an
> anti-tank round flies by and the crew notices it. Then they are alarmed and, if the danger is real,
> may automatically go for cover — backing the tank behind a building, never turning around and
> exposing the weaker side to the enemy.

- Vehicle crews share one `mind` (the commander's). Crews are NOT alarmed by small arms, mortar
  fragments or infantry sightings; they are alarmed only by: (a) spotting an enemy tank/SPG/AT gun/AT
  team within 400 m (`threatDir` toward it, `threatLevel` 0.7), (b) any AT hit on the vehicle
  (penetrating or not: `threatLevel` 1, belief at the shooter if spotted, else along the impact
  direction), (c) an AT/tank round passing within 3 tiles (`threatLevel` 0.8, direction from the
  tracer origin if the crew has LOS that way).
- "Whether the danger is real": compute `danger = P(penetration)` of the strongest known AT threat
  against the vehicle's FRONT armour at its range (ballistics.penetrates expectation). If
  `danger < 0.15` the crew stays and fights (keeps the front toward the threat, turret on it). If
  `danger ≥ 0.15` and the vehicle is not immobilised, it seeks cover.
- Cover for vehicles = a position within 12 tiles from which the threat direction is blocked by a
  building/stone wall/woods (LOS from the candidate tile toward the threat blocked within 4 tiles),
  preferring tiles reachable by REVERSING: the vehicle keeps its hull facing the threat (±30°) and
  drives backwards (movement.ts/vehicle.ts: allow negative speed along the hull axis at 60% of forward
  speed) to the cover tile; it never rotates the hull more than 30° away from the threat while within
  400 m of an alive AT threat. If no such tile is reachable by reversing, it stays hull-down facing
  the threat and fires. Once behind cover the vehicle holds (defend) with the turret on the threat.
- Alarm decays like infantry `threatLevel` (0.1/s); the crew returns to its order when
  `threatLevel` < 0.3 and no AT threat is spotted for 30 s.
- Halftracks treat HMG/AT rifle hits as AT threats too (thin armour).
- Tests: a tank shot at by a PaK it can see reverses (hull facing kept toward the PaK within 30°)
  to a tile where LOS to the PaK is blocked; a tank under rifle fire does not move; a tank with
  danger < 0.15 (e.g. Tiger vs 45 mm at 800 m) holds and fires.

### 10.1 Threat ranking (user clarification)

> A greatly superior tank (Tiger vs a Stuart) does not look for cover; it aims and shoots back — or
> deals with the highest threat first.

- The crew keeps a ranked list of known armour/AT threats: `danger_i = P(penetrate our FRONT at
  range_i)` × proximity factor (1 at ≤ 200 m, 0.5 at 600 m) × confidence. The target of the main gun is
  the highest-`danger` threat that can be engaged (LOS, in range); if none, the nearest enemy vehicle,
  then infantry.
- Cover seeking triggers only when the top threat's `danger ≥ 0.15` AND our own expected chance to kill
  it within two shots is lower than its chance to kill us (compare `P(we penetrate its front/side)`):
  a Tiger facing a T-26/Stuart/45 mm gun stays, aims and fires; a PzIV facing a KV-1 at 300 m reverses
  to cover; a T-34 facing a PaK 40 at 200 m engages if it has the shot, else reverses.
- While engaging, the hull turns toward the top threat only if the turret cannot bear or the vehicle
  has no turret (StuG/SU); otherwise only the turret rotates, so the side is never shown to threat #2:
  when two threats are on different bearings, keep the hull toward the most dangerous one.

### 10.2 Small-calibre hits and crew nerves (user clarification)

> Many hits on a tank, even from lower-calibre ammunition, may alarm and even panic an inexperienced
> crew. An experienced crew can take the noise and disregard it.

- Every non-penetrating hit on the hull (rifle/MG rounds, shell fragments, ricochets of small AT
  rounds) adds crew `stress` scaled by inexperience: `+ (1.5 for small arms, 6 for AT-rifle/light
  gun, 12 for a bounced tank/AT round) × (1.4 − experience/100)` (so a 20-experience crew takes ~1.2×,
  an 80-experience crew ~0.6×), and the same amount as "noise" for hits within 20 m. The alarm rule of
  §10 stays: small arms alone never set `threatDir`/`threatLevel` above 0.3, but the accumulated
  stress can still drive `fear` up.
- Crew fear effects: `shaken` (fear > 40): main-gun accuracy ×0.8, slower turret laying; `cowering`
  (fear > 70, only for experience < 50): buttons up — coax MG stops, main gun fires only at threats
  with danger > 0.15; `panicked` (fear > 80 and experience < 50, or morale < 25): the driver reverses
  the vehicle away from `threatDir` (hull still kept toward it when known) until out of LOS of all
  known threats, or, if immobilised, the crew bails out (vehicle → abandoned, crew soldiers become
  panicked infantry). Experience ≥ 70 crews never panic from non-penetrating hits.
- Recovery as in §3, halved delays when the commander (index 0) is alive.
- Test: 200 MG rounds hitting a T-26 with a 20-experience crew push it to `shaken`/`cowering`; the same
  on a Tiger with an 80-experience crew leaves it `calm`/`alert`.

## 11. Everyone is an individual — crews, specialists, leaders, traits (user: "apply to all, be creative")

**Hidden traits** (rolled at spawn with the seeded Rng, shown nowhere except through behaviour and
messages): each soldier gets one of `steady` (stress gain ×0.8), `nervous` (×1.3, hesitates more),
`brave` (obedience +0.15, may charge when berserk-eligible), `reckless` (fires more, ammo ×1.3 use,
cover seeking less), `cautious` (seeks cover eagerly, sneaks when wary), `stoic` (no panic above 60
experience). Leaders are never `nervous`.

**Gun crews (AT gun, mortar, HMG):** the weapon is static; the crew's `anchor` is the gun. Alarm
triggers: enemy infantry within 60 m (danger by their count vs the crew), enemy armour targeting them,
HE landing within 20 m. Roles: gunner fires, loader/assistant feeds (fire rate ×0.6 without an
assistant), assistant leader spots. When the gunner falls, the next crewman takes over after
2–6 s (longer for inexperience). Inexperienced crews (experience < 40) with fear > 70 ABANDON the gun
and run to cover; experienced crews (≥ 60) keep serving it ("to the last round"). A calmed crew
returns to an abandoned gun within 40 m. Mortar crews are alarmed by counter-battery HE and by
infantry closer than their minimum range (they can't fire back: helpless +2/s).

**MG teams:** the gunner is the stress anchor of the team: while he fires, teammates within 6 m get
stress −1/s ("the gun is talking"); if the gunner is hit the whole team gets +20 stress. The assistant
panics before the gunner (traits aside); a lone gunner fires at ×0.6 rate and must reload himself.

**Snipers:** high experience, `stoic`/`steady` traits; ignore distant small-arms noise; after 3 shots
from one spot they relocate 10–20 m (their own "hunch" that the enemy now knows the spot); never
berserk; surrender only when surrounded and out of ammo.

**Leaders:** presence within 10 m halves recovery delays (§3). A leader with experience ≥ 50 can
RALLY once per 30 s when a teammate enters `panicked`/`cowering`: every teammate within 10 m loses
30 stress and gains +5 morale; message "<team>\n<Rank>. <Name> rallies his men." If the leader dies,
the most experienced survivor becomes leader after 10 s; in between the team gets +0.5 stress/s and
obedience −0.2 ("who's in charge?"); message "…takes command."

**Conscripts vs veterans:** experience < 30: "first-fire shock" — the first time the soldier is
fired upon in the battle he freezes 3–8 s (state `shaken`, no movement, no fire), unless the leader is
within 5 m; when shaken they fire wildly (rate ×1.3, accuracy ×0.5, ammo burns) and hesitate 2–5 s on
orders. Experience ≥ 70: conserve ammo (fire only with hit chance > 0.08 unless suppressing), keep
formation, recover twice as fast, may `berserk` after a buddy's death, and are the ones who counter-
attack when a defender's morale is high.

**Grudge and buddies:** each soldier has one buddy (the adjacent index in the team). If the buddy is
killed in sight: stress +25, but a veteran (≥ 60) instead marks the killer's belief with `count`+1 and
priority — he fires at that spot preferentially for 60 s ("payback"). A conscript who loses his buddy
is far more likely to panic (fear +20 for 30 s).

**Fatigue:** fatigue > 70 doubles hesitation, forbids Move Fast (the soldier walks), and makes cover
seeking more likely (score threshold −0.05); fatigue > 90 forces a halt of 10 s when arriving anywhere.

**Surrender:** broken AND surrounded AND (no ammo or an enemy within 3 tiles) → `surrendered`
(hands up, walks toward the enemy side); experienced soldiers need an enemy within 2 tiles.

**Vehicle crews:** per §10–10.2; the commander's traits apply; a `reckless` commander closes with
enemy armour, a `cautious` one reverses at danger ≥ 0.1.

**Messages with personality** (player side only, rate-limited to one per 5 s per team): "…has frozen
up.", "…is out of ammo and keeps his head down.", "…abandons the gun!", "…mans the gun.", "…rallies
his men.", "…takes command.", "…is looking for cover.", "…has rallied.", "…wants payback.",
"…surrenders."

Tests: trait modifiers change stress gain; gunner replacement after death; inexperienced AT crew
abandons the gun under fear while an experienced one stays; leader rally reduces stress; first-fire
shock only for experience < 30; sniper relocates after 3 shots.
