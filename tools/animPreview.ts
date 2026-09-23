// Dev-only: plays every entry of whatever sprite atlases exist (spec 2026-09-17 §5) as looping
// animations at 1x and 3x, both sides / seasons, with the pure frame selection of soldierAnim.ts,
// plus a ragdoll demo driven by the real sim knockback and the real ragdoll playback. With no
// atlas present it shows the code-drawn fallback poses instead. `window.__animStrip` /
// `window.__ragdollStrip` render deterministic frame strips for capture scripts.
import type { BattleState, Camera, Facing8, GameMap, MapDef, Season, Side, Soldier, Terrain, WeaponDef } from '@/shared/types';
import {
  drawAtlasFrame, getAtlas, loadAtlas, setAtlasBasePath, soldierAtlasName, vehicleAtlasName, weaponAtlasName, type Atlas,
} from '@/render/spriteAtlas';
import { frameFor, type AnimAction } from '@/render/soldierAnim';
import { drawRagdollFlight, drawRagdollLanded, ragdollBeginFrame, ragdollPhase } from '@/render/ragdoll';
import { drawEffects } from '@/render/effects';
import { applyBlastKnockback, stepCombat } from '@/sim/combat';
import { stepMovement } from '@/sim/movement';
import { createMind } from '@/sim/mind';
import { Rng } from '@/shared/rng';
import { drawUnits } from '@/render/unitRender';
import { stepCrewWeapons, crewWeaponStatus, crewTaskWord, isInAction, fireMissionWait, onMissionRound } from '@/sim/crewWeapon';
import type { GameSettings, Team } from '@/shared/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const root = $('root'), status = $('status');
const srcSel = $<HTMLSelectElement>('src'), sideSel = $<HTMLSelectElement>('side'), seasonSel = $<HTMLSelectElement>('season'), dirSel = $<HTMLSelectElement>('dir');
for (let d = 0; d < 16; d++) { const o = document.createElement('option'); o.value = String(d); o.textContent = `dir ${d}`; dirSel.appendChild(o); }

const GROUND: Record<'summer' | 'winter', string> = { summer: '#797a36', winter: '#d4d8da' };
const now = () => performance.now() / 1000;

function fakeSoldier(id: number, side: Side, o: Partial<Soldier> = {}): Soldier {
  return {
    id, teamId: 1, side, name: 'Preview', rank: 'Pvt', weaponId: side === 'german' ? 'kar98k' : 'mosin', ammo: 5, ammoReserve: 0, grenades: 0,
    health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance: 'standing', activity: 'idle', pos: { x: 0, y: 0 },
    facing: 0, targetSoldierId: null, targetVehicleId: null, targetPoint: null, path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0,
    isLeader: false, vehicleId: null, formationOffset: { x: 0, y: 0 }, lastFiredAt: -99, cover: 0, kills: 0, mind: createMind(50), ...o,
  };
}

/** Frame of `key` at clock `t`, through the same pure selection the battle uses. */
function frameAt(key: string, atlas: Atlas, t: number, id = 1): number {
  const entry = atlas.meta.entries[key];
  const action = (key.split('@')[0].split('.')[1] ?? 'idle') as AnimAction;
  const s = fakeSoldier(id, 'german');
  if (action === 'fire') s.lastFiredAt = Math.floor(t / 0.8) * 0.8;                 // fire every 0.8 s
  if (action === 'reload') { s.activity = 'reloading'; s.reloadTimer = 3 - (t % 3); }
  if (!entry.loop && action !== 'fire' && action !== 'reload') return Math.floor((t * Math.max(1, entry.fps)) % entry.frames);
  return frameFor(s, t, action, entry, undefined, 'calm');
}

interface Anim { canvas: HTMLCanvasElement; atlas: Atlas; key: string; zoom: number; bg: string }
const anims: Anim[] = [];

function section(title: string): HTMLElement {
  const h = document.createElement('h2'); h.textContent = title; root.appendChild(h);
  const row = document.createElement('div'); row.className = 'row'; root.appendChild(row);
  return row;
}

function addEntryCell(row: HTMLElement, atlas: Atlas, key: string, bg: string): void {
  const cell = document.createElement('div'); cell.className = 'cell';
  const k = 1 / atlas.meta.scale;
  for (const zoom of [1, 3]) {
    const c = document.createElement('canvas');
    c.width = atlas.meta.cell.w * k * zoom; c.height = atlas.meta.cell.h * k * zoom;
    c.style.display = 'inline-block'; c.style.margin = '0 2px 3px'; c.style.verticalAlign = 'bottom';
    cell.appendChild(c);
    anims.push({ canvas: c, atlas, key, zoom, bg });
  }
  const e = atlas.meta.entries[key];
  const span = document.createElement('span'); span.textContent = `${key} (${e.frames}f @${e.fps}${e.loop ? ' loop' : ''})`;
  cell.appendChild(span); row.appendChild(cell);
}

