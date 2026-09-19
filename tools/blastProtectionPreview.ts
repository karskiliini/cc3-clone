import type { BattleState, Camera, GameSettings, MapDef, Soldier, Terrain, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { dist } from '@/shared/math';
import { Rng } from '@/shared/rng';
import { createMind } from '@/sim/mind';
import { applyHESplash } from '@/sim/combat';
import { drawUnits } from '@/render/unitRender';
import { drawEffects } from '@/render/effects';
import { loadAtlas, requestBattleAtlases, soldierAtlasName } from '@/render/spriteAtlas';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('scene'), ctx = canvas.getContext('2d')!;
const camera: Camera = { x: 0, y: 0, zoom: 2 };
const settings: GameSettings = { unitLabels: false, losLines: false, volume: 0, speed: 1 };
const source = { x: 2, y: 2.4 }, origin = { x: 3.25, y: 2.4 };
const weapon: WeaponDef = { id: 'mortar81', name: '8cm', cls: 'mortar', rangeM: 1000, rate: 0.15, burst: 1,
  accuracy: 0.15, lethality: 0, suppression: 0.6, penetrationMm: 0, heRadiusM: 6, ammo: 1, reloadS: 8 };
const cases: { label: string; stance: Soldier['stance']; terrain: Terrain }[] = [
  { label: 'Standing · open', stance: 'standing', terrain: 'open' },
  { label: 'Crouching · open', stance: 'crouching', terrain: 'open' },
  { label: 'Prone · open', stance: 'prone', terrain: 'open' },
  { label: 'Prone · trench', stance: 'prone', terrain: 'trench' },
];
let scenes: BattleState[] = [], elapsed = 0, playing = false, fired = false;

function fresh(stance: Soldier['stance'], terrain: Terrain): BattleState {
  const width = 30, height = 8;
  const def: MapDef = { id: 'blast-demo', name: 'Blast comparison', description: '', width, height, season: 'summer',
    paint() {}, victoryLocations: [], attacker: 'german', deployZones: {
      german: { x: 0, y: 0, w: 2, h: 2 }, soviet: { x: 26, y: 0, w: 2, h: 2 },
    } };
  const army = (side: 'german' | 'soviet') => ({ side, morale: 100, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 });
  const s: Soldier = { id: 1, teamId: 1, side: 'german', name: 'Soldier', rank: 'Pvt', weaponId: 'kar98k', ammo: 5, ammoReserve: 0, grenades: 0,
    health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance, activity: 'idle', pos: { ...origin }, facing: 2,
    targetSoldierId: null, targetVehicleId: null, targetPoint: null, path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0,
    isLeader: false, vehicleId: null, formationOffset: { x: 0, y: 0 }, lastFiredAt: -999, cover: 0, kills: 0, mind: createMind(80) };
  const tiles: Terrain[] = Array(width * height).fill('open'); tiles[2 * width + 3] = terrain;
  return { config: { mapId: def.id, playerSide: 'german', year: 1943, seed: 7, durationS: 1200, difficulty: 'normal', forces: { german: [], soviet: [] } },
    map: { def, width, height, tiles, buildingId: new Int16Array(width * height).fill(-1), windows: new Uint8Array(width * height),
      smoke: new Float32Array(width * height), victoryLocations: [], craters: [] }, phase: 'running', time: 0,
    soldiers: new Map([[1, s]]), teams: new Map(), vehicles: new Map(), sides: { german: army('german'), soviet: army('soviet') },
    spotted: { german: new Set(), soviet: new Set() }, spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], projectiles: [], sparks: [], pendingBursts: [], structureFx: [], events: [], result: null, nextId: 100 };
}
function reset(): void { elapsed = 0; playing = false; fired = false; scenes = cases.map(c => fresh(c.stance, c.terrain)); draw(); }
function detonate(): void {
  reset(); fired = true;
  for (const state of scenes) applyHESplash(state, new Rng(7), source, weapon, 'soviet');
  elapsed = 0.25; draw();
}
function draw(): void {
  ctx.imageSmoothingEnabled = false;
  scenes.forEach((state, i) => {
    state.time = elapsed;
    for (const e of state.explosions) e.t = elapsed;
    ctx.save(); ctx.translate(0, i * 160); ctx.beginPath(); ctx.rect(0, 0, 900, 160); ctx.clip();
    ctx.fillStyle = i % 2 ? '#70794e' : '#778154'; ctx.fillRect(0, 0, 900, 160);
    ctx.fillStyle = '#eee9d2'; ctx.font = '15px monospace'; ctx.fillText(cases[i].label, 16, 24);
    ctx.save(); ctx.translate(230, 0);
    if (cases[i].terrain === 'trench') { ctx.fillStyle = '#433c27'; ctx.fillRect(120, 72, 40, 48); }
    ctx.strokeStyle = '#d8bb70'; ctx.beginPath(); ctx.arc(source.x * 40, source.y * 40, 6, 0, Math.PI * 2); ctx.stroke();
    drawUnits(ctx, camera, state, 'german', [], settings); drawEffects(ctx, camera, state); ctx.restore();
    const s = state.soldiers.get(1)!;
    const recovery = elapsed < (s.stunnedUntil ?? 0) ? 'Knocked down' : elapsed < (s.dazedUntil ?? 0) ? 'Dazed' : 'Able to act';
    ctx.fillStyle = '#eee9d2'; ctx.font = '12px monospace';
    ctx.fillText(`${recovery} · thrown ${(dist(s.pos, origin) * TILE_M).toFixed(1)} m · suppression ${Math.round(s.suppression)}`, 16, 146);
    ctx.restore();
  });
  $('clock').textContent = `${elapsed.toFixed(2)} s`;
  $('play').textContent = playing ? 'Pause' : 'Play';
}
$('reset').onclick = reset; $('burst').onclick = detonate;
$('play').onclick = () => { if (!fired) detonate(); playing = !playing; draw(); };
reset();
await requestBattleAtlases(['german'], 'summer');
await loadAtlas(soldierAtlasName('german', 'summer', 2));
$<HTMLButtonElement>('burst').disabled = false; $<HTMLButtonElement>('play').disabled = false;
let previous = performance.now();
function frame(now: number): void {
  if (playing) elapsed += Math.min(0.1, (now - previous) / 1000);
  previous = now; draw(); requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
