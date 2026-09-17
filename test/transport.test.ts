// Infantry riding in a halftrack (sim/transport.ts).
import { describe, it, expect } from 'vitest';
import type { BattleState, Soldier, Team, Vehicle } from '@/shared/types';
import { SIM_DT, TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { stepVehicles } from '@/sim/vehicle';
import { stepMovement } from '@/sim/movement';
import { stepMinds } from '@/sim/mind';
import { stepCombat, applyHESplash } from '@/sim/combat';
import { stepMorale } from '@/sim/morale';
import { applyOrder } from '@/sim/orders';
import { resolveVehicleHit } from '@/sim/vehicleDamage';
import { BOARD_S, passengersAboard, roomLeft, canTeamMount } from '@/sim/transport';
import { angleTo, dist, wrapAngle } from '@/shared/math';
import { makeState, addTank, soldier, mkTeam, W, H } from './vehicleDamageHelpers';

function step(state: BattleState, rng: Rng, seconds: number, opts: { combat?: boolean; each?: () => void } = {}): void {
  for (let i = 0; i < seconds / SIM_DT; i++) {
    state.time += SIM_DT;
    stepMovement(state, rng, SIM_DT);
    stepVehicles(state, rng, SIM_DT);
    stepMinds(state, rng, SIM_DT);
    if (opts.combat) stepCombat(state, rng, SIM_DT);
    stepMorale(state, rng, SIM_DT);
    opts.each?.();
    state.events.length = 0; state.tracers.length = 0; state.explosions.length = 0;
  }
}

function squad(state: BattleState, teamId: number, n: number, at: { x: number; y: number }, type: Team['type'] = 'rifle', side: Team['side'] = 'german'): { team: Team; men: Soldier[] } {
  const men: Soldier[] = [];
  for (let i = 0; i < n; i++) {
    const m = soldier(teamId * 100 + i, teamId, side, { x: at.x + (i % 5) * 0.6, y: at.y + Math.floor(i / 5) * 0.6 }, side === 'german' ? 'kar98k' : 'mosin', { isLeader: i === 0, ammo: 5, ammoReserve: 60 });
    state.soldiers.set(m.id, m); men.push(m);
  }
  const team = mkTeam(teamId, type, men.map((m) => m.id), side, at);
  state.teams.set(teamId, team);
  return { team, men };
}

function scene(n = 10): { state: BattleState; v: Vehicle; vteam: Team; team: Team; men: Soldier[]; rng: Rng } {
  const state = makeState(1943);
  const ht = addTank(state, 'sdkfz251', { x: 100, y: 100 }, 0, 60);
  const sq = squad(state, 7, n, { x: 100, y: 108 });
  return { state, v: ht.v, vteam: ht.team, team: sq.team, men: sq.men, rng: new Rng(4) };
}
const aboard = (men: Soldier[], v: Vehicle): Soldier[] => men.filter((m) => m.vehicleId === v.id && m.seat === 'passenger');
const mount = (state: BattleState, team: Team, v: Vehicle, rng: Rng): void => applyOrder(state, team, { type: 'move', target: { ...v.pos }, issuedAt: state.time }, rng);

describe('mounting a halftrack', () => {
  it('a Move order onto a friendly halftrack is a mount order: the squad boards one man per ~1.5 s through the rear door, and the vehicle waits', () => {
    const { state, v, vteam, team, men, rng } = scene(10);
    expect(WEAPONS.kar98k).toBeTruthy();
    mount(state, team, v, rng);
    expect(team.order?.mountVehicleId).toBe(v.id);
    expect(team.transportId).toBe(v.id);
    // the halftrack is told to drive off at once: it must not move until loading is finished
    applyOrder(state, vteam, { type: 'move', target: { x: 100, y: 40 }, issuedAt: state.time }, rng);
    const start = { ...v.pos };
    const boardedAt: number[] = [];
    let last = 0, t = 0, maxClimbing = 0;
    while (aboard(men, v).length < 10 && t < 90) {
      step(state, rng, 0.1); t += 0.1;
      const n = aboard(men, v).length;
      if (n > last) { boardedAt.push(t); last = n; }
      maxClimbing = Math.max(maxClimbing, men.filter((m) => m.hatch).length);
      if (n < 10) expect(dist(v.pos, start)).toBeLessThan(1e-6);
    }
    expect(aboard(men, v).length).toBe(10);
    expect(maxClimbing).toBe(1); // one at a time
    for (let i = 1; i < boardedAt.length; i++) expect(boardedAt[i] - boardedAt[i - 1]).toBeGreaterThan(BOARD_S - 0.15);
    const loading = boardedAt[9] - boardedAt[0];
    expect(loading).toBeGreaterThan(9 * BOARD_S - 1);
    expect(loading).toBeLessThan(9 * BOARD_S + 6);
    expect(state.messages.some((m) => m.text.includes('Waiting for passengers.'))).toBe(true);
    expect(v.passengerIds?.length).toBe(10);
    step(state, rng, 0.2);
    expect(team.status).toBe('Mounted');
    // now it drives, and the men go with it without tiring
    const tired = men.map((m) => m.fatigue);
    step(state, rng, 20);
    expect(dist(v.pos, start) * TILE_M).toBeGreaterThan(30);
    men.forEach((m, i) => { expect(dist(m.pos, v.pos)).toBeLessThan(0.5); expect(m.fatigue).toBeLessThanOrEqual(tired[i]); });
  });

  it('capacity is respected: the rest of a big squad stays outside as the same team', () => {
    const { state, v, team, men, rng } = scene(10);
    const other = squad(state, 8, 4, { x: 97, y: 108 });
    mount(state, other.team, v, rng);
    step(state, rng, 25);
    expect(aboard(other.men, v).length).toBe(4);
    mount(state, team, v, rng);
    step(state, rng, 60);
    expect(aboard(men, v).length).toBe(6);
    expect(roomLeft(state, v)).toBe(0);
    expect(men.filter((m) => m.vehicleId == null).length).toBe(4);
    expect(men.every((m) => m.teamId === team.id)).toBe(true);
    // a third squad finds no room: an ordinary move order
    const third = squad(state, 9, 3, { x: 103, y: 110 });
    mount(state, third.team, v, rng);
    expect(third.team.order?.mountVehicleId).toBeUndefined();
  });

  it('an AT gun team cannot mount; tanks carry nobody', () => {
    const { state, v, rng } = scene(0);
    const gun = squad(state, 11, 4, { x: 100, y: 108 }, 'atgun');
    expect(canTeamMount(gun.team)).toBe(false);
    mount(state, gun.team, v, rng);
    expect(gun.team.order?.mountVehicleId).toBeUndefined();
    step(state, rng, 30);
    expect(passengersAboard(state, v).length).toBe(0);
    const tank = addTank(state, 'pz4gh', { x: 120, y: 100 }, 0, 60);
    const sq = squad(state, 12, 5, { x: 120, y: 108 });
    mount(state, sq.team, tank.v, rng);
    expect(sq.team.order?.mountVehicleId).toBeUndefined();
    expect(VEHICLE_DEFS.pz4gh.passengers ?? 0).toBe(0);
    expect(VEHICLE_DEFS.sdkfz251.passengers).toBe(10);
  });
});

describe('riding', () => {
  function loaded(): ReturnType<typeof scene> {
    const sc = scene(8);
    mount(sc.state, sc.team, sc.v, sc.rng);
    step(sc.state, sc.rng, 40);
    expect(aboard(sc.men, sc.v).length).toBe(8);
    return sc;
  }

  it('rifle fire from the front at ground level hurts nobody aboard; a grenade landing inside does', () => {
    const { state, v, men } = loaded();
    const rng = new Rng(21);
    for (let i = 0; i < 300; i++) resolveVehicleHit(state, rng, v, { weapon: WEAPONS.mosin, shooterPos: { x: 100, y: 60 }, shooterSide: 'soviet', distM: 80 });
    expect(men.every((m) => m.health === 'healthy')).toBe(true);
    const grenade = Object.values(WEAPONS).find((w) => w.cls === 'grenade' && w.heRadiusM > 0)!;
    for (let i = 0; i < 6; i++) applyHESplash(state, rng, { x: v.pos.x + 0.1, y: v.pos.y + 0.2 }, grenade, 'soviet');
    expect(men.some((m) => m.health !== 'healthy')).toBe(true);
    expect(men.every((m) => m.mind.stress > 0)).toBe(true);
  });

  it('a shooter on a hill above, close by, fires down into the open compartment', () => {
    const { state, v, men } = loaded();
    const rng = new Rng(22);
    const heights = new Float32Array(W * H);
    for (let y = 70; y < 95; y++) for (let x = 85; x < 115; x++) heights[y * W + x] = 6;
    state.map.ground = heights;
    for (let i = 0; i < 200; i++) resolveVehicleHit(state, rng, v, { weapon: WEAPONS.mosin, shooterPos: { x: 100, y: 80 }, shooterSide: 'soviet', distM: 40 });
    expect(men.some((m) => m.health !== 'healthy')).toBe(true);
  });

  it('passengers do not fire on the move, and fire over the sides when halted', () => {
    const { state, v, vteam, men, rng } = loaded();
    const foe = squad(state, 30, 3, { x: 100, y: 75 }, 'rifle', 'soviet');
    for (const f of foe.men) { f.ammo = 0; f.ammoReserve = 0; }
    v.coaxAmmo = 0; // the halftrack's own MG stays out of it
    const see = (): void => { for (const f of foe.men) state.spotted.german.add(f.id); };
    applyOrder(state, vteam, { type: 'move', target: { x: 160, y: 100 }, issuedAt: state.time }, rng);
    step(state, rng, 3);
    const t0 = state.time;
    step(state, rng, 6, { combat: true, each: see });
    expect(men.every((m) => m.lastFiredAt < t0)).toBe(true);
    applyOrder(state, vteam, { type: 'defend', target: { x: 100, y: 0 }, issuedAt: state.time }, rng);
    step(state, rng, 3);
    const t1 = state.time;
    step(state, rng, 25, { combat: true, each: see });
    expect(men.some((m) => m.lastFiredAt > t1)).toBe(true);
    expect(men.every((m) => m.vehicleId === v.id)).toBe(true);
  });
});

describe('dismounting', () => {
  it('a Dismount order unloads one man at a time; they settle behind the vehicle, away from the threat', () => {
    const { state, v, vteam, team, men, rng } = scene(8);
    mount(state, team, v, rng);
    step(state, rng, 40);
    // the enemy is believed to be dead ahead (north)
    const foe = squad(state, 30, 3, { x: 100, y: 40 }, 'rifle', 'soviet');
    for (const f of foe.men) { f.ammo = 0; f.ammoReserve = 0; state.spotted.german.add(f.id); }
    applyOrder(state, vteam, { type: 'defend', target: { x: 100, y: 0 }, issuedAt: state.time, dismount: true }, rng);
    let maxClimbing = 0, t = 0;
    while (aboard(men, v).length + men.filter((m) => m.hatch).length > 0 && t < 60) { step(state, rng, 0.1); t += 0.1; maxClimbing = Math.max(maxClimbing, men.filter((m) => m.hatch).length); }
    expect(maxClimbing).toBe(1);
    expect(t).toBeGreaterThan(7 * BOARD_S);
    step(state, rng, 12);
    const toThreat = angleTo(v.pos, foe.men[0].pos);
    for (const m of men) {
      expect(m.vehicleId).toBeNull();
      expect(m.seat).toBeUndefined();
      const rel = Math.abs(wrapAngle(angleTo(v.pos, m.pos) - toThreat));
      expect(rel).toBeGreaterThan(Math.PI / 2); // behind the hull as seen from the enemy
      expect(dist(m.pos, v.pos) * TILE_M).toBeLessThan(15);
    }
    expect(team.transportId).toBeUndefined();
  });

  it('any order to the riding team gets it out first, then it carries the order out', () => {
    const { state, v, team, men, rng } = scene(5);
    mount(state, team, v, rng);
    step(state, rng, 30);
    expect(aboard(men, v).length).toBe(5);
    applyOrder(state, team, { type: 'move', target: { x: 130, y: 120 }, issuedAt: state.time }, rng);
    step(state, rng, 60);
    expect(aboard(men, v).length).toBe(0);
    for (const m of men) expect(dist(m.pos, { x: 130, y: 120 }) * TILE_M).toBeLessThan(12);
  });

  it('a burning halftrack ejects everyone', () => {
    const { state, v, team, men, rng } = scene(8);
    mount(state, team, v, rng);
    step(state, rng, 40);
    v.state = 'burning';
    step(state, rng, 8);
    for (const m of men) if (m.health !== 'dead' && m.health !== 'incapacitated') { expect(m.vehicleId).toBeNull(); expect(m.hatch).toBeUndefined(); }
    expect(men.some((m) => m.vehicleId === null)).toBe(true);
  });
});

describe('determinism', () => {
  it('the same seed gives the same ride', () => {
    const run = (): string => {
      const { state, v, vteam, team, rng } = scene(9);
      mount(state, team, v, rng);
      step(state, rng, 30, { combat: true });
      applyOrder(state, vteam, { type: 'move', target: { x: 100, y: 60 }, issuedAt: state.time }, rng);
      step(state, rng, 15, { combat: true });
      applyOrder(state, vteam, { type: 'defend', target: { x: 100, y: 0 }, issuedAt: state.time, dismount: true }, rng);
      step(state, rng, 30, { combat: true });
      return JSON.stringify([Array.from(state.vehicles.values()), Array.from(state.soldiers.values()).map((s) => [s.id, s.health, s.vehicleId, s.seat, s.pos, s.hatch])]);
    };
    expect(run()).toBe(run());
  });
});
