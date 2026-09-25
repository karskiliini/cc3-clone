// Dev-only preview page: renders every sprite this module produces at 4x so
// a human can eyeball them. Not part of the shipped game bundle.
import type { CursorKind, Season } from '@/shared/types';
import {
  getFlagSprite,
  getTeamIcon,
  getCursorSprite,
  getSmokePuff,
  getTreeSprite,
} from '@/render/sprites';
import { drawVehicleSprite } from '@/render/unitRender';
import { loadAtlas, vehicleDefAtlasName } from '@/render/spriteAtlas';
import { VEHICLE_DEFS } from '@/data/units';
import { drawText, textWidth, FONT_SMALL_H, FONT_BIG_H } from '@/render/pixelfont';
import { PALETTE, TERRAIN_COLORS, SIDE_COLOR, ORDER_COLOR } from '@/render/palette';

const root = document.getElementById('root')!;
const SCALE = 4;
const SCALE_1X = 1;
const SCALE_3X = 3;

function section(title: string): HTMLElement {
  const h = document.createElement('h2');
  h.textContent = title;
  root.appendChild(h);
  const row = document.createElement('div');
  row.className = 'row';
  root.appendChild(row);
  return row;
}

function cell(row: HTMLElement, label: string, src: HTMLCanvasElement, scale = SCALE): HTMLCanvasElement {
  const c = document.createElement('div');
  c.className = 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = src.width * scale;
  canvas.height = src.height * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  const span = document.createElement('span');
  span.textContent = label;
  c.appendChild(canvas);
  c.appendChild(span);
  row.appendChild(c);
  return canvas;
}

/** Show a sprite at 1x (true in-game size) AND 3x (for eyeballing detail),
 * stacked in one cell, per the sprite-scale verification requirement. */
function cellPair(row: HTMLElement, label: string, src: HTMLCanvasElement): void {
  const c = document.createElement('div');
  c.className = 'cell';
  const mk = (scale: number) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, src.width * scale);
    canvas.height = Math.max(1, src.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    canvas.style.display = 'block';
    canvas.style.margin = '0 auto 2px';
    return canvas;
  };
  c.appendChild(mk(SCALE_1X));
  c.appendChild(mk(SCALE_3X));
  const span = document.createElement('span');
  span.textContent = `${label} (1x/3x)`;
  c.appendChild(span);
  row.appendChild(c);
}

// ------------------------------------------------- wf19: legibility boards --
// Every soldier pose / crew weapon / vehicle at true 1x and 2x size on two ground backdrops: the
// current (dark) summer ground tone and one 20% brighter (the terrain repaint), plus snow. Each
// board is shown at 1:1 and magnified 3x. Board canvases carry ids (wf19-*) so a capture script
// can read their exact pixels with toDataURL().
const WF19_GROUNDS: [string, [number, number, number]][] = [
  ['dark', [101, 102, 45]], ['bright', [121, 122, 54]], ['snow', [212, 216, 218]],
];
function groundBackdrop(w: number, h: number, rgb: [number, number, number]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const blotch = Math.sin(x * 0.045) * Math.cos(y * 0.06) * 0.06;
      const k = 1 + (rnd() - 0.5) * 0.22 + blotch;
      const o = (y * w + x) * 4;
      img.data[o] = rgb[0] * k; img.data[o + 1] = rgb[1] * k; img.data[o + 2] = rgb[2] * k; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
function board(row: HTMLElement, id: string, label: string, cv: HTMLCanvasElement): void {
  cell(row, `${label} 1:1`, cv, 1).id = id;
  cell(row, `${label} x3`, cv, 3);
}
// Soldiers and crew-served weapons come from the Blender atlases: see tools/animPreview.html.
// Vehicles: see the Blender atlas section below.

/** In-game zoom-2 comparison: the 1x sprite blown up 2x with nearest-
 * neighbour (how zoom 2 used to look) beside the genuine 2x sprite drawn
 * 1:1 (how it looks now), on a ground-tone backdrop, plus a 3x magnified
 * copy of the 2x art for detail inspection. */
function zoomCompareCell(row: HTMLElement, label: string, s1: HTMLCanvasElement, s2: HTMLCanvasElement, bg: string): void {
  const c = document.createElement('div');
  c.className = 'cell';
  const mk = (src: HTMLCanvasElement, scale: number) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, src.width * scale);
    canvas.height = Math.max(1, src.height * scale);
    canvas.style.background = bg;
    canvas.style.display = 'inline-block';
    canvas.style.margin = '0 2px 2px';
    canvas.style.verticalAlign = 'bottom';
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    return canvas;
  };
  c.appendChild(mk(s1, 2));
  c.appendChild(mk(s2, 1));
  c.appendChild(mk(s2, 3));
  const span = document.createElement('span');
  span.textContent = `${label} (old 1x@2 | 2x | 2x@3)`;
  c.appendChild(span);
  row.appendChild(c);
}

