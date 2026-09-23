// Dev-only test bench for the combat effects: every effect at several ages side by side, drawn
// by the SAME drawEffects the battle uses, over plain summer grass (?bg=snow: winter, which also
// picks the winter flipbooks). Deterministic: one synchronous draw at a fixed battle time, each
// record back-dated to the age shown, so a screenshot always catches every stage.
// ?anim=1 plays it instead (the clock runs; records re-fire every 3 s).
import type { BattleState, Camera, Explosion, Vehicle } from '@/shared/types';
import { FLASH_LIFE, TRACER_LIFE } from '@/shared/types';
import { drawEffects } from '@/render/effects';
import { requestFxAtlases } from '@/render/fxSprites';
import { drawVehicleSprite } from '@/render/unitRender';
import { loadAtlas, vehicleDefAtlasName } from '@/render/spriteAtlas';
import { igniteTree } from '@/sim/trees';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const legend = document.getElementById('legend')!;
const params = new URLSearchParams(location.search);
const winter = params.get('bg') === 'snow';
const animate = params.get('anim') === '1';

const TILE_PX = 20;
const cam: Camera = { x: 0, y: 0, zoom: 1 };
const W = canvas.width, H = canvas.height;
const w = (px: number, py: number) => ({ x: px / TILE_PX, y: py / TILE_PX });

interface Row { name: string; y: number; ages: number[]; xs?: number[]; put: (s: BattleState, cx: number, cy: number, age: number) => void }

const AGES6 = [0.04, 0.12, 0.25, 0.5, 1.0, 1.8];
const XS6 = [150, 290, 430, 570, 720, 880];
const boom = (weaponId: string, radiusM: number, kind: Explosion['kind'] = 'he') =>
  (s: BattleState, cx: number, cy: number, age: number) => { s.explosions.push({ pos: w(cx, cy), radiusM, t: age, kind, weaponId }); };

let vehId = 1;
function vehicle(pos: { x: number; y: number }, state: Vehicle['state'], fireAge: number | null, time: number): Vehicle {
  return {
    id: vehId++, teamId: 1, side: 'german', defId: 'pz4gh', pos, hullFacing: 0, turretFacing: 0, state,
    mainAmmo: 0, coaxAmmo: 0, path: [], speed: 0, targetVehicleId: null, targetSoldierId: null, targetPoint: null,
    mainFireTimer: 0, coaxFireTimer: 0, burnTimer: Math.min(fireAge ?? 0, 30), hits: 1,
    fire: fireAge == null ? undefined : { t0: time - fireAge },
  } as Vehicle;
}

const rows: Row[] = [
  { name: 'HE shell 75mm', y: 70, ages: AGES6, put: boom('kwk40_75', 4) },
  { name: 'mortar 81mm', y: 175, ages: AGES6, put: boom('mortar81', 6) },
  { name: 'grenade', y: 265, ages: AGES6, put: boom('grenade', 4) },
  { name: 'ammo blast', y: 400, ages: [0.08, 0.3, 0.8, 1.8], xs: [170, 400, 630, 870], put: boom('ammo_explosion', 14) },
  { name: 'smoke round', y: 545, ages: [0.1, 0.5, 1.2, 2.4], xs: [170, 330, 490, 650], put: boom('mortar81', 3, 'smoke') },
  {
    name: '', y: 545, ages: [0.05, 0.15, 0.3], xs: [780, 850, 920],
    put: (s, cx, cy, age) => {
      s.explosions.push({ pos: w(cx, cy - 25), radiusM: 0, t: age, kind: 'small' });
      s.sparks.push({ pos: w(cx, cy + 15), t: s.time - age, kind: 'armor' });
      s.sparks.push({ pos: w(cx, cy + 50), t: s.time - age, kind: 'pen' });
    },
  },
  {
    name: 'burning tank', y: 690, ages: [2, 12, 45, 120, 190], xs: [150, 290, 430, 570, 710],
    put: (s, cx, cy, age) => { s.vehicles.set(vehId, vehicle(w(cx, cy), age < 30 ? 'burning' : 'knockedOut', age, s.time)); },
  },
  {
    name: '', y: 690, ages: [0], xs: [850],
    put: (s, cx, cy) => {
      s.vehicles.set(vehId, vehicle(w(cx, cy), 'knockedOut', null, s.time));
      const tx = Math.floor((cx + 110) / TILE_PX), ty = Math.floor(cy / TILE_PX);
      (s.map.tiles as string[])[ty * s.map.width + tx] = 'scatteredtrees';
      igniteTree(s, tx, ty);
    },
  },
  {
    name: 'rocket / lob', y: 800, ages: [0.25, 0.6], xs: [200, 480],
    put: (s, cx, cy, age) => {
      s.projectiles.push({ kind: 'atrocket', weaponId: 'panzerschreck', from: w(cx - 110, cy + 10), to: w(cx + 110, cy - 10), t0: s.time - age, flightS: 1, dirRad: 0, arcM: 0, hitKind: 'impact', preResolved: true });
      s.sparks.push({ pos: w(cx - 122, cy + 11), t: s.time - age, kind: 'backblast' });
    },
  },
  {
    name: '', y: 800, ages: [0.3, 0.55], xs: [700, 860],
    put: (s, cx, cy, age) => {
      s.projectiles.push({ kind: 'grenade', weaponId: 'grenade', from: w(cx - 60, cy + 10), to: w(cx + 60, cy - 10), t0: s.time - age, flightS: 1, dirRad: 0, arcM: 3, hitKind: 'impact' });
      s.flashes.push({ pos: w(cx - 60, cy + 30), facing: 0, t: age * 0.2 * FLASH_LIFE });
      s.flashes.push({ pos: w(cx - 20, cy + 30), facing: Math.PI / 2, t: 0.1 * FLASH_LIFE, kind: 'shell' });
      s.tracers.push({ from: w(cx - 70, cy + 45), to: w(cx + 70, cy + 40), t: 0.35 * TRACER_LIFE, hit: true, kind: 'mg' });
    },
  },
  {
    name: '', y: 800, ages: [0.6], xs: [985],
    put: (s, cx, cy, age) => { s.structureFx.push({ kind: 'breach', pos: w(cx, cy - 30), t0: s.time - age, stone: true, extentTiles: [] }); },
  },
];

