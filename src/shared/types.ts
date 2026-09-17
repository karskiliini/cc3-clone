// ============================================================================
// SHARED CONTRACT — every module imports from here. Do NOT redefine these
// types elsewhere. Add fields here if you need them (keep backward compatible).
// ============================================================================

// ----------------------------------------------------------------- constants
export const SCREEN_W = 1024;       // CC3 battle screen ran at 1024x768; menus are an 800x600 area centred on black
export const SCREEN_H = 768;
export const VIEW_W = 1024;
export const VIEW_H = 630;          // map viewport height; bottom panel is 138
export const PANEL_Y = 630;
export const PANEL_H = 138;
export const MENU_W = 800;          // menu screens: 800x600 area centred in the 1024x768 canvas
export const MENU_H = 600;
export const MENU_X = 112;
export const MENU_Y = 84;
export const TILE_M = 2;            // metres per tile
export const TILE_PX = 20;          // pixels per tile at zoom 1 (10 px per metre, like CC3 at 1024x768)
export const SIM_DT = 0.1;          // seconds per sim step (10 Hz)
export const SPOT_INTERVAL = 0.5;   // seconds between spotting passes
export const AI_INTERVAL = 5;       // seconds between AI re-planning
export const DEFAULT_BATTLE_SECONDS = 20 * 60;
export const VL_CAPTURE_RADIUS_M = 10;
export const VL_CAPTURE_SECONDS = 5;

