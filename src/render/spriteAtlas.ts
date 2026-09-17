// ============================================================================
// spriteAtlas.ts — runtime side of the pre-rendered (Blender) sprite pipeline.
// Contract: docs/superpowers/specs/2026-09-17-soldier-animation-design.md §5.
//
//   public/sprites/<name>.json + <name>.png
//   frame index = entry.start + dir * entry.frames + frame
//   grid cell   = (index % columns, floor(index / columns)); `anchor` = the cell pixel that sits on
//                 the unit's ground position; direction 0 faces north, increasing clockwise.
//
// Atlases load asynchronously (requestBattleAtlases, progress via atlasLoadProgress); every draw
// call returns false when its atlas or entry is missing so the caller falls back to the code-drawn
// sprite. Scale-1 atlases serve zoom <= 1, scale-2 atlases zoom 2. Soldier atlases of sides /
// seasons not in the current battle are freed.
// The index maths and key handling are pure (unit-tested in node); only load/draw touch the DOM.
// ============================================================================
import type { Season, Side } from '@/shared/types';
import { resolveEntryKey } from '@/render/soldierAnim';

export interface AtlasEntry {
  start: number; frames: number; fps: number; loop: boolean;
  /** frame chosen by a 0..1 progress rather than by time (crew tasks, hatch climbs) */
  progress?: boolean;
  /** `crew.bailout` / `crew.mount`: the hull height (m) the climb was rendered against */
  hullHeightM?: number;
}
export interface AtlasMeta {
  scale: number;
  cell: { w: number; h: number };
  anchor: { x: number; y: number };
  columns: number;
  dirs: number;
  entries: Record<string, AtlasEntry>;
  /** vehicles atlas: per vehicle extras (turret ring position in hull-local metres, +x right, +y aft). */
  vehicles?: Record<string, { turretPivotM?: { x: number; y: number } }>;
  /** Either a top-level map defId -> pivot (+y aft), or, in a per-vehicle atlas, that vehicle's own
   * pivot in the Blender frame (+y FORWARD, see `frame`). */
  turretPivotM?: Record<string, { x: number; y: number }> | { x: number; y: number };
  /** per-vehicle atlas: the vehicle it holds, and the coordinate frame note of the render scripts */
  vehicle?: string;
  frame?: string;
}
export interface Atlas { name: string; meta: AtlasMeta; image: CanvasImageSource | null }

// ------------------------------------------------------------------ pure index maths ---
/** Frame index of (dir, frame) in an entry; dir wraps, frame clamps (or wraps for loops). */
export function atlasFrameIndex(entry: AtlasEntry, dirs: number, dir: number, frame: number): number {
  const d = ((Math.round(dir) % dirs) + dirs) % dirs;
  const n = Math.max(1, entry.frames);
  let f = Math.floor(frame);
  f = entry.loop ? ((f % n) + n) % n : Math.max(0, Math.min(n - 1, f));
  return entry.start + d * n + f;
}

/** Source rectangle of a frame index in the PNG grid. */
export function atlasCellRect(meta: AtlasMeta, index: number): { sx: number; sy: number; sw: number; sh: number } {
  const col = index % meta.columns, row = Math.floor(index / meta.columns);
  return { sx: col * meta.cell.w, sy: row * meta.cell.h, sw: meta.cell.w, sh: meta.cell.h };
}

/** Destination rectangle so the anchor pixel lands on (x, y) at `zoom`. */
export function atlasDestRect(meta: AtlasMeta, x: number, y: number, zoom: number): { dx: number; dy: number; dw: number; dh: number } {
  const k = zoom / meta.scale;
  return { dx: Math.round(x - meta.anchor.x * k), dy: Math.round(y - meta.anchor.y * k), dw: meta.cell.w * k, dh: meta.cell.h * k };
}

/** Number of grid cells an atlas needs (for validation / the placeholder generator). */
export function atlasCellCount(meta: AtlasMeta): number {
  let n = 0;
  for (const e of Object.values(meta.entries)) n = Math.max(n, e.start + meta.dirs * Math.max(1, e.frames));
  return n;
}

/** Structural check of a parsed JSON: returns a reason string when it is not a usable atlas. */
export function validateAtlasMeta(meta: unknown): string | null {
  const m = meta as Partial<AtlasMeta> | null;
  if (!m || typeof m !== 'object') return 'not an object';
  if (!(Number(m.scale) > 0)) return 'scale';
  if (!m.cell || !(m.cell.w > 0) || !(m.cell.h > 0)) return 'cell';
  if (!m.anchor || typeof m.anchor.x !== 'number' || typeof m.anchor.y !== 'number') return 'anchor';
  if (!(Number(m.columns) > 0) || !(Number(m.dirs) > 0)) return 'columns/dirs';
  if (!m.entries || typeof m.entries !== 'object') return 'entries';
  for (const [k, e] of Object.entries(m.entries)) {
    if (!e || !(e.frames > 0) || !(e.start >= 0)) return `entry ${k}`;
  }
  return null;
}

