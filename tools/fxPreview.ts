// Dev-only preview page: renders every combat effect (flash/tracer/explosion/
// burning-vehicle/smoke) at 4 fixed life-stages side by side, using the exact
// same `drawEffects` the live battle uses, against a plain grass background.
// This sidesteps the rAF-throttled-background-tab problem that made it
// impossible to reliably screenshot short-lived effects live: everything
// here is drawn once, synchronously, at an exact chosen `t`.
import type { BattleState, Camera, Vehicle } from '@/shared/types';
import { FLASH_LIFE, TRACER_LIFE, EXPLOSION_LIFE_HE, EXPLOSION_LIFE_SMALL, EXPLOSION_LIFE_SMOKE } from '@/shared/types';
import { drawEffects } from '@/render/effects';
import { getVehicleSprite } from '@/render/sprites';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const legend = document.getElementById('legend')!;

const TILE_PX = 20;
const cam: Camera = { x: 0, y: 0, zoom: 1 };

// screen px -> world tile coords at zoom 1, cam origin (0,0)
function w(px: number, py: number) { return { x: px / TILE_PX, y: py / TILE_PX }; }

const STAGES = [0.05, 0.35, 0.65, 0.9]; // fraction of life: early / quarter / mid-late / near-end
const COLS = [150, 400, 650, 900];
const STAGE_LABELS = ['t≈5%', 't≈35%', 't≈65%', 't≈90%'];

function paintBackground(): void {
  // ?bg=snow previews effects against winter ground (plumes must read on snow)
  ctx.fillStyle = new URLSearchParams(location.search).get('bg') === 'snow' ? '#dfe2e0' : '#5f7a3e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // faint tile grid so positions are legible
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  for (let x = 0; x < canvas.width; x += TILE_PX * 5) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
}

function label(px: number, py: number, text: string): void {
  ctx.save();
  ctx.font = '10px monospace';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(px - 2, py - 12, ctx.measureText(text).width + 4, 12);
  ctx.fillStyle = '#f0f0ec';
  ctx.fillText(text, px, py - 2);
  ctx.restore();
}

function rowLabel(py: number, text: string): void {
  ctx.save();
  ctx.font = 'bold 11px monospace';
  ctx.fillStyle = '#ffe08a';
  ctx.fillText(text, 4, py + 4);
  ctx.restore();
}

// A hand-built minimal BattleState: only the fields drawEffects touches
// (flashes/tracers/explosions/vehicles) are populated; everything else is a
// harmless empty stand-in via `as unknown as BattleState`.
function makeState(): BattleState {
  return {
    flashes: [],
    tracers: [],
    explosions: [],
    vehicles: new Map<number, Vehicle>(),
    time: 12.3, // nonzero so knocked-out wisp phase isn't degenerate
  } as unknown as BattleState;
}

let vehId = 1;
function makeVehicle(pos: { x: number; y: number }, state: Vehicle['state'], burnTimer: number): Vehicle {
  return {
    id: vehId++, teamId: 1, side: 'german', defId: 'pz3j', pos,
    hullFacing: 0, turretFacing: 0, state, mainAmmo: 0, coaxAmmo: 0, path: [],
    speed: 0, targetVehicleId: null, targetSoldierId: null, targetPoint: null,
    mainFireTimer: 0, coaxFireTimer: 0, burnTimer, hits: 1,
  } as Vehicle;
}

function drawVehicleHull(pos: { x: number; y: number }): void {
  const sprite = getVehicleSprite('pz3j', 'hull', 'knockedOut');
  const sx = pos.x * TILE_PX, sy = pos.y * TILE_PX;
  ctx.drawImage(sprite, Math.round(sx - sprite.width / 2), Math.round(sy - sprite.height / 2));
}

