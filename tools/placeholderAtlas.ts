// Placeholder sprite atlases in the exact §5 contract format (docs/superpowers/specs/
// 2026-09-17-soldier-animation-design.md), so the loader, the preview and the tests run against
// real files before the Blender render scripts deliver theirs. Pure: returns the JSON meta and
// the RGBA pixels; tools/makePlaceholderAtlas.mjs encodes the PNGs into
// public/sprites/_placeholder/ (never into public/sprites/, which belongs to the real atlases).
// Figures are deliberately schematic: a body blob, a heading line, a moving limb tick per frame.
import type { AtlasMeta, AtlasEntry } from '../src/render/spriteAtlas.ts';

export interface BuiltAtlas { name: string; meta: AtlasMeta; width: number; height: number; rgba: Uint8Array }

const POSTURES = ['standing', 'crouched', 'kneeling', 'prone'] as const;
const ACTIONS: Record<string, { frames: number; fps: number; loop: boolean; postures?: readonly string[] }> = {
  idle: { frames: 4, fps: 3.3, loop: true }, aim: { frames: 2, fps: 2, loop: true }, fire: { frames: 3, fps: 12, loop: false },
  reload: { frames: 4, fps: 2, loop: false }, hide: { frames: 2, fps: 2, loop: true },
  walk: { frames: 4, fps: 6, loop: true, postures: ['standing'] }, run: { frames: 6, fps: 9, loop: true, postures: ['standing'] },
  sneak: { frames: 4, fps: 5, loop: true, postures: ['crouched'] }, crawl: { frames: 4, fps: 4, loop: true, postures: ['prone'] },
  throw: { frames: 4, fps: 8, loop: false, postures: ['standing', 'kneeling'] },
  hit: { frames: 3, fps: 8, loop: false }, woundedCrawl: { frames: 4, fps: 2, loop: true, postures: ['prone'] },
};
/** Mood variants the placeholder carries (the rest exercise the fallback chain). */
const MOOD_VARIANTS = ['standing.run.panicked', 'standing.idle.surrendered', 'kneeling.idle.surrendered', 'prone.hide.pinned', 'crouched.hide.cowering', 'standing.idle.alert'];

function layout(scale: number, cell: number, anchor: { x: number; y: number }, dirs: number, columns: number, defs: [string, { frames: number; fps: number; loop: boolean }][]): AtlasMeta {
  const entries: Record<string, AtlasEntry> = {};
  let start = 0;
  for (const [key, d] of defs) { entries[key] = { start, frames: d.frames, fps: d.fps, loop: d.loop }; start += dirs * d.frames; }
  return { scale, cell: { w: cell, h: cell }, anchor, columns, dirs, entries };
}

function paint(meta: AtlasMeta, draw: (key: string, dir: number, frame: number, put: (x: number, y: number, r: number, g: number, b: number, a?: number) => void) => void): { width: number; height: number; rgba: Uint8Array } {
  let cells = 0;
  for (const e of Object.values(meta.entries)) cells = Math.max(cells, e.start + meta.dirs * e.frames);
  const rows = Math.ceil(cells / meta.columns);
  const width = meta.columns * meta.cell.w, height = rows * meta.cell.h;
  const rgba = new Uint8Array(width * height * 4);
  for (const [key, e] of Object.entries(meta.entries)) {
    for (let dir = 0; dir < meta.dirs; dir++) {
      for (let f = 0; f < e.frames; f++) {
        const index = e.start + dir * e.frames + f;
        const ox = (index % meta.columns) * meta.cell.w, oy = Math.floor(index / meta.columns) * meta.cell.h;
        draw(key, dir, f, (x, y, r, g, b, a = 255) => {
          const px = Math.round(x), py = Math.round(y);
          if (px < 0 || py < 0 || px >= meta.cell.w || py >= meta.cell.h) return;
          const o = ((oy + py) * width + ox + px) * 4;
          rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
        });
      }
    }
  }
  return { width, height, rgba };
}

function disc(put: (x: number, y: number, r: number, g: number, b: number, a?: number) => void, cx: number, cy: number, rx: number, ry: number, rot: number, col: [number, number, number], a = 255): void {
  const R = Math.ceil(Math.max(rx, ry));
  const c = Math.cos(rot), s = Math.sin(rot);
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
    const lx = x * c + y * s, ly = -x * s + y * c;
    if ((lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 1) put(cx + x, cy + y, col[0], col[1], col[2], a);
  }
}
function line(put: (x: number, y: number, r: number, g: number, b: number, a?: number) => void, x0: number, y0: number, x1: number, y1: number, col: [number, number, number]): void {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) * 2;
  for (let i = 0; i <= n; i++) put(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, col[0], col[1], col[2]);
}

