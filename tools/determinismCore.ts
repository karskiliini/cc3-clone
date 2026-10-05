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
export const DEFAULT_MAPS = ['border_1941', 'village_1942', 'steppe_1943', 'forest_1944', 'berlin_1945'];
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
  ms: number;
}

function yearForMap(mapId: string): number {
  const m = /(\d{4})$/.exec(mapId);
  const year = m ? Number(m[1]) : NaN;
  return DEFAULT_FORCES[year] ? year : 1943;
}

/** One map and seed, AI vs AI, deployed and started through commands like any battle. */
export function runDeterminism(mapId: string, seed: number, minutes: number): DeterminismRun {
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
