import { makeState } from '../test/kitHelpers';
import { addTank } from '../test/vehicleDamageHelpers';
import type { Camera, GameSettings } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { applyOrder } from '@/sim/orders';
import { stepVehicles } from '@/sim/vehicle';
import { stepGrowth } from '@/sim/growth';
import { vehicleGrowthRangeMul } from '@/sim/spotting';
import { TerrainRenderer } from '@/render/terrainRender';
import { GrassFx } from '@/render/grassFx';
import { drawUnits, vehiclesWithGrass3d } from '@/render/unitRender';
import { requestBattleAtlases } from '@/render/spriteAtlas';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('scene'), ctx = canvas.getContext('2d')!;
const camera: Camera = { x: 1, y: 12, zoom: 1.5 };
const settings: GameSettings = { unitLabels: false, losLines: false, volume: 0, speed: 1 };
let state = makeState(), rng = new Rng(4), terrain: TerrainRenderer, grass = new GrassFx(), playing = false, accumulator = 0;
function reset() {
  state = makeState(); state.time = 0; state.config.playerSide = 'german'; rng = new Rng(4); accumulator = 0; playing = false; grass = new GrassFx();
  state.map.tiles.fill('grass');
  for (let y = 9; y < 38; y++) for (let x = 18; x <= 29; x++) state.map.tiles[y * 40 + x] = 'tallgrass';
  for (let y = 22; y <= 26; y++) for (let x = 5; x <= 15; x++) state.map.tiles[y * 40 + x] = 'woods';
  for (const [x, id] of [[10.5, 'pz4gh'], [23.5, 't34_76']] as const) {
    const { v, team } = addTank(state, id, { x, y: 33.5 }, 0, 60, 'german');
    applyOrder(state, team, { type: 'moveFast', target: { x, y: 12.5 }, issuedAt: 0 }, rng);
    v.mainAmmo = 0;
  }
  terrain = new TerrainRenderer(state.map); draw();
}
function step() { state.time += 0.1; stepVehicles(state, rng, 0.1); stepGrowth(state); }
function draw() {
  terrain.draw(ctx, camera); terrain.drawOverlays(ctx, camera, state);
  grass.update(state, 'german'); grass.drawTrails(ctx, camera);
  drawUnits(ctx, camera, state, 'german', [], settings); grass.drawStanding(ctx, camera, state, 'german', vehiclesWithGrass3d());
  $('status').textContent = `${state.time.toFixed(1)} s · ${[...state.vehicles.values()].map(v => `${v.defId}: ${v.speed.toFixed(2)} m/s, grass screening ${Math.round((1 - vehicleGrowthRangeMul(state, v)) * 100)}%`).join(' · ')} · ${state.map.fallenTrees?.size ?? 0} trees felled`;
  $('pause').textContent = playing ? 'Pause' : 'Play';
}
$('reset').onclick = reset; $('pause').onclick = () => { playing = !playing; };
$('advance').onclick = () => { for (let i = 0; i < 10; i++) step(); draw(); };
reset(); await requestBattleAtlases(['german'], 'summer', undefined, ['pz4gh', 't34_76']);
let previous = performance.now();
function frame(now: number) {
  if (playing) accumulator += Math.min(0.1, (now - previous) / 1000) * Number($<HTMLSelectElement>('speed').value);
  previous = now; while (accumulator >= 0.1) { step(); accumulator -= 0.1; }
  draw(); requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