// ---------------------------------------------------------------- geometry
export interface Vec2 { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
/** Facing 0..7, 0 = north (up), clockwise: 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW */
export type Facing8 = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

// -------------------------------------------------------------------- sides
export type Side = 'german' | 'soviet';
export const SIDES: Side[] = ['german', 'soviet'];
export function otherSide(s: Side): Side { return s === 'german' ? 'soviet' : 'german'; }

// ------------------------------------------------------------------ terrain
export type Terrain =
  | 'open' | 'grass' | 'tallgrass' | 'crops' | 'dirtroad' | 'pavedroad'
  | 'woods' | 'scatteredtrees' | 'buildingWood' | 'buildingStone' | 'floor'
  | 'rubble' | 'stonewall' | 'hedge' | 'fence' | 'water' | 'bridge'
  | 'snow' | 'mud' | 'crater' | 'trench';

export interface TerrainProps {
  cover: number;          // 0..1 reduces hit chance & lethality
  concealment: number;    // 0..1 per-tile visibility loss along LOS
  blocksLOS: boolean;     // hard LOS block (walls, building walls, woods)
  infantryCost: number;   // A* cost multiplier (Infinity = impassable)
  vehicleCost: number;    // A* cost multiplier (Infinity = impassable)
  crushable: boolean;     // vehicles turn it into rubble/open
  speedMul: number;       // movement speed multiplier
}

export type Season = 'summer' | 'autumn' | 'winter';

export interface VictoryLocation {
  id: number;
  name: string;
  x: number;              // tile coords (centre)
  y: number;
  value: 1 | 2 | 3;
  owner: Side | null;
  captureTimer: number;   // seconds of uncontested presence by `capturingSide`
  capturingSide: Side | null;
}

export type DecorKind =
  | 'haystack' | 'well' | 'cart' | 'bush' | 'stump' | 'pole' | 'rocks' | 'log'
  | 'shellhole' | 'grave' | 'sign' | 'barrel' | 'crate' | 'wreck' | 'woodpile' | 'puddle' | 'flowers' | 'tramwire'
  | 'foxhole';
/** Purely visual map dressing (no sim effect — except 'foxhole', whose tile the map DSL also
 * paints as 'trench' so it gives trench cover). Position in tile coords (may be fractional).
 * `angle` (radians, 0 = east, PI/2 = south) is the direction a foxhole faces (toward the enemy). */
export interface DecorItem { kind: DecorKind; x: number; y: number; variant?: number; angle?: number }

/** Vector source geometry recorded by the map DSL so the renderer can paint smooth curves (tiles remain the sim truth). */
export interface MapVectorFeature {
  kind: 'road' | 'river' | 'line';
  terrain: Terrain;          // dirtroad/pavedroad/water/hedge/fence/stonewall/trench
  points: Vec2[];            // tile coordinates (may be fractional)
  width: number;             // tiles
}

/** Ground-relief painting API handed to `MapDef.elevation` (implemented by sim/mapdsl.ts's
 * ElevationPainter). Declared structurally here so shared/types.ts stays free of sim imports. */
export interface ElevationApi {
  readonly w: number;
  readonly h: number;
  /** Sets every tile to a constant base elevation (m). */
  base(m: number): void;
  /** A rounded hill of `peakM` metres centred on (cx, cy) with radius `radiusTiles`. */
  hill(cx: number, cy: number, radiusTiles: number, peakM: number, falloff?: HillFalloff): void;
  /** A raised spine `heightM` metres high along a polyline, `widthTiles` wide (feathered). */
  ridge(points: Vec2[], widthTiles: number, heightM: number): void;
  /** A depression `depthM` metres deep along a polyline (a gully / balka / stream cut). */
  valley(points: Vec2[], widthTiles: number, depthM: number): void;
  /** A linear ramp across `rect`, going from `fromM` to `toM` along the direction `angleRad`
   * (0 = +x / east, pi/2 = +y / south). */
  slope(rect: Rect, fromM: number, toM: number, angleRad: number): void;
  /** Lifts/lowers a rect to a flat shelf at `m` metres (feathered over 2 tiles at the edge). */
  terrace(rect: Rect, m: number): void;
  /** Flattens a corridor along a polyline to a walkable grade (<= `maxGradePct` %), leaving a
   * small embankment/cutting at the corridor edge. */
  gradeRoad(points: Vec2[], widthTiles: number, maxGradePct: number): void;
  /** Cuts a river/stream bed `depthM` metres below the surrounding ground, forced to run
   * downhill along the polyline (points given in flow order). */
  cutRiver(points: Vec2[], widthTiles: number, depthM: number): void;
  /** N passes of a 3x3 box blur over the whole field (smooths the seams between features). */
  smoothElevation(passes: number): void;
  /** Relaxes the whole field until no 4-neighbour step exceeds `maxGradePct` % — the "no cliffs"
   * safety net every map runs last. */
  limitGrade(maxGradePct: number, iterations?: number): void;
  /** Reads/writes single tiles (fractional coords are floored). */
  at(x: number, y: number): number;
  add(x: number, y: number, m: number): void;
  /** Clamps the whole field into [lo, hi] metres. */
  clampRange(lo: number, hi: number): void;
  /** Low-amplitude coherent undulation over the whole map (m peak-to-peak). */
  rolling(amplitudeM: number, wavelengthTiles: number, seedOffset?: number): void;
}

export type HillFalloff = 'smooth' | 'cone' | 'dome' | 'plateau';

export interface MapDef {
  id: string;
  name: string;
  description: string;
  width: number;          // tiles
  height: number;         // tiles
  season: Season;
  /** Fills `tiles` (row-major, width*height) with Terrain values. */
  paint(tiles: Terrain[], w: number, h: number): void;
  victoryLocations: Omit<VictoryLocation, 'owner' | 'captureTimer' | 'capturingSide'>[];
  deployZones: Record<Side, Rect>;   // tile rects
  /** Which side attacks (starts owning fewer VLs). Defender owns all VLs at start. */
  attacker: Side;
  /** optional visual dressing */
  decor?: DecorItem[];
  /** optional vector geometry for smooth rendering of roads/rivers/linear features */
  vectors?: MapVectorFeature[];
  /** Optional ground relief: fills a per-tile elevation field (metres above the map datum).
   * Maps without one are perfectly flat, exactly as before. */
  elevation?(e: ElevationApi): void;
}

export interface GameMap {
  def: MapDef;
  width: number;
  height: number;
  tiles: Terrain[];
  /** parallel to tiles; building id per tile or -1 */
  buildingId: Int16Array;
  /** parallel to tiles; 0 = no window, 1 = wall tile with a window/door (can be fired through) */
  windows: Uint8Array;
  victoryLocations: VictoryLocation[];
  /** smoke density 0..1 per tile */
  smoke: Float32Array;
  /** crater decals: tile indexes */
  craters: number[];
  /** visual blast marks left by explosions this battle (sub-tile position, size by weapon); the
   * renderer stamps them into its baked terrain. Render-only: never read by the sim. */
  craterMarks?: CraterMark[];
  /** tile indexes changed since last render bake (e.g. vehicle crushing terrain); renderer clears this */
  dirtyTiles?: number[];
  /** surface height model (sim/heightField.ts), built at map load and updated by blasts/damage */
  heightField?: HeightField;
  /** Per-tile GROUND elevation in metres (row-major, width*height) — the landform under every
   * feature. Undefined on a map with no `elevation()` (perfectly flat, height 0 everywhere).
   * This is the array the sim's hot paths (LOS, movement, spotting) read directly. */
  ground?: Float32Array;
  /** Per-tile steepness: the largest |grade| (rise/run, 1.0 = 45deg) to a 4-neighbour. Used to
   * keep vehicles off banks steeper than 25%. Undefined together with `ground`. */
  groundSteep?: Float32Array;
}

/** Surface height in metres at HF_RES samples per tile edge (0.5 m), row-major over
 * (width*res) x (height*res). `height` = `ground` (the landform) plus base (terrain/structures)
 * composed with `dig` (craters, foxholes, trenches); `canopy` is tree-crown height (0 = none), kept apart so a
 * view can show the ground under woods. `version` increments on every change. */
export interface HeightField {
  res: number;
  w: number;
  h: number;
  /** ground elevation (m) per sample, bilinearly interpolated from the map's per-tile field */
  ground: Float32Array;
  base: Float32Array;
  dig: Float32Array;
  height: Float32Array;
  canopy: Float32Array;
  version: number;
  /** craterMarks already stamped into `dig` */
  marksApplied: number;
}

/** A blast mark from one explosion: centre in tile coords, rim diameter in metres. */
export interface CraterMark { x: number; y: number; sizeM: number; kind: 'shell' | 'grenade' }

// ------------------------------------------------------------------ weapons
export type WeaponClass =
  | 'rifle' | 'smg' | 'lmg' | 'hmg' | 'pistol' | 'mortar' | 'atgun' | 'tankgun'
  | 'coaxmg' | 'grenade' | 'atrocket' | 'atrifle' | 'flamethrower';

export interface WeaponDef {
  id: string;
  name: string;               // display name e.g. "Kar98k", "MG42", "7.5cm KwK 40"
  cls: WeaponClass;
  rangeM: number;             // max effective range in metres
  minRangeM?: number;         // mortars
  rate: number;               // shots per second (bursts count as shots)
  burst: number;              // rounds per trigger pull (1 for rifles)
  accuracy: number;           // hit prob at 100 m vs standing unprotected target
  lethality: number;          // 0..1 chance a hit kills/incapacitates
  suppression: number;        // 0..1 suppression per shot landing nearby
  penetrationMm: number;      // at 100 m; 0 for small arms
  heRadiusM: number;          // splash radius, 0 for direct small arms
  ammo: number;               // magazine/ready rounds
  reloadS: number;
  /** guns (tank, SPG, AT): seconds a regular, stationary crew needs to load one round, by calibre
   * (sim/gunTiming.ts). `rate` is NOT used for these guns' cycle; it stays for automatic weapons. */
  loadS?: number;
  smoke?: boolean;            // can fire smoke rounds
  indirect?: boolean;         // mortar
  /** crew-served weapons (mortar/hmg/atgun): seconds to set up after the crew stops (see sim/crewWeapon.ts) */
  setupS?: number;
  /** crew-served weapons: seconds to pack up before the crew can move off */
  packS?: number;
  /** guns: the ammunition load by round type for one `ammo` worth of rounds (AP / APCR / HE /
   * smoke). `penetrationMm` stays the plain AP value and `ammo` the total. Absent = one round type. */
  rounds?: { ap: number; apcr?: number; he: number; smoke?: number };
  /** special armour-piercing round (APCR / PzGr 40, or a HEAT round with falloffPerKm 0):
   * penetration at 100 m, loss per km of range as a fraction (1.2 = all of it gone at 833 m),
   * first battle year it is issued. */
  apcr?: { penetrationMm: number; falloffPerKm: number; from?: number };
}

/** Ammunition a gun can have loaded. */
export type RoundType = 'ap' | 'apcr' | 'he' | 'smoke';
export type RoundCounts = Record<RoundType, number>;

/** Where a gunner lays on an armoured target (sim/aimPoint.ts). 'mass' = centre of visible mass. */
export type AimPoint =
  | 'mass' | 'turretRing' | 'lowerHull' | 'driverPlate' | 'gunMantlet' | 'runningGear'
  | 'engineDeck' | 'sideHull' | 'rear';

/** Hit zones of a vehicle (sim/vehicleDamage.ts). Turretless vehicles use the turret zones for
 * their fighting compartment. */
export type VehicleZone =
  | 'turretFront' | 'turretSide' | 'turretRear' | 'mantlet' | 'cupola'
  | 'hullFrontUpper' | 'hullFrontLower' | 'hullSide' | 'hullRear' | 'engineDeck'
  | 'runningGearL' | 'runningGearR' | 'top';

export type EquipState = 'ok' | 'damaged' | 'destroyed';
export type VehicleSystem =
  | 'mainGun' | 'coaxMg' | 'bowMg' | 'sight' | 'traverse' | 'engine' | 'transmission'
  | 'trackL' | 'trackR' | 'radio' | 'fuelLeak';
export type VehicleDamage = Record<VehicleSystem, EquipState>;
export type CrewRole = 'commander' | 'gunner' | 'loader' | 'driver' | 'radioOp';

/** What sits where inside a vehicle; every field optional, defaults by class and crew size
 * (sim/vehicleDamage.ts `vehicleLayout`). */
export interface VehicleLayoutDef {
  /** front = German front drive (lower front plate covers the final drive), rear = Soviet */
  transmission?: 'front' | 'rear';
  /** fuel tanks along the hull sides (T-34, KV) */
  sideFuel?: boolean;
  /** the commander lays the gun himself (T-34/76, T-26, BT, T-70) */
  twoManTurret?: boolean;
  /** open fighting compartment: exposed to HE, mortars, grenades and small arms from above/behind */
  openTop?: boolean;
  bowMg?: boolean;
  radio?: boolean;
  /** where the crew gets in and out (spec 2026-09-17 §10); defaults by vehicle class in
   * sim/vehicleDamage.ts `vehicleLayout` */
  hatches?: VehicleHatchDef[];
  /** where passengers board and leave a transport (the SdKfz 251's twin rear doors: one opening) */
  doors?: VehicleHatchDef[];
}
/** A hatch (or the side/rear wall of an open vehicle), hull-local metres: x to the right, y ahead. */
export interface VehicleHatchDef {
  x: number;
  y: number;
  /** turret/cupola hatches serve the turret crew, hull hatches the driver and bow gunner; the
   * sides and rear of an open vehicle serve everyone */
  group: 'turret' | 'hull' | 'side' | 'rear';
}
/** A man climbing out of (or into) a vehicle through one hatch (spec 2026-09-17 §10). */
export interface HatchClimb {
  vehicleId: number;
  /** index into the vehicle layout's `hatches` */
  hatch: number;
  kind: 'bailout' | 'mount';
  /** tile coords at the start and the end of the climb (hatch on the hull <-> beside it) */
  from: Vec2;
  to: Vec2;
  start: number;
  until: number;
  /** a panicked bail-out: faster, sloppier, ends in a run */
  panicked: boolean;
  /** a passenger using a transport's door (`hatch` then indexes the layout's `doors`; a panicked
   * passenger goes over the side: `overSide` with `hatch` indexing `hatches`) */
  passenger?: boolean;
  overSide?: boolean;
}

// ----------------------------------------------------------------- soldiers
export type Health = 'healthy' | 'wounded' | 'incapacitated' | 'dead';
export type Stance = 'standing' | 'crouching' | 'prone';
export type Activity =
  | 'idle' | 'moving' | 'movingFast' | 'sneaking' | 'firing' | 'reloading'
  | 'defending' | 'ambushing' | 'hiding' | 'cowering' | 'pinned' | 'panicked'
  | 'routed' | 'berserk' | 'surrendered' | 'dead' | 'incapacitated';

// -------------------------------------------------------------- soldier mind
export type MentalState =
  | 'calm' | 'alert' | 'wary' | 'shaken' | 'pinned' | 'cowering' | 'panicked' | 'broken' | 'berserk';

export interface EnemyBelief {
  pos: Vec2;                  // tile coords
  count: number;              // enemies believed at this spot
  confidence: number;         // 0..1
  kind: 'seen' | 'fired' | 'reported';
  time: number;               // battle seconds of last refresh
  deadSeen: number;           // dead enemies seen near this spot
}

/** Per-soldier psychology and memory; see docs/superpowers/specs/2026-09-13-soldier-mind-design.md */
export interface SoldierMind {
  state: MentalState;
  motivation: number;         // 0..100, slow
  stress: number;             // 0..100, fast
  fear: number;               // 0..100, derived each step
  beliefs: EnemyBelief[];     // max 8
  threatDir: number | null;   // radians, 0 = north, clockwise
  threatLevel: number;        // 0..1, decays
  lastIncomingAt: number;     // battle seconds
  hesitation: number;         // seconds before acting on the current order
  surrounded: boolean;
  helpless: boolean;
  stateSince: number;         // battle seconds when `state` was entered
  /** ordered position for cover seeking (set by orders); null = none */
  anchor: Vec2 | null;
  /** last cover-seek evaluation time */
  lastCoverSeekAt: number;
  /** hidden personality trait rolled at spawn (spec §11); undefined = no notable trait. */
  trait?: 'steady' | 'nervous' | 'brave' | 'reckless' | 'cautious' | 'stoic';
  /** issuedAt of a team order this soldier refused (failed obedience); retried after hesitation. */
  pendingOrderAt?: number;
}

export interface Soldier {
  /** gun gunners: rounds left by type (sum = ammo + ammoReserve); sim/aimPoint.ts `soldierRounds` */
  rounds?: RoundCounts;
  id: number;
  teamId: number;
  side: Side;
  name: string;               // surname only, e.g. "Müller"; display as `${rank}. ${name}`
  rank: string;               // "Gefr", "Sgt", "Ryad"
  weaponId: string;
  ammo: number;
  ammoReserve: number;
  grenades: number;
  health: Health;
  morale: number;             // 0..100
  fatigue: number;            // 0..100
  suppression: number;        // 0..100
  experience: number;         // 0..100
  stance: Stance;
  activity: Activity;
  pos: Vec2;                  // tile coordinates, continuous
  facing: Facing8;
  targetSoldierId: number | null;
  targetVehicleId: number | null;
  targetPoint: Vec2 | null;
  path: Vec2[];               // remaining waypoints (tile centres)
  reloadTimer: number;
  fireTimer: number;
  animFrame: number;
  isLeader: boolean;
  /** which vehicle this soldier crews, or null */
  vehicleId: number | null;
  formationOffset: Vec2;
  /** last time (battle seconds) this soldier fired; used by spotting */
  lastFiredAt: number;
  /** cover value at current tile (cached) */
  cover: number;
  kills: number;
  mind: SoldierMind;
  /** Last HE burst that threw this man (spec 2026-09-17 §4): where it burst, when, how hard
   * (0..1.5), and where he stood before the knockback (`origin`) so the renderer can fly a ragdoll
   * from there to his current `pos`. Written by the sim, read only by the renderer. */
  blast?: { from: Vec2; time: number; force: number; origin: Vec2 };
  /** Knocked down by a blast: cannot move, fire or throw until battle time reaches this. */
  stunnedUntil?: number;
  /** Dazed by that blast (sim/daze.ts) until this battle time: cannot fire, throw, reload, work a
   * crew task, spot, loot or obey a movement order — he may only crawl to better cover. */
  dazedUntil?: number;
  /** Recovering from the daze until this battle time: accuracy and task speed x0.7 fading to 1. */
  shakenUntil?: number;
  /** A dazed man's self-preservation crawl (sim/daze.ts): the path he drags himself along (empty =
   * lying still) and when he next looks around for something better. */
  dazeCrawl?: { path: Vec2[]; lookAt: number };
  /** Crew-served weapon task this man is assigned to right now (sim/crewWeapon.ts, spec
   * 2026-09-17 §6); absent when he has none. `progress` 0..1 of the task; `walking` while he is
   * still on his way to the station. Written by the sim each step, read by the HUD and renderer. */
  crewTask?: { id: CrewTaskId; progress: number; walking: boolean };
  /** Run down by a vehicle (spec 2026-09-17 §7): the corpse is drawn flattened along `dir`
   * (radians, 0 = north, clockwise — the vehicle's direction of travel). */
  crushed?: { dir: number; time: number };
  /** Leaping out of a vehicle's way until this battle time (§7): he sprints along `path` whatever
   * his state, and is not run down meanwhile. */
  dodgeUntil?: number;
  /** Torn apart by a severe blast (spec 2026-09-17 §8): the body is no longer drawn, its parts
   * are in `state.debris`. */
  dismembered?: boolean;
  /** His kit has been turned into ground items (sim/items.ts `dropKit`); never dropped twice. */
  kitDropped?: boolean;
  /** Going for an item on the ground (sim/pickup.ts, spec 2026-09-17 §9): walking to it, then —
   * once `until` is set — stooping over it until that battle time (`from` = when he stooped).
   * `priority` is why he wants it (1 ammunition, 2 squad MG, 3 grenades / AT kit, 4 better weapon);
   * `resume` is the path end and activity he goes back to afterwards. */
  pickup?: { itemId: number; priority: number; startedAt: number; from?: number; until?: number; resume?: { dest: Vec2 | null; activity: Activity } };
  /** Climbing out of or into a vehicle through a hatch (sim/vehicleCrew.ts, spec 2026-09-17 §10):
   * he is outside the armour, standing, and can be hit. The renderer plays `crew.bailout` /
   * `crew.mount` by progress between `from` and `to`. */
  hatch?: HatchClimb;
  /** Riding in a transport as a passenger (sim/transport.ts): `vehicleId` is the transport, but he
   * is NOT one of its crew. */
  seat?: 'passenger';
  /** Just out of a vehicle in a panic (§10): he runs to `to` whatever his mind says, until then. */
  bailRun?: { to: Vec2; until: number };
}

/** Kit lying on the ground (spec 2026-09-17 §9; sim/items.ts). `weapon`: `weaponId` with the
 * `rounds` left in it; `ammo`: spare `rounds` for `weaponId` (usable by its cartridge family);
 * `grenades`: `count` of them; `helmet` / `pack`: purely visual. `sprite` is the items-atlas key
 * without the `item.` prefix. `from`/`thrownAt` describe the last blast flight for the renderer. */
export type ItemKind = 'weapon' | 'ammo' | 'grenades' | 'helmet' | 'pack';
export interface GroundItem {
  id: number;
  kind: ItemKind;
  weaponId?: string;
  rounds?: number;
  count?: number;
  side: Side;
  pos: Vec2;
  /** radians, 0 = north, clockwise: how it lies */
  dir: number;
  sprite: string;
  /** squad whose man dropped it (the squad's own MG is taken over from further away) */
  teamId?: number;
  /** soldier currently going for it */
  claimedBy?: number;
  from?: Vec2;
  thrownAt?: number;
  force?: number;
}

/** A piece of a body broken up by a severe blast (spec 2026-09-17 §8; sim/debris.ts). */
export type DebrisKind = 'torso' | 'head' | 'arm' | 'leg' | 'boot' | 'plate' | 'wheel' | 'hatch';
export interface Debris {
  /** 'plate' | 'wheel' | 'hatch': heavy fragments of a vehicle torn apart by its ammunition
   * (sim/vehicleExplosion.ts); the rest are body parts */
  kind: DebrisKind;
  side: Side;
  season: Season;
  pos: Vec2;
  /** radians, 0 = north, clockwise */
  dir: number;
  variant: number;
  /** last flight, for the renderer: where it started, when, how hard */
  from?: Vec2;
  thrownAt?: number;
  force?: number;
  /** heavy vehicle fragment still in the air: battle time it comes down (it can injure a man it
   * lands on; cleared once resolved) */
  landAt?: number;
}

// ----------------------------------------------------------------- vehicles
export type VehicleState = 'ok' | 'immobilized' | 'knockedOut' | 'burning' | 'abandoned';

export interface VehicleDef {
  id: string;
  name: string;               // "T-34/76", "PzKw IV G"
  kind: 'tank' | 'spg' | 'halftrack' | 'armoredcar';
  lengthM: number;
  widthM: number;
  speedRoadMs: number;        // metres per second
  speedOffroadMs: number;
  /** @deprecated legacy hull turn rate (rad/s). No entry of data/units.ts carries it any more; it is
   * read ONLY by `hullTurnRad`/`turretTraverseRad` in sim/gunTiming.ts as the documented fallback for
   * VehicleDef literals (tests) that lack the historical figures below. */
  turnRateRad?: number;
  /** historical turret traverse, deg/s, typical combat value (casemates: the gun's handwheel traverse) */
  turretTraverseDegS?: number;
  /** hand traverse when the engine is dead (powered turrets), deg/s */
  turretTraverseHandDegS?: number;
  /** historical hull turn in place, deg/s (wheel-steered halftracks: see `turnRadiusM`) */
  hullTurnDegS?: number;
  /** turretless vehicles: the gun traverses this many degrees either side of the hull axis */
  gunArcDeg?: number;
  /** wheel-steered vehicles cannot pivot: turn rate = speed / this radius (m), zero at rest */
  turnRadiusM?: number;
  /** rounds in the ready rack: they load at full speed, the rest x1.25 from the hull racks */
  readyRack?: number;
  armor: { front: number; side: number; rear: number; top: number };  // mm
  mainWeaponId: string | null;
  coaxWeaponId: string | null;
  hasTurret: boolean;
  crew: number;
  mainAmmo: number;
  /** known weak plates an ace gunner aims for: effective thickness in mm by aim point */
  weakSpots?: Partial<Record<AimPoint, number>>;
  layout?: VehicleLayoutDef;
  /** men it carries besides its crew (SdKfz 251: 10); absent = none */
  passengers?: number;
}

/** A gunner's lay on one target (vehicles: sim/combat.ts; the same bracketing fields serve AT guns). */
export interface GunLay {
  /** identity of the target: 'v<id>' vehicle, 't<teamId>' infantry team, 'p' a point */
  key: string;
  /** where the gun is being laid */
  aim: Vec2;
  /** seconds of target designation left (commander's call) */
  designateLeftS: number;
  /** seconds of fine lay (or follow-up correction) left, and of the whole lay for the progress */
  fineLeftS: number;
  totalS: number;
  /** follow-up correction on a target already fired at */
  followUp?: boolean;
  /** observed misses on this target (bracketing), where we and the target stood when they fell */
  misses?: number;
  bracketFrom?: Vec2;
  bracketAt?: Vec2;
  /** battle time the target was lost from sight (the lay is kept a few seconds) */
  lostAt?: number;
}

export interface Vehicle {
  id: number;
  teamId: number;
  side: Side;
  defId: string;
  pos: Vec2;                  // tile coords
  hullFacing: number;         // radians, 0 = north, clockwise
  turretFacing: number;       // radians absolute
  state: VehicleState;
  mainAmmo: number;
  coaxAmmo: number;
  path: Vec2[];
  speed: number;              // current m/s
  targetVehicleId: number | null;
  targetSoldierId: number | null;
  targetPoint: Vec2 | null;
  mainFireTimer: number;
  coaxFireTimer: number;
  burnTimer: number;
  hits: number;
  // ---- ammunition types, aim points, locational damage (all optional, lazy defaults) ----
  /** main-gun rounds left by type (sum = mainAmmo); sim/aimPoint.ts `vehicleRounds` */
  rounds?: RoundCounts;
  /** round in the breech of the main gun (already taken out of `rounds`/`mainAmmo`) */
  loadedRound?: RoundType;
  /** the gunner's current aim point on an armoured target, and the vehicle it was chosen for */
  aimPoint?: AimPoint;
  aimVehicleId?: number;
  /** battle time until which the gunner holds fire for a better presentation */
  aimHoldUntil?: number;
  // ---- loading and laying phases of the main gun (sim/gunTiming.ts, sim/combat.ts; all optional) ----
  /** what the main gun is waiting for: the loader, the gunner's lay, or nothing */
  gunState?: 'loading' | 'laying' | 'ready';
  /** 0..1 progress of the round being loaded (1 = in the breech, breech closed) */
  loadProgress?: number;
  /** 0..1 progress of the lay on the current target (designation + fine lay; 1 = laid) */
  layProgress?: number;
  /** seconds the whole current load takes / took (`mainFireTimer` holds what is left of it) */
  loadTotalS?: number;
  /** the gunner's lay on the current target */
  gunLay?: GunLay;
  /** rounds taken from the ready rack since it was last restocked */
  readyRackUsed?: number;
  /** battle time of the last main-gun round */
  lastMainShotAt?: number;
  /** battle time until which a moving vehicle stands still for an aimed shot (short halt) */
  fireHaltUntil?: number;
  /** when the current short halt began / battle time before which it will not halt again */
  fireHaltSince?: number;
  noFireHaltUntil?: number;
  /** equipment states (sim/vehicleDamage.ts); absent = all ok */
  damage?: VehicleDamage;
  /** seat -> soldier id (null = empty); filled from the team's crew on first use */
  seats?: Partial<Record<CrewRole, number | null>>;
  /** a crewman changing seats: nobody works `role` until `until` */
  seatSwap?: { role: CrewRole; soldierId: number; until: number };
  /** catastrophic ammunition explosion: the turret is blown off */
  turretBlown?: boolean;
  /** where the blown-off turret came down (tile coords) and how it lies (radians, 0 = north,
   * clockwise); absent = the renderer's default spot beside the hull */
  turretLanding?: Vec2;
  turretLandingDir?: number;
  /** cook-off of a burning vehicle (sim/vehicleExplosion.ts): burn seconds already checked, rounds
   * that have popped, and how it ended ('detonated': the ammunition went up; 'fuel': the fuel
   * tank; 'burntOut': the fire died down without either); `rackFire`: the fire started in the
   * ammunition itself, which cooks off more readily */
  cookOff?: { checkedS: number; pops: number; ended?: 'detonated' | 'fuel' | 'burntOut'; rackFire?: boolean };
  /** battle time the crew must be out by (fire); set when a fire starts */
  bailBy?: number;
  // ---- leaving and re-entering (sim/vehicleCrew.ts, spec 2026-09-17 §10; all optional) ----
  /** the crew is getting out, one man per hatch at a time */
  exiting?: { panicked: boolean; fire: boolean; startedAt: number };
  /** battle time each hatch is busy until (index = layout hatch) */
  hatchBusyUntil?: number[];
  /** what drove the crew out, as they believed it then (null: nothing they could place) */
  bailThreat?: { pos: Vec2; time: number } | null;
  /** the crew will not think of going back before this battle time */
  crewShockUntil?: number;
  /** the crew refuses to go back for the rest of the battle */
  noReturn?: boolean;
  /** the crew is on its way back in (own decision, or ordered by the player) */
  remount?: { since: number; ordered: boolean };
  /** the hull was already immobilised when it was abandoned */
  wasImmobile?: boolean;
  // ---- transport (sim/transport.ts) ----
  /** men riding as passengers (not crew), in boarding order */
  passengerIds?: number[];
  /** battle time the passenger door is busy until (one man at a time) */
  doorBusyUntil?: number;
  /** the passengers are getting out (orderly: through the door; else over the sides too) */
  unloading?: { panicked: boolean; startedAt: number; teamId?: number };
  /** battle time it began waiting for men to board (it does not drive off meanwhile) */
  waitingSince?: number;
}

// -------------------------------------------------------------------- teams
export type TeamType =
  | 'rifle' | 'smg' | 'mg' | 'mortar' | 'atgun' | 'sniper' | 'atteam'
  | 'tank' | 'spg' | 'halftrack' | 'command' | 'engineer';

export type OrderType = 'move' | 'moveFast' | 'sneak' | 'fire' | 'smoke' | 'defend' | 'ambush';
export const ORDER_TYPES: OrderType[] = ['move', 'moveFast', 'sneak', 'fire', 'smoke', 'defend', 'ambush'];
export const ORDER_LABELS: Record<OrderType, string> = {
  move: 'MOVE', moveFast: 'MOVE FAST', sneak: 'SNEAK', fire: 'FIRE',
  smoke: 'SMOKE', defend: 'DEFEND', ambush: 'AMBUSH',
};
/** Original CC3 keyboard reference: Z Move, X Move Fast, C Sneak, V Fire, B Smoke, N Defend, M Ambush */
export const ORDER_HOTKEYS: Record<OrderType, string> = {
  move: 'z', moveFast: 'x', sneak: 'c', fire: 'v', smoke: 'b', defend: 'n', ambush: 'm',
};
/** Order dot colours from the manual: Move blue, Move Fast purple, Sneak yellow, Fire red (orange = suppression), Smoke gray; Defend blue arc, Ambush green arc */
export const ORDER_DOT_COLOR: Record<OrderType, string> = {
  move: '#3c6cff', moveFast: '#b040e0', sneak: '#f0e040', fire: '#e02020', smoke: '#a0a0a0', defend: '#3c6cff', ambush: '#30c030',
};
export const AMBUSH_TRIGGER_M = 30;   // manual: ambush launches when enemy within 30 m

export interface Order {
  type: OrderType;
  target: Vec2;               // destination, fire point, or facing point
  targetTeamId?: number;      // for fire orders on a team ("attack unit"; absent = area fire)
  /** attack-unit orders on a vehicle team: the target hull */
  targetVehicleId?: number;
  /** attack-unit orders: battle time the target was last spotted by the ordering side */
  lastSeenAt?: number;
  /** attack-unit orders: target centre when it was last spotted (order.target follows it) */
  lastKnownPos?: Vec2;
  issuedAt: number;           // battle seconds
  /** Move/MoveFast onto a friendly transport with room: board it (sim/transport.ts) */
  mountVehicleId?: number;
  /** a transport's team: unload the passengers here and now */
  dismount?: boolean;
  /** Move/MoveFast/Sneak only: additional waypoints after `target`, placed by
   * holding Shift while clicking (HUD-side chain; sim support may follow). */
  waypoints?: Vec2[];
}

export type TeamMoraleWord = 'Fanatic' | 'Confident' | 'Steady' | 'Shaken' | 'Broken';
export type TeamStatusWord =
  // 'Idle' is only ever the one-frame spawn-time default (sim/spawn.ts) before the first
  // computeTeamStatus (sim/morale.ts) runs; that function itself never emits it — see 'Waiting'.
  | 'Idle' | 'Moving' | 'Moving Fast' | 'Sneaking' | 'Firing' | 'Defending'
  | 'Ambushing' | 'Pinned' | 'Cowering' | 'Panicked' | 'Routed' | 'Broken'
  // most of the team is knocked down or dazed by a blast (sim/daze.ts)
  | 'Stunned'
  | 'Destroyed' | 'Surrendered' | 'Knocked Out' | 'Setting up' | 'Aiming' | 'Loading'
  // crew-served weapons follow their open task (spec 2026-09-17 §6)
  | 'Unlimbering' | 'Spreading trails' | 'Digging in' | 'Packing up'
  // Manual vocabulary this HUD was missing (round5 critique #9): a team with no active order or
  // that has finished one (arrived, nothing left to do) waits for orders; a team whose obedience
  // roll failed (sim/orders.ts canObey) is visibly hesitating rather than looking merely idle; a
  // team with a Fire order but no line of sight to its target can't see it.
  | 'Waiting' | 'Hesitating' | "Can't See"
  // a serviceable vehicle whose crew is outside it (spec 2026-09-17 §10)
  | 'Abandoned' | 'Bailing out' | 'Remounting'
  // riding in a transport (sim/transport.ts)
  | 'Mounting' | 'Mounted' | 'Dismounting';

export interface TeamDef {
  id: string;                 // "ger_rifle_41"
  name: string;               // "Rifle Squad"
  type: TeamType;
  side: Side;
  years: number[];            // available years
  cost: number;               // requisition points
  /** soldiers in order; index 0 is the leader */
  soldiers: { rank: string; weaponId: string; grenades?: number }[];
  vehicleDefId?: string;
  iconId: string;             // sprite key for team list icon
}

export interface Team {
  id: number;
  defId: string;
  side: Side;
  name: string;
  type: TeamType;
  soldierIds: number[];
  leaderId: number;
  vehicleId: number | null;
  order: Order | null;
  /** set by fire/defend/ambush orders */
  facing: Facing8;
  experience: number;
  /** cached each step */
  morale: number;
  status: TeamStatusWord;
  /** average position of alive soldiers (or vehicle pos) */
  pos: Vec2;
  /** true when the team can no longer be commanded (all dead/routed/surrendered/KO) */
  outOfAction: boolean;
  kills: number;
  /** for AI */
  aiObjective: Vec2 | null;
  /** the transport this team is boarding or riding in (sim/transport.ts) */
  transportId?: number;
  /** crew-served weapon (mortar/HMG/AT gun) on the ground or carried; managed by sim/crewWeapon.ts */
  crewWeapon?: CrewWeaponState;
}

/** packed = carried/limbered (or lying unassembled); settingUp/packing = transition timers running. */
export type CrewWeaponPhase = 'packed' | 'settingUp' | 'ready' | 'packing';

export interface CrewWeaponState {
  weaponId: string;
  /** weapon pivot (baseplate / tripod / gun axle), tile coords; follows the gunner while packed */
  pos: Vec2;
  /** radians, 0 = north, clockwise (muzzle direction) */
  facing: number;
  phase: CrewWeaponPhase;
  /** seconds left in settingUp/packing */
  timer: number;
  /** full length of the current settingUp/packing transition */
  phaseTotal: number;
  /** soldier currently serving the weapon */
  gunnerId: number;
  /** crew ran off or the gunner fell: the weapon stays where it is until a crewman re-mans it */
  abandoned: boolean;
  abandonedAt: number;
  /** battle seconds the weapon was last set down (a move order issued before this does not pack it) */
  setAt: number;
  /** fire-mission preparation (sim/crewWeapon.ts): laying on a new target, loading the next round,
   * or ready to fire. Absent when the weapon has no current mission. (Named `firePhase` because
   * `phase` is the set-up/packing state above.) */
  firePhase?: FireMissionPhase;
  /** the current fire mission, if any */
  mission?: FireMission;
  // ---- task state machine (spec 2026-09-17 §6); all optional so older literals stay valid and
  // are migrated from `phase` on the first step.
  /** what the crew is working towards: the weapon in action, or packed for a move */
  goal?: 'deploy' | 'pack';
  /** deploy tasks completed so far (e.g. ['unhook', 'spreadLeft']); all of them = in action */
  done?: CrewTaskId[];
  /** seconds of work already put into each unfinished task (kept when the worker falls) */
  progress?: Partial<Record<CrewTaskId, number>>;
  /** soldier id assigned to each open task */
  workers?: Partial<Record<CrewTaskId, number>>;
  /** tasks open this step, in order (the first names the team's status word) */
  open?: CrewTaskId[];
  /** a round is in the breech (guns; taken from the ammunition when it was loaded) */
  chambered?: boolean;
  /** which round that is (absent on weapons with one round type) */
  chamberedType?: RoundType;
  /** the weapon is laid on the mission's lay point */
  laid?: boolean;
  /** guns: battle time the recoil / run-out / case ejection ends */
  recoilUntil?: number;
  /** battle time an open task was last worked, and of the last 'no one to ...' message */
  lastWorkedAt?: number;
  lastHelpMsgAt?: number;
  /** mortars: who set the baseplate down (the bipod is carried by another man) */
  baseplateBy?: number;
}

/** Tasks of the crew-served weapon state machine (spec 2026-09-17 §6). */
export type CrewTaskId =
  // AT / infantry guns: into action, and packing up
  | 'unhook' | 'spreadLeft' | 'spreadRight' | 'digLeft' | 'digRight'
  | 'liftLeft' | 'liftRight' | 'closeLeft' | 'closeRight' | 'hook'
  // mortars
  | 'placeBaseplate' | 'mountTube' | 'setBipod' | 'liftBipod' | 'dismountTube' | 'liftBaseplate'
  // heavy MGs
  | 'placeTripod' | 'mountGun' | 'feedBelt' | 'dismountGun' | 'liftTripod'
  // serving the weapon
  | 'load' | 'lay' | 'fire' | 'dropRound' | 'unload';

/** The weapon sprite state that goes with the task state (renderer; falls back to setup/half/packed). */
export type CrewWeaponVisual =
  | 'limbered' | 'trailsClosed' | 'trailLeftOpen' | 'trailRightOpen' | 'trailsOpen' | 'emplaced' | 'recoil'
  // mortars: baseplate down / tube mounted; HMGs: tripod down
  | 'baseplate' | 'tube' | 'tripod'
  | 'packed' | 'half' | 'setup';

export type FireMissionPhase = 'aiming' | 'loading' | 'ready';

export interface FireMission {
  /** point the weapon was laid on (tile coords) */
  layAim: Vec2;
  /** attack-unit / engaged team being tracked, or null for a point */
  targetTeamId: number | null;
  /** seconds left in the aiming/loading phase */
  timer: number;
  /** rounds fired on this mission (mortar walk-in) */
  rounds: number;
  /** a round has been (or is being) loaded for this mission */
  loaded: boolean;
  /** battle seconds the mission was started */
  startedAt: number;
  /** seconds of work the current lay needs (task duration before the crew's drill factor) */
  layS?: number;
  /** battle seconds combat last asked to fire on this mission */
  lastRequestAt?: number;
  /** round type this mission needs in the breech */
  wantRound?: RoundType;
  /** where the gunner lays on an armoured target, and which vehicle */
  aimPoint?: AimPoint;
  aimVehicleId?: number;
  /** bracketing (sim/gunTiming.ts): observed misses on this target and where both parties stood */
  misses?: number;
  bracketFrom?: Vec2;
  bracketAt?: Vec2;
}

// ------------------------------------------------------------------- battle
export type BattlePhase = 'deploy' | 'running' | 'paused' | 'ended';
// Manual (docs/reference/cc3-manual-notes.md §"Scoring and Victory Determination"): "Total,
// decisive, major, minor victory; or equivalent defeat" — nine symmetric grades around a draw.
export type BattleResult =
  | 'totalVictory' | 'decisiveVictory' | 'majorVictory' | 'minorVictory' | 'draw'
  | 'minorDefeat' | 'majorDefeat' | 'decisiveDefeat' | 'totalDefeat';

export interface BattleMessage {
  time: number;               // battle seconds elapsed
  text: string;
  kind: 'info' | 'warn' | 'bad' | 'good';
}

export interface Explosion { pos: Vec2; radiusM: number; t: number; kind: 'he' | 'smoke' | 'small' }
export interface Tracer { from: Vec2; to: Vec2; t: number; hit: boolean; kind: 'bullet' | 'mg' | 'shell' | 'mortar' }
/** `kind: 'shell'` marks a vehicle main-gun flash, drawn larger than the default infantry flash. */
export interface Flash { pos: Vec2; facing: number; t: number; kind?: 'shell' }

// ---------------------------------------------------- effect lifetimes (s)
// Shared between src/sim/battle.ts (ageEffects, which must expire records at
// these exact lifetimes) and src/render/effects.ts (which draws the fade
// curve against the same lifetime) so the two never drift out of sync.
export const FLASH_LIFE = 0.25;
export const TRACER_LIFE = 0.35;
export const EXPLOSION_LIFE_HE = 0.9;
export const EXPLOSION_LIFE_SMALL = 0.3;
export const EXPLOSION_LIFE_SMOKE = 2.0;

export interface BattleEvent {
  kind: 'shot' | 'hit' | 'kill' | 'explosion' | 'vlCaptured' | 'teamBroken' | 'vehicleKO' | 'message' | 'truce' | 'ended'
    /** a vehicle blows up (ammunition or fuel): `pos`, `radiusM`, `turretLanding` when the turret was thrown */
    | 'vehicleExplosion'
    /** a round cooking off in a burning vehicle: `pos` */
    | 'cookOffPop';
  pos?: Vec2;
  /** vehicleExplosion: blast radius in metres */
  radiusM?: number;
  /** vehicleExplosion: where the blown-off turret lands (tile coords) */
  turretLanding?: Vec2;
  side?: Side;
  weaponId?: string;
  text?: string;
  teamId?: number;
}

export interface SideState {
  side: Side;
  morale: number;             // 0..100 aggregate
  truceOffered: boolean;
  truceAccepted: boolean;
  kills: number;
  losses: number;
  score: number;
}

export interface BattleConfig {
  mapId: string;
  playerSide: Side;
  year: number;
  seed: number;
  durationS: number;
  difficulty: 'easy' | 'normal' | 'hard';
  /** team def ids to field per side */
  forces: Record<Side, string[]>;
  /** Test/harness only: run stepAI for BOTH sides (normally only the non-player side gets AI).
   * Lets a headless harness simulate AI-vs-AI battles. Never set by UI screens. */
  aiBothSides?: boolean;
}

export interface BattleState {
  config: BattleConfig;
  map: GameMap;
  phase: BattlePhase;
  time: number;               // elapsed battle seconds
  soldiers: Map<number, Soldier>;
  teams: Map<number, Team>;
  vehicles: Map<number, Vehicle>;
  sides: Record<Side, SideState>;
  /** per side: set of enemy soldier ids currently spotted */
  spotted: Record<Side, Set<number>>;
  spottedVehicles: Record<Side, Set<number>>;
  messages: BattleMessage[];
  explosions: Explosion[];
  tracers: Tracer[];
  flashes: Flash[];
  /** dark red pixel decals (tile coordinates) */
  bloodDecals: Vec2[];
  result: BattleResult | null;
  events: BattleEvent[];      // drained by renderer/audio each frame
  nextId: number;
  /** Side that ended the battle by fleeing (sim/victory.ts flee()), if any — lets the debrief show
   * a surviving team as "Withdrawn" rather than "Intact" when its own side quit the field. */
  fledSide?: Side | null;
  /** Kit on the ground (spec 2026-09-17 §9). Optional: created lazily by sim/items.ts. */
  items?: GroundItem[];
  /** Body parts (spec 2026-09-17 §8), capped, oldest removed. Optional: created lazily. */
  debris?: Debris[];
}

// --------------------------------------------------------------- UI shared
export type CursorKind = 'arrow' | 'crosshair' | 'hand' | 'no' | 'move' | 'wait' | 'target' | 'targetNone' | 'targetMaybe' | 'targetLikely';

export interface InputState {
  mouse: Vec2;                // logical 800x600 coords
  buttons: { left: boolean; right: boolean; middle: boolean };
  /** edge-triggered, cleared each frame by the engine */
  clicks: { x: number; y: number; button: 0 | 1 | 2 }[];
  releases: { x: number; y: number; button: 0 | 1 | 2 }[];
  keysDown: Set<string>;      // KeyboardEvent.key lower-cased
  keysPressed: Set<string>;   // edge-triggered, cleared each frame
  wheel: number;              // accumulated ctrl/cmd+wheel (pinch-zoom) deltaY, cleared each frame
  /** accumulated plain two-finger-scroll wheel delta (screen px), cleared each frame */
  wheelDX: number;
  wheelDY: number;
  /** false once the pointer has left the window/canvas or the window lost focus */
  pointerInside: boolean;
}

export interface Camera {
  x: number;                  // top-left of viewport in tile coords
  y: number;
  zoom: number;               // pixels per tile = TILE_PX * zoom (1 or 2)
}

// ------------------------------------------------------------- operation
export interface OperationBattleDef {
  mapId: string;
  year: number;
  title: string;              // "Barbarossa, June 1941"
  requisition: Record<Side, number>;
  aiForces: Record<Side, string[]>;
}

export interface OperationState {
  index: number;
  playerSide: Side;
  results: BattleResult[];
  /** surviving player teams: def id + experience + soldier count */
  forcePool: { defId: string; experience: number; alive: number }[];
  requisition: number;
}

// ------------------------------------------------------------- screens
/** A full-screen UI state (main menu, battle, debrief...). Implemented in src/ui/screens/*. */
export interface Screen {
  onEnter?(): void;
  onExit?(): void;
  /** dt in seconds of real time */
  update(dt: number, input: InputState): void;
  draw(ctx: CanvasRenderingContext2D): void;
  /** cursor to draw this frame */
  cursor?(): CursorKind;
}

export interface GameSettings {
  volume: number;             // 0..1
  unitLabels: boolean;
  losLines: boolean;
  speed: 1 | 2 | 4;
  /** Shade the map by what the selected units can see ('L' key / Options). Missing = on. */
  showUnitVision?: boolean;
  /** Depth/height map view (Tab key / Options). Missing = off. */
  showDepthMap?: boolean;
  // ---- "realism" toggles from the original's Options screen (cosmetic
  // no-ops for now; stored so the UI has somewhere to persist them) ----
  alwaysSeeEnemy?: boolean;
  neverActOnInitiative?: boolean;
  alwaysFullEnemyInfo?: boolean;
  alwaysObeyOrders?: boolean;
}
