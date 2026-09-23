# Module APIs (historical: the 2026-09-12 contract for the first parallel build)

The code is the authority now; many signatures below have since changed or been removed (e.g. the code-drawn sprite builders, the 800×600 input space). Read the module itself before relying on anything here.

All types come from `src/shared/types.ts` (import with `@/shared/types`). Path alias `@/` = `src/`.
Do not import from a module you are not told you depend on, except `@/shared/*`.
Tests live in `test/<module>.test.ts` (vitest, node environment — no DOM in tests).
Run `npx tsc --noEmit` and `npx vitest run` before you finish; fix what you own.

## src/engine
- `loop.ts`: `startLoop(cb: (dt: number) => void): void` — requestAnimationFrame loop, dt clamped to 0.1.
- `input.ts`: `createInput(canvas: HTMLCanvasElement): { state: InputState; endFrame(): void }` — maps window mouse coords to 800×600 logical coords (object-fit: contain), prevents context menu, tracks keys (lower-case `KeyboardEvent.key`, e.g. 'escape', ' ', 'shift', 'arrowleft').
- `camera.ts`: `createCamera(): Camera`, `worldToScreen(cam, p: Vec2): Vec2` (tile→viewport px), `screenToWorld(cam, p: Vec2): Vec2`, `clampCamera(cam, mapW, mapH)`, `panCamera(cam, dxPx, dyPx)`, `centerCamera(cam, p: Vec2)`.

## src/main.ts + src/game.ts
- `game.ts`: `class Game { settings: GameSettings; screen: Screen; setScreen(s: Screen): void; input; cam; audio; operation: OperationState | null; battleConfig: BattleConfig | null; battle: Battle | null; }` singleton `game` exported. Screens get `game` via import (`import { game } from '@/game'`).
- `main.ts`: create canvas ctx (imageSmoothingEnabled=false), input, start loop: `screen.update(dt, input.state); screen.draw(ctx); drawCursor(ctx, input.state.mouse, screen.cursor?.() ?? 'arrow'); input.endFrame()`. Starts on `MainMenuScreen`.

## src/sim/terrain.ts
- `TERRAIN_PROPS: Record<Terrain, TerrainProps>`
- `TERRAIN_LIST: Terrain[]`

## src/sim/map.ts
- `buildMap(def: MapDef): GameMap` — runs `def.paint`, assigns `buildingId` by flood-filling connected building tiles (buildingWood/buildingStone/floor), sets `windows`=1 on every 3rd wall tile of a building perimeter (and always on wall tiles adjacent to a road), initializes VLs (owner = `def.attacker` other side), smoke zeros.
- `tileAt(map, x: number, y: number): Terrain` (clamped; out of bounds = 'water'-like impassable 'open' but treat OOB as impassable in path).
- `idx(map, x, y): number`, `inBounds(map, x, y)`.
- `coverAt(map, p: Vec2): number`, `concealmentAt(map, p: Vec2): number` (includes smoke density × 1.5).
- `setTile(map, x, y, t: Terrain)` (for crushing / craters).
- `class MapPainter` (in `src/sim/mapdsl.ts`):
  ```ts
  constructor(tiles: Terrain[], w: number, h: number, seed?: number)
  fill(t: Terrain): void
  rect(x, y, w, h, t: Terrain): void
  patch(cx, cy, r, t: Terrain): void                      // blobby irregular disc
  noiseFill(t: Terrain, density: number, onlyOver?: Terrain[]): void  // scatter clumps of t
  road(points: Vec2[], width: number, t: 'dirtroad'|'pavedroad'): void
  building(x, y, w, h, kind: 'wood'|'stone'): void        // walls ring + floor interior (interior is 'floor')
  woods(cx, cy, rx, ry): void                             // irregular ellipse of 'woods' with 'scatteredtrees' fringe
  line(points: Vec2[], t: Terrain): void                  // 1-tile wide polyline (hedge/fence/stonewall/trench)
  river(points: Vec2[], width: number): void              // water polyline
  bridge(x, y, w, h): void
  ```

