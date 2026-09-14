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
  getWeaponSprite,
} from '@/render/sprites';
import { getCrewPoseSprite, CREW_POSES } from '@/render/soldierArt';
import { weaponTowLengthM } from '@/render/weaponArt';
import { CREW_LAYOUT, crewServedClass } from '@/sim/crewWeapon';
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

// ----------------------------------------------- crew-served weapons (wf9) --
// Every crew-served weapon at 1x and 2x, 8 facings, set up (crew posed around it at the
// CREW_LAYOUT role slots) and packed (carry poses / AT gun towed trail-first by its crew).
{
  const CREW_WEAPONS: [string, Side][] = [
    ['mortar81', 'german'], ['mortar82', 'soviet'], ['mg34_hmg', 'german'], ['mg42_hmg', 'german'], ['maxim', 'soviet'],
    ['pak38', 'german'], ['pak40', 'german'], ['m1937_45mm', 'soviet'], ['zis3', 'soviet'], ['ptrd', 'soviet'],
  ];
  const clsOf = (id: string): 'mortar' | 'hmg' | 'atgun' | null => crewServedClass(id);
  /** A small scene: weapon + crew, drawn at true size for `scale` (1 = zoom 1, 2 = zoom 2). */
  const scene = (weaponId: string, side: Side, season: Season, facing8: number, packed: boolean, scale: 1 | 2, fire = false): HTMLCanvasElement => {
    const W = 90 * scale;
    const c = document.createElement('canvas');
    c.width = W; c.height = W;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = season === 'winter' ? '#d4d6d2' : '#6f7a45';
    ctx.fillRect(0, 0, W, W);
    const rad = (facing8 * Math.PI) / 4;
    const pxPerM = 10 * scale;
    const at = (m: { x: number; y: number }) => {
      const r = { x: m.x * Math.cos(rad) - m.y * Math.sin(rad), y: m.x * Math.sin(rad) + m.y * Math.cos(rad) };
      return { x: W / 2 + r.x * pxPerM, y: W / 2 + r.y * pxPerM };
    };
    const blit = (sp: HTMLCanvasElement, p: { x: number; y: number }) => ctx.drawImage(sp, Math.round(p.x - sp.width / 2), Math.round(p.y - sp.height / 2));
    const f8 = facing8 as Facing8;
    const cls = clsOf(weaponId);
    if (!cls) {
      // PTRD: rifle on its bipod, gunner prone behind it
      blit(getWeaponSprite(weaponId, 'ready', rad, side, season, scale), at({ x: 0, y: -0.6 }));
      blit(getCrewPoseSprite(side, season, 'mgProne', f8, 0, 'friendly', scale), at({ x: 0.35, y: 0.7 }));
      return c;
    }
    const L = CREW_LAYOUT[cls];
    if (packed) {
      if (cls === 'atgun') {
        const tow = weaponTowLengthM(weaponId);
        blit(getWeaponSprite(weaponId, 'packed', rad + Math.PI, side, season, scale), at({ x: 0, y: tow + 0.2 - tow / 2 }));
        blit(getCrewPoseSprite(side, season, 'haul', f8, 0, 'friendly', scale), at({ x: -0.55, y: -tow / 2 }));
        blit(getCrewPoseSprite(side, season, 'haul', f8, 1, 'friendly', scale), at({ x: 0.6, y: -tow / 2 + 0.3 }));
      } else {
        const a = cls === 'mortar' ? 'carryTube' : 'carryMg';
        const b = cls === 'mortar' ? 'carryPlate' : 'carryTripod';
        blit(getCrewPoseSprite(side, season, a, f8, 0, 'friendly', scale), at({ x: -0.9, y: -0.6 }));
        blit(getCrewPoseSprite(side, season, b, f8, 1, 'friendly', scale), at({ x: 0.9, y: 0.9 }));
      }
      return c;
    }
    blit(getWeaponSprite(weaponId, 'ready', rad, side, season, scale), at({ x: 0, y: 0 }));
    const gunnerPose = cls === 'hmg' ? 'mgProne' : 'gunnerKneel';
    const loaderPose = cls === 'mortar' ? 'loaderRound' : cls === 'atgun' ? 'loaderShell' : 'gunnerKneel';
    blit(getCrewPoseSprite(side, season, gunnerPose, f8, 0, 'friendly', scale), at(L.gunner));
    blit(getCrewPoseSprite(side, season, loaderPose, f8, fire ? 1 : 0, 'friendly', scale), at(L.loader));
    blit(getSoldierSprite(side, season, 'crouching', f8, 0, 'friendly', scale), at(L.assistant));
    return c;
  };
  const addCanvas = (row: HTMLElement, label: string, cv: HTMLCanvasElement, zoom = 1) => cell(row, label, cv, zoom);
  for (const [weaponId, side] of CREW_WEAPONS) {
    const row1 = section(`Crew-served weapon — ${weaponId} (${side}) — 1x (zoom 1), 8 facings: set up / packed`);
    for (let f = 0; f < 8; f++) addCanvas(row1, `f${f} set up`, scene(weaponId, side, 'summer', f, false, 1), 2);
    for (let f = 0; f < 8; f += 2) addCanvas(row1, `f${f} packed`, scene(weaponId, side, 'summer', f, true, 1), 2);
    const row2 = section(`Crew-served weapon — ${weaponId} (${side}) — 2x (zoom 2), 8 facings: set up / packed`);
    for (let f = 0; f < 8; f++) addCanvas(row2, `f${f} set up`, scene(weaponId, side, 'summer', f, false, 2), 1);
    for (let f = 0; f < 8; f += 2) addCanvas(row2, `f${f} packed`, scene(weaponId, side, 'summer', f, true, 2), 1);
    addCanvas(row2, 'winter f1', scene(weaponId, side, 'winter', 1, false, 2), 1);
  }
  const vRow = section('Crew-served weapons — sprite variants (ready / half / packed) at 2x, weapon only, x2 magnified');
  for (const [weaponId, side] of CREW_WEAPONS) {
    for (const v of ['ready', 'half', 'packed'] as const) cell(vRow, `${weaponId} ${v}`, getWeaponSprite(weaponId, v, Math.PI / 4, side, 'summer', 2), 2);
  }
  const pRow = section('Crew poses (german summer, facing 0, 1x | 2x x2)');
  for (const pose of CREW_POSES) {
    for (const fr of [0, 1] as const) {
      zoomCompareCell(pRow, `${pose} fr${fr}`, getCrewPoseSprite('german', 'summer', pose, 0, fr, 'friendly', 1), getCrewPoseSprite('german', 'summer', pose, 0, fr, 'friendly', 2), '#6f7a45');
    }
  }
}

