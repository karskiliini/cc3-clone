// Dev-only: plays every entry of whatever sprite atlases exist (spec 2026-09-17 §5) as looping
// animations at 1x and 3x, both sides / seasons, with the pure frame selection of soldierAnim.ts,
// plus a ragdoll demo driven by the real sim knockback and the real ragdoll playback. With no
// atlas present it shows the code-drawn fallback poses instead. `window.__animStrip` /
// `window.__ragdollStrip` render deterministic frame strips for capture scripts.
import type { BattleState, Camera, Facing8, GameMap, MapDef, Season, Side, Soldier, Terrain, WeaponDef } from '@/shared/types';
import {
  drawAtlasFrame, getAtlas, loadAtlas, setAtlasBasePath, soldierAtlasName, vehicleAtlasName, weaponAtlasName, type Atlas,
} from '@/render/spriteAtlas';
import { frameFor, type AnimAction } from '@/render/soldierAnim';
import { drawRagdollFlight, drawRagdollLanded, landedFacing8, ragdollBeginFrame, ragdollPhase } from '@/render/ragdoll';
import { drawEffects } from '@/render/effects';
import { getSoldierSprite } from '@/render/sprites';
import type { SoldierPose } from '@/render/soldierArt';
import { applyBlastKnockback } from '@/sim/combat';
import { createMind } from '@/sim/mind';
import { Rng } from '@/shared/rng';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const root = $('root'), status = $('status');
const srcSel = $<HTMLSelectElement>('src'), sideSel = $<HTMLSelectElement>('side'), seasonSel = $<HTMLSelectElement>('season'), dirSel = $<HTMLSelectElement>('dir');
for (let d = 0; d < 16; d++) { const o = document.createElement('option'); o.value = String(d); o.textContent = `dir ${d}`; dirSel.appendChild(o); }

const GROUND: Record<'summer' | 'winter', string> = { summer: '#797a36', winter: '#d4d8da' };
const now = () => performance.now() / 1000;

function fakeSoldier(id: number, side: Side, o: Partial<Soldier> = {}): Soldier {
  return {
    id, teamId: 1, side, name: 'Preview', rank: 'Pvt', weaponId: side === 'german' ? 'kar98k' : 'mosin', ammo: 5, ammoReserve: 0, grenades: 0,
    health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance: 'standing', activity: 'idle', pos: { x: 0, y: 0 },
    facing: 0, targetSoldierId: null, targetVehicleId: null, targetPoint: null, path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0,
    isLeader: false, vehicleId: null, formationOffset: { x: 0, y: 0 }, lastFiredAt: -99, cover: 0, kills: 0, mind: createMind(50), ...o,
  };
}

/** Frame of `key` at clock `t`, through the same pure selection the battle uses. */
function frameAt(key: string, atlas: Atlas, t: number, id = 1): number {
  const entry = atlas.meta.entries[key];
  const action = (key.split('@')[0].split('.')[1] ?? 'idle') as AnimAction;
  const s = fakeSoldier(id, 'german');
  if (action === 'fire') s.lastFiredAt = Math.floor(t / 0.8) * 0.8;                 // fire every 0.8 s
  if (action === 'reload') { s.activity = 'reloading'; s.reloadTimer = 3 - (t % 3); }
  if (!entry.loop && action !== 'fire' && action !== 'reload') return Math.floor((t * Math.max(1, entry.fps)) % entry.frames);
  return frameFor(s, t, action, entry, 0, 'calm');
}

interface Anim { canvas: HTMLCanvasElement; atlas: Atlas; key: string; zoom: number; bg: string }
const anims: Anim[] = [];

function section(title: string): HTMLElement {
  const h = document.createElement('h2'); h.textContent = title; root.appendChild(h);
  const row = document.createElement('div'); row.className = 'row'; root.appendChild(row);
  return row;
}

