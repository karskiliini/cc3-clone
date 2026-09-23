import type { BattleState, Camera, GameSettings, MapDef, Soldier, Team, Vec2 } from '@/shared/types';
import { FLASH_LIFE, TRACER_LIFE } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { worldToScreen, screenToWorld } from '@/engine/camera';
import { createMind } from '@/sim/mind';
import { applyOrder } from '@/sim/orders';
import { stepMovement } from '@/sim/movement';
import { stepCombat } from '@/sim/combat';
import { crewWeaponStatus, stepCrewWeapons } from '@/sim/crewWeapon';
import { drawUnits } from '@/render/unitRender';
import { drawEffects } from '@/render/effects';
import { loadAtlas, requestBattleAtlases, soldierAtlasName, weaponAtlasName } from '@/render/spriteAtlas';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('scene'), ctx = canvas.getContext('2d')!;
const weapon = $<HTMLSelectElement>('weapon'), crewCount = $<HTMLSelectElement>('crew');
const camera: Camera = { x: 0, y: 0, zoom: 2 };
const settings: GameSettings = { unitLabels: false, losLines: false, volume: 0, speed: 1 };
let state: BattleState, team: Team, rng = new Rng(7), paused = false, accumulator = 0, loading = true, resetVersion = 0;
let destination: Vec2 = { x: 14, y: 7 };

function freshState(): BattleState {
  const width = 40, height = 28;
  const def: MapDef = { id: 'mg-mount-demo', name: 'MG mount drill', description: '', width, height, season: 'summer',
    paint() {}, victoryLocations: [], attacker: 'german', deployZones: {
      german: { x: 0, y: 0, w: 10, h: 20 }, soviet: { x: 30, y: 0, w: 10, h: 20 },
    } };
  const side = weapon.value === 'maxim' ? 'soviet' : 'german';
  const army = (side: Team['side']) => ({ side, morale: 100, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 });
  return { config: { mapId: def.id, playerSide: side, year: 1943, seed: 7, durationS: 1200,
    difficulty: 'normal', forces: { german: [], soviet: [] } },
    map: { def, width, height, tiles: Array(width * height).fill('open'), buildingId: new Int16Array(width * height).fill(-1),
      windows: new Uint8Array(width * height), smoke: new Float32Array(width * height), victoryLocations: [], craters: [] },
    phase: 'running', time: 0, soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: { german: army('german'), soviet: army('soviet') }, spotted: { german: new Set(), soviet: new Set() },
    spottedVehicles: { german: new Set(), soviet: new Set() }, messages: [], explosions: [], tracers: [], flashes: [],
    bloodDecals: [], projectiles: [], sparks: [], pendingBursts: [], structureFx: [], events: [], result: null, nextId: 100 };
}

async function reset(): Promise<void> {
  const version = ++resetVersion;
  loading = true; rng = new Rng(7); accumulator = 0; destination = { x: 14, y: 7 };
  state = freshState();
  const side = state.config.playerSide;
  const ids = Array.from({ length: Number(crewCount.value) }, (_, i) => i + 1);
  for (const [i, id] of ids.entries()) {
    const s: Soldier = { id, teamId: 1, side, name: i === 0 ? 'Gunner' : i === 1 ? 'Assistant' : 'Replacement', rank: 'Pvt',
      weaponId: i === 0 ? weapon.value : side === 'german' ? 'kar98k' : 'mosin', ammo: i === 0 ? 200 : 5, ammoReserve: 300, grenades: 0,
      health: 'healthy', morale: 100, fatigue: 0, suppression: 0, experience: 80, stance: 'crouching', activity: 'idle',
      pos: { x: 6 + i * 0.65, y: 7.8 + i * 0.8 }, facing: 2, targetSoldierId: null, targetVehicleId: null, targetPoint: null,
      path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0, isLeader: i === 0, vehicleId: null,
      formationOffset: { x: i * 0.8, y: i * 0.8 }, lastFiredAt: -999, cover: 0, kills: 0, mind: createMind(100) };
    s.mind.trait = 'brave'; state.soldiers.set(id, s);
  }
  team = { id: 1, defId: 'mg-mount-demo', side, name: 'Machine-gun crew', type: 'mg', soldierIds: ids, leaderId: 1, vehicleId: null,
    order: null, facing: 2, experience: 80, morale: 100, status: 'Idle', pos: { x: 6, y: 7.8 }, outOfAction: false, kills: 0, aiObjective: null,
    crewWeapon: { weaponId: weapon.value, pos: { x: 7, y: 7.8 }, facing: Math.PI / 2, phase: 'ready', timer: 0, phaseTotal: 0,
      gunnerId: 1, abandoned: false, abandonedAt: 0, setAt: 0 } };
  state.teams.set(team.id, team); stepCrewWeapons(state, 0.1);
  draw();
  await requestBattleAtlases([side], 'summer');
  await Promise.all([loadAtlas(soldierAtlasName(side, 'summer', 2)), loadAtlas(weaponAtlasName(2))]);
  if (version === resetVersion) { loading = false; draw(); }
}