// ------------------------------------------------------ wf5: zoom 2 (2x) --
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

const Z2_STANCES: (Stance | 'dead')[] = ['standing', 'crouching', 'prone', 'dead'];
for (const season of ['summer', 'winter'] as Season[]) {
  const bg = season === 'winter' ? '#d4d6d2' : '#6f7a45';
  for (const side of SIDES) {
    const row = section(`2x (zoom 2) soldiers — ${side} / ${season} — friendly (rim) then enemy`);
    for (const outline of ['friendly', 'enemy'] as const) {
      for (const stance of Z2_STANCES) {
        if (stance === 'dead' && outline === 'friendly') continue;
        for (const facing of [0, 1, 2] as Facing8[]) {
          zoomCompareCell(row, `${outline[0]} ${stance} f${facing}`,
            getSoldierSprite(side, season, stance, facing, 0, outline, 1),
            getSoldierSprite(side, season, stance, facing, 0, outline, 2), bg);
        }
      }
    }
  }
}

/** Side-by-side readability line-up at true in-game zoom-2 size. */
const lineupRow = section('2x line-up at true zoom-2 size: German friendly / German enemy / Soviet friendly / Soviet enemy');
for (const season of ['summer', 'winter'] as Season[]) {
  const bg = season === 'winter' ? '#d4d6d2' : '#6f7a45';
  const c = document.createElement('canvas');
  c.width = 4 * 8 * 30; c.height = 70;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height);
  let x = 0;
  for (const [side, outline] of [['german', 'friendly'], ['german', 'enemy'], ['soviet', 'friendly'], ['soviet', 'enemy']] as [Side, 'friendly' | 'enemy'][]) {
    for (let f = 0; f < 8; f++) {
      const sp = getSoldierSprite(side, season, f % 3 === 2 ? 'crouching' : 'standing', f as Facing8, (f % 2) as 0 | 1, outline, 2);
      ctx.drawImage(sp, x - sp.width / 2 + 15, 35 - sp.height / 2);
      x += 30;
    }
  }
  cell(lineupRow, season, c, 1);
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

// ------------------------------------------------------ wf5: 2x vehicles --
function composeVehicleAt(id: string, state: 'ok' | 'knockedOut', scale: number): HTMLCanvasElement {
  return composeVehicle(getVehicleSprite(id, 'hull', state, scale), getVehicleSprite(id, 'turret', state, scale));
}
const veh2Row = section('2x (zoom 2) vehicles — composed hull+turret (old 1x@2 | 2x | 2x@3)');
for (const id of VEHICLE_IDS) zoomCompareCell(veh2Row, id, composeVehicleAt(id, 'ok', 1), composeVehicleAt(id, 'ok', 2), '#6f7a45');
const veh2KoRow = section('2x (zoom 2) vehicles — knocked out / burning');
for (const id of VEHICLE_IDS) zoomCompareCell(veh2KoRow, `${id} KO`, composeVehicleAt(id, 'knockedOut', 1), composeVehicleAt(id, 'knockedOut', 2), '#6f7a45');

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
