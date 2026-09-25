import { crewMayReturn, crewOutsideWord } from './vehicleCrew';
import { inCommand } from './command';
import { transportWord } from './transport';
import type {
  Activity, BattleState, Health, Side, Soldier, Team, TeamMoraleWord, TeamStatusWord, Vec2, Vehicle,
} from '@/shared/types';
import { SIDES, TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { clamp, dist } from '@/shared/math';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { addMessage } from './messages';
import { crewWeaponStatus } from './crewWeapon';
import { isDazed } from './daze';

// ============================================================================
// morale.ts — team-level morale aggregation, casualty morale hits, tank-scare,
// surrender, and team/side status caching. Per-SOLDIER psychology (stress,
// fear, the mental-state machine, beliefs) lives in mind.ts (spec §1-8); this
// module only keeps the team-wide bookkeeping and the exported names other
// modules rely on (stepMorale, moraleWord, team status caching).
// ============================================================================

// ---------------------------------------------------------------- tracking
interface MoraleTrack {
  lastHealth: Map<number, Health>;
  tankScareAt: Map<number, number>;
  teamLastStatus: Map<number, TeamStatusWord>;
  /** last time (battle seconds) a "is hesitating" flavour message was posted for a team, so it
   * doesn't spam every step while an order stays refused (round5 critique #9). */
  hesitationMsgAt: Map<number, number>;
}

const tracks = new WeakMap<BattleState, MoraleTrack>();

function getTrack(state: BattleState): MoraleTrack {
  let t = tracks.get(state);
  if (!t) {
    t = { lastHealth: new Map(), tankScareAt: new Map(), teamLastStatus: new Map(), hesitationMsgAt: new Map() };
    tracks.set(state, t);
  }
  return t;
}

export function moraleWord(m: number): TeamMoraleWord {
  if (m >= 85) return 'Fanatic';
  if (m >= 65) return 'Confident';
  if (m >= 45) return 'Steady';
  if (m >= 25) return 'Shaken';
  return 'Broken';
}

function aliveTeammatesWithin(state: BattleState, s: Soldier, team: Team, radiusTiles: number): number {
  let n = 0;
  for (const id of team.soldierIds) {
    if (id === s.id) continue;
    const o = state.soldiers.get(id);
    if (!o || o.health === 'dead' || o.health === 'incapacitated') continue;
    if (dist(o.pos, s.pos) <= radiusTiles) n++;
  }
  return n;
}

function nearestEnemySoldierDistTiles(state: BattleState, s: Soldier): number {
  const spotted = state.spotted[s.side];
  let best = Infinity;
  for (const id of spotted) {
    const e = state.soldiers.get(id);
    if (!e || e.health === 'dead' || e.health === 'incapacitated') continue;
    const d = dist(e.pos, s.pos);
    if (d < best) best = d;
  }
  return best;
}

function nearestEnemyTankDistTiles(state: BattleState, s: Soldier): number {
  const spotted = state.spottedVehicles[s.side];
  let best = Infinity;
  for (const id of spotted) {
    const v = state.vehicles.get(id);
    if (!v || v.state === 'knockedOut') continue;
    const def = VEHICLE_DEFS[v.defId];
    if (!def || def.kind !== 'tank') continue;
    const d = dist(v.pos, s.pos);
    if (d < best) best = d;
  }
  return best;
}

function applyTeamMoraleHit(state: BattleState, team: Team, amount: number): void {
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    s.morale = clamp(s.morale - amount, 0, 100);
  }
}

