import type { BattleResult, BattleState, Side, Vec2 } from '@/shared/types';
import { SIDES, TILE_M, VL_CAPTURE_RADIUS_M, VL_CAPTURE_SECONDS, otherSide } from '@/shared/types';
import { dist } from '@/shared/math';
import { addMessage } from './messages';

const RADIUS_TILES = VL_CAPTURE_RADIUS_M / TILE_M;
const MIN_CEASEFIRE_TIME_S = 5 * 60;

function sideName(side: Side): string {
  return side === 'german' ? 'German' : 'Soviet';
}

function presentSidesAt(state: BattleState, p: Vec2): Set<Side> {
  const present = new Set<Side>();
  for (const s of state.soldiers.values()) {
    if (present.size === 2) break;
    if (s.health === 'dead' || s.health === 'incapacitated') continue;
    if (s.morale < 25) continue;
    if (s.activity === 'routed' || s.activity === 'surrendered' || s.activity === 'panicked') continue;
    if (dist(s.pos, p) <= RADIUS_TILES) present.add(s.side);
  }
  for (const v of state.vehicles.values()) {
    if (present.size === 2) break;
    if (v.state !== 'ok' && v.state !== 'immobilized') continue;
    if (dist(v.pos, p) <= RADIUS_TILES) present.add(v.side);
  }
  return present;
}

const KILL_POINTS = 2;
/** Manual: a captured prisoner counts 3x a kill's point value toward score. */
const PRISONER_VALUE_MULTIPLIER = 3;

/** Enemy soldiers currently surrendered to `side` (captured, out of the fight but not dead). */
export function prisonerCount(state: BattleState, side: Side): number {
  const enemy = otherSide(side);
  let n = 0;
  for (const s of state.soldiers.values()) {
    if (s.side === enemy && s.activity === 'surrendered') n++;
  }
  return n;
}

/** VL points × 10 + kills × 2 + prisoners × 2 × 3 − losses × 1, for the given side. */
export function sideScore(state: BattleState, side: Side): number {
  let vlPoints = 0;
  for (const vl of state.map.victoryLocations) {
    if (vl.owner === side) vlPoints += vl.value * 10;
  }
  const ss = state.sides[side];
  const prisoners = prisonerCount(state, side);
  return vlPoints + ss.kills * KILL_POINTS + prisoners * KILL_POINTS * PRISONER_VALUE_MULTIPLIER - ss.losses * 1;
}

/** Result from the player's perspective: ratio of (score+20) between the two sides. */
export function computeResult(state: BattleState): BattleResult {
  const player = state.config.playerSide;
  const enemy = otherSide(player);
  const ps = state.sides[player].score;
  const es = state.sides[enemy].score;
  const ratio = (ps + 20) / (es + 20);
  if (ratio >= 3) return 'decisive';
  if (ratio >= 1.5) return 'victory';
  if (ratio < 0.67) return 'defeat';
  return 'draw';
}

function resultMessage(result: BattleResult): string {
  switch (result) {
    case 'decisive': return 'A decisive victory!';
    case 'victory': return 'Victory.';
    case 'defeat': return 'Defeat.';
    default: return 'A draw.';
  }
}

/** Immediately ends the battle: `side` flees the field, ceding every victory location to the
 * enemy and forcing a result from the player's perspective — per the manual, "Flee ends the
 * battle immediately with the enemy taking the map." No-op once the battle has already ended. */
export function flee(state: BattleState, side: Side): void {
  if (state.phase !== 'running') return;
  const enemy = otherSide(side);
  for (const vl of state.map.victoryLocations) {
    vl.owner = enemy;
    vl.capturingSide = null;
    vl.captureTimer = 0;
  }
  for (const s of SIDES) state.sides[s].score = sideScore(state, s);
  state.phase = 'ended';
  state.result = side === state.config.playerSide ? 'defeat' : 'decisive';
  state.events.push({ kind: 'ended' });
  addMessage(state, `${sideName(side)} forces have fled the field — the enemy takes the ground.`, 'warn');
}

/** VL capture/contest logic, side scoring, and battle end conditions per spec §6.8. */
export function stepVictory(state: BattleState, dt: number): void {
  for (const vl of state.map.victoryLocations) {
    const present = presentSidesAt(state, { x: vl.x, y: vl.y });
    if (present.size === 2) {
      vl.captureTimer = 0;
      vl.capturingSide = null;
      continue;
    }
    if (present.size === 0) {
      vl.captureTimer = 0;
      vl.capturingSide = null;
      continue;
    }
    const side = [...present][0];
    if (vl.owner === side) {
      vl.captureTimer = 0;
      vl.capturingSide = null;
      continue;
    }
    if (vl.capturingSide === side) {
      vl.captureTimer += dt;
    } else {
      vl.capturingSide = side;
      vl.captureTimer = dt;
    }
    if (vl.captureTimer >= VL_CAPTURE_SECONDS) {
      vl.owner = side;
      vl.capturingSide = null;
      vl.captureTimer = 0;
      state.events.push({ kind: 'vlCaptured', side, pos: { x: vl.x, y: vl.y } });
      const isPlayer = side === state.config.playerSide;
      const header = isPlayer ? sideName(side) : 'Enemy';
      const body = isPlayer ? `We have taken ${vl.name}.` : `Enemy has taken ${vl.name}.`;
      addMessage(state, `${header}\n${body}`, 'good');
    }
  }

  for (const side of SIDES) state.sides[side].score = sideScore(state, side);

  if (state.phase !== 'running') return;

  let ended = false;

  if (state.time >= state.config.durationS) ended = true;
  if (state.sides.german.truceAccepted && state.sides.soviet.truceAccepted) ended = true;

  // The morale-based forced ceasefire must not fire in the opening minutes even when a side takes
  // early heavy losses — per the design brief, a truce/ceasefire shouldn't end a battle before
  // ~5 min normally (and in a typical, not-lopsided battle side morale shouldn't even reach this
  // floor before ~12 min once casualties/morale decay are tuned). This is a hard safety floor, not
  // a soft target: total elimination (below) and the duration timeout can still end a battle early.
  if (state.time >= MIN_CEASEFIRE_TIME_S) {
    for (const side of SIDES) {
      if (state.sides[side].morale < 10) {
        addMessage(state, `Ceasefire — ${sideName(side)} forces are exhausted.`, 'warn');
        ended = true;
      }
    }
  }

  for (const side of SIDES) {
    const teams = [...state.teams.values()].filter((t) => t.side === side);
    if (teams.length > 0 && teams.every((t) => t.outOfAction)) ended = true;
  }

  if (ended) {
    state.phase = 'ended';
    state.result = computeResult(state);
    state.events.push({ kind: 'ended' });
    addMessage(state, resultMessage(state.result), 'info');
  }
}
