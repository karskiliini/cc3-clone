# Combat FX & Full Animation Pass

## Context

CC3 clone (TypeScript + Canvas 2D, `src/sim` → `src/render` → `src/ui` + `src/audio`, vitest in `test/`). User ask: nothing may be "just a message" — every action must be visible. Priority order per user interjections: **(A) combat FX** (explosions, bullet hits, gun fire, smoke, fire, tank damage states, visible shells, ricochets), then **(B) missing animations** (grenade throw/flight, AT rockets, building destruction, aiming, MG crew, reload, boarding), then **(C) gameplay/UX** (movement-line scale, shift-waypoint bugs, vehicle-vs-soldier behavior, order latency with shouted orders, medic/first-aid with carry). All art is procedural/code-generated (Blender atlases in `public/sprites/` with code fallbacks in `soldierArt.ts`/`sprites.ts`); new animation states ship with procedural fallbacks first, atlas keys second.

Key existing facts (verified by scout):
- Animation selection is pure: `src/render/soldierAnim.ts` (`pickAnimation`, `actionFor`, `frameFor`, `entryKeyChain` — key format `<posture>.<action>[.<mood>][@weapon]`). `AnimAction 'throw'` exists but no sim state produces it.
- Per-soldier pose override point: `unitRender.ts` `crewSoldierDraws()`.
- Effects are records pushed by sim into `state.flashes / tracers / explosions / items / debris / craterMarks`, drawn by `src/render/effects.ts`; vehicle explosion events (`vehicleExplosion`, `cookOffPop`) consumed by `src/render/blastFx.ts`.
- Grenades today: `src/sim/combat.ts` `stepGrenades` (~lines 944–975) applies HE splash **instantly** at the enemy position — no flight, no throw.
- AT rockets (panzerfaust/panzerschreck/bazooka class `atrocket`) fire via `fireBurst` with a `shell`-kind flash/tracer; no projectile, no backblast.
- `Vehicle.layProgress / gunState / loadProgress` + `Team.crewWeapon` carry aiming progress; only visible as HUD text in `ui/hud/soldierMonitor.ts` (`layingWord`, `AIM_WORDS`).
- Order markers: `src/render/orderMarkers.ts`, `DOT_R = 2.5`, `WAYPOINT_R = 1.75`, one `scale` literal in `drawOrderMarkers`; pick radius `ORDER_MARKER_PICK_PX = 7` (screen px).
- Overrun: `src/sim/vehicle.ts` `stepOverrun` — friendly always dodges, enemy killed via `runDown` with `OVERRUN_MIN_SPEED_MS = 1`.
- Structures: `src/sim/structures.ts` (HP tables, breach/cave-in/collapse → rubble tiles, `map.windows: Uint8Array`), visuals only via `terrainRender.ts` tile repaint. No debris/dust/collapse FX.
- Audio: `src/audio/sfx.ts` (`SfxKind` union, `play()` switch, `handleEvents`, HIGH_PRIORITY set), `src/audio/synth.ts` primitives (`noiseBurst`, `tone`, `makeSlapEcho`, `startEngineVoice`, `startAmbientWind`).
- No medic/heal/bandage mechanic anywhere; `Health = 'healthy'|'wounded'|'incapacitated'|'dead'`; pickup anim already wired (`s.pickup.from/until` → `<posture>.pickup`).
- `AnimAction 'reload'` + `soldier.reloadTimer` exist; `frameFor` maps reload progress, but atlas coverage/fallback per weapon is incomplete.
- Crew tasks (`crewTaskAnim`: lay/load/feedBelt/dig/trail/haul) exist; heavy-MG tripod carry state does not.

---

## Workstream A — Combat FX (top priority)

### A1. Visible shells, rockets, grenades, mortar rounds in flight

New shared record in `src/shared/types.ts`:

