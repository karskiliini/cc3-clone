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
import { VEHICLE_DEFS } from '@/data/units';

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
  /** image file next to the JSON when it is not `<name>.png` (e.g. the lossless WebP soldier sheets) */
  image?: string;
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
/** Planted feet, five torso angles and a per-round kick for aimed / hip SMG bursts. */
export function smgAtlasName(side: Side, season: Season, scale: 1 | 2): string { return `smg_${side}_${seasonKey(season)}_${scale}`; }
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
    for (const side of sides) out.push(smgAtlasName(side, season, scale));
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

/** One atlas per vehicle type (a single sheet of all of them would be ~600 MB decoded). Winter
 * battles add `vehicles_<def>_winter_<scale>`: the whitewashed live looks (hull ok / trackL / trackR,
 * turret ok); wrecks come from the summer atlas (a fire burns the wash off). */
export function vehicleDefAtlasName(defId: string, scale: 1 | 2, season: Season = 'summer'): string {
  return `vehicles_${defId}${seasonKey(season) === 'winter' ? '_winter' : ''}_${scale}`;
}

/** Vehicles still waiting for their own Blender model are drawn as the closest existing one,
 * scaled to their own length, instead of not at all. A vehicle's own atlas wins as soon as it
 * exists. */
export const VEHICLE_STAND_IN: Readonly<Record<string, string>> = {
  tiger2: 'tiger', pantherD: 'panther', pantherA: 'panther', pz4g: 'pz4gh', flammpanzer3: 'pz3j',
  stug4: 'stug3g', hetzer: 'stug3g', sdkfz251_rocket: 'sdkfz251', kubelwagen: 'sdkfz251', kettenkrad: 'sdkfz251',
  is1: 'is2', is3: 'is2', ot34: 't34_76', t28: 't34_76', sherman76: 't34_76',
  su100: 'su85', su122: 'su85', su152: 'su85', bm13: 'sdkfz251',
};

/** Crew weapons waiting for their own model: the 15 cm Nebelwerfer 41 is a wheeled carriage with
 * split trails, like the PaK 38. */
export const WEAPON_STAND_IN: Readonly<Record<string, string>> = { nebel41: 'pak38' };

/** Which vehicle's art draws `defId` (itself, or its stand-in while its own atlas is missing) and
 * at what size relative to that art. */
export function vehicleArtFor(defId: string): { artId: string; scale: number } {
  const stand = VEHICLE_STAND_IN[defId];
  if (!stand) return { artId: defId, scale: 1 };
  const own = slots.get(vehicleDefAtlasName(defId, 1));
  if (!own) void loadAtlas(vehicleDefAtlasName(defId, 1)); // it may have been rendered by now
  if (own?.state === 'ready') return { artId: defId, scale: 1 };
  const a = VEHICLE_DEFS[defId], b = VEHICLE_DEFS[stand];
  return { artId: stand, scale: a && b ? a.lengthM / b.lengthM : 1 };
}

/** The atlases that may hold this vehicle at this zoom, preferred first: its winter atlas in a
 * winter battle, its own per-vehicle atlas (both fetched on first use, so a battle only loads the
 * vehicles present), else a combined `vehicles_<scale>` atlas. */
