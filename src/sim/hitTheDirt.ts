// ============================================================================
// hitTheDirt.ts — a man running (Move Fast) or walking (Move) throws himself down when fire
// comes in, crawls on along his own route, and gets up to go on only once HE is convinced the
// fire has stopped (user request 2026-09-25; mind spec §4.1).
//
// Rules (each soldier decides for himself; nothing here touches his order, destination or path):
//  * Trigger: rounds / near misses / blasts landing on him (mind.lastIncomingAt, set by
//    combat.ts onIncomingFire and mind.ts onExplosionNear) or on a teammate within
//    TEAM_FIRE_NEAR_M of him, within the last FRESH_FIRE_S. He drops (DROP_HOLD_S still, the
//    get-down), then crawls at crawl pace along the same path (activity stays movingFast/moving; the
//    prone stance caps his speed in infantryPace.ts, and the renderer picks prone.crawl).
//  * Resume: no fire on him or his neighbours for `quietNeededS` seconds AND his suppression
//    has fallen to `suppressionOkFor`. Veterans judge quickly, green / stressed / shaken men
//    stay down longer; see quietNeededS for the numbers. He then gets up (a short still rise,
//    RISE_HOLD_S) and runs on. Fire during the rise or later drops him again.
//  * Move and Move Fast. A Sneak is already prone. An Assault is a walking charge that fires as it
//    goes (hastyFire.ts 'assault'): going to ground in the open in the middle of a charge is what
//    kills it, so the assault keeps going on its feet and only suppression (the mind's pinned
//    state) stops a man.
//  * While crawling he takes a shot that is there (combat.ts crawlerTarget), never hunts for one.
//  * Pinned / cowering / panicked men belong to the mind state machine; while they are in it
//    this module only keeps its memory, so on recovery (resumeFromOrder) he is still down.
// ============================================================================
import type { BattleState, Soldier } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { clamp, dist } from '@/shared/math';

/** Fire this recent (s) counts as "fire now": a few sim steps, so an older event never re-drops a man. */
export const FRESH_FIRE_S = 0.6;
/** Fire on a teammate this close (m) counts as fire on him. */
export const TEAM_FIRE_NEAR_M = 10;
/** Throwing himself down: he holds still this long (s) — the renderer's drop is 0.45 s. */
export const DROP_HOLD_S = 0.5;
/** A leader already up and moving on within this distance (m) pulls his men up sooner. */
const LEADER_PULL_M = 15;

/** Latest incoming fire on him or a living teammate close by (battle seconds). */
export function lastFireNear(state: BattleState, s: Soldier): number {
  let at = s.mind.lastIncomingAt;
  const team = state.teams.get(s.teamId);
  if (!team) return at;
  const nearTiles = TEAM_FIRE_NEAR_M / TILE_M;
  for (const id of team.soldierIds) {
    if (id === s.id) continue;
    const o = state.soldiers.get(id);
    if (!o || o.health === 'dead' || o.health === 'incapacitated' || o.vehicleId != null) continue;
    if (o.mind.lastIncomingAt > at && dist(o.pos, s.pos) <= nearTiles) at = o.mind.lastIncomingAt;
  }
  return at;
}

/** Stable per-man judgement spread (0.85..1.15), so a squad does not stand up as one. */
function personalSpread(id: number): number {
  const h = Math.imul(id + 0x9e37, 0x85ebca6b) >>> 0;
  return 0.85 + ((h % 1000) / 1000) * 0.3;
}

/** Seconds of quiet this man needs before he believes the fire has stopped:
 * (1.5 + (100 − experience)·0.06 + stress·0.04) × trait × mind state × leader × personal spread.
 * Experience 80 / stress 10 ≈ 3.1 s; experience 20 / stress 40 ≈ 8.0 s. */