```ts
type ProjectileKind = 'shell' | 'atrocket' | 'grenade' | 'satchel' | 'mortar';
interface Projectile {
  kind: ProjectileKind; weaponId: string;
  from: Vec2; to: Vec2;          // sim tiles
  t0: number; flightS: number;   // sim-clock flight time
  dirRad: number;                // for rocket orientation
  arcM: number;                  // lob height: 0 for AT shells/rockets, 2–4 for grenades/satchel, 6–12 for mortar
  hitKind: 'impact' | 'ricochet' | 'airburst';
}
```

Add `state.projectiles: Projectile[]` to BattleState (near `state.tracers`), stepped and expired in the same sim step that expires tracers (`src/sim/combat.ts`).

- **Tank/AT guns** (`fireBurst`, `src/sim/combat.ts`): for weapon classes `atgun`/`tankgun`/`atrocket` replace the current instant tracer with a Projectile (`kind 'shell'` or `'atrocket'`, `flightS = distM / shellSpeedMps` — shell speeds 400–800 m/s per weapon in `data/weapons.ts` if present, else 600; atrocket 80 m/s). Sim damage timing does NOT wait for flight (keep today's instant resolution); the projectile is a visual that plays the impact at arrival: on expiry push an impact effect per A2 (penetration → metal strike sparks + interior flash for pen; non-pen → ricochet/armor ding).
- **Grenades**: rewrite `stepGrenades` to (1) set `soldier.throwAt = state.time` (drives A4 throw animation), (2) push a `grenade` Projectile with a real ballistic arc (`flightS = 0.8–1.2 s` by distance), (3) schedule the HE burst at `t0 + flightS` via a new `state.pendingBursts: {at, pos, weaponId}[]` stepped each sim tick (replace the immediate `applyHESplash`). Grenade drawn as a small tumbling dark oval (code-drawn in `effects.ts`), landing bounce puff, then explosion. Same for satchel charges if thrown (`kind 'satchel'`, bigger arc).
- **Mortars**: mortar rounds already get a skipped tracer — replace with a `mortar` Projectile (steep `arcM`, whoosh audio B7) and draw its descent streak + landing flash before the existing explosion fires. Mortar impact timing: keep current sim timing, render projectile to arrive at the explosion time (compute `flightS` from the explosion record's spawn time minus launch time; if unknown use 3–6 s by range and offset the visual only).
- Renderer: new `drawProjectiles(ctx, cam, state)` in `src/render/effects.ts`, called in `BattleScreen.draw` right after `drawEffects` (order: shells as thick short bright streak with dark under-line, rockets as small elongated body + flame tail + thin smoke trail segments, grenades/mortars as arcing tumbling dot with shadow). Smoke trail: push tiny `smokePuff` effects along the rocket path each render frame while it flies.

### A2. Bullet hits & armor impacts

- Non-penetrating armor hits: today only a `ricochet` audio event. Add a `Spark { pos, t, kind: 'armor' | 'dust' | 'wood' | 'stone' | 'brick' | 'body' }` record list `state.sparks` (cap ~64, life 0.4–0.8 s) pushed at the hit point when a round resolves. Where hit points are known (ballistics resolution in `src/sim/ballistics.ts` / `combat.ts` resolveRound path — `unverified — confirm first`: the hit resolution call site that currently only fires 'hit' events), push per-surface kind:
  - armor: 4–8 bright white/yellow sparks flying off + gray puff + brief bright flash ellipse on the plate; small `clank` sound (B7).
  - ground/dust near-misses: dirt spray + puff (also spawn on every near-miss tracer expiry).
  - building surfaces: wood splinters / stone chips / brick dust colored per tile material (`map.tiles`).
  - body hits: small red-gray puff + soldier `hit` flinch already exists (`FLINCH_S`); ensure the flinch also plays on non-fatal body hits even when soldier keeps firing.
- Penetrating hits on vehicles: bright interior flash through the hatch/pierced plate (draw a 0.2 s white-orange glow at the hit point), then A3 fire stages.
- Renderer: `drawSparks` in `effects.ts` (short velocity-random streaks + fading puff), called inside `drawEffects`.

### A3. Tank damage: visible hit → fire stages → burn → black

Replace the current instant "turns black" visual with a staged burn driven by a new `Vehicle.fire` state in `src/sim/vehicleDamage.ts` (or `vehicleExplosion.ts` — the KO site):

- `Vehicle.fire: { t0: number } | null` set on lethal/knockout damage instead of instantly switching sprite to `blown` variant. Burn timeline driven purely by `state.time - t0` (no per-frame sim cost):
  - 0–5 s: smoke only (thin gray wisps from engine deck/hatch).
  - 5–20 s: small flames licking from hatches/grilles (slow, flicker at ~4 Hz).
  - 20–90 s: intense fire — full flame column + heavy black smoke (the existing `blastFx` 40 s smoke column re-timed to this window, plus a looping `fire` ambient sound B7).
  - 90–150 s: fire dies down (flames shrink, smoke thins and grays).
  - after 150 s: switch to the existing `blown` sprite variant (black, scorched) + persistent thin smoke for another 60 s.
- Death sequence on the KO event: keep existing `vehicleExplosion` blast FX (BlastFx white-out/shake), then the burn timeline starts. If ammo cook-off (`cookOffPop`), add 2–4 secondary turret-throwing pops during the intense stage: each pop pushes a small explosion at turret position and (first pop only) a turret flight using the loose-object flight path (`unitRender.looseFlight` reuse, `unverified — confirm first` how wreck turret parts are modeled; if no part entity, draw a tumbling dark box silhouette only).
- While burning: crew bailout already exists — ensure it triggers at fire start (t0), not after collapse.
- Renderer: new `drawVehicleFire(ctx, cam, state)` in `blastFx.ts` or a new `src/render/fireFx.ts`; procedural flames = layered noisy ellipses (`noise.ts` helpers) colored white-core/orange/mid/dark, flicker phase from `hash2(id, floor(t*4))`; smoke puffs rise with wind offset (existing smoke module `src/sim/smoke.ts` produces puffs — extend it with `kind: 'burn'` low-rate emission while a vehicle burns).

### A4. Aiming made visible

- **Aim pose + shake**: in `soldierAnim.ts`, scale `trembleOffset` amplitude by `(1 - layProgress)` for soldiers/vehicles currently laying (layProgress available on `Team.crewWeapon` and `Vehicle.layProgress`; for plain infantry use `1 - min(1, timeSinceAimStart / fineLayS-equivalent)`, computed in the render track). While aiming, cycle the `aim` entry frames slowly (breathing sway) instead of a static frame.
- **Lay progress arc**: in `unitRender.ts` draw a small arc/bar over each laying soldier and each vehicle gun: arc sweeps 0→360° with `layProgress`; color = weapon order color (reuse `orderMarkerColor` fire red). For vehicles additionally draw the gun barrel gradually converging on the target heading (interpolate current gun heading toward target with `layProgress` — `unverified — confirm first` whether the vehicle turret art already renders gun heading per frame from `gunLay`; if it does, skip).
- **Muzzle anticipation**: 0.15 s before a shell fires (when `loadProgress` completes and lay tolerance is reached), spawn a tiny dust ring under the muzzle (recoil prep). Uses existing flash spawn site.
- Remove "just a message": `soldierMonitor` aiming text stays, but the map now always shows the arc + shake + kneeling aim pose + target brackets.

### A5. Explosion quality pass

- `effects.ts` `drawExplosions` ('he'): rework into staged draw over the record's life: (1) white flash frame (0–10%), (2) expanding bright core + shock ring (10–30%), (3) fireball blobs with turbulent edge (30–60%, use `noise.ts` for blob wobble), (4) rising dark smoke ball + lingering ground glow (60–100%), debris streaks launched in phase 2 with individual ballistic arcs (reuse `ragdollSample`-style arc math). Ground scorch already stamped via `craterMarks` — keep.
- Camera shake for ALL explosions, not just vehicle ones: extend `BlastFx.shake` to also listen to `explosion` events with radius-scaled amplitude (small for grenades, medium HE, large for satchel/mortar).
- Craters: increase scorch diameter visual for HE (crater sizes come from `craterForWeapon` — bump `he` kind rendering only, not sim cover).

---

## Workstream B — Missing animations (everything visible)

### B1. Grenade throw (sim + anim)

- `stepGrenades` sets `soldier.throwAt = state.time` and a `throwTarget` tile; `soldierAnim.actionFor` returns `'throw'` while `state.time - throwAt < THROW_S (0.9 s)`; `frameFor` maps progress over `throw` entry frames; atlas key `<posture>.throw@none` with procedural fallback pose in `soldierArt.ts` (arm wind-up → release → follow-through; code-drawn arm angles if no atlas entry).
- Grenade flight visual = A1 projectile. The throw animation release frame must coincide with the projectile spawn (spawn projectile at `throwAt + 0.35 s` — schedule via `pendingBursts`-style `pendingThrows`, or simpler: spawn projectile immediately at release-time offset baked into `t0`).

### B2. AT rockets (panzerfaust/panzerschreck/bazooka)

- Fire: big conical **backblast** behind the shooter (dust ring + smoke cone pushed as a `smokePuff` cluster + loud whoosh B7), visible rocket projectile per A1 with flame tail, gunner `fire` kick + brace pose.
- Reload (panzerschreck `reloadS = 8`): loader walks to the shooter, stoops (`pickup` anim), stands; show a visible rocket tube passing (draw carried tube sprite on the loader while `reloadTimer > 0`).

### B3. Building destruction FX

On `src/sim/structures.ts` events (breach / cave-in / collapse — each already computed and message-gated):
- Push a new `state.structureFx: { kind: 'breach'|'caveIn'|'collapse', pos: Vec2, t0, material: 'wood'|'stone', extentTiles }[]` (cap ~32).
- Renderer `src/render/structureFx.ts`: breach → burst of dust + material chips flying outward + rubble pile settling; cave-in → roof dust plume + sagging debris; collapse → staged: dust puffs along wall line, walls visually "fall" (draw shrinking wall sprites over 1.5 s before the terrain repaint, since `finishChanges` repaints tiles once) + bouncing debris chunks (`debris.ts` `blastThrow` reuse) + lingering dust cloud 10–20 s.
- **Broken windows**: currently `map.windows[i] = 0` removes the window art entirely. Instead add `map.windowsBroken: Uint8Array` (new parallel array in `map.ts`), set on breach; `terrainRender.ts` window drawing (~lines 2227–2276) renders a broken variant (jagged remaining glass, dark hole, cracked frame via `hash2` jitter) when broken, intact when 1, nothing when 0. LOS rule (`los.ts:145`) unchanged (broken still passes LOS like 0).

### B4. MG crew animation

`src/sim/crewWeapon.ts` + `unitRender.ts`:
- Setup/teardown: `crewTaskAnim` already keys lay/load — ensure the heavy MG tripod actually appears on the ground during `lay` (draw tripod sprite at gun position when `weaponState` is 'laying'/'laid' for tripod guns) and is picked up on trail.
- On the move: gun is carried by one soldier (draw MG sprite slung on the carrier's back/side — carrier = designated crew member, mark via `Team.crewWeapon.carrierId`); heavy MG: a second soldier carries the tripod (`tripodCarrierId`). Choose carriers at order time: lowest-skill healthy member carries MG, next carries tripod.
- Loss rule: when the tripod carrier is killed/incapacitated and no other member can take it, the crew weapon downgrades to light MG (no tripod → worse `fireMissionWait` timing: add `heavy: boolean` to CrewWeapon; when downgraded set `heavy = false` which increases lay time / reduces sustained ROF — concrete: multiply `fineLayS` result by 1.5 and halve belt size, `unverified — confirm first` the exact CrewWeapon fields; implement via the existing fire-mission timing hooks).
- Firing: shooter prone/kneeling at the gun with recoil + belt-links ejecting (tiny ground confetti puffs beside gun while firing), loader beside shooter feeding (`feedBelt` task anim during reload pauses).

### B5. Reload animation for every weapon

- `frameFor` already maps `reloadTimer` progress. Audit `entryKeyChain` coverage: every WeaponSuffix (rifle/smg/lmg/none) must resolve `<posture>.reload@<suffix>` or fall back to a procedural reload pose in `soldierArt.ts` (weapon lowered, hands working — 4-frame code pose cycling with reload progress). Vehicle guns: use existing `loadProgress` to animate the loader crew task (already keyed) AND a visible round being rammed (small sprite moving into breech on the vehicle sprite during the last 20% of load).

### B6. Boarding / dismounting halftracks & trucks

`src/sim/transport.ts`:
- Mount: passenger path goes to the vehicle's rear/side door point (offset from hull), then a 1 s climb anim (`hatchClimbAnim` reuse, generic side-entry variant) before entering; draw the soldier walking then scaling into the hull (fade+rise) during the climb.
- Dismount: reverse — soldier appears at door point, 1 s climb-down anim, then moves on. Reuse `crew.mount/bailout` progress fields pattern; add `passenger.mount/dismount` timestamps on the passenger soldier record.
- Atlas keys `climb.<side>` with procedural fallback (simple two-frame crouch→stand at door).

### B7. Order latency — leader shouts, soldiers ingest

`src/sim/orders.ts` `applyOrder`:
- Extend the existing `delayedOrders` WeakMap mechanism (currently only radio-out delay): every issued order now gets a per-team ingest pipeline: `issuedAt` → leader shout delay `SHOUT_S = 0.8–1.5 s` (rng by experience) → per-soldier reaction `reactS = base(0.4) * skillMul(mind.state: calm 1, alert 0.8, pinned 2.5, panicked 4) * (1.2 - experience/100*0.5)`. Soldiers start acting (pathing/moving/firing posture) only after their own `reactS` elapses; stagger by id hash (±0.3 s) so the team visibly "comes alive" rather than snapping.
- Audio: new `SfxKind 'shoutMove' | 'shoutFire' | 'shoutSmoke' | 'shoutDefend'` — short synthesized bark (filtered noise + tone drop, per `synth.ts` primitives); played at the leader position when the shout delay elapses (NOT at issue time), distance-attenuated like other positional sfx. Event kind `orderShout { teamId, orderType }` pushed on shout.
- Message line on issue stays; map feedback: order marker appears immediately (dashed/ghost at 40% alpha until the shout lands, then solid — reuse `UNSELECTED_ALPHA` pattern in `orderMarkers.ts`).

### B8. Medic / first aid with carry

New sim feature in a new `src/sim/medic.ts` (stepped from the same place as `stepPickups`):
- Any team with a healthy soldier and a wounded/incapacitated teammate gets a medic task on the squad's own initiative (cooldown 10 s per wounded man, only when not under heavy fire — `suppression < 40`): nearest healthy member walks to the wounded man.
- Wounded (can self-treat): medic reaches → 3 s `bandage` anim (`<posture>.pickup` reuse + new `<posture>.bandage` key; procedural fallback = kneel + hands motion) → `health: 'wounded' → 'healthy'`, message "Bandaged <name>."
- Incapacitated: medic performs the bandage/stabilize anim, then **carries** him toward rear cover: new soldier state `carrying: { patientId, since }` — carrier moves at half speed toward the team's original deployment side or nearest cover tile ≥10 m from the nearest spotted enemy; patient drawn slung over the carrier's shoulder (code-drawn: patient sprite rotated ~90° across carrier's back, plus atlas key `<posture>.carry@none`), patient is `hidden` from enemy spotting while carried (CC3-style carry saves lives). Arrival → gentle put-down (`pickup` anim) → patient stays incapacitated (not healed) but stabilized (no further bleed-out if any exists; if no bleed-out mechanic, stabilizing = message only).
- No dedicated medic unit type: any healthy infantry soldier can act (closest existing pattern: `pickup.ts` priority system — reuse its `REACH_TILES` / stagger / `pk.from/until` machinery).
- Priority interplay: medic task yields to explicit player orders (a new order cancels the carry; patient dropped gently at current pos).

---

## Workstream C — Gameplay/UX fixes

### C1. Movement line & endpoint scale

`src/render/orderMarkers.ts`:
- `DOT_R 2.5 → 6`, `WAYPOINT_R 1.75 → 4.5` (world-tile radii, matching original CC3's chunky markers).
- The `scale` multiplier in `drawOrderMarkers`: unselected 0.8 stays, but scale by zoom-independent design: dots drawn in world units already — verify `drawDot` uses `cam.zoom`; if pick radius feels small keep `ORDER_MARKER_PICK_PX = 7` unchanged.
- Order polyline `lineWidth 1 → 2`, dashed pattern `[3,3] → [6,4]`, endpoint outline ring `r + 1.5 → r + 2.5`.
- Attack rings: vehicle `12 * zoom` unchanged (already large); soldier `5 → 9`.
- Update `test/waypoints.test.ts` marker pick expectations if any pin radii (they test pick radius in px, likely unaffected — `unverified — confirm first`).

### C2. Shift+waypoint bug fixes

`src/sim/orders.ts` + `src/ui/screens/battle.ts`:
- Stale follower waypoints: `stepOrderWaypoints` drops wps[0] only from the leader/vehicle route; extend the drop check to followers (compare each follower's remaining `pathLegHeadings`-routed path progress, or simply: drop wps[0] for the team when `routeVia` from current pos to wps[0] is already behind — concrete rule: if the team's remaining path never comes within `WAYPOINT_REACHED_TILES` of wps[0] because the leg was skipped (`leg.length === 0` recorded at route time), drop it. Store `order.skippedLegs: number[]` at `routeVia` time and consume it in `stepOrderWaypoints`).
- Dedup: in `issueOrderToSelection`, filter a shift-click point equal (within 0.5 tiles) to the previous chain point or the final target.
- `isOrderActive` vehicle marker vanish during `fireHaltUntil`: treat a vehicle with an order as active while `order` exists and it hasn't reached the target — change the active test from `v.path.length > 0` to `!orderComplete(state, team)` (team pos within settle radius of target and no waypoints left).
- Escape while chaining: verify pendingWaypoints cleared and rubber-band gone (existing behavior per scout; add regression test).
- Group-shift ordering: `offsetOrderPoints` offsets every chain point per team — verify unreachable intermediate points don't strand followers (covered by the skippedLegs fix).

### C3. Vehicles vs soldiers

`src/sim/vehicle.ts` `stepOverrun`:
- **Friendly**: current rule "always dodge, else pass under" → replace else-branch: if a friendly cannot dodge (no passable spot beside hull), the vehicle **slows and waits**: set `v.holdUntil = state.time + 0.5` (re-checked every tick while the friendly remains under the hull path; zero speed while held), and the friendly gets `dodgeUntil` extended + stress. He waits only until the soldier moves aside; if the soldier is stuck > 5 s (rare), the vehicle resumes and pushes him aside WITHOUT killing (nudge displacement to nearest free tile, `runDown` never fires for friendlies). Message once per team: "We can't advance — our men in the way." (rate-limited).
- **Enemy**: remove `OVERRUN_MIN_SPEED_MS` gate for enemies? No — keep it (a stationary tank shouldn't kill), but make it 0.5 m/s so any real motion runs enemies down; keep dodge chance and `runDown` crush as-is (already matches "drive over and crush").
- The friendly-soldier side: `dodgeUntil` sprint (4.5 m/s) already exists; extend dodge trigger distance to when the vehicle is within 1.5 hull-lengths and heading at him (currently only when hull-local hit test triggers, which is too late at speed — trigger earlier via `stepOverrun` lookahead `unverified — confirm first` exact current trigger distance).

### C4. Assault charge — "Move Fast" onto an enemy

When the player issues a **Move Fast** order whose target lands on or within 15 m of a spotted enemy team, it becomes an **assault**: `src/sim/orders.ts` `applyOrder` converts the order to `type: 'assault'` (new OrderType alongside move/moveFast/sneak) with `targetTeamId` set to that enemy.

- Charge: soldiers move at moveFast speed toward the enemy with the existing B7 shout/react latency (shout kind `shoutMove`), weapons carried ready.
- vs **infantry**: when the charging soldier closes within grenade range (existing `stepGrenades` 25 m + LOS check) and the enemy is spotted, he throws grenades at the target team immediately (independent of the normal per-track grenade cooldown gate — grenadeTimer is reset on assault issue) and keeps charging; on closing to point-blank (≤ 8 m) the enemy team takes normal close-combat fire from the carried weapons (existing `fireBurst` path, suppression spike from the assault).
- vs **tank/vehicle**: every soldier in the charging team with an AT weapon (panzerfaust/panzerschreck/bazooka/AT grenade/satchel — class check via `data/weapons.ts` `cls: 'atrocket'` or the AT-kit pickup priority in `pickup.ts`) fires it **on the move** as soon as gun lay tolerance allows (use the infantry snap-shot path — `SNAP_SHOT_MIN` behavior in `gunTiming.ts` — with aim mul relaxed to 0.6 for charge shots), then reloads and repeats while ammo lasts; soldiers without AT weapons close in and throw satchel/grenades against the engine deck/rear via the normal grenade path (HE splash vs armor already handled by `ballistics`/`penChance` HE rule).
- Rendering/audio: charging soldiers get `run` action + weapon suffix as today; AT shots on the move reuse B2 backblast + A1 rocket projectile; the order marker stays fire-red (reuse `orderMarkerColor` area-fire color `#e08a2c` for assault).
- Cancel: any new order replaces the assault (existing applyOrder cutover); if the target dies, the assault degrades to a plain move to the target point.


### C5. Audio improvements

`src/audio/sfx.ts` + `synth.ts` new recipes:
- `shellWhoosh` (incoming/outgoing shell flyby — filtered noise sweep, positional, triggered by A1 projectiles passing near viewport center), `rocketLaunch` (whoosh + crackle for atrocket), `backblast` (sharp low thump), `armorClank` (non-pen hit), `penHit` (sharp crack + metal ring), `grenadeBounce` (short metallic tick on landing), `fireLoop` (looping fire crackle while a vehicle burns — new engine-voice-style loop channel or reuse `startEngineVoice` with noise), `mgSetup` (metallic clanks on lay/trail), `shout*` (B7), `collapseRumble` (low noise rumble for B3), `bandage` (soft cloth noise, B8).
- Wire triggers via BattleEvent kinds or direct `play()` at the spawn sites listed per step.
- Add `shellWhoosh`/`penHit` to HIGH_PRIORITY.
- Keep polyphony caps; new loops (`fireLoop`) count against `MAX_ENGINES`-style separate cap (add `MAX_FIRES = 4`).

---

## Critical files & anchors

1. `src/sim/combat.ts` — `fireBurst`, `stepGrenades` (~944–975), `heBurstAt`, `resolveRound` — projectile spawn + pendingBursts + sparks.
2. `src/shared/types.ts` — BattleState record additions: `projectiles`, `sparks`, `pendingBursts`, `structureFx`, Soldier fields `throwAt`, `carrying`, `reactAt`; `Projectile`/`Spark`/`StructureFx` interfaces.
3. `src/render/effects.ts` — `drawProjectiles`, `drawSparks`, staged `drawExplosions`; `src/render/blastFx.ts` — staged vehicle fire, all-explosion shake.
4. `src/render/soldierAnim.ts` + `src/render/soldierArt.ts` — `throw`, `bandage`, `carry`, reload fallbacks, aim shake; `src/render/unitRender.ts` — lay-progress arc, MG carrier/tripod sprites, carrying pose.
5. `src/sim/vehicle.ts` (`stepOverrun` hold-for-friendlies), `src/sim/orders.ts` (ingest latency, skippedLegs, isOrderActive, assault conversion), `src/render/orderMarkers.ts` (sizes), `src/sim/structures.ts` + `terrainRender.ts` (structureFx, broken windows), `src/audio/sfx.ts` (new recipes), `src/sim/medic.ts` (new file).

## Verification

- `npm test` after each workstream (existing suites: combat, blast, blastFx, crewTasks, crewWeapon, waypoints, overrun, trackedDrive, structures, sfx).
- New tests:
  - `test/projectiles.test.ts`: grenade no longer applies splash at throw time; burst lands at `t0 + flightS` at the target tile; shell projectile spawns for tankgun with correct flightS scaling.
  - `test/ricochet.test.ts`: non-pen shell → ricochet event + a soldier in the ricochet path dies; pen shell → pen event.
  - `test/vehicleFire.test.ts`: KO'd vehicle has `fire.t0`, crew bails within 2 s, sprite stays normal until 150 s then blown (drive sim clock).
  - `test/medic.test.ts`: wounded teammate gets bandaged (health flip), incapacitated carried toward rear and dropped ≥10 m from nearest spotted enemy; carry cancels on new order.
  - `test/overrun.test.ts` additions: friendly non-dodgeable → vehicle halts (`holdUntil`), never crushed; enemy crushed at 0.5 m/s.
  - `test/waypoints.test.ts` additions: skipped-leg waypoint dropped for followers; fireHalt keeps marker active; duplicate shift-click filtered.
  - `test/orders.test.ts` additions: soldier does not move before `issuedAt + shoutS + reactS`; panicked reacts 4× slower than calm; `orderShout` event fired at shout time.
  - `test/assault.test.ts`: moveFast order within 15 m of a spotted enemy team becomes `type: 'assault'` with `targetTeamId`; charging infantry throws grenades inside 25 m before point-blank; soldier with panzerfaust fires it on the move (ammo decremented, backblast event); target death degrades to plain move.
- Manual: `npm run dev` → battle screen: fire at a tank (see shell streak, sparks on bounce, pen flash, staged fire over 2+ min using time-accelerated test or waiting), throw grenades (throw anim + arc + bounce), shoot a building corner with HE (dust burst, broken window art), issue shift-click multi-waypoint move (enlarged dots, staggered start after shout), drive a tank into own squad (halt + wait), shoot own AT gun team into enemies (backblast + rocket trail), MG team lay/heavy-MG setup (tripod appears, carrier slings), wound a soldier and watch teammate bandage/carry.

## Assumptions & contingencies

- Atlas regeneration is NOT required for correctness: every new animation ships with a procedural code fallback (`soldierArt.ts` poses / code-drawn FX), so visuals work today even where `public/sprites/` Blender atlases lack entries; atlas keys are declared so a future atlas build lights them up automatically via the existing fallback chain.
- Shell flight is visual-only (damage resolution stays instant) to avoid destabilizing the combat/ballistics tests; if that reads wrong in play (impact visibly before flight ends at long range), follow-up: gate damage application on projectile expiry — contained change behind the same `pendingBursts` mechanism.
- Grenade throw cadence (`1/0.1 s` rng interval) unchanged; only the resolution becomes ballistic.
- Burn timeline constants (5/20/90/150 s) chosen to match "minutes" ask; single set of constants in one module (`fireFx.ts`) for easy tuning.