// --------------------------------------------------------------- vehicles --
// Blender atlases (tools/blender/vehicles.py), drawn exactly as in battle by drawVehicleSprite:
// every vehicle at 1x and 2x, facings N / NE / E / S / SW (turret slewed on E), ok, ko, thrown
// track and blown turret, summer and winter (whitewash).
const VEHICLE_IDS = Object.keys(VEHICLE_DEFS); // every vehicle in the game
/** a scale-2 atlas decodes to ~100 MB: only a few vehicles at 2x here */
const VEHICLE_IDS_2X = ['pz4gh', 'panther', 'sdkfz251', 't34_85', 'kv1', 'su76'];
async function vehicleSections(): Promise<void> {
  const names: string[] = [];
  for (const se of ['summer', 'winter'] as const) {
    for (const id of VEHICLE_IDS) names.push(vehicleDefAtlasName(id, 1, se));
    for (const id of VEHICLE_IDS_2X) names.push(vehicleDefAtlasName(id, 2, se));
  }
  await Promise.all(names.map((n) => loadAtlas(n)));
  const looks: { name: string; state: 'ok' | 'knockedOut'; blown?: boolean; track?: 'L' | 'R' }[] = [
    { name: 'ok', state: 'ok' }, { name: 'thrown track', state: 'ok', track: 'L' },
    { name: 'knocked out', state: 'knockedOut' }, { name: 'turret blown', state: 'knockedOut', blown: true },
  ];
  const facings = [0, Math.PI / 4, Math.PI / 2, Math.PI, Math.PI * 1.25];
  for (const scale of [1, 2] as const) {
    for (const [gname, rgb] of [WF19_GROUNDS[0], WF19_GROUNDS[2]]) {
      const season: Season = gname === 'snow' ? 'winter' : 'summer';
      for (const look of looks) {
        if (look.name !== 'ok' && gname === 'snow' && scale === 2) continue;
        const row = section(`vehicles ${look.name} at ${scale}x on ${gname} (${season}) — facings N / NE / E (turret +35°) / S / SW`);
        const ids = scale === 2 ? VEHICLE_IDS_2X : VEHICLE_IDS;
        const step = 92 * scale;
        const cv = groundBackdrop(step * facings.length, step * ids.length, rgb);
        const ctx = cv.getContext('2d')!;
        ctx.imageSmoothingEnabled = false;
        ids.forEach((id, i) => facings.forEach((rad, r) => {
          const cx = r * step + step / 2, cy = i * step + step / 2;
          drawVehicleSprite(ctx, id, look.state, cx, cy, rad, rad + (r === 2 ? 0.6 : 0), scale, !!look.blown, look.track ?? null, undefined, season);
        }));
        board(row, `vehicles-${look.name.replace(' ', '-')}-${scale}x-${gname}`, `${gname}`, cv);
      }
    }
  }
}
void vehicleSections();

// ------------------------------------------------------------------ flags --
const flagRow = section('Flags');
cellPair(flagRow, 'german', getFlagSprite('german'));
cellPair(flagRow, 'soviet', getFlagSprite('soviet'));
cellPair(flagRow, 'neutral', getFlagSprite(null));

// ------------------------------------------------------------------ icons --
const ICONS = ['rifle', 'smg', 'mg', 'mortar', 'atgun', 'sniper', 'atteam', 'tank', 'spg', 'halftrack', 'command', 'engineer'];
const iconRow = section('Team icons');
for (const id of ICONS) cellPair(iconRow, id, getTeamIcon(id));

// --------------------------------------------------------------- cursors --
const CURSORS: CursorKind[] = ['arrow', 'crosshair', 'hand', 'no', 'move', 'wait'];
const cursorRow = section('Cursors');
for (const kind of CURSORS) cellPair(cursorRow, kind, getCursorSprite(kind));

// ----------------------------------------------------------------- smoke --
const smokeRow = section('Smoke puffs');
for (const size of [8, 16, 24, 32]) cell(smokeRow, `${size}px`, getSmokePuff(size), 3);

// ----------------------------------------------------------------- trees --
for (const season of ['summer', 'autumn', 'winter'] as Season[]) {
  const row = section(`Trees — ${season}`);
  for (let v = 0; v < 4; v++) cellPair(row, `variant ${v}`, getTreeSprite(v, season));
}

// ---------------------------------------------------------------- palette --
const paletteRow = section('Terrain palette swatches (summer)');
for (const [terrain, shades] of Object.entries(TERRAIN_COLORS.summer)) {
  const c = document.createElement('canvas');
  c.width = shades.length * 16;
  c.height = 16;
  const ctx = c.getContext('2d')!;
  shades.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(i * 16, 0, 16, 16);
  });
  cell(paletteRow, terrain, c, 1);
}

const sideRow = section('Side / order colors');
for (const [side, color] of Object.entries(SIDE_COLOR)) {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 16;
  c.getContext('2d')!.fillStyle = color;
  c.getContext('2d')!.fillRect(0, 0, 32, 16);
  cell(sideRow, side, c, 1);
}
for (const [order, color] of Object.entries(ORDER_COLOR)) {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 16;
  c.getContext('2d')!.fillStyle = color;
  c.getContext('2d')!.fillRect(0, 0, 32, 16);
  cell(sideRow, order, c, 1);
}

// -------------------------------------------------------------------- font --
function makeTextCanvas(text: string, size: 'small' | 'big', color: string): HTMLCanvasElement {
  const h = size === 'small' ? FONT_SMALL_H : FONT_BIG_H;
  const w = Math.max(1, textWidth(text, size));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  drawText(ctx, text, 0, 0, color, size);
  return c;
}

const fontRow = section('Font — small (5x7)');
cell(fontRow, 'small ASCII', makeTextCanvas('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'small', PALETTE.white), 3);
const fontRow2 = section('Font — small lowercase/punct');
cell(fontRow2, 'lower', makeTextCanvas('abcdefghijklmnopqrstuvwxyz 0123456789', 'small', PALETTE.text), 3);
cell(fontRow2, 'msg', makeTextCanvas("22:14 Rifle Squad is pinned down!", 'small', PALETTE.gold), 3);
const fontRow3 = section('Font — big (7x11)');
cell(fontRow3, 'big caps', makeTextCanvas('CLOSE COMBAT III', 'big', PALETTE.gold), 3);
cell(fontRow3, 'big digits/punct', makeTextCanvas("00:00 (1) '?.,-/", 'big', PALETTE.text), 3);
