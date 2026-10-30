import { makePhysicsScene } from './hullPhysicsScenarios';
import { applyOrder } from '@/sim/orders';
import { onVehicleNearMiss, stepVehicles, beginVehicleBodyTick } from '@/sim/vehicle';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import * as dm from '@/shared/dmath';
// ============================================================================
// tools/determinismCore.ts — the cross-engine determinism check (multiplayer plan §7 P5). Runs
// maps AI vs AI from a fixed seed for N sim-minutes and fingerprints the per-tick state-hash
// chain, so Node, Chromium, Firefox and WebKit can be compared run by run. Shared by
// tools/determinism.html (browsers) and tools/determinismNode.ts (Node).
// ============================================================================
import { Battle } from '@/sim/battle';
import { hashHex, hashState } from '@/sim/stateHash';
import { runTicks } from '@/sim/replay';
import { MAPS } from '@/data/maps';
import { DEFAULT_FORCES } from '@/data/operation';
import type { BattleConfig } from '@/shared/types';
import { SIM_DT } from '@/shared/types';

/** The default set: five maps, seeds 1 and 2. */
export const PHYSICS_CASES = ['physics-flat', 'physics-sleep', 'physics-features', 'physics-routing', 'physics-overturn'];
export const DEFAULT_MAPS = ['border_1941', 'village_1942', 'steppe_1943', 'forest_1944', 'berlin_1945', ...PHYSICS_CASES];
export const DEFAULT_SEEDS = [1, 2];

/** Hash checkpoints every this many ticks (10 s), to find roughly where two engines part. */
const CHECKPOINT_TICKS = 100;

export interface DeterminismRun {
  mapId: string;
  seed: number;
  ticks: number;
  /** the state hash after the last tick */
  final: string;
  /** FNV fold of every tick's hash: equal digests = equal chains */
  digest: string;
  /** the hash every CHECKPOINT_TICKS ticks */
  checkpoints: string[];
  terrainCheckpoints?: string[];
  ms: number;
  physics?: { overturned: number; hungUp: number; frames: number };
}

function yearForMap(mapId: string): number {
  const m = /(\d{4})$/.exec(mapId);
  const year = m ? Number(m[1]) : NaN;
  return DEFAULT_FORCES[year] ? year : 1943;
}

/** One map and seed, AI vs AI, deployed and started through commands like any battle. */
export function runDeterminism(mapId: string, seed: number, minutes: number): DeterminismRun {
  if (PHYSICS_CASES.includes(mapId)) return runPhysicalDeterminism(mapId, seed, minutes);
  if (!MAPS.some((m) => m.id === mapId)) throw new Error(`unknown map ${mapId}`);
  const year = yearForMap(mapId);
  const config: BattleConfig = {
    mapId, playerSide: 'german', year, seed, durationS: Math.max(1200, minutes * 60),
    difficulty: 'normal', forces: DEFAULT_FORCES[year], aiBothSides: true,
  };
  const t0 = performance.now();
  const battle = new Battle(config);
  battle.submit('german', { type: 'autoDeploy' });
  battle.submit('german', { type: 'ready' });
  const chain = runTicks(battle, Math.round(minutes * 60 / SIM_DT));
  let digest = 0x811c9dc5;
  for (const h of chain) digest = Math.imul(digest ^ h, 0x01000193);
  return {
    mapId, seed, ticks: chain.length,
    final: hashHex(chain.length ? chain[chain.length - 1] : hashState(battle)),
    digest: hashHex(digest),
    checkpoints: chain.filter((_, i) => (i + 1) % CHECKPOINT_TICKS === 0).map(hashHex),
    ms: Math.round(performance.now() - t0),
  };
}

/** One line per run, for logs: map, seed, ticks, final hash, chain digest, time. */
export function formatRun(r: DeterminismRun): string {
  return `${r.mapId.padEnd(16)} seed ${r.seed}  ${String(r.ticks).padStart(5)} ticks  final ${r.final}  chain ${r.digest}  ${(r.ms / 1000).toFixed(1)} s`;
}

/** Shared real-contact fixtures exercise bodies, sleep, terrain, driver memory and rollover. */
function runPhysicalDeterminism(mapId: string, seed: number, minutes: number): DeterminismRun {
  const routing = mapId === 'physics-routing', rollover = mapId === 'physics-overturn';
  const kind = routing ? 'routing' : mapId === 'physics-sleep' ? 'flat-sleepers'
    : mapId === 'physics-features' ? 'log-crater' : 'flat-awake';
  const scene = makePhysicsScene(kind, 4, routing ? 160 : Math.max(180, Math.ceil(minutes * 60) + 100));
  scene.rng.setState(seed);
  if (routing) for (const v of scene.state.vehicles.values()) {
    const team = scene.state.teams.get(v.teamId)!;
    applyOrder(scene.state, team, { type: 'move', target: { x: v.pos.x, y: 20 }, issuedAt: 0 }, scene.rng);
  }
  if (rollover) for (const v of scene.state.vehicles.values()) {
    beginVehicleBodyTick(scene.state, v, VEHICLE_DEFS[v.defId]);
    v.body!.orientation = { x: 0, y: dm.sin(Math.PI / 4), z: 0, w: dm.cos(Math.PI / 4) };
  }
  const start = performance.now(), checkpoints: string[] = [], terrainCheckpoints: string[] = [], overturned = new Set<number>(), hung = new Set<number>();
  let digest = 0x811c9dc5, final = hashState(scene);
  const ticks = Math.round(minutes * 60 / SIM_DT);
  for (let tick = 0; tick < ticks; tick++) {
    if (routing || rollover) {
      scene.state.time += SIM_DT;
      if (routing && tick === 20) {
        const v = [...scene.state.vehicles.values()][0];
        onVehicleNearMiss(scene.state, v, WEAPONS.pak40, { x: v.pos.x, y: v.pos.y - 20 });
      }
      stepVehicles(scene.state, scene.rng, SIM_DT);
    } else scene.step();
    scene.state.tick = tick + 1;
    for (const v of scene.state.vehicles.values()) {
      if (v.body!.overturned) overturned.add(v.id);
      if (v.body!.hungUp) hung.add(v.id);
      for (const p of [v.body!.position, v.body!.velocity, v.body!.orientation])
        if (!Object.values(p).every(Number.isFinite)) throw new Error(`${mapId}: nonfinite body at ${tick}`);
    }
    final = hashState(scene); digest = Math.imul(digest ^ final, 0x01000193);
    if ((tick + 1) % CHECKPOINT_TICKS === 0) {
      checkpoints.push(hashHex(final));
      // Validation-only digest of actual physical samples: matching mutation inputs
      // alone cannot detect a cross-engine difference in generated surface arrays.
      let surface = 0x811c9dc5;
      const field = scene.state.map.heightField!;
      for (const array of [field.ground, field.base, field.dig, field.height]) {
        surface = Math.imul(surface ^ array.length, 0x01000193);
        const words = new Uint32Array(array.buffer, array.byteOffset, array.length);
        for (const word of words) surface = Math.imul(surface ^ word, 0x01000193);
      }
      terrainCheckpoints.push(hashHex(surface));
    }
    scene.state.events.length = 0;
  }
  return { mapId, seed, ticks, final: hashHex(final), digest: hashHex(digest), checkpoints, terrainCheckpoints,
    ms: Math.round(performance.now() - start), physics: { overturned: overturned.size, hungUp: hung.size, frames: ticks } };
}
