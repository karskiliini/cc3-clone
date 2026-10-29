// The test fixtures are plain BattleState constructors, shared here to keep this drill identical
// to its integration tests. No test runner or mocks are imported into the browser.
import { makeState, W } from '../test/kitHelpers';
import { addGun } from '../test/vehicleDamageHelpers';
import type { Camera, GameSettings, Terrain } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { stepMovement } from '@/sim/movement';
import { stepCombat } from '@/sim/combat';
import { drawUnits } from '@/render/unitRender';
import { drawEffects } from '@/render/effects';
import { loadAtlas, requestBattleAtlases, soldierAtlasName, weaponAtlasName } from '@/render/spriteAtlas';
import { worldToScreen } from '@/engine/camera';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('scene'), ctx = canvas.getContext('2d')!;
const camera: Camera = { x: 5, y: 5, zoom: 2 };
const settings: GameSettings = { unitLabels: false, losLines: false, volume: 0, speed: 1 };
let state = makeState(), crew: ReturnType<typeof addGun>, rng = new Rng(1), playing = false, accumulator = 0;
function reset() {
  state = makeState(); state.config.playerSide = 'german'; rng = new Rng(1); playing = false; accumulator = 0;
  for (let y = 5; y <= 22; y++) for (let x = 6; x <= 18; x++) {
    state.map.tiles[y * W + x] = x === 6 || x === 18 || y === 5 || y === 22 ? $<HTMLSelectElement>('wall').value as Terrain : 'floor';
    state.map.buildingId[y * W + x] = 1;
  }
  crew = addGun(state, 'pak40', { x: 12.5, y: 13.5 }, 3, { ammo: 20, ammoReserve: 20 });
  crew.team.facing = 2; crew.team.order = { type: 'fire', target: { x: 28.5, y: 13.5 }, issuedAt: state.time };
  for (const s of crew.men) s.grenades = 0;
  draw();
}
function step() {
  state.time += 0.1; stepMovement(state, rng, 0.1); stepCombat(state, rng, 0.1);
  state.projectiles = state.projectiles.filter(p => state.time < p.t0 + p.flightS + 0.1);
  state.tracers = state.tracers.filter(t => (t.t += 0.1) < 0.15);
  state.flashes = state.flashes.filter(f => (f.t += 0.1) < 0.12);
  state.explosions = state.explosions.filter(e => (e.t += 0.1) < 0.5);
  state.sparks = state.sparks.filter(s => state.time - s.t < 1);
  state.structureFx = state.structureFx.filter(f => state.time - f.t0 < 2);
}
function draw() {
  ctx.imageSmoothingEnabled = false; ctx.fillStyle = '#798051'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 5; y <= 22; y++) for (let x = 6; x <= 18; x++) {
    const t = state.map.tiles[y * W + x], p = worldToScreen(camera, { x, y });
    ctx.fillStyle = t === 'floor' ? '#77715a' : t === 'rubble' ? '#9a927d' : t === 'buildingWood' ? '#65513c' : '#b4ada0';
    ctx.fillRect(p.x, p.y, 40, 40); ctx.strokeStyle = '#5c5947'; ctx.strokeRect(p.x, p.y, 40, 40);
  }
  drawUnits(ctx, camera, state, 'german', [], settings); drawEffects(ctx, camera, state);
  ctx.font = '13px monospace'; ctx.fillStyle = '#f2e8ce';
  for (const s of crew.men) {
    const p = worldToScreen(camera, s.pos);
    ctx.fillText(s.health === 'incapacitated' ? 'Down' : s.crewTask?.id ?? (s.id === crew.gunner.id ? 'Gunner' : 'Crew'), p.x - 25, p.y - 24);
  }
  const cw = crew.team.crewWeapon!, d = cw.gunOpening;
  $('status').textContent = `${state.time.toFixed(1)} s · ${d ? `${d.stage} · wall work ${d.worked.toFixed(1)} s` : cw.preparedOpening ? 'Opening occupied — firing' : cw.phase}`;
  $('pause').textContent = playing ? 'Pause' : 'Play';
}
$('reset').onclick = reset; $('wall').onchange = reset;
$('pause').onclick = () => { playing = !playing; draw(); };
$('advance').onclick = () => { for (let i = 0; i < 100; i++) step(); draw(); };
$('casualty').onclick = () => { const id = crew.team.crewWeapon?.gunOpening?.workerId; const s = id != null ? state.soldiers.get(id) : undefined; if (s) s.health = 'incapacitated'; draw(); };
reset();
await requestBattleAtlases(['german'], 'summer');
await Promise.all([loadAtlas(soldierAtlasName('german', 'summer', 2)), loadAtlas(weaponAtlasName(2))]);
let previous = performance.now();
function frame(now: number) {
  if (playing) accumulator += Math.min(0.1, (now - previous) / 1000) * Number($<HTMLSelectElement>('speed').value);
  previous = now;
  while (accumulator >= 0.1) { step(); accumulator -= 0.1; }
  draw(); requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
