import { describe, it, expect } from 'vitest';
import { Battle } from '@/sim/battle';
import { applyOrder } from '@/sim/orders';
import { isPassable } from '@/sim/path';
import { pickOrderMarker, orderLinePoints } from '@/render/orderMarkers';
import { SIM_DT, TILE_PX } from '@/shared/types';
import type { BattleConfig, BattleState, Camera, Team, Vec2 } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';

function config(german: string[], year = 1941): BattleConfig {
  return {
    mapId: 'border_1941', playerSide: 'german', year, seed: 2, durationS: 600,
    difficulty: 'normal', forces: { german, soviet: ['sov_rifle_41'] },
  };
}

function obedient(rng: Rng): Rng {
  return new Proxy(rng, {
    get(obj, prop) {
      if (prop === 'chance') return () => true;
      const v = Reflect.get(obj, prop);
      return typeof v === 'function' ? v.bind(obj) : v;
    },
  }) as Rng;
}

/** A passable point near `p` (spiral search). */
function passableNear(state: BattleState, p: Vec2, mover: 'infantry' | 'vehicle'): Vec2 {
  for (let r = 0; r < 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.floor(p.x) + dx, y = Math.floor(p.y) + dy;
        if (isPassable(state.map, x, y, mover)) return { x: x + 0.5, y: y + 0.5 };
      }
    }
  }
  return p;
}

/** Returns the times the tracked position first came within `r` tiles of each point. */
function visitTimes(battle: Battle, pos: () => Vec2, points: Vec2[], r: number, maxS: number): number[] {
  const times = points.map(() => Infinity);
  for (let t = 0; t < maxS; t += SIM_DT) {
    battle.step(SIM_DT);
    const p = pos();
    points.forEach((q, i) => { if (times[i] === Infinity && dist(p, q) <= r) times[i] = t; });
    if (times[times.length - 1] < Infinity) break;
  }
  return times;
}

describe('move orders with waypoints', () => {
  it('an infantry team visits its waypoints in click order before the target', () => {
    const battle = new Battle(config(['ger_rifle_41']));
    battle.start();
    const st = battle.state;
    const team = battle.selectableTeams('german')[0];
    const leader = st.soldiers.get(team.leaderId)!;
    const o = leader.pos;
    // a dog-leg: out 10 tiles, across 10, back: the straight line to the target never passes the waypoints
    const wp1 = passableNear(st, { x: o.x + 10, y: o.y }, 'infantry');
    const wp2 = passableNear(st, { x: o.x + 10, y: o.y + 10 }, 'infantry');
    const target = passableNear(st, { x: o.x, y: o.y + 10 }, 'infantry');
    const clicked = [wp1, wp2];
    applyOrder(st, team, { type: 'move', target, waypoints: clicked, issuedAt: st.time }, obedient(battle.rng));
    expect(team.order!.waypoints).toEqual(clicked);
    expect(team.order!.waypoints).not.toBe(clicked); // the UI's list is copied, not consumed
    const times = visitTimes(battle, () => leader.pos, [wp1, wp2, target], 1.5, 120);
    expect(times[0]).toBeLessThan(Infinity);
    expect(times[0]).toBeLessThan(times[1]);
    expect(times[1]).toBeLessThan(times[2]);
    // passed waypoints are consumed
    expect(team.order!.waypoints ?? []).toHaveLength(0);
  });

  it('a vehicle follows its waypoints', () => {
    const battle = new Battle(config(['ger_pz3j']));
    battle.start();
    const st = battle.state;
    const team = battle.selectableTeams('german')[0];
    const v = st.vehicles.get(team.vehicleId!)!;
    const o = v.pos;
    const wp1 = passableNear(st, { x: o.x + 12, y: o.y }, 'vehicle');
    const target = passableNear(st, { x: o.x + 12, y: o.y + 12 }, 'vehicle');
    applyOrder(st, team, { type: 'move', target, waypoints: [wp1], issuedAt: st.time }, obedient(battle.rng));
    const times = visitTimes(battle, () => v.pos, [wp1, target], 1.5, 180);
    expect(times[0]).toBeLessThan(Infinity);
    expect(times[0]).toBeLessThan(times[1]);
  });
});

describe('order markers', () => {
  function markerState(): { battle: Battle; st: BattleState; teams: Team[]; cam: Camera } {
    const battle = new Battle({ ...config(['ger_rifle_41', 'ger_rifle_41']), forces: { german: ['ger_rifle_41', 'ger_rifle_41'], soviet: ['sov_rifle_41'] } });
    battle.start();
    const st = battle.state;
    const teams = battle.selectableTeams('german');
    return { battle, st, teams, cam: { x: 0, y: 0, zoom: 1 } };
  }
  const screen = (p: Vec2): Vec2 => ({ x: p.x * TILE_PX, y: p.y * TILE_PX });

  it('the drawn point list is team, waypoints (in order), then target', () => {
    const { st, teams } = markerState();
    const t = teams[0];
    t.order = { type: 'move', target: { x: 30, y: 30 }, waypoints: [{ x: 10, y: 10 }, { x: 20, y: 20 }], issuedAt: st.time };
    expect(orderLinePoints(t)).toEqual([t.pos, { x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }]);
  });

  it('pickOrderMarker: hit, miss, nearest of two, waypoint hit, ignores enemy teams', () => {
    const { st, teams, cam } = markerState();
    const [a, b] = teams;
    a.order = { type: 'move', target: { x: 30, y: 30 }, waypoints: [{ x: 10, y: 12 }], issuedAt: st.time };
    b.order = { type: 'fire', target: { x: 30.5, y: 30 }, issuedAt: st.time };
    // hit
    expect(pickOrderMarker(st, cam, screen({ x: 30, y: 30 }), 'german')).toEqual({ teamId: a.id, kind: 'target', index: 0 });
    // nearest of two (b's target is 10 px right of a's)
    const nearB = { x: 30.5 * TILE_PX - 2, y: 30 * TILE_PX };
    expect(pickOrderMarker(st, cam, nearB, 'german')?.teamId).toBe(b.id);
    // miss
    expect(pickOrderMarker(st, cam, { x: 30 * TILE_PX, y: 30 * TILE_PX + 20 }, 'german')).toBeNull();
    // waypoint hit
    expect(pickOrderMarker(st, cam, { x: 10 * TILE_PX + 3, y: 12 * TILE_PX - 3 }, 'german')).toEqual({ teamId: a.id, kind: 'waypoint', index: 0 });
    // enemy teams' markers are never picked
    const enemy = Array.from(st.teams.values()).find((t) => t.side === 'soviet')!;
    enemy.order = { type: 'move', target: { x: 50, y: 50 }, issuedAt: st.time };
    expect(pickOrderMarker(st, cam, screen({ x: 50, y: 50 }), 'german')).toBeNull();
    expect(pickOrderMarker(st, cam, screen({ x: 50, y: 50 }), 'soviet')?.teamId).toBe(enemy.id);
  });
});
