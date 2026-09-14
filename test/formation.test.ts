import { describe, it, expect } from 'vitest';
import type { BattleConfig, BattleState, GameMap, MapDef, Order, Team, Terrain, Vec2 } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { TEAM_DEFS } from '@/data/units';
import { spawnTeam, naturalFormation, rotateOffset, formationBaseHeading } from '@/sim/spawn';
import { applyOrder, applyOrderToSoldier, orderSlotOffset } from '@/sim/orders';
import { coverScore } from '@/sim/cover';

const W = 60, H = 60;

function makeMap(setup?: (tiles: Terrain[]) => void): GameMap {
  const tiles: Terrain[] = new Array(W * H).fill('open');
  setup?.(tiles);
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: W, height: H, season: 'summer',
    paint: () => {}, victoryLocations: [],
    // soviet zone north of the german one: the German deploy heading is north (0 rad)
    deployZones: { german: { x: 0, y: 50, w: 60, h: 10 }, soviet: { x: 0, y: 0, w: 60, h: 10 } },
    attacker: 'german',
  };
  return {
    def, width: W, height: H, tiles,
    buildingId: new Int16Array(W * H).fill(-1), windows: new Uint8Array(W * H),
    victoryLocations: [], smoke: new Float32Array(W * H), craters: [],
  };
}

function makeState(map: GameMap): BattleState {
  const config: BattleConfig = {
    mapId: 'test', playerSide: 'german', year: 1943, seed: 1, durationS: 1200,
    difficulty: 'normal', forces: { german: [], soviet: [] },
  };
  return {
    config, map, phase: 'running', time: 0,
    soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted: { german: new Set(), soviet: new Set() },
    spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [],
    result: null, events: [], nextId: 100,
  };
}

const tileKey = (p: Vec2) => `${Math.floor(p.x)},${Math.floor(p.y)}`;

/** Make every soldier of the team obey (obedience p clamps to 0.98; retry failed rolls). */
function obedient(state: BattleState, team: Team): void {
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id)!;
    s.mind.motivation = 100; s.experience = 100; s.mind.fear = 0;
  }
}

function orderAll(state: BattleState, team: Team, order: Order, rng: Rng): void {
  applyOrder(state, team, order, rng);
  // a failed obedience roll (p is capped at 0.98) just hesitates: retry like mind.ts does
  for (let tries = 0; tries < 10; tries++) {
    for (const id of team.soldierIds) {
      const s = state.soldiers.get(id)!;
      if (s.path.length === 0) { s.mind.hesitation = 0; applyOrderToSoldier(state, team, s, rng); }
    }
  }
  expect(team.soldierIds.every((id) => state.soldiers.get(id)!.path.length > 0)).toBe(true);
}

const infantryDefs = Object.values(TEAM_DEFS).filter((d) => !d.vehicleDefId);

describe('natural formations', () => {
  it('no two soldiers of a team share a tile after spawn', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const state = makeState(makeMap());
      const rng = new Rng(seed);
      for (const def of infantryDefs) {
        const team = spawnTeam(state, def, def.side, { x: 30.5, y: 30.5 }, rng);
        const keys = team.soldierIds.map((id) => tileKey(state.soldiers.get(id)!.pos));
        expect(new Set(keys).size).toBe(keys.length);
      }
    }
  });

  it('keeps men on separate tiles next to impassable ground and the map edge', () => {
    const map = makeMap((tiles) => { for (let y = 0; y < H; y++) for (let x = 0; x < 3; x++) tiles[y * W + x] = 'water'; });
    const state = makeState(map);
    const rng = new Rng(7);
    for (const def of infantryDefs) {
      const team = spawnTeam(state, def, def.side, { x: 3.5, y: 58.5 }, rng);
      const ps = team.soldierIds.map((id) => state.soldiers.get(id)!.pos);
      expect(new Set(ps.map(tileKey)).size).toBe(ps.length);
      for (const p of ps) {
        expect(p.x).toBeGreaterThanOrEqual(3); expect(p.y).toBeLessThan(H);
      }
    }
  });

  it("a squad's offsets are not all on one row or column, and never form rows", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const rng = new Rng(seed);
      for (const def of infantryDefs) {
        const offs = naturalFormation(def, rng);
        expect(offs[0]).toEqual({ x: 0, y: 0 });
        for (let i = 0; i < offs.length; i++) {
          for (let k = i + 1; k < offs.length; k++) {
            expect(Math.hypot(offs[i].x - offs[k].x, offs[i].y - offs[k].y)).toBeGreaterThanOrEqual(1.45);
          }
        }
        if (offs.length < 3) continue;
        const xs = offs.map((o) => o.x), ys = offs.map((o) => o.y);
        expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.5);
        expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.5);
        // no three men on one exact row or column (a grid has 3-4 per row)
        for (const o of offs) {
          expect(offs.filter((q) => Math.abs(q.y - o.y) < 0.01).length).toBeLessThanOrEqual(2);
          expect(offs.filter((q) => Math.abs(q.x - o.x) < 0.01).length).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('rifle squads spread 2-3 tiles apart; MG and mortar crews cluster tightly', () => {
    const rng = new Rng(3);
    const rifle = infantryDefs.find((d) => d.type === 'rifle' && d.soldiers.length >= 8)!;
    const mg = infantryDefs.find((d) => d.type === 'mg')!;
    const spanOf = (offs: Vec2[]) => Math.max(...offs.map((o) => Math.hypot(o.x, o.y)));
    for (let i = 0; i < 5; i++) {
      expect(spanOf(naturalFormation(rifle, rng))).toBeGreaterThan(5);
      expect(spanOf(naturalFormation(mg, rng))).toBeLessThan(4.5);
    }
  });
});

