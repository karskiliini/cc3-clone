// ============================================================================
// daze.ts — knocked down -> DAZED -> RECOVERING (user request 2026-09-17).
//
// A man thrown off his feet by a blast first lies DOWN (`stunnedUntil`, combat.ts
// applyBlastKnockback — unchanged). After that he is DAZED until `dazedUntil`: he cannot fire,
// throw, reload, work a crew task, spot for mortars, pick things up or obey a movement order, and
// he sees very little. The one thing he may do is look after himself: in the open or under fire
// he crawls, slowly and in a panic, to the nearest better cover within ~12 m and lies still there.
// Then he is RECOVERING until `shakenUntil`: accuracy and task speed x0.7 fading back to 1.
// Experience shortens both phases; a wound from the same blast and a second blast lengthen the
// daze (capped). Everything here is a pure function of the soldier and the battle clock — no rng.
// ============================================================================
import type { BattleState, Soldier, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { angleTo, clamp, dist, facingFromAngle } from '@/shared/math';
import { tileAt } from './map';
import { TERRAIN_PROPS } from './terrain';
import { findPath } from './path';
import { bestCoverNear } from './coverSeek';

/** Daze length before the man's own qualities, seconds: weakest knock-down .. heaviest blast. */
export const DAZE_BASE_MIN_S = 6;
export const DAZE_BASE_MAX_S = 20;
/** No man stays dazed longer than this from now, however many shells land on him. */
export const DAZE_CAP_S = 45;
/** Recovery (after the daze) lasts this long: veteran .. recruit. */
export const RECOVER_MIN_S = 10;
export const RECOVER_MAX_S = 30;
/** Accuracy / task-speed factor at the start of the recovery (and throughout the daze). */
export const RECOVER_FACTOR_MIN = 0.7;
/** How much a dazed man sees of what he normally would. */
export const DAZE_VISION_FACTOR = 0.25;
/** Self-preservation crawl: a wounded man's crawl (0.25 m/s) x1.5 — fear helps. */
export const DAZE_CRAWL_MS = 0.375;
/** He looks for something better within this many metres... */
export const DAZE_CRAWL_RADIUS_M = 12;
/** ...and only bothers when it is this much better than where he lies. */
const DAZE_CRAWL_GAIN = 0.15;
/** Cover (against his known threats) below which he counts as lying in the open. */
const DAZE_OPEN_COVER = 0.35;
/** Fire at him within this many seconds counts as "under fire". */
const DAZE_UNDER_FIRE_S = 4;
/** Seconds between looks around for cover while he lies dazed. */
const DAZE_LOOK_EVERY_S = 3;
/** Experience at and above which a man counts as a veteran (same line as vehicle.ts overrun dodge). */
export const DAZE_VETERAN_EXP = 70;

/** Experience factor on the daze: x1.5 for a raw recruit (<= 20) .. x0.5 for a veteran / hero (>= 80). */
export function dazeExperienceMul(experience: number): number {
  return clamp(1.5 - (experience - 20) / 60, 0.5, 1.5);
}

/** Seconds of daze a blast of `force` (combat.ts blastForce, ~0.2..1.5 for a knock-down) gives this
 * man: 6-20 s by force, x experience (1.5 recruit .. 0.5 veteran), a little shorter with high
 * morale and motivation (his "know-how": he has been here before and knows it passes), longer
 * when already wounded and longer still when this very blast wounded him. */
export function dazeDurationS(s: Soldier, force: number, woundedByIt: boolean): number {
  const f = clamp((force - 0.2) / 1.1, 0, 1);
  let d = DAZE_BASE_MIN_S + (DAZE_BASE_MAX_S - DAZE_BASE_MIN_S) * f;
  d *= dazeExperienceMul(s.experience);
  d *= 1.1 - 0.2 * clamp(s.morale / 100, 0, 1);
  d *= 1.05 - 0.1 * clamp((s.mind?.motivation ?? 50) / 100, 0, 1);
  if (woundedByIt) d *= 1.4;
  else if (s.health === 'wounded') d *= 1.2;
  return d;
}

/** Seconds the recovery after a daze lasts: 30 s recruit .. 10 s veteran. */
export function recoverDurationS(s: Soldier): number {
  return clamp(RECOVER_MAX_S - ((s.experience - 20) / 60) * (RECOVER_MAX_S - RECOVER_MIN_S), RECOVER_MIN_S, RECOVER_MAX_S);
}

/** Dazed by a blast right now (this includes the seconds he lies knocked down before it). */
export function isDazed(s: Soldier, time: number): boolean {
  return s.dazedUntil != null && time < s.dazedUntil;
}

/** Dazed and no longer lying stunned: the phase in which he may crawl for cover. */
function isDazedAndStirring(s: Soldier, time: number): boolean {
  return isDazed(s, time) && !(s.stunnedUntil != null && time < s.stunnedUntil);
}

/** Accuracy / task-speed factor: 0.7 while dazed, fading linearly back to 1 over the recovery. */
export function recoveryFactor(s: Soldier, time: number): number {
  if (s.dazedUntil == null) return 1;
  if (time < s.dazedUntil) return RECOVER_FACTOR_MIN;
  const until = s.shakenUntil ?? s.dazedUntil;
  if (time >= until) return 1;
  const span = Math.max(1e-6, until - s.dazedUntil);
  return RECOVER_FACTOR_MIN + (1 - RECOVER_FACTOR_MIN) * clamp((time - s.dazedUntil) / span, 0, 1);
}

/** Spotting multiplier (spotting.ts, next to painVisionFactor): a dazed man sees a quarter of what
 * he would; a recovering one is back to normal as his head clears. */
export function dazeVisionFactor(s: Soldier, time: number): number {
  if (s.dazedUntil == null) return 1;
  if (time < s.dazedUntil) return DAZE_VISION_FACTOR;
  return recoveryFactor(s, time);
}

/** A knock-down (combat.ts applyBlastKnockback, after `stunnedUntil` is set) dazes the man. A
 * second blast while he is still dazed EXTENDS the daze; never beyond DAZE_CAP_S from now. The
 * team's order in force is left pending on him (mind.pendingOrderAt), so he takes it up again
 * when his head clears, exactly like a man who hesitated. */
export function applyDaze(state: BattleState, s: Soldier, force: number, woundedByIt: boolean): void {
  if (s.health === 'dead' || s.health === 'incapacitated') return;
  const dur = dazeDurationS(s, force, woundedByIt);
  const downUntil = Math.max(state.time, s.stunnedUntil ?? state.time);
  const from = isDazed(s, state.time) ? Math.max(s.dazedUntil!, downUntil) : downUntil;
  s.dazedUntil = Math.min(state.time + DAZE_CAP_S, from + dur);
  s.shakenUntil = s.dazedUntil + recoverDurationS(s);
  s.dazeCrawl = undefined;
  s.targetSoldierId = null;
  s.targetVehicleId = null;
  s.targetPoint = null;
  const team = state.teams.get(s.teamId);
  if (team?.order && team.vehicleId == null && s.mind) s.mind.pendingOrderAt = team.order.issuedAt;
}

function endDaze(state: BattleState, s: Soldier): void {
  s.dazeCrawl = undefined;
  s.path = [];
  if (s.activity === 'hiding') s.activity = state.teams.get(s.teamId)?.order?.type === 'defend' ? 'defending' : 'idle';
}

function crawl(state: BattleState, s: Soldier, path: Vec2[], dt: number): void {
  const tile = tileAt(state.map, Math.floor(s.pos.x), Math.floor(s.pos.y));
  let remaining = (DAZE_CRAWL_MS * TERRAIN_PROPS[tile].speedMul * (s.health === 'wounded' ? 0.7 : 1) * dt) / TILE_M;
  while (remaining > 0 && path.length > 0) {
    const wp = path[0];
    const d = dist(s.pos, wp);
    if (d > 1e-4) s.facing = facingFromAngle(angleTo(s.pos, wp));
    if (d <= remaining) { s.pos = { x: wp.x, y: wp.y }; remaining -= d; path.shift(); }
    else { s.pos = { x: s.pos.x + ((wp.x - s.pos.x) / d) * remaining, y: s.pos.y + ((wp.y - s.pos.y) / d) * remaining }; remaining = 0; }
  }
}

/** The self-preservation crawl, run by movement.ts before anyone else moves (which then leaves a
 * dazed man alone). In the open (cover against his known threats < 0.35) or under fire he picks
 * the best cover within 12 m with the cover-seek scoring, crawls there prone, and lies still. */
export function stepDazed(state: BattleState, _rng: Rng, dt: number): void {
  for (const s of state.soldiers.values()) {
    if (s.dazedUntil == null) continue;
    if (s.health === 'dead' || s.health === 'incapacitated') { s.dazeCrawl = undefined; continue; }
    if (!isDazed(s, state.time)) {
      if (s.dazeCrawl) endDaze(state, s);
      continue;
    }
    if (!isDazedAndStirring(s, state.time) || s.vehicleId != null || s.hatch) continue;
    if (s.activity === 'surrendered') continue;
    s.stance = 'prone';
    if (s.activity !== 'pinned' && s.activity !== 'cowering' && s.activity !== 'panicked' && s.activity !== 'routed') s.activity = 'hiding';
    let c = s.dazeCrawl;
    if (!c) c = s.dazeCrawl = { path: [], lookAt: state.time };
    if (c.path.length === 0 && state.time >= c.lookAt) {
      c.lookAt = state.time + DAZE_LOOK_EVERY_S;
      const found = bestCoverNear(state, s, DAZE_CRAWL_RADIUS_M / TILE_M);
      const underFire = state.time - s.mind.lastIncomingAt < DAZE_UNDER_FIRE_S;
      if (found && (found.current < DAZE_OPEN_COVER || underFire) && found.score - found.current >= DAZE_CRAWL_GAIN) {
        const path = findPath(state.map, s.pos, found.tile, 'infantry');
        let len = 0;
        for (let i = 0, p = s.pos; i < path.length; p = path[i], i++) len += dist(p, path[i]);
        // round a building is not "the nearest cover": he has the strength for a dozen metres
        if (path.length > 0 && len * TILE_M <= DAZE_CRAWL_RADIUS_M * 1.5) c.path = path;
      }
    }
    // the path is his alone while he is dazed (the mind and the order code may have touched it)
    s.path = c.path;
    if (c.path.length > 0) {
      crawl(state, s, c.path, dt);
      s.animFrame = Math.floor(state.time / 0.5) % 2;
    } else s.animFrame = 0;
  }
}
