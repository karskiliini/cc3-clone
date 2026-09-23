// ============================================================================
// tools/vehicleBattle.ts — dev-only: a real Battle (AI on both sides) run headlessly for `t`
// seconds, then drawn once with the game's own terrain / unit / effect renderers, the camera on a
// vehicle. Judges the vehicle atlases in context at true 1:1 (or zoom 2).
//   vehicleBattle.html?map=steppe_1943&year=1943&t=40&zoom=1&focus=0
//     &ger=ger_pz4gh,ger_tiger,ger_rifle_43&sov=sov_t34_76,sov_kv1,sov_rifle_43
// Sets window.__vbReady when drawn.
// ============================================================================
import type { BattleConfig, Camera, GameSettings } from '@/shared/types';
import { SIM_DT, VIEW_W, VIEW_H, TILE_PX } from '@/shared/types';
import { Battle } from '@/sim/battle';
import { TerrainRenderer } from '@/render/terrainRender';
import { drawUnits } from '@/render/unitRender';
import { drawEffects } from '@/render/effects';
import { requestBattleAtlases, loadAtlas, vehicleDefAtlasName } from '@/render/spriteAtlas';

declare global { interface Window { __vbReady?: boolean } }

const q = new URLSearchParams(location.search);
const list = (k: string, d: string): string[] => (q.get(k) ?? d).split(',').filter(Boolean);
const cfg: BattleConfig = {
  mapId: q.get('map') ?? 'steppe_1943',
  playerSide: 'german',
  year: Number(q.get('year') ?? 1943),
  seed: Number(q.get('seed') ?? 3),
  durationS: 900,
  difficulty: 'normal',
  forces: {
    german: list('ger', 'ger_pz4gh,ger_tiger,ger_panther,ger_stug3g,ger_rifle_43'),
    soviet: list('sov', 'sov_t34_76,sov_t34_85,sov_kv1,sov_su85,sov_rifle_43'),
  },
  aiBothSides: true,
};
const battle = new Battle(cfg);
battle.start();
const steps = Math.round(Number(q.get('t') ?? 30) / SIM_DT);
for (let i = 0; i < steps && battle.state.phase === 'running'; i++) battle.step(SIM_DT);

const state = battle.state;
const zoom = Number(q.get('zoom') ?? 1);
const vehicles = [...state.vehicles.values()];
const focus = vehicles[Number(q.get('focus') ?? 0)] ?? vehicles[0];
const cam: Camera = { x: 0, y: 0, zoom };
if (focus) {
  cam.x = focus.pos.x - VIEW_W / (2 * TILE_PX * zoom);
  cam.y = focus.pos.y - VIEW_H / (2 * TILE_PX * zoom);
}
const settings: GameSettings = { volume: 0, unitLabels: false, losLines: false, speed: 1, showUnitVision: false, showDepthMap: false };

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
ctx.imageSmoothingEnabled = false;
const defs = [...new Set(vehicles.map((v) => v.defId))];
const sides = [...new Set([...state.teams.values()].map((t) => t.side))];
const sc = zoom >= 2 ? 2 : 1;
void Promise.all([
  requestBattleAtlases(sides, state.map.def.season, undefined, defs),
  ...defs.map((d) => loadAtlas(vehicleDefAtlasName(d, sc))),
  ...defs.map((d) => loadAtlas(vehicleDefAtlasName(d, sc, state.map.def.season))),
]).then(() => {
  const terrain = new TerrainRenderer(state.map);
  const frame = (): void => {
    terrain.draw(ctx, cam);
    terrain.drawOverlays(ctx, cam, state);
    drawUnits(ctx, cam, state, focus?.side ?? 'german', [], settings);
    drawEffects(ctx, cam, state);
  };
  // the terrain bakes its chunks lazily over a few frames: keep drawing
  setInterval(frame, 250);
  frame();
  document.getElementById('status')!.textContent =
    `t=${state.time.toFixed(1)} vehicles: ${vehicles.map((v) => `${v.defId}:${v.state}@${v.pos.x.toFixed(0)},${v.pos.y.toFixed(0)}`).join(' ')}`;
  window.__vbReady = true;
});