function addEntryCell(row: HTMLElement, atlas: Atlas, key: string, bg: string): void {
  const cell = document.createElement('div'); cell.className = 'cell';
  const k = 1 / atlas.meta.scale;
  for (const zoom of [1, 3]) {
    const c = document.createElement('canvas');
    c.width = atlas.meta.cell.w * k * zoom; c.height = atlas.meta.cell.h * k * zoom;
    c.style.display = 'inline-block'; c.style.margin = '0 2px 3px'; c.style.verticalAlign = 'bottom';
    cell.appendChild(c);
    anims.push({ canvas: c, atlas, key, zoom, bg });
  }
  const e = atlas.meta.entries[key];
  const span = document.createElement('span'); span.textContent = `${key} (${e.frames}f @${e.fps}${e.loop ? ' loop' : ''})`;
  cell.appendChild(span); row.appendChild(cell);
}

function drawAnim(a: Anim, t: number): void {
  const ctx = a.canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = a.bg; ctx.fillRect(0, 0, a.canvas.width, a.canvas.height);
  const fixed = Number(dirSel.value);
  const dirs = a.atlas.meta.dirs;
  const dir = fixed >= 0 ? Math.round((fixed / 16) * dirs) : Math.floor(t / (dirs > 16 ? 0.12 : 1.6)) % dirs;
  // draw at the atlas's native 1x size times the cell zoom
  const z = a.zoom;
  ctx.save();
  drawAtlasFrame(ctx, a.atlas, a.key, dir, frameAt(a.key, a.atlas, t), a.atlas.meta.anchor.x / a.atlas.meta.scale * z, a.atlas.meta.anchor.y / a.atlas.meta.scale * z, z);
  ctx.restore();
}

const FALLBACK_POSES: SoldierPose[] = ['standing', 'crouching', 'prone', 'wary', 'cowering', 'pinned', 'panicked', 'berserk', 'surrendered', 'woundedCrawl', 'dead'];
interface FallbackAnim { canvas: HTMLCanvasElement; side: Side; season: Season; pose: SoldierPose; zoom: number }
const fallbackAnims: FallbackAnim[] = [];

async function rebuild(): Promise<void> {
  anims.length = 0; fallbackAnims.length = 0; root.innerHTML = '';
  setAtlasBasePath(srcSel.value);
  const side = sideSel.value as Side, season = seasonSel.value as Season;
  const bg = GROUND[season === 'winter' ? 'winter' : 'summer'];
  const names = [soldierAtlasName(side, season, 1), soldierAtlasName(side, season, 2), vehicleAtlasName(1), vehicleAtlasName(2), weaponAtlasName(1), weaponAtlasName(2)];
  status.textContent = 'loading…';
  const loaded = await Promise.all(names.map((n) => loadAtlas(n)));
  status.textContent = names.map((n, i) => `${n}: ${loaded[i] ? `${Object.keys(loaded[i]!.meta.entries).length} entries` : 'missing'}`).join(' | ');
  for (const atlas of loaded) {
    if (!atlas) continue;
    const row = section(`${atlas.name} — scale ${atlas.meta.scale}, ${atlas.meta.dirs} dirs, cell ${atlas.meta.cell.w}x${atlas.meta.cell.h} (1x | 3x)`);
    for (const key of Object.keys(atlas.meta.entries)) addEntryCell(row, atlas, key, bg);
  }
  if (!loaded[0]) {
    const row = section(`no soldier atlas at ${srcSel.value} — the game draws these code-made fallback poses (2 frames, 8 facings)`);
    for (const pose of FALLBACK_POSES) {
      const cell = document.createElement('div'); cell.className = 'cell';
      for (const zoom of [1, 3]) {
        const c = document.createElement('canvas'); c.width = 40 * zoom; c.height = 40 * zoom;
        c.style.display = 'inline-block'; c.style.margin = '0 2px 3px'; cell.appendChild(c);
        fallbackAnims.push({ canvas: c, side, season, pose, zoom });
      }
      const span = document.createElement('span'); span.textContent = pose; cell.appendChild(span); row.appendChild(cell);
    }
  }
}