## src/sim/los.ts
- `hasLOS(map: GameMap, from: Vec2, to: Vec2): boolean` — Bresenham; blocked by `blocksLOS` tiles except the start/end tiles and window wall tiles (`windows`==1) when they are the tile adjacent to start or end; accumulates concealment (>1.0 blocks); smoke density counts.
- `losTrace(map, from, to): { clear: boolean; blockedAt: Vec2 | null; visibility: number }` — for the LOS tool.
- `losDistanceFactor(distM: number): number` — 1 at 0m, 0.5 at 200m, 0.2 at 400m.

## src/sim/path.ts
- `findPath(map: GameMap, from: Vec2, to: Vec2, mover: 'infantry'|'vehicle', maxNodes?: number): Vec2[]` — A* 8-neighbour, no corner cutting through impassable, returns tile-centre waypoints (x+0.5,y+0.5) excluding start; empty if unreachable (falls back to nearest reachable tile within 5 tiles). Must handle 240×180 maps under ~20 ms.
- `isPassable(map, x, y, mover): boolean`.

## src/sim/spotting.ts
- `updateSpotting(state: BattleState, rng: Rng): void` — recomputes `state.spotted[side]` and `state.spottedVehicles[side]` for both sides. Spot prob per pair as in spec §6.5 with the spotter being any alive soldier (or vehicle). Soldiers that fired within 5 s are spotted automatically if LOS exists. Cap pair checks: only consider pairs within 300 m.

## src/sim/smoke.ts
- `addSmoke(map, center: Vec2, radiusTiles: number, density: number)`, `stepSmoke(map, dt)` (decay 1/60 per s, slight drift +x).

## src/data
- `weapons.ts`: `WEAPONS: Record<string, WeaponDef>`; ids like `kar98k, mp40, mg34, mg42, mosin, ppsh41, dp28, maxim, svt40, pistol_p38, pistol_tt, mortar81, mortar82, pak38, pak40, zis3, m1937_45mm, kwk40_75, kwk36_88, kwk42_75, stuk40, f34_76, zis_s53_85, kv_zis5, d25t_122, coax_mg34, coax_dt, grenade, panzerfaust, panzerschreck, ptrd, satchel`.
- `units.ts`: `TEAM_DEFS: Record<string, TeamDef>`, `VEHICLE_DEFS: Record<string, VehicleDef>`, `teamsForYear(side, year): TeamDef[]`.
- `names.ts`: `randomName(side: Side, rng: Rng): string` (surname only), `RANKS: Record<Side, string[]>` (leader ranks first).
- `maps/index.ts`: `MAPS: MapDef[]`, `getMap(id): MapDef`. Five maps: `border_1941` (summer, farms, dirt roads, woods), `village_1942` (autumn, village with stone church, crops), `steppe_1943` (summer, open steppe with balkas as trenches/ hedges, small farm), `forest_1944` (summer, dense forest with clearings, river+bridge), `berlin_1945` (winter→ use 'winter' season, urban blocks of stone buildings, rubble, paved roads).
- `operation.ts`: `OPERATION: OperationBattleDef[]` (5 entries in that order), `initialForcePool(side): OperationState['forcePool']`, `DEFAULT_FORCES: Record<number, Record<Side, string[]>>` (year → forces for Battle mode).

## src/sim/battle.ts
```ts
export class Battle {
  state: BattleState; rng: Rng;
  constructor(config: BattleConfig)               // builds map, spawns teams into deploy zones (auto-layout), phase='deploy'
  step(dt: number): void                          // advances SIM by exactly dt (callers pass SIM_DT multiples); no-op unless phase==='running'
  start(): void                                   // deploy→running
  pause(): void; resume(): void
  issueOrder(teamId: number, order: Order): void  // validates, sets team.order, computes paths (uses path.ts)
  deployTeam(teamId: number, pos: Vec2): boolean  // only in deploy phase, inside the side's zone, passable
  offerTruce(side: Side): void                    // player offers; AI accepts if its morale < 50 or losing; both accepted → end
  selectableTeams(side: Side): Team[]
  soldierAt(p: Vec2, side?: Side): Soldier | null // hit-test within 0.8 tiles
  teamAt(p: Vec2, side: Side): Team | null
  playerSide(): Side
  drainEvents(): BattleEvent[]
}
```
- Internally per step: `stepOrders/Movement` (soldiers walk paths; speeds: move 1.4 m/s, moveFast 3.0, sneak 0.5; stance rules), vehicles (turn then drive, crush crushable), `stepSpotting` every SPOT_INTERVAL, `stepCombat(state, rng, dt, map)` from combat.ts, `stepMorale(state, rng, dt)` from morale.ts, `stepAI(state, rng, dt, battle)` every AI_INTERVAL from ai.ts (for the non-player side only), `stepVictory(state, dt)` from victory.ts, `stepSmoke`, effects arrays age out (explosions 1 s, tracers 0.15 s, flashes 0.1 s), `time += dt`, and end conditions.
- `spawn.ts`: `spawnTeam(state, def: TeamDef, side, pos, rng): Team` creates soldiers (names via data/names), vehicles.
- `teamStatus(state, team): TeamStatusWord`, `moraleWord(m: number): TeamMoraleWord` in `team.ts`.

