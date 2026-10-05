// ============================================================================
// replay.ts — a battle as data: the config it was built from plus the command log it was played
// with (multiplayer plan §3 "Replays", §7 P4). The sim is deterministic, so rebuilding the battle
// from the config and re-applying the commands at their ticks reproduces it exactly; the per-tick
// state hash (stateHash.ts) proves it, and the first differing hash pins a desync to its tick.
// Headless: Node runs these (tools/replay.ts), the debrief saves and watches them.
// ============================================================================
import type { BattleConfig } from '@/shared/types';
import { SIM_DT } from '@/shared/types';
import { BUILD_VERSION } from '@/shared/version';
import { Battle } from './battle';
import type { Command } from './commands';
import { hashState } from './stateHash';

export interface ReplayLog {
  format: 1;
  /** The build that recorded it (src/shared/version.ts); another build may not reproduce it. */
  buildVersion: string;
  /** The battle's config (seed, map, forces, controllers...) as it was built. */
  config: BattleConfig;
  /** Every applied command, in application order (`Battle.commandLog()`). */
  commands: Command[];
  /** Where the recorded battle stood when the log was taken: ticks run and the state hash. */
  final?: { tick: number; hash: number };
}

/** The replay log of a battle played so far. */
export function makeReplayLog(battle: Battle): ReplayLog {
  return {
    format: 1,
    buildVersion: BUILD_VERSION,
    config: structuredClone(battle.state.config),
    commands: structuredClone([...battle.commandLog()]),
    final: { tick: battle.state.tick ?? 0, hash: hashState(battle) },
  };
}

/** A fresh battle that will replay `log` as it is stepped. */
export function replayBattle(log: ReplayLog): Battle {
  const battle = new Battle(structuredClone(log.config));
  battle.loadCommands(log.commands);
  return battle;
}

export interface ReplayRun {
  battle: Battle;
  /** chain[i] = the state hash after tick i + 1 */
  chain: number[];
}

/**
 * Replays `log` headless, one tick at a time, recording the state hash after every tick. Stops at
 * `untilTick` (default: the log's final tick, else when the battle ends or no command is left to
 * start or resume it).
 */
export function runReplay(log: ReplayLog, untilTick = log.final?.tick ?? Infinity): ReplayRun {
  const battle = replayBattle(log);
  const chain: number[] = [];
  return { battle, chain: runTicks(battle, untilTick, chain) };
}

/** Steps `battle` tick by tick up to `untilTick` ticks run, pushing each tick's hash to `chain`. */
export function runTicks(battle: Battle, untilTick: number, chain: number[] = []): number[] {
  const state = battle.state;
  while ((state.tick ?? 0) < untilTick && state.phase !== 'ended') {
    const before = state.tick ?? 0, waiting = battle.pendingCount();
    battle.step(SIM_DT);
    battle.drainEvents();
    if ((state.tick ?? 0) > before) chain.push(hashState(battle));
    // deploy or paused, and no command applied: nothing left that could start or resume it
    else if (state.phase !== 'running' && battle.pendingCount() === waiting) break;
  }
  // the commands stamped with the last tick (a flee, a truce, setSpeed) applied after it ran
  if ((state.tick ?? 0) <= untilTick) battle.flushDue();
  return chain;
}