function drawAnim(a: Anim, t: number): void {
  const ctx = a.canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = a.bg; ctx.fillRect(0, 0, a.canvas.width, a.canvas.height);
  const fixed = Number(dirSel.value);
  const dirs = a.atlas.meta.dirs;
  const dir = fixed >= 0 ? Math.round((fixed / 16) * dirs) : Math.floor(t / (dirs > 16 ? 0.12 : 1.6)) % dirs;
  // draw at the atlas's native 1x size times the cell zoom
  const z = a.zoom;
  ctx.save();
  drawAtlasFrame(ctx, a.atlas, a.key, dir, frameAt(a.key, a.atlas, t), a.atlas.meta.anchor.x / a.atlas.meta.scale * z, a.atlas.meta.anchor.y / a.atlas.meta.scale * z, z);
  ctx.restore();
}


async function rebuild(): Promise<void> {
  anims.length = 0; root.innerHTML = '';
  setAtlasBasePath(srcSel.value);
  const side = sideSel.value as Side, season = seasonSel.value as Season;
  const bg = GROUND[season === 'winter' ? 'winter' : 'summer'];
  const names = [soldierAtlasName(side, season, 1), soldierAtlasName(side, season, 2), vehicleAtlasName(1), vehicleAtlasName(2), weaponAtlasName(1), weaponAtlasName(2)];
  status.textContent = 'loading…';
  const loaded = await Promise.all(names.map((n) => loadAtlas(n)));
  status.textContent = names.map((n, i) => `${n}: ${loaded[i] ? `${Object.keys(loaded[i]!.meta.entries).length} entries` : 'missing'}`).join(' | ');
  for (const atlas of loaded) {
    if (!atlas) continue;
    const row = section(`${atlas.name} — scale ${atlas.meta.scale}, ${atlas.meta.dirs} dirs, cell ${atlas.meta.cell.w}x${atlas.meta.cell.h} (1x | 3x)`);
    for (const key of Object.keys(atlas.meta.entries)) addEntryCell(row, atlas, key, bg);
  }
  if (!loaded[0]) section(`no soldier atlas at ${srcSel.value}: run npm run sprites:soldiers`);
}