function vehicleAtlasesFor(defId: string, zoom: number, season: Season): Atlas[] {
  const out: Atlas[] = [];
  if (seasonKey(season) === 'winter') {
    const w = atlasForZoom((sc) => vehicleDefAtlasName(defId, sc, 'winter'), zoom);
    if (w) out.push(w);
  }
  const own = atlasForZoom((sc) => vehicleDefAtlasName(defId, sc), zoom) ?? getAtlas(vehicleAtlasName(atlasScaleForZoom(zoom))) ?? getAtlas(vehicleAtlasName(1));
  if (own) out.push(own);
  return out;
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
        img.src = urlOf(typeof meta.image === 'string' && meta.image ? meta.image : `${name}.png`);
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
export function requestBattleAtlases(
  sides: readonly Side[], season: Season, onProgress?: (p: number) => void,
  /** vehicle types on the map: their scale-1 atlases load with the rest (no pop-in on first sight) */
  vehicleDefs: readonly string[] = [],
): Promise<void> {
  // the combat-FX flipbooks too, so the first muzzle puff or burst of the battle is not skipped
  const names = [...battleAtlasNames(sides, season), 'fx_s', 'fx_m', 'fx_l'];
  for (const d of vehicleDefs) {
    const def = VEHICLE_STAND_IN[d] ?? d;
    names.push(vehicleDefAtlasName(def, 1));
    if (seasonKey(season) === 'winter') names.push(vehicleDefAtlasName(def, 1, 'winter'));
  }
  // Only the scale-1 set is fetched up front. The scale-2 images are several times larger (a
  // soldier atlas decodes to ~170 MB) and are fetched by `atlasForZoom` the first time the player
  // zooms in; until they arrive the scale-1 frames are drawn enlarged.
  const upfront = names.filter((n) => !n.endsWith('_2'));
  wanted = upfront;
  for (const name of Array.from(slots.keys())) {
    if ((name.startsWith('soldiers_') || name.startsWith('smg_') || name.startsWith('parts_')) && !names.includes(name)) slots.delete(name);
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
/** Blit one frame with its anchor on (x, y). False = entry missing / atlas has no image.
 * `smooth`: at a zoom that is not a whole multiple of the atlas scale (the continuous zoom steps
 * 0.8, 1.25, 1.56 ...) resample with filtering instead of dropping / doubling uneven pixel rows. */
export function drawAtlasFrame(ctx: CanvasRenderingContext2D, atlas: Atlas | null, key: string, dir: number, frame: number, x: number, y: number, zoom: number, smooth = false): boolean {
  if (!atlas || !atlas.image) return false;
  const entry = atlas.meta.entries[key];
  if (!entry) return false;
  const r = atlasCellRect(atlas.meta, atlasFrameIndex(entry, atlas.meta.dirs, dir, frame));
  const d = atlasDestRect(atlas.meta, x, y, zoom);
  const k = zoom / atlas.meta.scale;
  if (smooth && Math.abs(k - Math.round(k)) > 0.01) {
    const was = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(atlas.image, r.sx, r.sy, r.sw, r.sh, d.dx, d.dy, d.dw, d.dh);
    ctx.imageSmoothingEnabled = was;
  } else {
    ctx.drawImage(atlas.image, r.sx, r.sy, r.sw, r.sh, d.dx, d.dy, d.dw, d.dh);
  }
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

/** Soldiers (and their body parts) use the scale-2 art for every zoom above 1: filtered down
 * from 2x (drawSoldier smooths) keeps the small figures crisp at the in-between zoom steps. */
const soldierScaleZoom = (zoom: number): number => (zoom > 1.01 ? Math.max(2, zoom) : zoom);
export function soldierAtlas(side: Side, season: Season, zoom: number): Atlas | null {
  return atlasForZoom((sc) => soldierAtlasName(side, season, sc), soldierScaleZoom(zoom));
}
export function smgAtlas(side: Side, season: Season, zoom: number): Atlas | null {
  return atlasForZoom((sc) => smgAtlasName(side, season, sc), soldierScaleZoom(zoom));
}
export function itemAtlas(zoom: number): Atlas | null { return atlasForZoom(itemAtlasName, zoom); }
export function partsAtlas(side: Side, season: Season, zoom: number): Atlas | null {
  return atlasForZoom((sc) => partsAtlasName(side, season, sc), soldierScaleZoom(zoom));
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
  return drawAtlasFrame(ctx, atlas, key, dir, frameOf(atlas.meta.entries[key], key), x, y, zoom, true) ? key : null;
}

/** Hull or turret from the 64 pre-rendered directions. The turret is placed on its ring:
 * `turretPivotM` (hull-local metres) rotated by the hull heading. False while its atlas loads. */
export function drawVehiclePart(
  ctx: CanvasRenderingContext2D, defId: string, part: 'hull' | 'turret', state: 'ok' | 'knockedOut',
  partRad: number, hullRad: number, x: number, y: number, zoom: number,
  /** damage look: 'blown' (hull with an open turret ring / turret lying on the ground, anchored
   * under its own centre) or 'trackL' / 'trackR' (hull with that track thrown); falls back to the
   * plain ok / ko entry when the atlas lacks it */
  variant?: 'blown' | 'trackL' | 'trackR',
  season: Season = 'summer',
): boolean {
  const art = vehicleArtFor(defId);
  defId = art.artId;
  zoom *= art.scale;
  const atlases = vehicleAtlasesFor(defId, zoom, season);
  const base = `${defId}.${part}.${state === 'ok' ? 'ok' : 'ko'}`;
  const keys = variant ? [`${defId}.${part}.${variant}`, base] : [base];
  for (const key of keys) {
    const atlas = atlases.find((a) => !!a.meta.entries[key]);
    if (!atlas) continue;
    let px = x, py = y;
    if (part === 'turret' && !(key !== base && variant === 'blown')) {
      const pv = turretPivotM(atlas.meta, defId);
      const c = Math.cos(hullRad), s = Math.sin(hullRad), pxPerM = 10 * zoom;
      // whole-pixel offset: the turret never shimmers against its hull while the vehicle drives
      px += Math.round((pv.x * c - pv.y * s) * pxPerM);
      py += Math.round((pv.x * s + pv.y * c) * pxPerM);
    }
    const dirs = atlas.meta.dirs;
    const dir = ((Math.round((partRad / (Math.PI * 2)) * dirs) % dirs) + dirs) % dirs;
    return drawAtlasFrame(ctx, atlas, key, dir, 0, px, py, zoom);
  }
  return false;
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

/** Muzzle of a crew-served weapon in weapon-frame metres (x right, y AFT, so forward is -y) —
 * where flashes, tracers and the mortar puff start. Read from the weapons atlas (tools/blender/
 * weapons.py writes `weapons.<id>.muzzleM` with y forward); the table mirrors it for the moments
 * before the atlas has loaded. */
const MUZZLE_FWD_M: Record<string, number> = {
  mortar81: 0.99, mortar82: 0.99, mg34_hmg: 1.425, mg42_hmg: 1.425, maxim: 1.296,
  pak38: 2.71, pak40: 3.31, m1937_45mm: 2.0, zis3: 3.19, ptrd: 1.86,
};
export function weaponMuzzleM(weaponId: string): { x: number; y: number } {
  const meta = (getAtlas(weaponAtlasName(1)) ?? getAtlas(weaponAtlasName(2)))?.meta as
    (AtlasMeta & { weapons?: Record<string, { muzzleM?: { x: number; y: number } }> }) | undefined;
  const m = meta?.weapons?.[weaponId]?.muzzleM;
  if (m) return { x: m.x, y: -m.y };
  return { x: 0, y: -(MUZZLE_FWD_M[weaponId] ?? 1) };
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
  // a crew weapon still waiting for its own model draws as its stand-in (see VEHICLE_STAND_IN)
  const art = Object.keys(atlas.meta.entries).some((k) => k.startsWith(`${weaponId}.`)) ? weaponId : (WEAPON_STAND_IN[weaponId] ?? weaponId);
  for (const st of states) {
    const key = `${art}.${st}`;
    if (atlas.meta.entries[key] && drawAtlasFrame(ctx, atlas, key, dir, 0, x, y, zoom)) return st;
  }
  return null;
}