## src/sim/combat.ts
- `stepCombat(state: BattleState, rng: Rng, dt: number): void` — target selection, firing, ballistics, HE/splash, AT vs armor, grenades, mortars, smoke rounds, pushes tracers/flashes/explosions/events/messages, applies casualties (`applyHit(state, soldier, weapon, rng)`), suppression. Exports `hitChance(weapon, distM, targetCover, targetStance, shooter: Soldier, targetMoving: boolean): number` and `penetrates(weapon, distM, armorMm, rng): boolean` for tests.

## src/sim/morale.ts
- `stepMorale(state: BattleState, rng: Rng, dt: number): void` — suppression decay, morale changes, activity transitions (pinned/cowering/panicked/routed/berserk/surrendered), fatigue, team morale & status caching (`team.morale`, `team.status`, `team.outOfAction`), side morale. Exports `moraleWord(m): TeamMoraleWord`.
- Events: push `teamBroken` and messages like "Rifle Squad is pinned down" (once per transition).

## src/sim/victory.ts
- `stepVictory(state, dt)`: VL capture logic, scores, end conditions (`state.phase='ended'`, `state.result` from the player's perspective, push `ended` event). Exports `computeResult(state): BattleResult`, `sideScore(state, side): number`.

## src/sim/ai.ts
- `stepAI(state: BattleState, rng: Rng, battle: { issueOrder(teamId, order): void }, side: Side): void` — plan for the given side per spec §6.9. Also `aiDeploy(state, side, rng, battle)` to auto-place teams in the deploy zone (used for the AI side and for "auto-deploy" of the player).

## src/render
- `palette.ts`: `PALETTE` consts: chrome colors (`chromeBg '#3a3f36', bevelLight '#6b7064', bevelDark '#1c1f1a', gold '#d8b448', text '#e8e8e0', dim '#9a9c94', red '#c8402c', green '#5fbf4a', yellow '#e0c04a', blue '#5a8fd0', cyan, orange, white, black`), `TERRAIN_COLORS: Record<Season, Record<Terrain, string[]>>` (2–4 shades per terrain), `STATUS_COLOR(word)`, `ORDER_COLOR: Record<OrderType,string>`, `SIDE_COLOR`.
- `pixelfont.ts`: `drawText(ctx, text: string, x: number, y: number, color: string, size?: 'small'|'big'): void` (small = 5×7 glyphs 1px spacing; big = 7×11 bold), `textWidth(text, size?): number`, `drawTextCentered(ctx, text, cx, y, color, size?)`. Glyphs: A–Z a–z 0–9 punctuation `.,:;!?'"-+/()%&*` and `äöüßÄÖÜ` fallback to base letters. Uppercase only rendered in big.
- `sprites.ts`: all procedural sprites, cached canvases:
  ```ts
  getSoldierSprite(side: Side, season: Season, stance: Stance | 'dead', facing: Facing8, frame: 0|1): HTMLCanvasElement   // 12×12 (prone/dead 14×8 ok, still return canvas)
  getVehicleSprite(defId: string, part: 'hull'|'turret', state: 'ok'|'knockedOut'): HTMLCanvasElement                     // scaled TILE_PX/TILE_M px per metre, pointing north
  getFlagSprite(owner: Side | null): HTMLCanvasElement       // 10×14 incl pole
  getTeamIcon(iconId: string): HTMLCanvasElement             // 12×12 icons: rifle, smg, mg, mortar, atgun, sniper, atteam, tank, spg, halftrack, command, engineer
  getCursorSprite(kind: CursorKind): HTMLCanvasElement       // 16×16 with hotspot at (0,0) except crosshair (8,8)
  getSmokePuff(size: number): HTMLCanvasElement
  getTreeSprite(variant: number, season: Season): HTMLCanvasElement // 14×14 canopy w/ shadow
  ```
- `terrainRender.ts`: `class TerrainRenderer { constructor(map: GameMap); draw(ctx, cam: Camera): void; invalidateTile(x,y): void; thumbnail(w,h): HTMLCanvasElement; }` — bakes terrain into offscreen chunk canvases (256 px chunks) with procedural texture per tile (use `hash2` noise), roads with ruts, building roofs (wood: brown planks; stone: gray slate with ridge), rubble, hedges, walls, water with ripples, snow. Trees drawn from `getTreeSprite` clustered over woods. Draws craters, blood decals, smoke clouds (soft alpha) via `drawOverlays(ctx, cam, state: BattleState)`.
- `unitRender.ts`: `drawUnits(ctx, cam, state: BattleState, playerSide: Side, selectedTeamId: number | null, settings: GameSettings)` — corpses first, then vehicles (hull, then turret rotated), soldiers (only friendly + spotted enemy), selection rings (gold 1px circle under each soldier of selected team), team labels if settings.unitLabels (small text with dark backdrop), order lines for selected team (`ORDER_COLOR`), defend/ambush facing arcs, VL flags.
- `effects.ts`: `drawEffects(ctx, cam, state)` — flashes, tracers, explosions, burning vehicles smoke/flames.
- `cursor.ts`: `drawCursor(ctx, mouse: Vec2, kind: CursorKind)`.

## src/ui (all canvas; no DOM)
- `chrome.ts`: `drawPanel(ctx, r: Rect, opts?: { sunken?: boolean; title?: string })`, `drawButton(ctx, r, label, { pressed?, disabled?, hot? }): void`, `class Button { constructor(r: Rect, label: string); update(input): boolean /* true when clicked */; draw(ctx) ; disabled; }`, `drawBevelBox`, `drawListRow`, `drawScrollArrows`, `drawTitleBanner(ctx, text, y)`, `hitRect(p: Vec2, r: Rect)`.
- `teamList.ts`: `class TeamListPanel { rect = {x:0,y:480,w:200,h:120}; scroll: number; update(input, teams: Team[], state: BattleState): number | null /* clicked team id */; draw(ctx, teams, state, selectedTeamId) }`.
- `soldierMonitor.ts`: `drawSoldierMonitor(ctx, state, team: Team | null)` at {200,480,400,120}.
- `messagePanel.ts`: `class MessagePanel { update(input): 'truce'|'overview'|'options'|'pause'|null; draw(ctx, state, paused: boolean) }` at {600,480,200,120}: 5 message lines + 4 buttons + clock.
- `commandMenu.ts`: `class CommandMenu { open(at: Vec2, team: Team): void; close(); isOpen; update(input): OrderType | 'cancel' | null; draw(ctx) }` — vertical list of the seven orders, 90×14 rows, hover highlight, disabled entries dim (smoke only if team has smoke capability, fire needs a weapon).
- `screens/mainMenu.ts` `MainMenuScreen`, `screens/battleSetup.ts` `BattleSetupScreen`, `screens/options.ts` `OptionsScreen(returnTo: Screen)`, `screens/debrief.ts` `DebriefScreen(battle: Battle)`, `screens/deploy.ts` `DeployScreen(battle: Battle)`, `screens/battle.ts` `BattleScreen(battle: Battle)`, `screens/overview.ts` `OverviewScreen(battle, returnTo)`, `screens/operation.ts` `OperationScreen` (briefing before each operation battle + force picker).

## src/audio
- `sfx.ts`: `class Sfx { setVolume(v: number); play(kind: SfxKind, gain?: number): void; engine(id: number, speedFactor: number | null): void; ambient(on: boolean); unlock(): void /* call on first user gesture */ }` with `type SfxKind = 'rifle'|'smg'|'lmg'|'hmg'|'pistol'|'mortarFire'|'mortarHit'|'tankGun'|'atGun'|'explosion'|'grenade'|'ricochet'|'smokePop'|'click'|'message'|'flagCapture'|'scream'`. `handleEvents(events: BattleEvent[], cam: Camera)` maps battle events to sounds with distance attenuation from viewport centre.