export function buildSoldierPlaceholder(side: 'german' | 'soviet', season: 'summer' | 'winter', scale: 1 | 2): BuiltAtlas {
  const defs: [string, { frames: number; fps: number; loop: boolean }][] = [];
  for (const p of POSTURES) for (const [a, d] of Object.entries(ACTIONS)) if (!d.postures || d.postures.includes(p)) defs.push([`${p}.${a}`, d]);
  for (const k of MOOD_VARIANTS) { const base = ACTIONS[k.split('.')[1]]; defs.push([k, base]); }
  defs.push(['standing.idle@lmg', ACTIONS.idle]);
  for (let i = 0; i < 6; i++) defs.push([`ragdoll.flight${i}`, { frames: 8, fps: 10, loop: false }]);
  for (let i = 0; i < 8; i++) defs.push([`ragdoll.landed${i}`, { frames: 1, fps: 1, loop: false }]);
  for (let i = 0; i < 8; i++) defs.push([`corpse${i}`, { frames: 1, fps: 1, loop: false }]);
  const cell = 40 * scale;
  const meta = layout(scale, cell, { x: 20 * scale, y: 24 * scale }, 16, 32, defs);
  const uniform: [number, number, number] = season === 'winter' ? [206, 208, 200] : side === 'german' ? [133, 147, 143] : [192, 164, 104];
  const helmet: [number, number, number] = side === 'german' ? [90, 100, 104] : [119, 124, 70];
  const img = paint(meta, (key, dir, f, put) => {
    const [posture, action, mood] = key.split('@')[0].split('.');
    const rad = (dir / 16) * Math.PI * 2;
    const fx = Math.sin(rad), fy = -Math.cos(rad);
    const cx = meta.anchor.x, cy = meta.anchor.y;
    const lying = posture === 'prone' || posture.startsWith('ragdoll') || posture.startsWith('corpse');
    const len = (lying ? 8 : posture === 'standing' ? 4.5 : 3.6) * scale, wid = (lying ? 3 : 3.4) * scale;
    const spin = posture === 'ragdoll' && action.startsWith('flight') ? (f / 8) * Math.PI * 2 * (1 + (Number(action.slice(6)) % 3) * 0.5) : 0;
    const bodyRot = rad + Math.PI / 2 + spin;
    const flight = posture === 'ragdoll' && action.startsWith('flight');
    if (!flight) disc(put, cx + 2 * scale, cy + 2 * scale, len, wid, bodyRot, [0, 0, 0], 90); // contact shadow (none in flight)
    const dead = posture.startsWith('corpse') || (posture === 'ragdoll' && !flight);
    const body: [number, number, number] = dead ? [uniform[0] * 0.55, uniform[1] * 0.55, uniform[2] * 0.55] : uniform;
    disc(put, cx, cy, len, wid, bodyRot, body);
    const swing = Math.sin((f / Math.max(1, ACTIONS[action]?.frames ?? 4)) * Math.PI * 2);
    if (['walk', 'run', 'sneak', 'crawl', 'woundedCrawl'].includes(action)) {
      line(put, cx - fx * len * 0.6, cy - fy * len * 0.6, cx - fx * (len + 3 * scale * (1 + swing)), cy - fy * (len + 3 * scale * (1 + swing)), [36, 31, 24]);
    }
    disc(put, cx + fx * (lying ? len * 0.7 : 0), cy + fy * (lying ? len * 0.7 : 0), 2.4 * scale, 2.4 * scale, 0, helmet);
    put(cx + fx * (lying ? len * 0.7 : 0) - scale, cy + fy * (lying ? len * 0.7 : 0) - scale, 232, 236, 236);
    if (mood === 'surrendered') { line(put, cx - 3 * scale, cy, cx - 4 * scale, cy - 6 * scale, [201, 163, 124]); line(put, cx + 3 * scale, cy, cx + 4 * scale, cy - 6 * scale, [201, 163, 124]); return; }
    if (dead || mood === 'cowering' || mood === 'panicked') return;
    const kick = action === 'fire' ? (f === 0 ? -1.5 : f === 1 ? -0.5 : 0) * scale : 0;
    const reach = (action === 'aim' || action === 'fire' ? 10 : 7) * scale + kick;
    line(put, cx + fx * 2 * scale, cy + fy * 2 * scale, cx + fx * reach, cy + fy * reach, [20, 20, 18]);
    line(put, cx + fx * 2 * scale - fy, cy + fy * 2 * scale + fx, cx + fx * reach - fy, cy + fy * reach + fx, [180, 182, 172]);
  });
  return { name: `soldiers_${side}_${season}_${scale}`, meta, ...img };
}

