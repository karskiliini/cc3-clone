import { makePhysicsScene } from './hullPhysicsScenarios';
import { buildMap } from '@/sim/map';
import { placeVehicleTeam } from '@/sim/spawn';
import { applyOrder } from '@/sim/orders';
import { hashState } from '@/sim/stateHash';
import { hullAngles } from '@/sim/hullMath';
import { TerrainRenderer } from '@/render/terrainRender';
import { drawUnits } from '@/render/unitRender';
import { vehicles3d, loadVehicleModels } from '@/render/vehicle3d';
import { modelSource } from '@/render/vehicle3d/models';
import { projectVehicleWorldPoint } from '@/render/vehicle3d/look';
import { vehicleGunOrigin } from '@/sim/hullAim';
import { requestBattleAtlases } from '@/render/spriteAtlas';
import { VEHICLE_DEFS } from '@/data/units';
import { SIM_DT, TILE_PX, VIEW_W, VIEW_H, type GameSettings } from '@/shared/types';
const query = new URLSearchParams(location.search), name = query.get('case') ?? 'log-crest';
const feature = ['log-crest', 'crater-descent', 'crater-ascent'].includes(name);
let scene = makePhysicsScene(feature ? 'log-crater' : 'flat-awake', 4, 180);
let state = scene.state, vehicles = [...state.vehicles.values()];
let focus = vehicles[name.startsWith('halftrack') ? 1 : name === 'kv-slope' ? 2 : name === 'sideways-turret' ? 3 : 0];
if (name === 'kv-slope' || name === 'sideways-turret') {
  const def = { ...state.map.def, id: `physical-preview-${name}`, width: 128,
    elevation: (e: Parameters<NonNullable<typeof state.map.def.elevation>>[0]) =>
      e.slope({ x: 0, y: 0, w: 128, h: 180 }, 0, name === 'kv-slope' ? 128 * 2 * 0.35 : 180 * 2 * 0.1,
        name === 'kv-slope' ? 0 : Math.PI / 2) };
  state.map = buildMap(def);
}
for (let i = 0; i < vehicles.length; i++) placeVehicleTeam(state, vehicles[i], { x: 8 + i * 4, y: 160 }, name === 'halftrack-side' ? Math.PI / 2 : 0);
if (name === 'sideways-turret') applyOrder(state, state.teams.get(focus.teamId)!,
  { type: 'fire', target: { x: 65, y: 160 }, issuedAt: 0 }, scene.rng);
let targetTick = Number(query.get('ticks') ?? (feature ? 250 : name === 'sideways-turret' ? 120 : 10));
if (feature && !query.has('ticks')) {
  const wantedY = name === 'log-crest' ? 140.5 : name === 'crater-descent' ? 155.5 : 152.5;
  let best = Infinity;
  for (let tick = 1; tick <= 600; tick++) {
    scene.step(); const pitch = hullAngles(focus.body!.orientation).pitch;
    const d = name === 'log-crest' ? Math.abs(focus.pos.y - wantedY)
      : focus.pos.y < 150 || focus.pos.y > 158 ? Infinity
      : name === 'crater-descent' ? pitch : -pitch;
    if (d < best) { best = d; targetTick = tick; }
  }
  // Replay the authored fixture to the selected physical frame, without navigation
  // races or a fabricated render pose.
  scene = makePhysicsScene('log-crater', 4, 180); state = scene.state;
  vehicles = [...state.vehicles.values()]; focus = vehicles[0];
  void main();
} else void main();
async function main() {
  for (let i = 0; i < targetTick; i++) scene.step();
  const ids = vehicles.map(v => v.defId);
  await requestBattleAtlases(['german', 'soviet'], 'summer', undefined, ids);
  if (vehicles3d()) {
    loadVehicleModels(ids, 'summer');
    const until = performance.now() + 30000;
    while (!ids.every(id => modelSource.get(id))) {
      if (performance.now() > until) throw new Error('preview model load timeout');
      await new Promise(r => setTimeout(r, 50));
    }
  }
  const canvas = document.getElementById('game') as HTMLCanvasElement, ctx = canvas.getContext('2d')!;
  const cam = { x: focus.pos.x - VIEW_W / (2 * TILE_PX), y: focus.pos.y - VIEW_H / (2 * TILE_PX), zoom: 1 };
  const settings: GameSettings = { volume: 0, unitLabels: false, losLines: false, speed: 1, showUnitVision: false, showDepthMap: false };
  const terrain = new TerrainRenderer(state.map), before = hashState(scene);
  for (let i = 0; i < 40; i++) { terrain.draw(ctx, cam); terrain.drawOverlays(ctx, cam, state); }
  drawUnits(ctx, cam, state, focus.side, [focus.teamId], settings);
  const origin = vehicleGunOrigin(focus, VEHICLE_DEFS[focus.defId]);
  const muzzle = projectVehicleWorldPoint(cam, [origin.x, origin.z, origin.y]);
  ctx.strokeStyle = '#ffd15c'; ctx.beginPath(); ctx.arc(muzzle.x, muzzle.y, 3, 0, 2 * Math.PI); ctx.stroke();
  const angles = hullAngles(focus.body!.orientation);
  ctx.fillStyle = '#101710e8'; ctx.fillRect(8, 8, 1008, 62); ctx.fillStyle = '#fff'; ctx.font = '13px monospace';
  ctx.fillText(`${name} | ${focus.defId} | tick ${targetTick} | zoom 1 | ${vehicles3d() ? '3D' : 'sprite fallback'}`, 18, 28);
  ctx.fillText(`pitch ${(angles.pitch * 180 / Math.PI).toFixed(2)}°  roll ${(angles.roll * 180 / Math.PI).toFixed(2)}°  speed ${focus.speed.toFixed(3)} m/s | yellow ring: actual muzzle`, 18, 50);
  const after = hashState(scene); if (after !== before) throw new Error('preview rendering changed simulation hash');
  (window as any).__hullPhysicsMetrics = { name, targetTick, defId: focus.defId, body: focus.body, turretFacing: focus.turretFacing,
    gunElevationRad: focus.gunElevationRad ?? 0, muzzle: origin, before, after, viewport: [VIEW_W, VIEW_H], zoom: 1,
    three: !!vehicles3d(), angles };
}