function stepSoldierMorale(state: BattleState, s: Soldier, dt: number, track: MoraleTrack): void {
  // Vehicle crew are shielded by armor: their morale/suppression is driven by vehicle.ts's crew
  // mind (spec §10), not by exposed-infantry mechanics.
  if (s.vehicleId != null) return;

  const team = state.teams.get(s.teamId);
  const leader = team ? state.soldiers.get(team.leaderId) : undefined;
  const leaderAlive = !!leader && leader.health !== 'dead' && leader.health !== 'incapacitated';
  const leaderNearM = leaderAlive && leader ? dist(leader.pos, s.pos) * TILE_M <= 10 : false;
  const leaderNotSuppressed = leaderAlive && leader ? leader.suppression <= 60 : false;

  // -------------------------------------------------------- suppression decay
  // Tried raising this (5->6 / 8->10) to let attackers recover fire sooner; harness showed it made
  // the attacker win rate WORSE (31%->27% combined with the throttle loosening below), presumably by
  // letting defenders (who take far less suppression to begin with) recover just as fast and keep
  // outshooting the attacker regardless. Reverted to the original rates.
  const decayRate = leaderNearM && leaderNotSuppressed && inCommand(state, s) ? 8 : 5;
  s.suppression = clamp(s.suppression - decayRate * dt, 0, 100);

  // -------------------------------------------------------------- tank scare
  const tankDistM = nearestEnemyTankDistTiles(state, s) * TILE_M;
  if (tankDistM <= 100) {
    const last = track.tankScareAt.get(s.id) ?? -Infinity;
    if (state.time - last >= 10) {
      s.morale = clamp(s.morale - 5, 0, 100);
      track.tankScareAt.set(s.id, state.time);
    }
  }

  // ------------------------------------------------------------- surrender
  // Broken (mind.state) AND surrounded AND (no ammo or an enemy within 3 tiles) -> surrendered
  // (spec §11); experienced soldiers (>=60) need the enemy within 2 tiles instead of 3.
  if (s.activity !== 'surrendered' && s.activity !== 'dead' && s.activity !== 'incapacitated') {
    if (s.mind.state === 'broken' && s.mind.surrounded) {
      const enemyDist = nearestEnemySoldierDistTiles(state, s) * TILE_M;
      const threshold = s.experience >= 60 ? 2 : 3;
      const noAmmo = s.ammo <= 0 && s.ammoReserve <= 0;
      if (noAmmo || enemyDist <= threshold) {
        s.activity = 'surrendered';
        s.stance = 'standing';
        s.path = [];
        if (s.side === state.config.playerSide) {
          addMessage(state, `${team?.name ?? 'Report'}\n${s.rank}. ${s.name} surrenders.`, 'bad');
        } else {
          // the player just took a prisoner (G17): say so, the score change alone is invisible
          addMessage(state, `${s.rank}. ${s.name} surrenders to your forces.`, 'good');
        }
      }
    }
  }

  // -------------------------------------------------------------- fatigue
  if (s.activity === 'idle' || s.activity === 'defending') {
    s.fatigue = clamp(s.fatigue - 1 * dt, 0, 100);
  }
}

function detectCasualtiesAndApply(state: BattleState, track: MoraleTrack): void {
  for (const s of state.soldiers.values()) {
    const last = track.lastHealth.get(s.id);
    if (last !== s.health) {
      track.lastHealth.set(s.id, s.health);
      if (last !== undefined && last !== s.health && (s.health === 'dead' || s.health === 'incapacitated' || s.health === 'wounded')) {
        const team = state.teams.get(s.teamId);
        if (team) {
          const isKIA = s.health === 'dead' || s.health === 'incapacitated';
          let amount = isKIA ? 15 : 8;
          if (s.isLeader) amount *= 2;
          applyTeamMoraleHit(state, team, amount);
        }
      }
    }
  }
}

const ACTIVITY_TO_STATUS: Partial<Record<Activity, TeamStatusWord>> = {
  // A team that has arrived/has nothing left to do is "Waiting" for its next order, not "Idle" —
  // the manual's vocabulary has no "Idle" (round5 critique #9); see computeTeamStatus for how this
  // is further split into Hesitating / Can't See / a vehicle's resting order-stance.
  idle: 'Waiting',
  moving: 'Moving',
  movingFast: 'Moving Fast',
  sneaking: 'Sneaking',
  firing: 'Firing',
  reloading: 'Firing',
  defending: 'Defending',
  ambushing: 'Ambushing',
  hiding: 'Waiting',
  cowering: 'Cowering',
  pinned: 'Pinned',
  panicked: 'Panicked',
  routed: 'Routed',
  berserk: 'Firing',
  surrendered: 'Surrendered',
};

/** True once a strict majority of `alive` still hasn't obeyed the team's *current* order because
 * their individual obedience roll failed (sim/orders.ts canObey sets mind.pendingOrderAt on any
 * refusal, then retries after mind.hesitation runs out) — i.e. they are refusing/slow to respond,
 * not merely incapacitated by a severe mental state (that path is caught earlier by the
 * pinned/cowering/panicked/routed activity mirror, so this only fires for otherwise-idle men). */