export function quietNeededS(state: BattleState, s: Soldier): number {
  const mind = s.mind;
  let q = 1.5 + (100 - clamp(s.experience, 0, 100)) * 0.06 + clamp(mind.stress, 0, 100) * 0.04;
  switch (mind.trait) {
    case 'reckless': q *= 0.6; break;
    case 'brave': q *= 0.8; break;
    case 'steady': case 'stoic': q *= 0.9; break;
    case 'cautious': case 'nervous': q *= 1.3; break;
    default: break;
  }
  if (mind.state === 'shaken') q *= 1.4;
  else if (mind.state === 'wary') q *= 1.1;
  if (leaderUpAndRunning(state, s)) q *= 0.7;
  return q * personalSpread(s.id);
}

/** Suppression (0..100) he must be down to before he gets up: 10 + experience/4. */
export function suppressionOkFor(s: Soldier): number {
  return 10 + clamp(s.experience, 0, 100) * 0.25;
}

/** Getting up again (s): a veteran is up in about half a second, a green man a little slower. */
export function riseHoldS(s: Soldier): number {
  return 0.45 + (100 - clamp(s.experience, 0, 100)) * 0.003;
}

function leaderUpAndRunning(state: BattleState, s: Soldier): boolean {
  const team = state.teams.get(s.teamId);
  if (!team || team.leaderId === s.id) return false;
  const l = state.soldiers.get(team.leaderId);
  if (!l || l.health === 'dead' || l.health === 'incapacitated') return false;
  return isMoverActivity(l) && l.path.length > 0 && l.mind.downAt == null && l.stance === 'standing'
    && dist(l.pos, s.pos) * TILE_M <= LEADER_PULL_M;
}

/** Is this man's movement under a Move / Move Fast order this module governs? */
function underMoveOrder(state: BattleState, s: Soldier): boolean {
  const team = state.teams.get(s.teamId);
  const order = team?.order;
  return !!team && team.vehicleId == null && !team.outOfAction && !!order
    && (order.type === 'moveFast' || order.type === 'move') && order.mountVehicleId == null;
}

/** The activity a man on this module's orders walks or runs in. */
function isMoverActivity(s: Soldier): boolean {
  return s.activity === 'movingFast' || s.activity === 'moving';
}

/** Down under fire and still on his way: crawling on (combat.ts lets him take a shot that is there). */
export function isCrawlingUnderFire(s: Soldier): boolean {
  return s.mind?.downAt != null && s.path.length > 0 && isMoverActivity(s) && s.stance === 'prone';
}

/** True while he is down (crawling) under a Move / Move Fast order. */
export function isDownUnderFire(s: Soldier): boolean {
  return s.mind.downAt != null;
}

function clear(s: Soldier): void {
  if (s.mind.downAt == null && s.mind.downHoldUntil == null) return;
  s.mind.downAt = undefined;
  s.mind.downHoldUntil = undefined;
}

/** Per movement step, before he moves. Sets his stance; returns true while he holds still
 * (dropping to the ground or getting up), so movement.ts skips his step. */
export function stepHitTheDirt(state: BattleState, s: Soldier): boolean {
  const mind = s.mind;
  if (!mind) return false;
  if (!underMoveOrder(state, s)) { clear(s); return false; }
  // pinned / firing / reloading...: the mind or combat has him for now; keep the memory
  if (!isMoverActivity(s)) return false;
  const t = state.time;
  if (s.path.length === 0) {
    // arrived while down (movement.onArrive normally handles this and clears the memory):
    // he stays down where he got to
    if (mind.downAt != null) s.stance = 'prone';
    clear(s);
    return false;
  }
  const fireAt = lastFireNear(state, s);
  if (mind.downAt == null) {
    if (t - fireAt <= FRESH_FIRE_S) {
      mind.downAt = t;
      mind.downHoldUntil = t + DROP_HOLD_S;
      s.stance = 'prone';
    }
  } else {
    s.stance = 'prone'; // a recovery (mind.resumeFromOrder) or a re-issued order must not stand him up
    const holding = mind.downHoldUntil != null && t < mind.downHoldUntil;
    if (!holding && t - fireAt >= quietNeededS(state, s) && s.suppression <= suppressionOkFor(s)) {
      mind.downAt = undefined;
      mind.downHoldUntil = t + riseHoldS(s);
      s.stance = 'standing';
    }
  }
  return mind.downHoldUntil != null && t < mind.downHoldUntil;
}