// ------------------------------------------------------------------ ragdoll demo ---
const mortar: WeaponDef = { id: 'mortar81', name: '8cm', cls: 'mortar', rangeM: 1000, rate: 0.15, burst: 1, accuracy: 0.15, lethality: 0.6, suppression: 0.6, penetrationMm: 0, heRadiusM: 6, ammo: 3, reloadS: 8 };
function demoState(season: Season): BattleState {
  const W = 40, H = 12;
  const tiles: Terrain[] = new Array(W * H).fill('open');
  const def = { id: 'demo', name: 'demo', description: '', width: W, height: H, season, paint: () => {}, victoryLocations: [], deployZones: { german: { x: 0, y: 0, w: 2, h: 2 }, soviet: { x: 30, y: 0, w: 2, h: 2 } }, attacker: 'german' } as unknown as MapDef;
  const map = { def, width: W, height: H, tiles, buildingId: new Int16Array(W * H).fill(-1), windows: new Uint8Array(W * H), victoryLocations: [], smoke: new Float32Array(W * H), craters: [] } as unknown as GameMap;
  return {
    config: { mapId: 'demo', playerSide: 'german', year: 1943, seed: 1, durationS: 99, difficulty: 'normal', forces: { german: [], soviet: [] } },
    map, phase: 'running', time: 0, soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: { german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 }, soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 } },
    spotted: { german: new Set(), soviet: new Set() }, spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], result: null, events: [], nextId: 100,
    projectiles: [], sparks: [], pendingBursts: [], structureFx: [],
  } as BattleState;
}
let demo = demoState('summer');
let demoT0 = now();
const demoCam: Camera = { x: 0, y: 0, zoom: 2 };
function resetDemo(): void {
  demo = demoState(seasonSel.value as Season);
  demoT0 = now();
  for (let i = 0; i < 8; i++) {
    const s = fakeSoldier(200 + i, sideSel.value as Side, { pos: { x: 3.5 + i * 1.3, y: 3 + ((i * 7) % 3) * 0.6 }, facing: (i % 8) as Facing8 });
    demo.soldiers.set(s.id, s);
  }
}
function fireBlast(time: number): void {
  const rng = new Rng(Math.floor(time * 1000) + 3);
  const burst = { x: 8, y: 2.4 };
  demo.time = time;
  for (const s of demo.soldiers.values()) {
    if (s.health === 'dead') continue;
    const d = Math.hypot(s.pos.x - burst.x, s.pos.y - burst.y);
    if (d < 1.4) { s.health = 'dead'; s.activity = 'dead'; }
    applyBlastKnockback(demo, rng, s, burst, mortar);
  }
  demo.explosions.push({ pos: burst, radiusM: 6, t: 0, kind: 'he' });
}
function drawDemo(canvas: HTMLCanvasElement, time: number): void {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const season = demo.map.def.season;
  ctx.fillStyle = GROUND[season === 'winter' ? 'winter' : 'summer']; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const dt = Math.max(0, time - demo.time);
  demo.time = time;
  for (const e of demo.explosions) e.t += dt;
  demo.explosions = demo.explosions.filter((e) => e.t < 1.2);
  ragdollBeginFrame(time);
  const order = [...demo.soldiers.values()].sort((a, b) => Number(a.health !== 'dead') - Number(b.health !== 'dead'));
  for (const s of order) {
    const rp = ragdollPhase(s, time);
    if (rp.phase === 'flight' && rp.sample) { drawRagdollFlight(ctx, demoCam, s, rp.sample, season); continue; }
    if (rp.phase === 'landed' && drawRagdollLanded(ctx, demoCam, s, season)) continue;
    const atlas = getAtlas(soldierAtlasName(s.side, season, 2));
    const px = s.pos.x * 40, py = s.pos.y * 40;
    const key = s.health === 'dead' ? `corpse${s.id % 8}` : s.blast && time < (s.stunnedUntil ?? 0) + 0.4 ? 'kneeling.idle' : 'standing.idle';
    if (atlas) drawAtlasFrame(ctx, atlas, key, s.facing * 2, s.health === 'dead' ? 0 : frameAt('standing.idle', atlas, time, s.id), px, py, 2);
  }
  drawEffects(ctx, demoCam, demo);
}

// ------------------------------------------------------------------ crew drill demo (spec §6) ---
const drillWeaponSel = $<HTMLSelectElement>('drillWeapon'), drillCrewSel = $<HTMLSelectElement>('drillCrew');
const drillCam: Camera = { x: 0, y: 0, zoom: 2 };
const DRILL_SETTINGS = { volume: 0, unitLabels: false, losLines: false, speed: 1 } as GameSettings;
let drill = demoState('summer');
let drillTeam: Team | null = null;
let drillPhaseAt = 0;
function resetDrill(): void {
  drill = demoState(seasonSel.value as Season);
  const side = sideSel.value as Side;
  const weaponId = drillWeaponSel.value;
  const n = Number(drillCrewSel.value);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = fakeSoldier(300 + i, side, { teamId: 9, pos: { x: 6.2 + i * 0.8, y: 5.6 + (i % 2) * 0.5 }, weaponId: i === 0 ? weaponId : side === 'german' ? 'kar98k' : 'mosin', isLeader: n > 1 && i === n - 1, ammo: 20, stance: 'crouching' });
    drill.soldiers.set(s.id, s); ids.push(s.id);
  }
  drillTeam = {
    id: 9, defId: 'demo', side, name: 'Demo gun', type: 'atgun', soldierIds: ids, leaderId: ids[ids.length - 1], vehicleId: null, order: null,
    facing: 0, experience: 50, morale: 80, status: 'Idle', pos: { x: 8, y: 4 }, outOfAction: false, kills: 0, aiObjective: null,
    crewWeapon: { weaponId, pos: { x: 8, y: 3.6 }, facing: 0.5, phase: 'settingUp', timer: 0, phaseTotal: 0, gunnerId: ids[0], abandoned: false, abandonedAt: 0, setAt: 0 },
  };
  drill.teams.set(9, drillTeam);
  drillPhaseAt = 0;
}
/** One sim step of the demo: into action, a few rounds at a far point, pack up, repeat. */
function stepDrill(dt: number): void {
  const team = drillTeam; if (!team?.crewWeapon) return;
  const cw = team.crewWeapon;
  drill.time += dt;
  const gunner = drill.soldiers.get(cw.gunnerId)!;
  const t = drill.time - drillPhaseAt;
  if (cw.goal !== 'pack' && isInAction(cw) && t > 4) {
    // serve the gun: ask to fire like combat does, and fire when it is loaded and laid
    gunner.fireTimer = Math.max(0, gunner.fireTimer - dt);
    const aim = { x: 8 + Math.sin(drill.time / 9) * 30, y: -40 };
    if (gunner.fireTimer <= 0 && fireMissionWait(drill, team, gunner, { aim, targetTeamId: null }) === 0) {
      gunner.lastFiredAt = drill.time; gunner.fireTimer = 4;
      onMissionRound(drill, team, gunner);
    }
  }
  if (cw.goal !== 'pack' && isInAction(cw) && t > 26) {
    team.order = { type: 'move', target: { x: 30, y: 4 }, issuedAt: drill.time };
    for (const id of team.soldierIds) drill.soldiers.get(id)!.path = [{ x: 30, y: 4 }];
  }
  if (cw.phase === 'packed' && cw.goal === 'pack') {
    // packed: "arrive" on the spot and start over
    team.order = null;
    for (const id of team.soldierIds) drill.soldiers.get(id)!.path = [];
    drillPhaseAt = drill.time;
  }
  stepCrewWeapons(drill, dt);
}
function drawDrill(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = GROUND[drill.map.def.season === 'winter' ? 'winter' : 'summer']; ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!drillTeam) return;
  drawUnits(ctx, drillCam, drill, drillTeam.side, [], DRILL_SETTINGS);
  const words = drillTeam.soldierIds.map((id) => crewTaskWord(drill.soldiers.get(id)!) ?? '-').join(' | ');
  $('drillStatus').textContent = `${crewWeaponStatus(drillTeam) ?? (drillTeam.crewWeapon!.phase)}  —  ${words}`;
}
for (const sel of [drillWeaponSel, drillCrewSel]) sel.addEventListener('change', resetDrill);