function majorityHesitating(alive: Soldier[], team: Team): boolean {
  if (!team.order) return false;
  const n = alive.filter((s) => s.mind.pendingOrderAt !== undefined && (s.activity === 'idle' || s.activity === 'defending')).length;
  return n * 2 > alive.length;
}

function maybeAnnounceHesitating(state: BattleState, team: Team, track: MoraleTrack): void {
  if (team.side !== state.config.playerSide) return;
  const last = track.hesitationMsgAt.get(team.id) ?? -Infinity;
  if (state.time - last < 60) return;
  track.hesitationMsgAt.set(team.id, state.time);
  addMessage(state, `${team.name}\nis hesitating.`, 'warn');
}

/** 'Loading' / 'Aiming' for a vehicle whose main gun is being loaded or laid, else null. */
export function vehicleGunWord(v: Vehicle): TeamStatusWord | null {
  return v.gunState === 'loading' ? 'Loading' : v.gunState === 'laying' ? 'Aiming' : null;
}

function computeTeamStatus(state: BattleState, team: Team, track: MoraleTrack): { status: TeamStatusWord; outOfAction: boolean; morale: number } {
  const soldiers = team.soldierIds.map((id) => state.soldiers.get(id)).filter((s): s is Soldier => !!s);
  const vehicle = team.vehicleId != null ? state.vehicles.get(team.vehicleId) : undefined;
  if (vehicle && vehicle.state === 'abandoned' && crewMayReturn(state, vehicle)) {
    // a serviceable hull whose crew may yet go back (spec 2026-09-17 §10): still in the battle
    // (selectable, so the player can order the crew back; for force morale and the end of the
    // battle it counts as lost until the crew is on its way back)
    const word = crewOutsideWord(state, vehicle) ?? 'Abandoned';
    const up = soldiers.filter((s) => s.health !== 'dead' && s.health !== 'incapacitated');
    return { status: word, outOfAction: false, morale: word === 'Remounting' ? up.reduce((a, s) => a + s.morale, 0) / Math.max(1, up.length) : 0 };
  }
  if (vehicle && (vehicle.state === 'knockedOut' || vehicle.state === 'burning' || vehicle.state === 'abandoned')) {
    return { status: 'Knocked Out', outOfAction: true, morale: 0 };
  }
  const alive = soldiers.filter((s) => s.health !== 'dead' && s.health !== 'incapacitated');
  // Round5 critique #8: a vehicle whose crew is wiped out but whose hull was never actually
  // marked knockedOut/burning/abandoned used to fall through to the generic "Destroyed" branch
  // below, so the SAME class of vehicle showed "Destroyed" or "Knocked Out" depending only on
  // which happened first (crew death vs. hull state) — the "KIA vs Destroyed used
  // interchangeably" defect. Route every non-functional vehicle through one status.
  if (alive.length === 0) return { status: vehicle ? 'Knocked Out' : 'Destroyed', outOfAction: true, morale: 0 };

  const morale = alive.reduce((sum, s) => sum + s.morale, 0) / alive.length;
  const actingAlive = alive.filter((s) => s.activity !== 'routed' && s.activity !== 'surrendered');
  const outOfAction = actingAlive.length === 0;

  // Team status derives from the majority MENTAL STATE (spec §7): activity mirrors mind.state 1:1
  // for the severe states (pinned/cowering/panicked/broken->routed), so a majority-of-activity
  // check here is equivalent and avoids a second soldiers.map pass.
  const majority = (pred: (s: Soldier) => boolean): boolean => alive.filter(pred).length * 2 > alive.length;
  if (majority((s) => s.activity === 'surrendered')) return { status: 'Surrendered', outOfAction, morale };
  if (majority((s) => s.activity === 'routed')) return { status: 'Routed', outOfAction, morale };
  if (morale < 25) return { status: 'Broken', outOfAction, morale };

  // most of the team knocked down or dazed by a blast (sim/daze.ts)
  if (majority((s) => s.vehicleId == null && (isDazed(s, state.time) || (s.stunnedUntil != null && state.time < s.stunnedUntil)))) return { status: 'Stunned', outOfAction, morale };

  // boarding, riding in or leaving a transport (sim/transport.ts)
  const riding = transportWord(state, team);
  if (riding) return { status: riding, outOfAction, morale };

  // Round5 critique #9: "Idle" used to cover arrived / order-refused / no-order alike, and the
  // player was never told an obedience roll had failed. Surface that mechanic explicitly.
  if (majorityHesitating(alive, team)) {
    maybeAnnounceHesitating(state, team, track);
    return { status: 'Hesitating', outOfAction, morale };
  }

  const counts = new Map<Activity, number>();
  for (const s of alive) counts.set(s.activity, (counts.get(s.activity) ?? 0) + 1);
  let best: Activity = 'idle';
  let bestN = -1;
  for (const [a, n] of counts) {
    if (n > bestN) { best = a; bestN = n; }
  }
  let word = ACTIVITY_TO_STATUS[best] ?? 'Waiting';

  // Round5 critique #7: vehicle crew soldiers are positioned by sim/vehicle.ts, not
  // sim/movement.ts (which is what resets infantry `activity` back to 'idle' on arrival) — a
  // vehicle team's soldier.activity is set to 'moving'/'movingFast' once at order-issue time and
  // then never updated again, so it read "Moving" forever even a minute after the vehicle itself
  // stopped. Trust the vehicle's own path/speed instead of the stale soldier activity.
  if (vehicle && (word === 'Moving' || word === 'Moving Fast' || word === 'Sneaking')) {
    const stillMoving = vehicle.path.length > 0 || Math.abs(vehicle.speed) > 0.05;
    if (!stillMoving) {
      const orderType = team.order?.type;
      word = orderType === 'defend' ? 'Defending' : orderType === 'ambush' ? 'Ambushing' : 'Waiting';
    }
  }

  // a vehicle's main gun, like a crew-served one: the word follows what the gun is waiting for
  // (`Vehicle.gunState`, sim/combat.ts) — the loader ramming a round, or the gunner laying on a
  // target. Never while it drives: 'Moving' tells the player more.
  if (vehicle && (word === 'Waiting' || word === 'Defending' || word === 'Ambushing' || word === 'Firing')) {
    const gunWord = vehicleGunWord(vehicle);
    if (gunWord) return { status: gunWord, outOfAction, morale };
  }

  // crew-served weapon being assembled (sim/crewWeapon.ts) reads 'Setting up' unless the crew is
  // doing something more urgent than waiting on it
  // (spec 2026-09-17 §6: the word follows the open task — 'Unlimbering', 'Spreading trails',
  // 'Digging in', 'Loading', 'Aiming', 'Packing up'; a crew held at the gun while it packs is not
  // 'Moving' yet)
  const moveWord = word === 'Moving' || word === 'Moving Fast' || word === 'Sneaking';
  if (word === 'Waiting' || word === 'Defending' || word === 'Ambushing' || word === 'Firing' || moveWord) {
    const crew = crewWeaponStatus(team);
    if (crew && (!moveWord || crew === 'Packing up' || crew === 'Need carrier' || crew === 'Recovering mount')) return { status: crew, outOfAction, morale };
  }

  // vision review round6: the manual's fire-team vocabulary. A team whose fire is in reply to
  // recent incoming fire reads "Returning Fire". A Fire/Smoke-order team whose men can see
  // something in weapon range but are not engaging reads "Not Firing" (out of arc, still
  // aiming, empty weapon); one with nothing visible in range keeps the manual's "Can't See".
  if (word === 'Firing') {
    const firing = alive.filter((s) => s.activity === 'firing' || s.activity === 'reloading' || s.activity === 'berserk');
    const returning = firing.filter((s) => state.time - s.mind.lastIncomingAt < 8);
    if (firing.length > 0 && returning.length * 2 >= firing.length) word = 'Returning Fire';
  }
  if (word === 'Waiting' && (team.order?.type === 'fire' || team.order?.type === 'smoke')) {
    const engaged = alive.some((s) => {
      const w = WEAPONS[s.weaponId];
      if (!w) return false;
      return s.mind.beliefs.some((b) => (b.kind === 'seen' || b.kind === 'fired')
        && b.confidence > 0.4 && state.time - b.time < 10 && dist(s.pos, b.pos) * TILE_M <= w.rangeM);
    });
    return { status: engaged ? 'Not Firing' : "Can't See", outOfAction, morale };
  }

  return { status: word, outOfAction, morale };
}

