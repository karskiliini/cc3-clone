# Close Combat III Clone — Design Spec

Date: 2026-09-12
Path: architectural (new project)

## 1. Goal

A browser-playable real-time tactical wargame that recreates Close Combat III: The Russian Front (Atomic Games, 1999) as faithfully as possible: the 800×600 screen layout, the bottom "monitor" panel, the seven-order command menu, individual soldiers with morale and fatigue, line of sight and cover, victory locations, the truce/ceasefire mechanic, the deployment phase and the debrief screen.

Copyright constraint: no original Atomic/Microsoft artwork, sounds, or text are used. Every sprite, map, UI bitmap and sound is generated procedurally in code, matched to the original's palette, proportions and feel.

## 2. Non-goals (YAGNI)

- Multiplayer.
- The full 1941–45 Grand Campaign with hundreds of maps. We ship one linear operation of 5 battles plus free "Battle" mode.
- Air support, artillery off-map beyond mortars.
- Map editor.

## 3. Technology

- TypeScript, Vite, HTML5 Canvas 2D. No runtime dependencies.
- Fixed 800×600 logical canvas scaled to the window with `image-rendering: pixelated`.
- Fixed-step deterministic simulation at 10 Hz (`SIM_DT = 0.1 s`), rendering at display rate with interpolation off (CC3 was choppy-ish 2D; we render positions at last sim state, which reads as authentic).
- Seeded RNG (`mulberry32`) so battles are reproducible for tests.
- Vitest unit tests for sim modules (pathfinding, LOS, ballistics, morale, victory).

## 4. Screen layout (800×600) — matches CC3

```
+--------------------------------------------------------------+
|  MAP VIEWPORT  800 x 480  (y 0..479)                          |
|  scrolls by moving the cursor to the screen edge or arrows    |
|                                                                |
+--------------------------------------------------------------+
| TEAM LIST 200px | SOLDIER MONITOR 400px | MESSAGES+BUTTONS 200 |  y 480..599
+--------------------------------------------------------------+
```

- Bottom panel height 120 px, background dark olive-gray `#3a3f36` with 2-px bevels (`#6b7064` light, `#1c1f1a` dark), gold headings `#d8b448`, white body text `#e8e8e0`, dim text `#9a9c94`.
- **Team list** (x 0..199): one row per friendly team, 14 px tall, 8 visible, scroll arrows top/bottom. Row: 12×12 unit-type icon, team name (e.g. "Rifle Squad", "MG42 Team", "PzKw IV"), then up to 10 tiny 3×5 px soldier figures colored by health (green healthy, yellow wounded, red incapacitated, dark gray dead). Selected team row has a gold frame. Team status word at right in state color ("Moving", "Pinned", "Broken", ...).
- **Soldier monitor** (x 200..599): heading line: team name, unit type, current order, team morale word. Then a grid of up to 10 soldier cards (2 rows × 5), each 78×46 px: rank abbreviation + surname (gold), weapon name (white), status word (colored), ammo count (dim), small 8×8 posture glyph.
- **Message panel** (x 600..799): 5 lines of scrolling messages (white, newest bottom, "22:14 Rifle Squad is pinned down"), and a button strip: `TRUCE`, `OVERVIEW`, `OPTIONS`, `PAUSE` plus the battle clock `MM:SS` remaining in gold.
- Cursor: custom drawn (arrow; crosshair when targeting; hand when panning; "no" when invalid).

Overlay screens (full 800×600, same chrome):
- **Main menu**: title "CLOSE COMBAT III" style banner (our own typography), buttons: BATTLE, OPERATION, OPTIONS. Background: dark map painting with vignette.
- **Battle setup**: map picker (list with thumbnail rendered from map), side toggle (German/Soviet), year (1941–1945 changes OOB), difficulty, START.
- **Deployment**: map with the side's deployment zone tinted; force pool list on the bottom panel; drag teams onto the zone; BEGIN.
- **Debrief**: result (Decisive Victory / Victory / Draw / Defeat), VLs held, kills, losses per team, morale; CONTINUE.
- **Overview map**: whole map scaled into 800×480 with VL flags and friendly dots; click to center.
- **Options**: sound volume, unit labels on/off, LOS lines on/off, speed.

## 5. Controls — matches CC3

- Left click soldier/team: select team. Left click empty: deselect. Left drag on empty map: pan (also edge scroll and arrow keys).
- Right click with a team selected: **command menu** at cursor, vertical list: `MOVE`, `MOVE FAST`, `SNEAK`, `FIRE`, `SMOKE`, `DEFEND`, `AMBUSH`. Left click an order then left click the map target (destination or fire point). `Esc` cancels. Hotkeys: M, F(ast), S(neak), I (fire), K (smoke), D, A. Right click on empty map with no team: nothing.
- `Defend` and `Ambush` take a facing direction (click the direction).
- Hold `Shift` with a team selected: LOS line from team leader to cursor, green = clear, red segment from the block point.
- `Space` pause. `+`/`-` game speed. `Tab` cycle teams. `Ctrl+A` select all? No (not in CC3).
- Team labels toggle `L`.

## 6. Simulation

