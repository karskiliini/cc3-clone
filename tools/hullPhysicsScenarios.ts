import { Battle } from '@/sim/battle';
import { buildMap } from '@/sim/map';
import { createHullBody, stepHullBody } from '@/sim/hullPhysics';
import { beginVehicleBodyTick, completeVehicleMovement } from '@/sim/vehicle';
import { requestHullDrive } from '@/sim/hullDrive';
import { spawnTeam, placeVehicleTeam } from '@/sim/spawn';
import { VEHICLE_DEFS, TEAM_DEFS } from '@/data/units';
import { Rng } from '@/shared/rng';
import { SIM_DT, type HullDrive, type HullGroundProbe, type MapDef, type Vehicle } from '@/shared/types';

export type PhysicsScene = 'flat-awake' | 'flat-sleepers' | 'log-crater' | 'routing' | 'mixed-resting';
/** Authored engineering map; the log surrogate is a 0.35 m raised spine (P2 support contract). */
export function makePhysicsScene(kind: PhysicsScene, count = 40, height = 1400) {
  const width = Math.max(32, 16 + count * 4);
  const mapDef: MapDef = {
    id: `physics-${kind}`, name: kind, description: 'P2 physical acceptance strip',
    width, height, season: 'summer', attacker: 'german',
    paint: (tiles, w, h) => {
      tiles.fill('open');
      if (kind === 'routing') {
        for (let y = Math.floor(h / 2); y < Math.floor(h / 2) + 4; y++)
          for (let x = 0; x < w; x++) if (x % 16 < 11) tiles[y * w + x] = 'water';
        for (let x = 13; x < w - 2; x += 12) tiles[(h - 26) * w + x] = 'buildingStone';
      }
    }, victoryLocations: [],
    deployZones: { german: { x: 1, y: 1, w: 4, h: 4 }, soviet: { x: width - 5, y: 1, w: 4, h: 4 } },
    elevation: kind === 'log-crater' ? e => {
      for (let y = 20; y < height - 10; y += 30) e.ridge([{ x: 1, y: y + 0.5 }, { x: width - 1, y: y + 0.5 }], 1.2, 0.35);
    } : undefined,
    decor: kind === 'log-crater' ? Array.from({ length: Math.floor((height - 20) / 30) * count }, (_, i) => ({
      kind: 'shellhole' as const, x: 8 + (i % count) * 4, y: 34 + Math.floor(i / count) * 30, variant: 0,
    })) : undefined,
  };
  const state = new Battle({ mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 7,
    durationS: 1200, difficulty: 'normal', forces: { german: [], soviet: [] } }).state;
  state.map = buildMap(mapDef); state.phase = 'running';
  // Wide enough to load both tracks: small decorative holes can pass harmlessly
  // between the tracks and cannot validate crater descent/ascent.
  if (kind === 'log-crater') state.map.craterMarks = Array.from({ length: Math.floor((height - 20) / 30) * count }, (_, i) => ({
    kind: 'shell' as const, x: 8 + (i % count) * 4, y: 34 + Math.floor(i / count) * 30, sizeM: 4,
  }));
  const rng = new Rng(7), ids = ['t34_76', 'sdkfz251', 'kv1', 'pz4gh'];
  for (let i = 0; i < count; i++) {
    const teamId = kind === 'flat-sleepers' ? 'sov_t34_76' : ['sov_t34_76', 'ger_sdkfz251', 'sov_kv1', 'ger_pz4gh'][i % 4];
    const definition = TEAM_DEFS[teamId];
    const pos = { x: 8 + i * 4, y: height - 20 };
    const team = spawnTeam(state, definition, definition.side, pos, rng);
    placeVehicleTeam(state, state.vehicles.get(team.vehicleId!)!, pos, 0);
    team.order = null; team.facing = 0;
  }
  const resting = kind === 'flat-sleepers' || kind === 'mixed-resting';
  const drive: HullDrive = { speedMs: resting ? 0 : 2, yawRateRadS: 0, brake: resting };
  return { state, rng, drive, step: () => {
    state.time += SIM_DT;
    for (const v of state.vehicles.values()) {
      beginVehicleBodyTick(state, v, VEHICLE_DEFS[v.defId]); requestHullDrive(v, drive);
    }
    for (const v of state.vehicles.values()) {
      const def = VEHICLE_DEFS[v.defId];
      completeVehicleMovement(state, rng, SIM_DT, v, def,
        resting ? undefined : { crushAt: v.pos, overrunDir: 0, checkMines: true });
    }
  } };
}

/** Diagnostic lower bound only: constant-normal probe deliberately excludes production terrain/blockers. */
export function makePureSolverScene(count = 40) {
  const probe: HullGroundProbe = () => ({ heightM: 0, normal: { x: 0, y: 0, z: 1 } });
  const rigs = Array.from({ length: count }, (_, i) => {
    const def = VEHICLE_DEFS[['t34_76', 'sdkfz251', 'kv1', 'pz4gh'][i % 4]];
    return { def, body: createHullBody(def, { x: 8 + i * 4, y: 20 }, 0, probe) };
  });
  const drive: HullDrive = { speedMs: 2, yawRateRadS: 0, brake: false };
  return { rigs, step: () => { for (const r of rigs) stepHullBody(r.body, r.def, drive, probe, SIM_DT); } };
}
