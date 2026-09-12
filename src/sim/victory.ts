import type { BattleResult, BattleState, Side, Vec2 } from '@/shared/types';
import { SIDES, TILE_M, VL_CAPTURE_RADIUS_M, VL_CAPTURE_SECONDS, otherSide } from '@/shared/types';
import { dist } from '@/shared/math';
import { addMessage } from './messages';

const RADIUS_TILES = VL_CAPTURE_RADIUS_M / TILE_M;

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

/** VL points × 10 + kills × 2 − losses × 1, for the given side. */
export function sideScore(state: BattleState, side: Side): number {
  let vlPoints = 0;
  for (const vl of state.map.victoryLocations) {
    if (vl.owner === side) vlPoints += vl.value * 10;
  }
  const ss = state.sides[side];
  return vlPoints + ss.kills * 2 - ss.losses * 1;
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
      addMessage(state, `${sideName(side)} forces have captured ${vl.name}.`, 'good');
    }
  }

  for (const side of SIDES) state.sides[side].score = sideScore(state, side);

  if (state.phase !== 'running') return;

  let ended = false;

  if (state.time >= state.config.durationS) ended = true;
  if (state.sides.german.truceAccepted && state.sides.soviet.truceAccepted) ended = true;

  for (const side of SIDES) {
    if (state.sides[side].morale < 10) {
      addMessage(state, `Ceasefire — ${sideName(side)} forces are exhausted.`, 'warn');
      ended = true;
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