function teamCenterPos(state: BattleState, team: Team): Vec2 {
  const soldiers = team.soldierIds.map((id) => state.soldiers.get(id)).filter((s): s is Soldier => !!s && s.health !== 'dead');
  if (soldiers.length > 0) {
    const sum = soldiers.reduce((acc, s) => ({ x: acc.x + s.pos.x, y: acc.y + s.pos.y }), { x: 0, y: 0 });
    return { x: sum.x / soldiers.length, y: sum.y / soldiers.length };
  }
  if (team.vehicleId != null) {
    const v = state.vehicles.get(team.vehicleId);
    if (v) return v.pos;
  }
  return team.pos;
}

function messageForTransition(side: Side, playerSide: Side, teamName: string, status: TeamStatusWord): string | null {
  if (side === playerSide) {
    if (status === 'Pinned') return `${teamName}\nWe're pinned down.`;
    if (status === 'Broken') return `${teamName}\nWe're breaking!`;
    if (status === 'Routed') return `${teamName}\nWe're running!`;
    // Body omits the team name (round5 critique #6): the name is already the message's first
    // line (combatMessages.ts splits on '\n' and draws it as its own row), so repeating it in the
    // body read as "PzKw IV F1 / PzKw IV F1 has been knocked out."
    if (status === 'Destroyed') return `${teamName}\nDestroyed.`;
    if (status === 'Knocked Out') return `${teamName}\nKnocked out.`;
    return null;
  }
  if (status === 'Knocked Out') return 'Enemy\nEnemy vehicle knocked out.';
  if (status === 'Routed' || status === 'Destroyed') return 'Enemy\nEnemy team is routing.';
  return null;
}