export function atlasScaleForZoom(zoom: number): 1 | 2 { return zoom >= 2 ? 2 : 1; }
export function seasonKey(season: Season): 'summer' | 'winter' { return season === 'winter' ? 'winter' : 'summer'; }
export function soldierAtlasName(side: Side, season: Season, scale: 1 | 2): string { return `soldiers_${side}_${seasonKey(season)}_${scale}`; }
export function vehicleAtlasName(scale: 1 | 2): string { return `vehicles_${scale}`; }
export function weaponAtlasName(scale: 1 | 2): string { return `weapons_${scale}`; }
/** Kit on the ground (spec 2026-09-17 §9): entries `item.<id>`, 16 dirs, one frame each. */
export function itemAtlasName(scale: 1 | 2): string { return `items_${scale}`; }
/** Body parts (spec 2026-09-17 §8): entries `part.<kind><n>`, in the side's uniform. */
export function partsAtlasName(side: Side, season: Season, scale: 1 | 2): string { return `parts_${side}_${seasonKey(season)}_${scale}`; }

/** Atlases a battle needs: both scales of the soldiers of the sides present and the weapons.
 * Vehicle atlases are per type and are fetched when a vehicle of that type is first drawn. */
export function battleAtlasNames(sides: readonly Side[], season: Season): string[] {
  const out: string[] = [];
  for (const scale of [1, 2] as const) {
    for (const side of sides) out.push(soldierAtlasName(side, season, scale));
    out.push(weaponAtlasName(scale));
    out.push(itemAtlasName(scale));
    for (const side of sides) out.push(partsAtlasName(side, season, scale));
  }
  return out;
}

/** Turret ring position in hull-local metres, +x right, +y AFT (the convention drawVehiclePart
 * rotates). Per-vehicle atlases from tools/blender store it with +y forward, so it is flipped here. */
export function turretPivotM(meta: AtlasMeta, defId: string): { x: number; y: number } {
  const own = meta.turretPivotM as { x?: unknown; y?: unknown } | undefined;
  if (own && typeof own.x === 'number' && typeof own.y === 'number') {
    return meta.vehicle === undefined || meta.vehicle === defId ? { x: own.x, y: own.y === 0 ? 0 : -own.y } : { x: 0, y: 0 };
  }
  const map = meta.turretPivotM as Record<string, { x: number; y: number }> | undefined;
  return meta.vehicles?.[defId]?.turretPivotM ?? map?.[defId] ?? { x: 0, y: 0 };
}

/** One atlas per vehicle type (a single sheet of all of them would be ~600 MB decoded). */
export function vehicleDefAtlasName(defId: string, scale: 1 | 2): string { return `vehicles_${defId}_${scale}`; }

/** The atlas holding this vehicle at this zoom: its own per-vehicle atlas, fetched on first use
 * (so a battle only ever loads the vehicles present), else a combined `vehicles_<scale>` atlas. */
function vehicleAtlasFor(defId: string, zoom: number): Atlas | null {
  return atlasForZoom((sc) => vehicleDefAtlasName(defId, sc), zoom) ?? getAtlas(vehicleAtlasName(atlasScaleForZoom(zoom))) ?? getAtlas(vehicleAtlasName(1));
}

// ------------------------------------------------------------------ registry / loading ---
type Slot = { state: 'loading' | 'ready' | 'missing'; atlas: Atlas | null; promise: Promise<Atlas | null> };
const slots = new Map<string, Slot>();
let basePath = 'sprites/';
let wanted: string[] = [];

/** Where atlases are fetched from (default `<base>/sprites/`). The preview points this at the
 * placeholder set. Changing it drops everything loaded. */
export function setAtlasBasePath(path: string): void {
  if (path === basePath) return;
  basePath = path.endsWith('/') ? path : `${path}/`;
  slots.clear();
  wanted = [];
}

function urlOf(file: string): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  const root = basePath.startsWith('/') || basePath.startsWith('http') ? '' : env?.BASE_URL ?? '/';
  return `${root}${basePath}${file}`;
}

/** Register an atlas directly (tests, tools). */
export function registerAtlas(name: string, meta: AtlasMeta, image: CanvasImageSource | null): Atlas {
  const atlas: Atlas = { name, meta, image };
  slots.set(name, { state: 'ready', atlas, promise: Promise.resolve(atlas) });
  return atlas;
}

