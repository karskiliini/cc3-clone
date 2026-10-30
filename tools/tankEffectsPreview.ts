import { makeState } from '../test/kitHelpers';
import { addTank } from '../test/vehicleDamageHelpers';
import type { Camera, GameSettings } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { detonateVehicle } from '@/sim/vehicleExplosion';
import { TerrainRenderer } from '@/render/terrainRender';
import { drawUnits } from '@/render/unitRender';
import { drawEffects } from '@/render/effects';
import { BlastFx } from '@/render/blastFx';
import { requestBattleAtlases } from '@/render/spriteAtlas';
import { requestFxAtlases } from '@/render/fxSprites';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('scene'), ctx = canvas.getContext('2d')!;
const camera: Camera = { x: 3, y: 11, zoom: 1.5 };
const settings: GameSettings = { unitLabels: false, losLines: false, volume: 0, speed: 1 };
let state = makeState(), source: ReturnType<typeof addTank>, target: ReturnType<typeof addTank>, terrain: TerrainRenderer, blast = new BlastFx();
let playing = false, detonated = false;
function reset() {
  state = makeState(); state.time = 0; state.map.tiles.fill('grass'); state.config.playerSide = 'german'; blast = new BlastFx(); detonated = false;
  source = addTank(state, 'pz4gh', { x: 8, y: 20 }, Math.PI / 2, 60, 'german');
  target = addTank(state, 't34_76', { x: 28, y: 20 }, -Math.PI / 2, 60, 'soviet');
  state.spottedVehicles.german.add(target.v.id); terrain = new TerrainRenderer(state.map);
}
function seek(time: number) {
  if (time < state.time) reset();
  if (time >= 0.35 && !detonated) {
    state.time = 0.35; detonateVehicle(state, new Rng(8), target.v, 'german');
    blast.onEvents(state.events, state.time); detonated = true;
  }
  state.time = time;
  source.v.lastMainShotAt = time >= 0.1 ? 0.1 : undefined;
  state.tracers = time >= 0.1 && time < 0.45 ? [{ from: { x: 9.8, y: 20 }, to: { ...target.v.pos }, kind: 'shell', t: time - 0.1, hit: true, fromHeightM: 1.5 }] : [];
  state.flashes = time >= 0.1 && time < 0.35 ? [{ pos: { x: 9.8, y: 20 }, facing: Math.PI / 2, t: time - 0.1, kind: 'shell' }] : [];
  for (const e of state.explosions) e.t = time - 0.35;
  if (detonated) target.v.burnTimer = Math.max(0, time - 0.35);
  $<HTMLInputElement>('time').value = time.toFixed(2);
  $('status').textContent = `${time.toFixed(2)} s`;
}
function draw() { terrain.draw(ctx, camera); terrain.drawOverlays(ctx, camera, state); drawUnits(ctx, camera, state, 'german', [], settings); drawEffects(ctx, camera, state); blast.draw(ctx, camera, state.time); }
$('reset').onclick = () => { playing = false; reset(); seek(0); draw(); };
$('play').onclick = () => { if (state.time >= 12) { reset(); seek(0); } playing = !playing; };
$('time').oninput = () => { playing = false; seek(Number($<HTMLInputElement>('time').value)); draw(); };
reset(); seek(0);
await Promise.all([requestBattleAtlases(['german', 'soviet'], 'summer', undefined, ['pz4gh', 't34_76']), requestFxAtlases()]);
let last = performance.now();
function frame(now: number) { if (playing) { seek(Math.min(12, state.time + Math.min(0.1, (now - last) / 1000))); if (state.time >= 12) playing = false; } last = now; $('play').textContent = playing ? 'Pause' : 'Play'; draw(); requestAnimationFrame(frame); }
requestAnimationFrame(frame);