function updateTeamCaches(state: BattleState, track: MoraleTrack): void {
  for (const team of state.teams.values()) {
    const { status, outOfAction, morale } = computeTeamStatus(state, team, track);
    team.morale = morale;
    team.status = status;
    team.outOfAction = outOfAction;
    team.pos = teamCenterPos(state, team);

    const last = track.teamLastStatus.get(team.id);
    if (last !== status) {
      track.teamLastStatus.set(team.id, status);
      if (status === 'Pinned' || status === 'Broken' || status === 'Routed' || status === 'Destroyed' || status === 'Knocked Out') {
        const msg = messageForTransition(team.side, state.config.playerSide, team.name, status);
        if (msg) addMessage(state, msg, team.side === state.config.playerSide ? 'bad' : 'good');
        if (status === 'Broken' || status === 'Routed') {
          state.events.push({ kind: 'teamBroken', teamId: team.id, side: team.side });
        }
      }
    }
  }
}

function updateSideMorale(state: BattleState): void {
  for (const side of SIDES) {
    const teams = Array.from(state.teams.values()).filter((t) => t.side === side);
    const nonDestroyed = teams.filter((t) => t.status !== 'Destroyed');
    let totalWeight = 0;
    let weighted = 0;
    for (const t of nonDestroyed) {
      const alive = t.soldierIds
        .map((id) => state.soldiers.get(id))
        .filter((s): s is Soldier => !!s && s.health !== 'dead' && s.health !== 'incapacitated').length;
      totalWeight += alive;
      weighted += t.morale * alive;
    }
    const base = totalWeight > 0 ? weighted / totalWeight : 0;
    const oOACount = teams.filter((t) => t.outOfAction || t.status === 'Abandoned' || t.status === 'Bailing out').length;
    const fraction = teams.length > 0 ? oOACount / teams.length : 0;
    state.sides[side].morale = clamp(base - 10 * fraction, 0, 100);
  }
}

/** Team-wide morale bookkeeping (spec's design brief §6.7 + this feature's spec's §1-8 "morale
 * additionally drifts" hooks live in mind.ts's stepOneMind, which runs earlier in the pipeline).
 * Per-soldier psychology/state-machine is mind.ts's job; this only aggregates. */
export function stepMorale(state: BattleState, rng: Rng, dt: number): void {
  const track = getTrack(state);

  detectCasualtiesAndApply(state, track);

  for (const s of state.soldiers.values()) {
    if (s.health === 'dead' || s.health === 'incapacitated' || s.activity === 'surrendered') continue;
    stepSoldierMorale(state, s, dt, track);
  }

  updateTeamCaches(state, track);
  updateSideMorale(state);
}