// Real infantry simulation, separate from the atlas-entry loops below.
let pace = demoState('summer'), paceRng = new Rng(17), paceAccum = 0, pacePaused = false;
const paceLabels = ['Walk', 'Run', 'Crouch', 'Crawl', 'Acquire / aim / fire'];
const paceCam: Camera = { x: 0, y: 0, zoom: 1 };
function resetPace(): void {
  pace = demoState(seasonSel.value as Season); paceRng = new Rng(17); paceAccum = 0;
  for (let i = 0; i < paceLabels.length; i++) {
    const y = 1.5 + i * 2;
    const s = fakeSoldier(500 + i, sideSel.value as Side, {
      teamId: 500 + i, pos: { x: 9, y }, facing: 2, ammo: 50,
      weaponId: 'kar98k',
      stance: i === 2 ? 'crouching' : i === 3 ? 'prone' : 'standing',
      activity: i === 4 ? 'idle' : i === 1 ? 'movingFast' : i === 3 ? 'sneaking' : 'moving',
      path: i === 4 ? [] : [{ x: 37, y }],
    });
    pace.soldiers.set(s.id, s);
    pace.teams.set(s.teamId, {
      id: s.teamId, defId: 'demo', side: s.side, name: paceLabels[i], type: 'rifle', soldierIds: [s.id],
      leaderId: s.id, vehicleId: null, order: i === 4 ? { type: 'fire', target: { x: 34, y }, issuedAt: 0 } : null,
      facing: 2, experience: 50, morale: 80, status: 'Idle', pos: { ...s.pos }, outOfAction: false, kills: 0, aiObjective: null,
    });
  }
}
function drawPace(dt: number): void {
  if (!pacePaused) paceAccum += Math.min(0.1, dt);
  while (paceAccum >= 0.05) {
    paceAccum -= 0.05; pace.time += 0.05;
    stepMovement(pace, paceRng, 0.05); stepCombat(pace, paceRng, 0.05);
    pace.events.length = 0; pace.tracers.length = 0; pace.explosions.length = 0;
    pace.flashes = pace.flashes.filter((f) => (f.t += 0.05) < 0.12);
    if (pace.time > 24) resetPace();
  }
  const canvas = $<HTMLCanvasElement>('paceCanvas'), ctx = canvas.getContext('2d')!;
  ctx.fillStyle = GROUND[pace.map.def.season === 'winter' ? 'winter' : 'summer']; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#969761'; ctx.lineWidth = 1;
  for (let x = 180; x < 780; x += 100) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 220); ctx.stroke();
    ctx.fillStyle = '#e8e8e0'; ctx.fillText(`${(x - 180) / 10} m`, x + 3, 231);
  }
  drawUnits(ctx, paceCam, pace, sideSel.value as Side, [], DRILL_SETTINGS);
  ctx.fillStyle = '#101810'; ctx.font = '12px monospace';
  paceLabels.forEach((label, i) => ctx.fillText(label, 8, 34 + i * 40));
  const s = pace.soldiers.get(504)!;
  $('paceStatus').textContent = `${pace.time.toFixed(1)} s — rifle: ${s.aiming ? `aiming (${Math.max(0, s.aiming.readyAt - pace.time).toFixed(1)} s)` : s.lastFiredAt > 0 ? 'recovering' : 'ready'} — ${50 - s.ammo} shots`;
}
$('paceReset').addEventListener('click', resetPace);
$('pacePause').addEventListener('click', () => { pacePaused = !pacePaused; $('pacePause').textContent = pacePaused ? 'Resume pace demo' : 'Pause pace demo'; });