function main(): void {
  paintBackground();
  const rows: { name: string; y: number; build: (state: BattleState, cx: number, cy: number, stage: number) => void }[] = [
    {
      name: 'Flash (infantry)',
      y: 60,
      build: (s, cx, cy, i) => { s.flashes.push({ pos: w(cx, cy), facing: 0, t: STAGES[i] * FLASH_LIFE }); },
    },
    {
      name: 'Flash (tank gun)',
      y: 130,
      build: (s, cx, cy, i) => { s.flashes.push({ pos: w(cx, cy), facing: Math.PI / 2, t: STAGES[i] * FLASH_LIFE, kind: 'shell' }); },
    },
    {
      name: 'Tracer: rifle (bullet)',
      y: 200,
      build: (s, cx, cy, i) => {
        s.tracers.push({ from: w(cx - 100, cy + 20), to: w(cx + 100, cy - 20), t: STAGES[i] * TRACER_LIFE, hit: true, kind: 'bullet' });
      },
    },
    {
      name: 'Tracer: MG',
      y: 260,
      build: (s, cx, cy, i) => {
        s.tracers.push({ from: w(cx - 100, cy + 20), to: w(cx + 100, cy - 20), t: STAGES[i] * TRACER_LIFE, hit: true, kind: 'mg' });
      },
    },
    {
      name: 'Tracer: tank shell',
      y: 320,
      build: (s, cx, cy, i) => {
        s.tracers.push({ from: w(cx - 110, cy + 10), to: w(cx + 110, cy - 10), t: STAGES[i] * TRACER_LIFE, hit: true, kind: 'shell' });
      },
    },
    {
      name: 'HE explosion',
      y: 385,
      build: (s, cx, cy, i) => { s.explosions.push({ pos: w(cx, cy), radiusM: 4, t: STAGES[i] * EXPLOSION_LIFE_HE, kind: 'he' }); },
    },
    {
      name: 'Small-arms impact (dust)',
      y: 440,
      build: (s, cx, cy, i) => { s.explosions.push({ pos: w(cx, cy), radiusM: 0, t: STAGES[i] * EXPLOSION_LIFE_SMALL, kind: 'small' }); },
    },
    {
      name: 'Smoke round',
      y: 500,
      build: (s, cx, cy, i) => { s.explosions.push({ pos: w(cx, cy), radiusM: 3, t: STAGES[i] * EXPLOSION_LIFE_SMOKE, kind: 'smoke' }); },
    },
    {
      name: 'Burning vehicle',
      y: 570,
      build: (s, cx, cy, i) => {
        drawVehicleHull(w(cx, cy));
        s.vehicles.set(vehId, makeVehicle(w(cx, cy), 'burning', 2 + STAGES[i] * 4));
      },
    },
  ];

  // Draw one shared state so drawEffects is called exactly once, then a
  // final knocked-out (not burning) vehicle + a crude representative crater
  // swatch off to the side as extra context (crater tile art itself belongs
  // to terrainRender.ts, owned separately — this is just a flat reference
  // patch, not a claim about the real crater decal).
  const state = makeState();
  for (const row of rows) {
    rowLabel(row.y, row.name);
    for (let i = 0; i < COLS.length; i++) {
      const cx = COLS[i], cy = row.y;
      row.build(state, cx, cy, i);
      label(cx - 20, cy - 22, STAGE_LABELS[i]);
    }
  }

  // extra: a knocked-out (non-burning) vehicle for comparison, far right margin
  const koPos = w(980, 570);
  drawVehicleHull(koPos);
  state.vehicles.set(vehId, makeVehicle(koPos, 'knockedOut', 0));

  drawEffects(ctx, cam, state);

  // crude reference crater swatch (NOT the real terrain crater sprite —
  // terrainRender.ts is owned by another agent and not touched here)
  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = '#6b5232';
  ctx.beginPath();
  ctx.ellipse(980, 500, 9, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#3d2e1a';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
  label(960, 480, 'crater (ref swatch)');
  label(940, 550, 'knocked-out (wisp)');

  legend.innerHTML =
    '<b>Rows</b>: flash, tank flash, rifle/MG/shell tracers, HE, small impact, smoke round, burning vehicle. ' +
    '<b>Columns</b>: 4 hand-set points along each effect\'s life (early/quarter/mid-late/near-end). ' +
    'Extra vehicle bottom-right is knocked-out (thin wisp, not burning).';
}

main();