export function buildVehiclePlaceholder(scale: 1 | 2): BuiltAtlas {
  const ids = ['pz3j', 't34_76'];
  const defs: [string, { frames: number; fps: number; loop: boolean }][] = [];
  for (const id of ids) for (const part of ['hull', 'turret']) for (const st of ['ok', 'ko']) defs.push([`${id}.${part}.${st}`, { frames: 1, fps: 1, loop: false }]);
  const cell = 96 * scale;
  const meta = layout(scale, cell, { x: 48 * scale, y: 48 * scale }, 64, 32, defs);
  meta.vehicles = { pz3j: { turretPivotM: { x: 0, y: -0.2 } }, t34_76: { turretPivotM: { x: 0, y: -0.8 } } };
  const img = paint(meta, (key, dir, _f, put) => {
    const [id, part, st] = key.split('.');
    const rad = (dir / 64) * Math.PI * 2;
    const base: [number, number, number] = id === 'pz3j' ? [90, 97, 102] : [88, 104, 64];
    const k = st === 'ko' ? 0.45 : 1;
    const col: [number, number, number] = [base[0] * k, base[1] * k, base[2] * k];
    const cx = meta.anchor.x, cy = meta.anchor.y;
    if (part === 'hull') {
      disc(put, cx + 5 * scale, cy + 5 * scale, 30 * scale, 15 * scale, rad + Math.PI / 2, [0, 0, 0], 110);
      disc(put, cx, cy, 29 * scale, 14.5 * scale, rad + Math.PI / 2, [58, 58, 52]);
      disc(put, cx, cy, 27 * scale, 10 * scale, rad + Math.PI / 2, col);
    } else {
      disc(put, cx, cy, 9 * scale, 8 * scale, rad + Math.PI / 2, [col[0] * 1.12, col[1] * 1.12, col[2] * 1.12]);
      line(put, cx, cy, cx + Math.sin(rad) * 30 * scale, cy - Math.cos(rad) * 30 * scale, [30, 30, 28]);
    }
  });
  return { name: `vehicles_${scale}`, meta, ...img };
}

export function buildWeaponPlaceholder(scale: 1 | 2): BuiltAtlas {
  const defs: [string, { frames: number; fps: number; loop: boolean }][] = [];
  for (const id of ['mortar81', 'mg34_hmg', 'pak38']) for (const v of ['setup', 'half', 'packed']) defs.push([`${id}.${v}`, { frames: 1, fps: 1, loop: false }]);
  const cell = 64 * scale;
  const meta = layout(scale, cell, { x: 32 * scale, y: 32 * scale }, 32, 32, defs);
  const img = paint(meta, (key, dir, _f, put) => {
    const [id, v] = key.split('.');
    const rad = (dir / 32) * Math.PI * 2;
    const cx = meta.anchor.x, cy = meta.anchor.y;
    disc(put, cx + 2 * scale, cy + 2 * scale, 6 * scale, 5 * scale, rad, [0, 0, 0], 100);
    disc(put, cx, cy, 5 * scale, 4 * scale, rad, [90, 96, 90]);
    const len = (id === 'pak38' ? 24 : 10) * scale * (v === 'packed' ? 0.5 : v === 'half' ? 0.75 : 1);
    line(put, cx, cy, cx + Math.sin(rad) * len, cy - Math.cos(rad) * len, [24, 24, 22]);
  });
  return { name: `weapons_${scale}`, meta, ...img };
}

export function buildAllPlaceholders(): BuiltAtlas[] {
  const out: BuiltAtlas[] = [];
  for (const scale of [1, 2] as const) {
    for (const side of ['german', 'soviet'] as const) for (const season of ['summer', 'winter'] as const) out.push(buildSoldierPlaceholder(side, season, scale));
    out.push(buildVehiclePlaceholder(scale), buildWeaponPlaceholder(scale));
  }
  return out;
}