// ------------------------------------------------------------------ ragdoll demo ---
const mortar: WeaponDef = { id: 'mortar81', name: '8cm', cls: 'mortar', rangeM: 1000, rate: 0.15, burst: 1, accuracy: 0.15, lethality: 0.6, suppression: 0.6, penetrationMm: 0, heRadiusM: 6, ammo: 3, reloadS: 8 };
function demoState(season: Season): BattleState {
  const W = 40, H = 12;
  const tiles: Terrain[] = new Array(W * H).fill('open');
  const def = { id: 'demo', name: 'demo', description: '', width: W, height: H, season, paint: () => {}, victoryLocations: [], deployZones: { german: { x: 0, y: 0, w: 2, h: 2 }, soviet: { x: 30, y: 0, w: 2, h: 2 } }, attacker: 'german' } as unknown as MapDef;
  const map = { def, width: W, height: H, tiles, buildingId: new Int16Array(W * H).fill(-1), windows: new Uint8Array(W * H), victoryLocations: [], smoke: new Float32Array(W * H), craters: [] } as unknown as GameMap;
  return {
    config: { mapId: 'demo', playerSide: 'german', year: 1943, seed: 1, durationS: 99, difficulty: 'normal', forces: { german: [], soviet: [] } },
    map, phase: 'running', time: 0, soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: { german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 }, soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 } },
    spotted: { german: new Set(), soviet: new Set() }, spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], result: null, events: [], nextId: 100,
  } as BattleState;
}
let demo = demoState('summer');
let demoT0 = now();
const demoCam: Camera = { x: 0, y: 0, zoom: 2 };
function resetDemo(): void {
  demo = demoState(seasonSel.value as Season);
  demoT0 = now();
  for (let i = 0; i < 8; i++) {
    const s = fakeSoldier(200 + i, sideSel.value as Side, { pos: { x: 3.5 + i * 1.3, y: 3 + ((i * 7) % 3) * 0.6 }, facing: (i % 8) as Facing8 });
    demo.soldiers.set(s.id, s);
  }
}
function fireBlast(time: number): void {
  const rng = new Rng(Math.floor(time * 1000) + 3);
  const burst = { x: 8, y: 2.4 };
  demo.time = time;
  for (const s of demo.soldiers.values()) {
    if (s.health === 'dead') continue;
    const d = Math.hypot(s.pos.x - burst.x, s.pos.y - burst.y);
    if (d < 1.4) { s.health = 'dead'; s.activity = 'dead'; }
    applyBlastKnockback(demo, rng, s, burst, mortar);
  }
  demo.explosions.push({ pos: burst, radiusM: 6, t: 0, kind: 'he' });
}
function drawDemo(canvas: HTMLCanvasElement, time: number): void {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const season = demo.map.def.season;
  ctx.fillStyle = GROUND[season === 'winter' ? 'winter' : 'summer']; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const dt = Math.max(0, time - demo.time);
  demo.time = time;
  for (const e of demo.explosions) e.t += dt;
  demo.explosions = demo.explosions.filter((e) => e.t < 1.2);
  ragdollBeginFrame(time);
  const order = [...demo.soldiers.values()].sort((a, b) => Number(a.health !== 'dead') - Number(b.health !== 'dead'));
  for (const s of order) {
    const rp = ragdollPhase(s, time);
    if (rp.phase === 'flight' && rp.sample) { drawRagdollFlight(ctx, demoCam, s, rp.sample, season); continue; }
    if (rp.phase === 'landed' && drawRagdollLanded(ctx, demoCam, s, season)) continue;
    const pose: SoldierPose = s.health === 'dead' ? 'dead' : rp.phase === 'landed' ? 'pinned' : s.blast && time < (s.stunnedUntil ?? 0) + 0.4 ? 'crouching' : 'standing';
    const facing = s.blast && (s.health === 'dead' || rp.phase === 'landed') ? landedFacing8(s) : s.facing;
    const atlas = getAtlas(soldierAtlasName(s.side, season, 2));
    const px = s.pos.x * 40, py = s.pos.y * 40;
    if (atlas && s.health !== 'dead' && drawAtlasFrame(ctx, atlas, pose === 'pinned' ? 'prone.hide' : pose === 'crouching' ? 'kneeling.idle' : 'standing.idle', facing * 2, frameAt('standing.idle', atlas, time, s.id), px, py, 2)) continue;
    const sp = getSoldierSprite(s.side, season, pose, facing, 0, 'friendly', 2);
    ctx.drawImage(sp, Math.round(px - sp.width / 2), Math.round(py - sp.height / 2));
  }
  drawEffects(ctx, demoCam, demo);
}