export function loadAtlas(name: string): Promise<Atlas | null> {
  const hit = slots.get(name);
  if (hit) return hit.promise;
  const slot: Slot = { state: 'loading', atlas: null, promise: Promise.resolve(null) };
  slot.promise = (async () => {
    try {
      const res = await fetch(urlOf(`${name}.json`));
      if (!res.ok) throw new Error(String(res.status));
      const meta = JSON.parse(await res.text()) as AtlasMeta; // a dev-server HTML fallback throws here
      const bad = validateAtlasMeta(meta);
      if (bad) throw new Error(`bad atlas json: ${bad}`);
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('image'));
        img.src = urlOf(`${name}.png`);
      });
      if (slots.get(name) !== slot) return null; // freed while loading
      slot.atlas = { name, meta, image };
      slot.state = 'ready';
      return slot.atlas;
    } catch {
      slot.state = 'missing';
      return null;
    }
  })();
  slots.set(name, slot);
  return slot.promise;
}

/** Start loading everything a battle needs and free soldier atlases of other sides / seasons.
 * Idempotent; resolves when every atlas is ready or known missing. `onProgress` gets 0..1. */
export function requestBattleAtlases(sides: readonly Side[], season: Season, onProgress?: (p: number) => void): Promise<void> {
  const names = battleAtlasNames(sides, season);
  // Only the scale-1 set is fetched up front. The scale-2 images are several times larger (a
  // soldier atlas decodes to ~170 MB) and are fetched by `atlasForZoom` the first time the player
  // zooms in; until they arrive the scale-1 frames are drawn enlarged.
  const upfront = names.filter((n) => !n.endsWith('_2'));
  wanted = upfront;
  for (const name of Array.from(slots.keys())) {
    if ((name.startsWith('soldiers_') || name.startsWith('parts_')) && !names.includes(name)) slots.delete(name);
  }
  let done = 0;
  return Promise.all(upfront.map((n) => loadAtlas(n).then(() => { done++; onProgress?.(done / upfront.length); }))).then(() => undefined);
}

/** 0..1 over the atlases of the last requestBattleAtlases (1 when nothing was requested). A missing
 * atlas counts as done — the game then draws the code-made fallback sprites. */
export function atlasLoadProgress(): number {
  if (wanted.length === 0) return 1;
  let done = 0;
  for (const n of wanted) { const s = slots.get(n); if (s && s.state !== 'loading') done++; }
  return done / wanted.length;
}

export function getAtlas(name: string): Atlas | null {
  const s = slots.get(name);
  return s && s.state === 'ready' ? s.atlas : null;
}
export function loadedAtlasNames(): string[] {
  return Array.from(slots.entries()).filter(([, s]) => s.state === 'ready').map(([n]) => n);
}
export function freeAllAtlases(): void { slots.clear(); wanted = []; }

// ------------------------------------------------------------------ drawing ---
/** Blit one frame with its anchor on (x, y). False = entry missing / atlas has no image. */
export function drawAtlasFrame(ctx: CanvasRenderingContext2D, atlas: Atlas | null, key: string, dir: number, frame: number, x: number, y: number, zoom: number): boolean {
  if (!atlas || !atlas.image) return false;
  const entry = atlas.meta.entries[key];
  if (!entry) return false;
  const r = atlasCellRect(atlas.meta, atlasFrameIndex(entry, atlas.meta.dirs, dir, frame));
  const d = atlasDestRect(atlas.meta, x, y, zoom);
  ctx.drawImage(atlas.image, r.sx, r.sy, r.sw, r.sh, d.dx, d.dy, d.dw, d.dh);
  return true;
}

/** The atlas to draw from at this zoom: the matching scale when it is ready; otherwise the other
 * scale (frames are resized by zoom / scale), while the wanted one is fetched in the background. */
export function atlasForZoom(nameOf: (scale: 1 | 2) => string, zoom: number): Atlas | null {
  const scale = atlasScaleForZoom(zoom);
  const name = nameOf(scale);
  const hit = getAtlas(name);
  if (hit) return hit;
  if (!slots.has(name)) void loadAtlas(name);
  return getAtlas(nameOf(scale === 2 ? 1 : 2));
}

export function soldierAtlas(side: Side, season: Season, zoom: number): Atlas | null {
  return atlasForZoom((sc) => soldierAtlasName(side, season, sc), zoom);
}
export function itemAtlas(zoom: number): Atlas | null { return atlasForZoom(itemAtlasName, zoom); }
export function partsAtlas(side: Side, season: Season, zoom: number): Atlas | null {
  return atlasForZoom((sc) => partsAtlasName(side, season, sc), zoom);
}

/** Draw a soldier frame from the first key of `keys` the atlas carries (see
 * soldierAnim.entryKeyChain). Returns the key used, or null => draw the code-made fallback. */
