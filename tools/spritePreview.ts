// Dev-only preview page: renders every sprite this module produces at 4x so
// a human can eyeball them. Not part of the shipped game bundle.
import type { Facing8, Stance, Season, Side, CursorKind } from '@/shared/types';
import {
  getSoldierSprite,
  getVehicleSprite,
  getFlagSprite,
  getTeamIcon,
  getCursorSprite,
  getSmokePuff,
  getTreeSprite,
} from '@/render/sprites';
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

function cell(row: HTMLElement, label: string, src: HTMLCanvasElement, scale = SCALE): void {
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

// --------------------------------------------------------------- soldiers --
const SIDES: Side[] = ['german', 'soviet'];
const SEASONS: Season[] = ['summer', 'autumn', 'winter'];
const STANCES: (Stance | 'dead')[] = ['standing', 'crouching', 'prone', 'dead'];
const FACINGS: Facing8[] = [0, 1, 2, 3, 4, 5, 6, 7];

/** Show a soldier sprite at 1x (true in-game size) AND 4x (for eyeballing
 * detail), stacked in one cell, per the verification requirement. */
function cellPair1x4x(row: HTMLElement, label: string, src: HTMLCanvasElement): void {
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
  c.appendChild(mk(SCALE));
  const span = document.createElement('span');
  span.textContent = `${label} (1x/4x)`;
  c.appendChild(span);
  row.appendChild(c);
}

for (const side of SIDES) {
  for (const season of SEASONS) {
    const row = section(`Soldiers — ${side} / ${season}`);
    for (const stance of STANCES) {
      for (const facing of FACINGS) {
        const sprite = getSoldierSprite(side, season, stance, facing, 0);
        cellPair1x4x(row, `${stance} f${facing}`, sprite);
      }
    }
  }
}

for (const side of SIDES) {
  const row = section(`Soldiers — ${side} / winter / friendly outline`);
  for (const stance of STANCES) {
    for (const facing of FACINGS) {
      cellPair1x4x(row, `${stance} f${facing}`, getSoldierSprite(side, 'winter', stance, facing, 0, 'friendly'));
    }
  }
}

const walkRow = section('Soldier walk frames (standing, german, summer, facing 0/2/4/6)');
for (const facing of [0, 2, 4, 6] as Facing8[]) {
  cellPair(walkRow, `f${facing} frame0`, getSoldierSprite('german', 'summer', 'standing', facing, 0));
  cellPair(walkRow, `f${facing} frame1`, getSoldierSprite('german', 'summer', 'standing', facing, 1));
}

// --------------------------------------------------------------- vehicles --
const VEHICLE_IDS = [
  'pz3j', 'pz4f1', 'pz4gh', 'stug3g', 'panther', 'tiger', 'sdkfz251', 'marder3',
  't26', 'bt7', 't34_76', 't34_85', 'kv1', 'is2', 't70', 'su76', 'su85',
];
const vehRow = section('Vehicles — hull + turret (ok)');
for (const id of VEHICLE_IDS) {
  const hull = getVehicleSprite(id, 'hull', 'ok');
  cellPair(vehRow, `${id} hull`, hull);
  const turret = getVehicleSprite(id, 'turret', 'ok');
  cellPair(vehRow, `${id} turret`, turret);
}
const vehKoRow = section('Vehicles — knocked out');
for (const id of VEHICLE_IDS) {
  cellPair(vehKoRow, `${id} hull KO`, getVehicleSprite(id, 'hull', 'knockedOut'));
}

/** Compose hull + turret onto one canvas the way unitRender does: both
 * centred on the same pivot point (their own canvas centre), turret drawn
 * on top of the hull, no rotation (north-facing). */
function composeVehicle(hull: HTMLCanvasElement, turret: HTMLCanvasElement | null): HTMLCanvasElement {
  const w = Math.max(hull.width, turret ? turret.width : 0);
  const h = Math.max(hull.height, turret ? turret.height : 0);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(hull, (w - hull.width) / 2, (h - hull.height) / 2);
  if (turret && turret.width > 1) ctx.drawImage(turret, (w - turret.width) / 2, (h - turret.height) / 2);
  return c;
}

const vehComposedRow = section('Vehicles — composed hull+turret (ok)');
for (const id of VEHICLE_IDS) {
  const hull = getVehicleSprite(id, 'hull', 'ok');
  const turret = getVehicleSprite(id, 'turret', 'ok');
  cellPair(vehComposedRow, `${id}`, composeVehicle(hull, turret));
}
const vehComposedKoRow = section('Vehicles — composed hull+turret (knocked out)');
for (const id of VEHICLE_IDS) {
  const hull = getVehicleSprite(id, 'hull', 'knockedOut');
  const turret = getVehicleSprite(id, 'turret', 'knockedOut');
  cellPair(vehComposedKoRow, `${id} KO`, composeVehicle(hull, turret));
}

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
for (const season of SEASONS) {
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