// deterministic strips for capture scripts
declare global { interface Window { __animStrip: (atlasName: string, key: string, dir: number, n?: number, dt?: number, zoom?: number) => string | null; __ragdollStrip: (n?: number, dt?: number) => string; __ready: boolean } }
window.__animStrip = (atlasName, key, dir, n = 8, dt = 0.1, zoom = 3) => {
  const atlas = getAtlas(atlasName);
  if (!atlas || !atlas.meta.entries[key]) return null;
  const k = zoom / atlas.meta.scale;
  const cw = Math.round(atlas.meta.cell.w * k), ch = Math.round(atlas.meta.cell.h * k);
  const c = document.createElement('canvas'); c.width = cw * n; c.height = ch;
  const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = GROUND[atlasName.includes('winter') ? 'winter' : 'summer']; ctx.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < n; i++) drawAtlasFrame(ctx, atlas, key, dir, frameAt(key, atlas, 0.8 + i * dt), i * cw + atlas.meta.anchor.x * k, atlas.meta.anchor.y * k, zoom);
  return c.toDataURL('image/png');
};
window.__ragdollStrip = (n = 8, dt = 0.1) => {
  resetDemo();
  const t0 = 1000; // a private clock: independent of the live demo
  demo.time = t0; fireBlast(t0);
  const frame = document.createElement('canvas'); frame.width = 640; frame.height = 200;
  const c = document.createElement('canvas'); c.width = 640; c.height = 200 * n;
  const ctx = c.getContext('2d')!;
  for (let i = 0; i < n; i++) { drawDemo(frame, t0 + i * dt); ctx.drawImage(frame, 0, i * 200); }
  resetDemo();
  return c.toDataURL('image/png');
};

$('ragdoll').addEventListener('click', () => { resetDemo(); fireBlast(now() - demoT0 + 0.0001); });
for (const sel of [srcSel, sideSel, seasonSel]) sel.addEventListener('change', () => { void rebuild().then(resetDemo); });

function tick(): void {
  const t = now();
  for (const a of anims) drawAnim(a, t);
  for (const f of fallbackAnims) {
    const ctx = f.canvas.getContext('2d')!; ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = GROUND[f.season === 'winter' ? 'winter' : 'summer']; ctx.fillRect(0, 0, f.canvas.width, f.canvas.height);
    const sp = getSoldierSprite(f.side, f.season, f.pose, (Math.floor(t / 1.6) % 8) as Facing8, (Math.floor(t / 0.3) % 2) as 0 | 1, 'friendly', f.zoom >= 2 ? 2 : 1);
    const k = f.zoom >= 2 ? f.zoom / 2 : 1;
    ctx.drawImage(sp, Math.round(f.canvas.width / 2 - (sp.width * k) / 2), Math.round(f.canvas.height / 2 - (sp.height * k) / 2), sp.width * k, sp.height * k);
  }
  drawDemo($<HTMLCanvasElement>('ragdollCanvas'), t - demoT0);
  requestAnimationFrame(tick);
}
resetDemo();
void rebuild().then(() => { window.__ready = true; });
requestAnimationFrame(tick);
