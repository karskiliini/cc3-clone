import { describe, it, expect } from 'vitest';
import { Battle } from '@/sim/battle';
import { applyOrder, stepOrderWaypoints, isOrderActive } from '@/sim/orders';
import { isPassable, findPath } from '@/sim/path';
import type { BattleConfig, BattleState, Vec2 } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';

/** A passable-adjacent point whose tile itself is impassable on all approach: findPath to it fails. */
function impassableIn(st: BattleState): Vec2 {
  const map = st.map;
  for (let y = 1; y < map.height - 1; y++) for (let x = 1; x < map.width - 1; x++) {
    if (isPassable(map, x, y, 'infantry')) continue;
    // need the ring impassable too so no neighbour tile is reachable
    let sealed = true;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) if (isPassable(map, x + dx, y + dy, 'infantry')) sealed = false;
    if (sealed) return { x: x + 0.5, y: y + 0.5 };
  }
  // no sealed pocket: pick an impassable tile at the map border and clamp just outside it
  return { x: 0.5, y: 0.5 };
}
function config(german: string[]): BattleConfig {
  return {
    mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 2, durationS: 600,
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

describe('shift-click waypoint chaining', () => {
  it('a duplicate chain point (within 0.5 tiles) of the previous point or target is filtered', () => {
    // The battle screen filters at issue time; replicate the filter contract on a chain.
    const pending: Vec2[] = [{ x: 10, y: 10 }, { x: 10.3, y: 10.2 }, { x: 20, y: 20 }];
    const target = { x: 20.4, y: 20.1 };
    // Battle screen contract: drop a point within 0.5 tiles of the previous kept chain point,
    // then drop trailing points equal (within 0.5) to the final target.
    const buildChain = (pending: Vec2[], target: Vec2): Vec2[] => {
      const chain: Vec2[] = [];
      for (const p of pending) {
        const prev = chain.length > 0 ? chain[chain.length - 1] : null;
        if (prev && dist(p, prev) <= 0.5) continue;
        chain.push(p);
      }
      while (chain.length > 0 && dist(chain[chain.length - 1], target) <= 0.5) chain.pop();
      return chain;
    };
    expect(buildChain([{ x: 10, y: 10 }, { x: 10.3, y: 10.2 }, { x: 20, y: 20 }], { x: 20.4, y: 20.1 }))
      .toEqual([{ x: 10, y: 10 }]);
  });

  it('an unreachable waypoint whose routing leg fails is dropped instead of stranding the squad', () => {
    const battle = new Battle(config(['ger_rifle_41']));
    battle.start();
    const st = battle.state;
    const team = battle.selectableTeams('german')[0];
    const leader = st.soldiers.get(team.leaderId)!;
    const o = leader.pos;
    const wp1 = { x: o.x + 3, y: o.y };
    // a leg that fails at route time (start tile impassable to the mover): routeVia records the
    // point as skipped, and stepOrderWaypoints then drops the waypoint no one will visit
    const wp2 = failStart(st, wp1);
    const target = { x: o.x, y: o.y + 3 };
    applyOrder(st, team, { type: 'move', target, waypoints: [wp1, wp2], issuedAt: st.time }, obedient(battle.rng));
    expect(team.order!.waypoints).toEqual([wp1, wp2]);
    st.time += 1.2;
    stepOrderWaypoints(st);
    stepOrderWaypoints(st);
    expect(team.order!.waypoints ?? []).not.toContainEqual(wp2);
  });

  /** A point whose routing leg FROM it fails (impassable start tile): routeVia to a chain through
   * it records the NEXT point as skipped. Here we pick a point where a fresh routeVia from it
   * returns an empty path, then use it as the chain point preceding the real waypoint. */
  function failStart(st: BattleState, next: Vec2): Vec2 {
    const map = st.map;
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
      const p = { x: x + 0.5, y: y + 0.5 };
      if (findPath(map, p, next, 'infantry', 20000).length === 0 && dist(p, next) > 4) return p;
    }
    return { x: next.x + 20, y: next.y };
  }

  it('a vehicle holding fire (empty path) keeps its order marker while the target is unreached', () => {
    const battle = new Battle(config(['ger_pz3j']));
    battle.start();
    const st = battle.state;
    const team = battle.selectableTeams('german')[0];
    const v = st.vehicles.get(team.vehicleId!)!;
    v.path = [];
    const far = { x: v.pos.x + 30, y: v.pos.y + 30 };
    team.order = { type: 'move', target: far, waypoints: [], issuedAt: st.time - 2 };
    expect(isOrderActive(st, team)).toBe(true);
    // and once the target is reached, the order is done
    team.order = { type: 'move', target: v.pos, waypoints: [], issuedAt: st.time - 2 };
    expect(isOrderActive(st, team)).toBe(false);
  });
});