function makeState(time: number): BattleState {
  const mw = Math.ceil(W / TILE_PX), mh = Math.ceil(H / TILE_PX);
  return {
    flashes: [], tracers: [], explosions: [], projectiles: [], sparks: [], structureFx: [],
    vehicles: new Map<number, Vehicle>(), soldiers: new Map(),
    map: { width: mw, height: mh, tiles: new Array(mw * mh).fill('open'), def: { season: winter ? 'winter' : 'summer' } },
    config: { playerSide: 'german' }, spotted: { german: new Set(), soviet: new Set() }, spottedVehicles: { german: new Set(), soviet: new Set() },
    time,
  } as unknown as BattleState;
}

function label(px: number, py: number, text: string, color = '#f0f0ec'): void {
  ctx.font = '10px monospace';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(px - 2, py - 11, ctx.measureText(text).width + 4, 12);
  ctx.fillStyle = color;
  ctx.fillText(text, px, py - 2);
}

// drawEffects clips to the 1024x630 battle view, so the rows below y = SPLIT are a second state
// drawn through a camera shifted up by SHIFT px and a canvas translated back down.
const SPLIT = 600, SHIFT = 400;
function draw(top: BattleState, bottom: BattleState): void {
  ctx.fillStyle = winter ? '#dfe2e0' : '#5f7a3e';
  ctx.fillRect(0, 0, W, H);
  for (const v of bottom.vehicles.values()) {
    drawVehicleSprite(ctx, 'pz4gh', 'knockedOut', v.pos.x * TILE_PX, v.pos.y * TILE_PX, 0, 0, 1);
  }
  drawEffects(ctx, cam, top);
  ctx.save();
  ctx.translate(0, SHIFT);
  drawEffects(ctx, { x: 0, y: SHIFT / TILE_PX, zoom: 1 }, bottom);
  ctx.restore();
  for (const r of rows) {
    if (r.name) label(4, r.y - 42, r.name, '#ffe08a');
    const xs = r.xs ?? XS6;
    if (!animate) r.ages.forEach((a, i) => label(xs[i] - 14, r.y - 42, `${a}s`));
  }
}

function build(time: number, age: (i: number, a: number) => number, lower: boolean): BattleState {
  vehId = 1;
  const s = makeState(time);
  for (const r of rows) {
    if ((r.y >= SPLIT) !== lower) continue;
    const xs = r.xs ?? XS6;
    r.ages.forEach((a, i) => r.put(s, xs[i], r.y, age(i, a)));
  }
  return s;
}

async function main(): Promise<void> {
  await Promise.all([requestFxAtlases(), loadAtlas(vehicleDefAtlasName('pz4gh', 1))]);
  legend.textContent = 'Rows: 75 mm shell, 81 mm mortar, grenade, ammunition blast, smoke round + impacts (dust / armour ding / penetration), burning tank at 2/12 s, then out at 30 s and smouldering at 45/120/190 s + knocked-out wisp + burning tree, rocket with backblast, grenade lob + flashes + MG tracer, wall breach dust. ?bg=snow = winter, ?anim=1 = play.';
  if (!animate) { draw(build(100, (_i, a) => a, false), build(100, (_i, a) => a, true)); return; }
  const start = performance.now();
  const frame = (): void => {
    const t = 100 + (performance.now() - start) / 1000;
    const age = (i: number, a: number): number => (a >= 2 ? a + (t - 100) : ((t - 100) + i * 0.37) % 3);
    draw(build(t, age, false), build(t, age, true));
    requestAnimationFrame(frame);
  };
  frame();
}

void main();