function gunner(): Soldier { return state.soldiers.get(team.crewWeapon!.gunnerId)!; }
function assistant(): Soldier | undefined {
  const mount = team.crewWeapon!.mount;
  if (mount?.carrierId != null) return state.soldiers.get(mount.carrierId);
  return team.soldierIds.map(id => state.soldiers.get(id)!).find(s => s.id !== gunner().id && s.health === 'healthy');
}
function order(type: 'move' | 'defend' | 'fire', at: Vec2): void {
  applyOrder(state, team, { type, target: { ...at }, issuedAt: state.time }, new Rng(7));
  if (type === 'move') destination = { ...at };
  draw();
}
function step(): void {
  state.time = Math.round((state.time + 0.1) * 1000) / 1000;
  state.tracers = state.tracers.filter(t => (t.t += 0.1) < TRACER_LIFE);
  state.flashes = state.flashes.filter(f => (f.t += 0.1) < FLASH_LIFE);
  state.explosions = state.explosions.filter(e => (e.t += 0.1) < 0.3);
  state.sparks = state.sparks.filter(s => state.time - s.t < 0.8); state.events = [];
  stepMovement(state, rng, 0.1); stepCombat(state, rng, 0.1);
  team.pos = { ...gunner().pos };
}

function draw(): void {
  if (!state) return;
  ctx.imageSmoothingEnabled = false; ctx.fillStyle = '#727b4c'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#818a5c'; ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 80) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
  for (let y = 0; y < canvas.height; y += 80) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
  const target = worldToScreen(camera, destination);
  ctx.strokeStyle = '#d9dfaa'; ctx.beginPath(); ctx.arc(target.x, target.y, 12, 0, Math.PI * 2); ctx.stroke();
  ctx.font = '12px monospace'; ctx.fillStyle = '#1b2618'; ctx.fillText('Move destination', target.x - 58, target.y - 22);
  drawUnits(ctx, camera, state, state.config.playerSide, [], settings); drawEffects(ctx, camera, state);
  const cw = team.crewWeapon!, mount = cw.mount;
  for (const s of state.soldiers.values()) {
    const p = worldToScreen(camera, s.pos);
    const role = s.id === mount?.carrierId ? 'Mount carrier' : s.name;
    ctx.fillStyle = '#f0edd1'; ctx.fillText(`${role}${s.health === 'incapacitated' ? ' · down' : ''}`, p.x - 26, p.y - 28);
  }
  if (mount && mount.state !== 'carried' && (cw.lightMode || mount.state === 'ground')) {
    const p = worldToScreen(camera, mount.pos); ctx.fillStyle = '#fbefb3'; ctx.fillText('Mount left here', p.x - 40, p.y + 30);
  }
  $('time').textContent = `${state.time.toFixed(1)} s${loading ? ' · loading sprites' : ''}`;
  $('incapacitate').textContent = mount?.state === 'carried' ? 'Incapacitate carrier' : 'Incapacitate assistant';
  ($('incapacitate') as HTMLButtonElement).disabled = !assistant();
  const task = crewWeaponStatus(team) ?? cw.phase;
  $('status').textContent = `${cw.lightMode ? 'Light MG' : cw.mountBlocked ? 'Needs a mount carrier' : 'Mounted MG'} · ${task} · Mount: ${mount?.state ?? 'initializing'}${mount?.carrierId != null ? ` with soldier ${mount.carrierId}` : ''}${mount?.recovery ? ` · recovering: soldier ${mount.recovery.soldierId}` : ''} · Gunner: ${gunner().weaponId}, ${gunner().ammo} rounds`;
}

$('move').onclick = () => order('move', { x: gunner().pos.x > 10 ? 6 : 14, y: 7 });
$('stop').onclick = () => order('defend', { x: gunner().pos.x + 5, y: gunner().pos.y });
$('fire').onclick = () => order('fire', { x: Math.min(37, gunner().pos.x + 8), y: gunner().pos.y });
$('incapacitate').onclick = () => { const s = assistant(); if (s) { s.health = 'incapacitated'; s.activity = 'incapacitated'; s.stance = 'prone'; s.path = []; step(); draw(); } };
$('reset').onclick = () => { void reset(); };
$('pause').onclick = () => { paused = !paused; $('pause').textContent = paused ? 'Resume' : 'Pause'; };
$('step').onclick = () => { paused = true; $('pause').textContent = 'Resume'; step(); draw(); };
weapon.onchange = crewCount.onchange = () => { void reset(); };
canvas.onclick = event => { const r = canvas.getBoundingClientRect(); order('move', screenToWorld(camera, {
  x: (event.clientX - r.left) * canvas.width / r.width, y: (event.clientY - r.top) * canvas.height / r.height,
})); };
const params = new URLSearchParams(location.search);
if (['mg34_hmg', 'mg42_hmg', 'maxim'].includes(params.get('weapon') ?? '')) weapon.value = params.get('weapon')!;
if (params.get('crew') === '3') crewCount.value = '3';
let last = performance.now();
function frame(now: number): void {
  if (!paused && !loading) accumulator += Math.min(0.1, (now - last) / 1000) * Number($<HTMLSelectElement>('speed').value);
  last = now;
  while (accumulator >= 0.1) { accumulator -= 0.1; step(); }
  draw(); requestAnimationFrame(frame);
}
await reset(); requestAnimationFrame(frame);