### 6.1 Map
- Tile size 2 m, rendered at 10 px per tile at zoom 1 (CC3 was ~5 px/m). Maps 160×120 tiles (320×240 m) to 240×180 tiles.
- Terrain enum: `open, grass, tallgrass, crops, dirtroad, pavedroad, woods, scatteredtrees, buildingWood, buildingStone, rubble, stonewall, hedge, fence, water, bridge, snow, mud, crater, trench`.
- Each terrain has: cover (0..1 reduces hit chance and damage), concealment (0..1 reduces spotting), block LOS (bool for walls/buildings/woods, partial for hedges), move cost per stance, passable by infantry/vehicles, vehicle-crushable.
- Buildings are rectangles of building tiles with a wall ring; interior tiles are "floor" that block LOS only at wall tiles. Windows: every third wall tile allows fire through.
- Elevation: not modeled (CC3 had it; we skip, stated non-goal for v1).
- Victory locations: list of `{x, y, name, owner}` with flag sprite.
- Deployment zones: rectangles per side.
- Map definition is code (`src/data/maps/*.ts`): a `paint(ctx)` DSL with helpers (`rect`, `road`, `building`, `woods`, `hedgeLine`) producing the terrain grid deterministically. Season selects palette.

### 6.2 Units
- **Team**: id, side, type (`rifle, smg, mg, mortar, atgun, sniper, atteam, tank, spg, halftrack`), name, soldiers[], leader, order, morale (team average), experience, formation offsets, vehicle (optional).
- **Soldier**: id, name, rank, weapon, ammo, health (`healthy, wounded, incapacitated, dead`), morale 0..100, fatigue 0..100, suppression 0..100, stance (`standing, crouching, prone`), activity (`idle, moving, movingFast, sneaking, firing, reloading, defending, ambushing, hiding, cowering, pinned, panicked, routed, berserk, surrendered`), position (continuous, in tiles), facing (0..7), target, path.
- **Weapon**: name, class (`rifle, smg, lmg, hmg, pistol, mortar, atgun, tankgun, mg, grenade, atrocket, atrifle`), range (m), rate (shots/s or burst), accuracy (0..1 at 100 m), lethality (0..1), suppression (0..1), penetration (mm at 100 m), ammo max, reload time.
- **Vehicle**: hull pos, hull facing (continuous radians), turret facing, speed road/offroad, armor front/side/rear/top (mm), main weapon, coax weapon, crew count, state (`ok, immobilized, knockedOut, burning, abandoned`).

### 6.3 Orders
`move, moveFast, sneak, fire, smoke, defend, ambush`. A team's order sets each soldier's activity. Move = walk, crouch when fired upon. Move Fast = run, fatigue, worse accuracy, less suppression response. Sneak = crawl, slow, prone, hard to spot. Fire = engage target point/unit. Smoke = fire smoke grenades/rounds to point (mortars, tanks, squads with smoke). Defend = hold, face direction, fire at will. Ambush = hold fire until enemy within 40 m, prone, hidden.

### 6.4 Pathfinding
A* on the tile grid with 8-neighbour movement and terrain cost; soldiers in a team follow the leader's path with formation offsets; vehicles use their own cost table and cannot enter buildings/woods/water except bridges.

### 6.5 Spotting and LOS
- LOS by Bresenham over tiles; blocked by `blocksLOS` tiles; hedges/tallgrass/crops reduce visibility with distance (concealment accumulates, >1 blocks).
- Each side keeps a set of spotted enemy soldiers/vehicles updated every 0.5 s. Spot chance per pair: base by distance, ×(1−concealment), stance (prone hard), moving (easier), firing (very easy, reveals for 5 s).
- Fog of war: unspotted enemy not drawn. Last known position ghost shown for 10 s (CC3 didn't; we don't either — keep simple: not drawn).

### 6.6 Combat
- Each firing soldier picks a target (nearest spotted enemy in range, leader-assigned target if Fire order). Shots at weapon rate. Hit chance: `acc × rangeFactor × (1 − cover) × stanceFactor × shooterStateFactor × (moving ? 0.4 : 1)`. Miss: suppression to targets within 2 m of the impact. Hit: roll vs lethality → dead / incapacitated / wounded.
- Mortars: indirect, minimum range 60 m, dispersion, splash radius 6 m, need LOS from team or any friendly (spotter).
- Anti-armor: penetration at range vs armor by facing; penetration → crew casualty/knockout chance; non-penetration ricochet still suppresses.
- Grenades when within 25 m.
- Vehicles machine-gun infantry; tanks are priority targets for AT.
- Smoke: cloud tiles with density decaying over 60 s; blocks LOS when density>0.5.
- Craters from mortar/tank HE.

