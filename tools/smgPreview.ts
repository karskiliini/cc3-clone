import type { BattleState, Camera, GameSettings, Season, Soldier, Team, Tracer } from '@/shared/types';
import { FLASH_LIFE, TRACER_LIFE } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { WEAPONS } from '@/data/weapons';
import { stepCombat } from '@/sim/combat';
import { createMind } from '@/sim/mind';
import { drawUnits } from '@/render/unitRender';
import { drawEffects } from '@/render/effects';
import { requestBattleAtlases, loadAtlas, smgAtlasName, soldierAtlasName } from '@/render/spriteAtlas';
import { worldToScreen } from '@/engine/camera';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('scene'), ctx = canvas.getContext('2d')!;
const weapon = $<HTMLSelectElement>('weapon'), season = $<HTMLSelectElement>('season');
const names = ['Aimed burst', 'Hip burst', 'Prone aimed', 'Uncontrolled hip', 'Uncontrolled prone'];
const camera: Camera = { x: 0, y: 0, zoom: 2 };
const settings: GameSettings = { volume: 0, unitLabels: false, losLines: false, speed: 1 };
let state: BattleState, rng = new Rng(7), paused = false, accumulator = 0, history: Tracer[] = [];
async function reset(): Promise<void> {
  rng = new Rng(7); accumulator = 0; history = [];
  const side = weapon.value === 'mp40' ? 'german' : 'soviet', w = 48, h = 36;
  const def = { id: 'smg-demo', season: season.value as Season, width: w, height: h, victoryLocations: [] };
  state = {
    config: { playerSide: side, year: 1943, difficulty: 'normal', forces: { german: [], soviet: [] }, seed: 7, durationS: 1200, mapId: def.id },
    map: { def, width: w, height: h, tiles: Array(w * h).fill('open'), buildingId: new Int16Array(w * h).fill(-1), windows: new Uint8Array(w * h), smoke: new Float32Array(w * h), victoryLocations: [], craters: [] },
    phase: 'running', time: 0, soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: { german: { morale: 100 }, soviet: { morale: 100 } },
    spotted: { german: new Set(), soviet: new Set() }, spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], projectiles: [], sparks: [], pendingBursts: [], structureFx: [], events: [], nextId: 100,
  } as unknown as BattleState;
  for (let i = 0; i < names.length; i++) {
    const s: Soldier = {
      id: i + 1, teamId: i + 1, side, name: names[i], rank: 'Pvt', weaponId: weapon.value, ammo: WEAPONS[weapon.value].ammo, ammoReserve: 0, grenades: 0,
      health: 'healthy', morale: i > 2 ? 25 : 80, fatigue: 0, suppression: 0, experience: i > 2 ? 20 : 65,
      stance: i === 2 || i === 4 ? 'prone' : 'standing', activity: 'idle', pos: { x: 5.5, y: 1.9 + i * 2.85 }, facing: 1,
      targetSoldierId: null, targetVehicleId: null, targetPoint: null, path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0,
      isLeader: true, vehicleId: null, formationOffset: { x: 0, y: 0 }, lastFiredAt: -999, cover: 0, kills: 0, mind: createMind(60),
    };
    if (i > 2) { s.mind.state = 'shaken'; s.mind.stress = 95; s.mind.fear = 85; }
    const team: Team = { id: s.teamId, defId: 'demo', side, name: names[i], type: 'smg', soldierIds: [s.id], leaderId: s.id, vehicleId: null,
      order: { type: 'fire', target: { x: 21, y: s.pos.y }, issuedAt: 0 }, facing: 2, experience: s.experience, morale: s.morale,
      pos: { ...s.pos }, status: 'Idle', outOfAction: false, kills: 0, aiObjective: null };
    state.soldiers.set(s.id, s); state.teams.set(team.id, team);
  }
  await requestBattleAtlases([side], season.value as Season);
  await Promise.all([loadAtlas(smgAtlasName(side, season.value as Season, 2)), loadAtlas(soldierAtlasName(side, season.value as Season, 2))]);
  const seek = Number(new URLSearchParams(location.search).get('time') ?? 0);
  if (seek > 0) { for (let t = 0; t < Math.min(seek, 20); t += 0.1) step(); paused = true; $('pause').textContent = 'Resume'; }
}
function step(): void {
  state.time = Math.round((state.time + 0.1) * 1000) / 1000;
  for (const s of state.soldiers.values()) if (s.aiming) {
    s.aiming.fireMode = s.id === 2 || s.id === 4 ? 'hip' : 'aimed'; s.aiming.uncontrolled = s.id >= 4;
  }
  const first = state.tracers.length;
  stepCombat(state, rng, 0.1);
  history.push(...state.tracers.slice(first).map(t => ({ ...t })));
  if (history.length > 300) history.splice(0, history.length - 300);
  state.tracers = state.tracers.filter(t => (t.t += 0.1) < TRACER_LIFE);
  state.flashes = state.flashes.filter(f => (f.t += 0.1) < FLASH_LIFE);
  state.explosions = state.explosions.filter(e => (e.t += 0.1) < 0.3);
  state.sparks = state.sparks.filter(s => state.time - s.t < 0.8); state.events = [];
}
function draw(): void {
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = season.value === 'winter' ? '#c2c8cb' : '#6e7643'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '12px monospace';
  for (let i = 0; i < names.length; i++) {
    ctx.fillStyle = '#172218'; ctx.fillText(names[i], 12, 62 + i * 114);
    ctx.strokeStyle = '#909776'; ctx.beginPath(); ctx.moveTo(195, 104 + i * 114); ctx.lineTo(920, 104 + i * 114); ctx.stroke();
  }
  if ($<HTMLInputElement>('paths').checked) {
    ctx.save(); ctx.globalAlpha = 0.12; ctx.strokeStyle = '#ffe8a0'; ctx.lineWidth = 1;
    for (const ray of history) { const a = worldToScreen(camera, ray.from), b = worldToScreen(camera, ray.to); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    ctx.restore();
  }
  drawUnits(ctx, camera, state, state.config.playerSide, [], settings); drawEffects(ctx, camera, state);
  $('time').textContent = `${state.time.toFixed(1)} s`;
  $('status').textContent = [...state.soldiers.values()].map(s => `${s.name}: ${s.ammo} rounds, ${s.aiming ? 'aiming' : s.smgBurst ? 'firing / recovering' : s.ammo ? 'ready' : 'empty'}`).join(' · ');
}
$('reset').onclick = () => { void reset(); };
$('pause').onclick = () => { paused = !paused; $('pause').textContent = paused ? 'Resume' : 'Pause'; };
$('step').onclick = () => { paused = true; $('pause').textContent = 'Resume'; step(); draw(); };
weapon.onchange = season.onchange = () => { void reset(); };
let last = performance.now();
function frame(now: number): void {
  if (!paused) accumulator += Math.min(0.1, (now - last) / 1000);
  last = now;
  while (accumulator >= 0.1) { accumulator -= 0.1; step(); }
  draw(); requestAnimationFrame(frame);
}
await reset(); requestAnimationFrame(frame);
