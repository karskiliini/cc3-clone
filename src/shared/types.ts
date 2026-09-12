// ============================================================================
// SHARED CONTRACT — every module imports from here. Do NOT redefine these
// types elsewhere. Add fields here if you need them (keep backward compatible).
// ============================================================================

// ----------------------------------------------------------------- constants
export const SCREEN_W = 800;
export const SCREEN_H = 600;
export const VIEW_W = 800;
export const VIEW_H = 480;          // map viewport height; bottom panel is 120
export const PANEL_Y = 480;
export const PANEL_H = 120;
export const TILE_M = 2;            // metres per tile
export const TILE_PX = 10;          // pixels per tile at zoom 1
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

export interface Soldier {
  id: number;
  teamId: number;
  side: Side;
  name: string;               // "Sgt. Müller"
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
export const ORDER_HOTKEYS: Record<OrderType, string> = {
  move: 'm', moveFast: 'f', sneak: 's', fire: 'i', smoke: 'k', defend: 'd', ambush: 'a',
};

export interface Order {
  type: OrderType;
  target: Vec2;               // destination, fire point, or facing point
  targetTeamId?: number;      // for fire orders on a team
  issuedAt: number;           // battle seconds
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
export interface Tracer { from: Vec2; to: Vec2; t: number; hit: boolean; kind: 'bullet' | 'shell' | 'mortar' }
export interface Flash { pos: Vec2; facing: number; t: number }

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
  wheel: number;              // accumulated deltaY, cleared each frame
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