### 6.7 Morale, fatigue, suppression
- Suppression rises with near misses, decays 5/s. >60 → `pinned` (won't move, may fire), >85 → `cowering`.
- Morale drops on casualties (own team −15 per KIA, −8 wounded, leader ×2), enemy tank in sight (−5), suppression; recovers slowly when unengaged with leader alive. <25 → `panicked` (runs away from enemy), <10 → `routed` (runs to friendly map edge, drops from control), rare `berserk` on high experience. Isolated broken soldier adjacent to enemy → `surrendered`.
- Fatigue up when running/carrying, down when idle; >70 halves speed.
- Side morale = weighted team morale; when side morale < 20% the AI (or player prompt) offers truce; when < 10% forced ceasefire → battle ends.

### 6.8 Victory and clock
- Battle length default 20 min game time. Ends on timer, truce accepted by both, forced ceasefire, or one side eliminated/routed.
- VL ownership: captured when a non-broken team stands within 10 m and no enemy within 10 m for 5 s.
- Score = VL points (each VL has value 1–3) + kill points; result thresholds: ratio ≥3 Decisive, ≥1.5 Victory, else Draw, <0.67 Defeat.

### 6.9 AI (enemy side)
- Every 5 s: evaluate VLs not owned; assign teams (keep 1/3 defending owned VLs). Move via cover-seeking waypoints (prefer tiles with cover>0.3). When a team is fired on and pinned → defend. Broken teams retreat. AT assets target vehicles. Mortars fire at spotted clusters. Vehicles advance with infantry, halt and fire when target spotted.

### 6.10 Operation (campaign)
- 5 sequential battles (Barbarossa 1941 → Kharkov 1942 → Kursk 1943 → Bagration 1944 → Berlin 1945). Each battle has a force pool per side; the player has requisition points to pick teams from the year's OOB. Surviving soldiers keep experience; casualties persist. Win streak affects next map's VL start owner. Save in `localStorage`.

## 7. Rendering

- **Terrain** rendered once per map into an offscreen canvas (chunked 512×512) with procedural texture per tile (noise dither, road ruts, woods canopy blobs with shadow, buildings with roof shading and wall highlights, snow with blue shadow). Style: muted 1990s painted look — palette per season.
- **Sprites**: soldiers 12×12 px, 8 facings × {standing, crouching, prone, dead} × 2 walk frames, drawn from pixel definitions by side (German feldgrau `#5b6349`, Soviet khaki `#7a6f3f`; winter white smocks). Weapons drawn as 1-px dark line in facing direction. Vehicles top-down at true scale (T-34 ≈ 6×3 m → 30×15 px) with rotating turret, tracks, shadow, cross/star marking, burning/knocked-out variant.
- **Effects**: muzzle flash (2 frames), tracers for MG (1-px yellow line fading), bullet impact puff, explosions (expanding orange→gray circle with sparks, 10 frames), smoke clouds (soft gray blobs drifting), craters baked into a decal layer, blood? (CC3 had small dark red pixel splat on casualty; include, subtle).
- **UI**: everything on canvas with a hand-built bitmap font (5×7 small, 7×11 bold) drawn from pixel strings — no DOM UI. Bevelled panels and buttons in the CC3 olive chrome. Selected team: soldiers get 1-px gold outline circle underneath; team order line drawn (destination line colored by order: move green, move fast yellow, sneak blue, fire red, smoke white, defend cyan arc, ambush orange arc).
- **Flags** at VLs: 8×12 flag on 1-px pole, German (black/white/red) vs Soviet (red with yellow) vs neutral (white).
- Overview and thumbnails rendered from the terrain canvas.

## 8. Audio

Web Audio synthesis (no files): rifle crack (noise burst + lowpass), SMG/MG bursts (repeated cracks), mortar thump + whistle + explosion, tank gun boom, engine hum loop for vehicles (pitch by speed), ricochet ping, radio "message" click, ambient wind loop. Positional volume by distance from viewport center.

## 9. Code structure

```
src/
  main.ts                 boot: canvas, game state machine, loop
  shared/types.ts         all shared types/enums/constants (contract)
  shared/rng.ts, math.ts
  engine/loop.ts input.ts camera.ts
  sim/map.ts terrain.ts los.ts path.ts spotting.ts
  sim/soldier.ts team.ts vehicle.ts weapons.ts orders.ts
  sim/combat.ts morale.ts victory.ts ai.ts smoke.ts
  sim/battle.ts           Battle: owns state, step(dt), events
  render/palette.ts pixelfont.ts sprites.ts terrainRender.ts unitRender.ts effects.ts cursor.ts
  ui/chrome.ts (panels/buttons) teamList.ts soldierMonitor.ts messagePanel.ts commandMenu.ts
  ui/screens/mainMenu.ts battleSetup.ts deploy.ts battleScreen.ts debrief.ts overview.ts options.ts
  data/weapons.ts units.ts names.ts maps/index.ts maps/*.ts operation.ts
  audio/synth.ts sfx.ts
test/*.test.ts
```

Module contracts live in `src/shared/types.ts`; every module imports from there and never redefines those types.

## 10. Testing

- Unit: path (A* finds road route, avoids water), LOS (wall blocks, hedge partial), ballistics (hit chance monotonic in range/cover), morale thresholds, victory scoring, map DSL produces expected tiles, spotting reveals firing units.
- Integration: headless `Battle` run 20 min with AI vs AI on each map completes without exceptions and produces a result.
- Manual: browser playtest with screenshots compared against the layout spec.
