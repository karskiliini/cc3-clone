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
  | 'shellhole' | 'grave' | 'sign' | 'barrel' | 'crate' | 'wreck' | 'woodpile' | 'puddle' | 'flowers' | 'tramwire';
/** Purely visual map dressing (no sim effect). Position in tile coords (may be fractional). */
export interface DecorItem { kind: DecorKind; x: number; y: number; variant?: number }

/** Vector source geometry recorded by the map DSL so the renderer can paint smooth curves (tiles remain the sim truth). */
export interface MapVectorFeature {
  kind: 'road' | 'river' | 'line';
  terrain: Terrain;          // dirtroad/pavedroad/water/hedge/fence/stonewall/trench
  points: Vec2[];            // tile coordinates (may be fractional)
  width: number;             // tiles
}

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
  /** tile indexes changed since last render bake (e.g. vehicle crushing terrain); renderer clears this */
  dirtyTiles?: number[];
}

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
  smoke?: boolean;            // can fire smoke rounds
  indirect?: boolean;         // mortar
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
  turnRateRad: number;        // radians per second
  armor: { front: number; side: number; rear: number; top: number };  // mm
  mainWeaponId: string | null;
  coaxWeaponId: string | null;
  hasTurret: boolean;
  crew: number;
  mainAmmo: number;
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
  targetTeamId?: number;      // for fire orders on a team
  issuedAt: number;           // battle seconds
  /** Move/MoveFast/Sneak only: additional waypoints after `target`, placed by
   * holding Shift while clicking (HUD-side chain; sim support may follow). */
  waypoints?: Vec2[];
}

export type TeamMoraleWord = 'Fanatic' | 'Confident' | 'Steady' | 'Shaken' | 'Broken';
export type TeamStatusWord =
  | 'Idle' | 'Moving' | 'Moving Fast' | 'Sneaking' | 'Firing' | 'Defending'
  | 'Ambushing' | 'Pinned' | 'Cowering' | 'Panicked' | 'Routed' | 'Broken'
  | 'Destroyed' | 'Surrendered' | 'Knocked Out';

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
}

// ------------------------------------------------------------------- battle
export type BattlePhase = 'deploy' | 'running' | 'paused' | 'ended';
export type BattleResult = 'decisive' | 'victory' | 'draw' | 'defeat';

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
  kind: 'shot' | 'hit' | 'kill' | 'explosion' | 'vlCaptured' | 'teamBroken' | 'vehicleKO' | 'message' | 'truce' | 'ended';
  pos?: Vec2;
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
}

// --------------------------------------------------------------- UI shared
export type CursorKind = 'arrow' | 'crosshair' | 'hand' | 'no' | 'move' | 'wait';

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
  // ---- "realism" toggles from the original's Options screen (cosmetic
  // no-ops for now; stored so the UI has somewhere to persist them) ----
  alwaysSeeEnemy?: boolean;
  neverActOnInitiative?: boolean;
  alwaysFullEnemyInfo?: boolean;
  alwaysObeyOrders?: boolean;
}