describe('formation follows the order direction', () => {
  it('rotates slot offsets with the direction of travel', () => {
    const def = infantryDefs.find((d) => d.type === 'rifle')!;
    const run = (target: Vec2) => {
      const state = makeState(makeMap());
      const rng = new Rng(11);
      const team = spawnTeam(state, def, 'german', { x: 30.5, y: 30.5 }, rng);
      obedient(state, team);
      const order: Order = { type: 'move', target, issuedAt: 0 };
      orderAll(state, team, order, rng);
      return { state, team, order };
    };
    const north = run({ x: 30.5, y: 10.5 });
    const east = run({ x: 50.5, y: 30.5 });
    expect(formationBaseHeading(north.state.map, 'german')).toBeCloseTo(0, 6);
    for (let i = 0; i < north.team.soldierIds.length; i++) {
      const sn = north.state.soldiers.get(north.team.soldierIds[i])!;
      const se = east.state.soldiers.get(east.team.soldierIds[i])!;
      const on = orderSlotOffset(north.state, north.team, sn, north.order);
      const oe = orderSlotOffset(east.state, east.team, se, east.order);
      // moving north keeps the deploy-heading shape; moving east turns it 90 degrees clockwise
      expect(on.x).toBeCloseTo(sn.formationOffset.x, 6);
      expect(on.y).toBeCloseTo(sn.formationOffset.y, 6);
      const r = rotateOffset(on, Math.PI / 2);
      expect(oe.x).toBeCloseTo(r.x, 6);
      expect(oe.y).toBeCloseTo(r.y, 6);
      // each man's path ends near his rotated slot (settling moves him at most ~2 tiles)
      const endE = se.path[se.path.length - 1];
      expect(Math.hypot(endE.x - (east.order.target.x + oe.x), endE.y - (east.order.target.y + oe.y))).toBeLessThan(2.9);
    }
    // the destinations differ in shape between the two orders (not map-axis aligned)
    const spread = (st: BattleState, t: Team, target: Vec2, axis: 'x' | 'y') => {
      const v = t.soldierIds.map((id) => { const p = st.soldiers.get(id)!.path; return p[p.length - 1][axis] - target[axis]; });
      return Math.max(...v) - Math.min(...v);
    };
    const nx = spread(north.state, north.team, north.order.target, 'x');
    const ex = spread(east.state, east.team, east.order.target, 'x');
    const ny = spread(north.state, north.team, north.order.target, 'y');
    const ey = spread(east.state, east.team, east.order.target, 'y');
    expect(Math.abs(nx - ey)).toBeLessThan(4.5);
    expect(Math.abs(ny - ex)).toBeLessThan(4.5);
  });

  it('arriving soldiers have unique destination tiles and stay within ~4 tiles of their slot en route', () => {
    const def = infantryDefs.find((d) => d.type === 'rifle' && d.soldiers.length >= 8)!;
    const state = makeState(makeMap());
    const rng = new Rng(5);
    const team = spawnTeam(state, def, 'german', { x: 30.5, y: 50.5 }, rng);
    obedient(state, team);
    const order: Order = { type: 'move', target: { x: 30.5, y: 20.5 }, issuedAt: 0 };
    orderAll(state, team, order, rng);
    const leader = state.soldiers.get(team.leaderId)!;
    const lp = leader.path;
    const ends = team.soldierIds.map((id) => { const p = state.soldiers.get(id)!.path; return tileKey(p[p.length - 1]); });
    expect(new Set(ends).size).toBe(ends.length);
    let drifted = false;
    for (const id of team.soldierIds) {
      if (id === team.leaderId) continue;
      const s = state.soldiers.get(id)!;
      const off = orderSlotOffset(state, team, s, order);
      // compare the shifted tail of the route with the leader's route
      const tail = s.path.slice(-lp.length);
      for (let i = 0; i < Math.min(tail.length, lp.length) - 1; i++) {
        const dx = tail[i].x - (lp[i].x + off.x), dy = tail[i].y - (lp[i].y + off.y);
        const d = Math.hypot(dx, dy);
        expect(d).toBeLessThanOrEqual(4);
        if (d > 0.3) drifted = true;
      }
    }
    expect(drifted).toBe(true);
  });
});

describe('arrival settling', () => {
  it('arriving soldiers prefer cover tiles near their slot', () => {
    const wallY = 18;
    const def = infantryDefs.find((d) => d.type === 'rifle' && d.soldiers.length >= 8)!;
    const run = (withWall: boolean) => {
      const map = makeMap((tiles) => { if (withWall) for (let x = 5; x < 55; x++) tiles[wallY * W + x] = 'stonewall'; });
      const state = makeState(map);
      const rng = new Rng(9);
      const team = spawnTeam(state, def, 'german', { x: 30.5, y: 50.5 }, rng);
      obedient(state, team);
      const order: Order = { type: 'move', target: { x: 30.5, y: wallY + 1.5 }, issuedAt: 0 };
      orderAll(state, team, order, rng);
      return team.soldierIds.map((id) => { const p = state.soldiers.get(id)!.path; return { end: p[p.length - 1], map }; });
    };
    const threat = [{ dirRad: 0, weight: 1 }];
    const walled = run(true);
    const open = run(false);
    const behindWall = walled.filter((r) => Math.floor(r.end.y) === wallY + 1).length;
    const behindOpen = open.filter((r) => Math.floor(r.end.y) === wallY + 1).length;
    expect(behindWall).toBeGreaterThan(behindOpen);
    const meanCover = (rs: { end: Vec2; map: GameMap }[]) => rs.reduce((a, r) => a + coverScore(r.map, r.end, threat), 0) / rs.length;
    expect(meanCover(walled)).toBeGreaterThan(meanCover(open) + 0.2);
  });
});