export function drawSoldier(
  ctx: CanvasRenderingContext2D, atlas: Atlas | null, keys: readonly string[], dirRad: number,
  frameOf: (entry: AtlasEntry, key: string) => number, x: number, y: number, zoom: number,
): string | null {
  if (!atlas || !atlas.image) return null;
  const key = resolveEntryKey(atlas.meta.entries, keys);
  if (!key) return null;
  const dirs = atlas.meta.dirs;
  const dir = ((Math.round((dirRad / (Math.PI * 2)) * dirs) % dirs) + dirs) % dirs;
  return drawAtlasFrame(ctx, atlas, key, dir, frameOf(atlas.meta.entries[key], key), x, y, zoom) ? key : null;
}

/** Hull or turret from the 64 pre-rendered directions. The turret is placed on its ring:
 * `turretPivotM` (hull-local metres) rotated by the hull heading. */
export function drawVehiclePart(
  ctx: CanvasRenderingContext2D, defId: string, part: 'hull' | 'turret', state: 'ok' | 'knockedOut',
  partRad: number, hullRad: number, x: number, y: number, zoom: number,
  /** damage look: 'blown' (hull with an open turret ring / turret lying on the ground, anchored
   * under its own centre) or 'trackL' / 'trackR' (hull with that track thrown); falls back to the
   * plain ok / ko entry when the atlas lacks it */
  variant?: 'blown' | 'trackL' | 'trackR',
): boolean {
  const atlas = vehicleAtlasFor(defId, zoom);
  if (!atlas) return false;
  let key = `${defId}.${part}.${state === 'ok' ? 'ok' : 'ko'}`;
  const vkey = variant ? `${defId}.${part}.${variant}` : null;
  const useVariant = !!vkey && !!atlas.meta.entries[vkey];
  if (useVariant) key = vkey!;
  if (!atlas.meta.entries[key]) return false;
  let px = x, py = y;
  if (part === 'turret' && !(useVariant && variant === 'blown')) {
    const pv = turretPivotM(atlas.meta, defId);
    const c = Math.cos(hullRad), s = Math.sin(hullRad), pxPerM = 10 * zoom;
    px += (pv.x * c - pv.y * s) * pxPerM;
    py += (pv.x * s + pv.y * c) * pxPerM;
  }
  const dirs = atlas.meta.dirs;
  const dir = ((Math.round((partRad / (Math.PI * 2)) * dirs) % dirs) + dirs) % dirs;
  return drawAtlasFrame(ctx, atlas, key, dir, 0, px, py, zoom);
}

/** True when the vehicles atlas can draw every part this vehicle needs (so hull and turret never
 * mix atlas and code-made art). */
export function vehicleAtlasHas(defId: string, state: 'ok' | 'knockedOut', hasTurret: boolean, zoom: number): boolean {
  const atlas = vehicleAtlasFor(defId, zoom);
  if (!atlas || !atlas.image) return false;
  const st = state === 'ok' ? 'ok' : 'ko';
  return !!atlas.meta.entries[`${defId}.hull.${st}`] && (!hasTurret || !!atlas.meta.entries[`${defId}.turret.${st}`]);
}

export function drawWeapon(
  ctx: CanvasRenderingContext2D, weaponId: string, variant: 'ready' | 'half' | 'packed', rad: number, x: number, y: number, zoom: number,
): boolean {
  const atlas = atlasForZoom(weaponAtlasName, zoom);
  if (!atlas) return false;
  const key = `${weaponId}.${variant === 'ready' ? 'setup' : variant}`;
  if (!atlas.meta.entries[key]) return false;
  const dirs = atlas.meta.dirs;
  const dir = ((Math.round((rad / (Math.PI * 2)) * dirs) % dirs) + dirs) % dirs;
  return drawAtlasFrame(ctx, atlas, key, dir, 0, x, y, zoom);
}

/** Draw a crew-served weapon in the first of `states` its atlas carries (drill-step looks such as
 * 'trailLeftOpen' or 'recoil' first, then the legacy 'setup' / 'half' / 'packed'). Returns the state
 * drawn, or null when the atlas has none of them (caller draws the code sprite). */
export function drawWeaponState(
  ctx: CanvasRenderingContext2D, weaponId: string, states: readonly string[], rad: number, x: number, y: number, zoom: number,
): string | null {
  const atlas = atlasForZoom(weaponAtlasName, zoom);
  if (!atlas) return null;
  const dirs = atlas.meta.dirs;
  const dir = ((Math.round((rad / (Math.PI * 2)) * dirs) % dirs) + dirs) % dirs;
  for (const st of states) {
    const key = `${weaponId}.${st}`;
    if (atlas.meta.entries[key] && drawAtlasFrame(ctx, atlas, key, dir, 0, x, y, zoom)) return st;
  }
  return null;
}