// deterministic strips for capture scripts
declare global { interface Window { __drillStrip: (n?: number, dt?: number) => string; __animStrip: (atlasName: string, key: string, dir: number, n?: number, dt?: number, zoom?: number) => string | null; __ragdollStrip: (n?: number, dt?: number) => string; __ready: boolean } }
window.__animStrip = (atlasName, key, dir, n = 8, dt = 0.1, zoom = 3) => {
  const atlas = getAtlas(atlasName);
  if (!atlas || !atlas.meta.entries[key]) return null;
  const k = zoom / atlas.meta.scale;
  const cw = Math.round(atlas.meta.cell.w * k), ch = Math.round(atlas.meta.cell.h * k);
  const c = document.createElement('canvas'); c.width = cw * n; c.height = ch;
  const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = GROUND[atlasName.includes('winter') ? 'winter' : 'summer']; ctx.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < n; i++) drawAtlasFrame(ctx, atlas, key, dir, frameAt(key, atlas, 0.8 + i * dt), i * cw + atlas.meta.anchor.x * k, atlas.meta.anchor.y * k, zoom);
  return c.toDataURL('image/png');
};
window.__ragdollStrip = (n = 8, dt = 0.1) => {
  resetDemo();
  const t0 = 1000; // a private clock: independent of the live demo
  demo.time = t0; fireBlast(t0);
  const frame = document.createElement('canvas'); frame.width = 640; frame.height = 200;
  const c = document.createElement('canvas'); c.width = 640; c.height = 200 * n;
  const ctx = c.getContext('2d')!;
  for (let i = 0; i < n; i++) { drawDemo(frame, t0 + i * dt); ctx.drawImage(frame, 0, i * 200); }
  resetDemo();
  return c.toDataURL('image/png');
};

window.__drillStrip = (n = 24, dt = 0.5) => {
  resetDrill();
  const frame = document.createElement('canvas'); frame.width = 640; frame.height = 300;
  const cols = 4, rows = Math.ceil(n / cols);
  const c = document.createElement('canvas'); c.width = 360 * cols; c.height = 240 * rows;
  const ctx = c.getContext('2d')!;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < Math.round(dt / 0.1); k++) stepDrill(0.1);
    drawDrill(frame);
    ctx.drawImage(frame, 140, 60, 360, 240, (i % cols) * 360, Math.floor(i / cols) * 240, 360, 240);
  }
  resetDrill();
  return c.toDataURL('image/png');
};

$('ragdoll').addEventListener('click', () => { resetDemo(); fireBlast(now() - demoT0 + 0.0001); });
for (const sel of [srcSel, sideSel, seasonSel]) sel.addEventListener('change', () => { void rebuild().then(() => { resetDemo(); resetDrill(); resetPace(); }); });

let lastPreviewTime = now();
function tick(): void {
  const t = now();
  drawPace(t - lastPreviewTime); lastPreviewTime = t;
  for (const a of anims) drawAnim(a, t);
  drawDemo($<HTMLCanvasElement>('ragdollCanvas'), t - demoT0);
  const want = (t - drillT0);
  let guard = 0;
  while (drill.time < want && guard++ < 5) stepDrill(0.1);
  if (drill.time < want - 1) drillT0 = t - drill.time;
  drawDrill($<HTMLCanvasElement>('drillCanvas'));
  requestAnimationFrame(tick);
}
resetDemo();
resetDrill();
resetPace();
let drillT0 = now();
void rebuild().then(() => { window.__ready = true; });
requestAnimationFrame(tick);
