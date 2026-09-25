import { describe, it, expect } from 'vitest';
import { buildMap } from '../src/sim/map';
import { Battle } from '../src/sim/battle';
import { applyOrder } from '../src/sim/orders';
import { getMap } from '../src/data/maps';
import { wireAt, cutWireNear, WIRE_INTACT, WIRE_CUT, wireSpeedMul, WIRE_SPEED_MUL } from '../src/sim/wire';
import { setMineAt, MINE_AP, mineAt, MINE_NONE } from '../src/sim/mines';
import { BUNKER_COVER, coverFrom } from '../src/sim/cover';
import type { BattleConfig, MapDef, Side } from '../src/shared/types';

interface WireRun { x: number; y: number; }

function mapWithWire(wire: WireRun[]): MapDef {
  const def = getMap('border_1941');
  def.wire = [{ tiles: wire }];
  return def;
}

function battleWithMap(mapDef: MapDef): Battle {
  const battle = new Battle({
    mapId: mapDef.id ?? 'border_1941',
    playerSide: 'german',
    year: 1941,
    seed: 7,
    durationS: 600,
    difficulty: 'normal',
    forces: { german: ['ger_rifle_41'], soviet: ['sov_rifle_41'] },
  } as BattleConfig);
  return battle;
}

describe('wire (G7)', () => {
  it('authored wire builds the per-tile array and reports per-tile state', () => {
    const map = buildMap(mapWithWire([{ x: 10, y: 10 }, { x: 11, y: 10 }]));
    expect(wireAt(map, 10, 10)).toBe(WIRE_INTACT);
    expect(wireAt(map, 11, 10)).toBe(WIRE_INTACT);
    expect(wireAt(map, 12, 10)).toBe(0);
    expect(wireSpeedMul(map, 10.5, 10.5)).toBe(WIRE_SPEED_MUL);
    expect(wireSpeedMul(map, 12.5, 10.5)).toBe(1);
  });

  it('intact wire slows a walking squad to a crawl; cut wire does not', () => {
    const wire = [{ x: 30, y: 40 }];
    const battle = battleWithMap(mapWithWire(wire));
    battle.start();
    const team = [...battle.state.teams.values()].find((t) => t.side === 'german')!;
    team.pos = { x: 26, y: 40 };
    applyOrder(battle.state, team, { type: 'move', target: { x: 40, y: 40 }, issuedAt: 0 }, battle.rng);
    const withWire = runUntil(battle, (b) => b.state.soldiers.get(team.leaderId)!.pos.x >= 29.5, 30);
    expect(withWire).toBeGreaterThan(4); // slowed: >4 s to cross ~4 tiles
  });

  it('an engineer cuts the wire tile adjacent to him', () => {
    const battle = battleWithMap(mapWithWire([{ x: 30, y: 20 }]));
    const map = battle.state.map;
    battle.start();
    const team = [...battle.state.teams.values()].find((t) => t.side === 'german')!;
    const eng = battle.state.soldiers.get(team.soldierIds[0])!;
    eng.pos = { x: 30.5, y: 21.5 };
    expect(cutWireNear(battle.state, eng)).toBe(true);
    expect(wireAt(map, 30, 20)).toBe(WIRE_CUT);
    expect(cutWireNear(battle.state, eng)).toBe(false); // nothing left adjacent
  });

  it('same seed produces the same crossing time (determinism)', () => {
    const run = () => {
      const battle = battleWithMap(mapWithWire([{ x: 30, y: 40 }]));
      battle.start();
      const team = [...battle.state.teams.values()].find((t) => t.side === 'german')!;
      team.pos = { x: 26, y: 40 };
      applyOrder(battle.state, team, { type: 'move', target: { x: 40, y: 40 }, issuedAt: 0 }, battle.rng);
      return runUntil(battle, (b) => b.state.soldiers.get(team.leaderId)!.pos.x >= 38, 60);
    };
    expect(run()).toEqual(run());
  });
});

function runUntil(battle: Battle, pred: (b: Battle) => boolean, maxS: number): number {
  let t = 0;
  while (t < maxS) {
    battle.step(0.1);
    t += 0.1;
    if (pred(battle)) return t;
  }
  return t;
}

describe('bunkers (G7)', () => {
  it('bunker interior gives heavy omni cover from every direction', () => {
    const def = getMap('border_1941');
    def.bunkers = [{ x: 30, y: 20, w: 2, h: 2, side: 'soviet' as Side }];
    const map = buildMap(def);
    expect(map.bunkerId![20 * map.width + 30]).toBe(0);
    expect(map.bunkerId![21 * map.width + 31]).toBe(0);
    expect(map.bunkerId![19 * map.width + 30]).toBe(-1); // outside
    expect(coverFrom(map, { x: 30.5, y: 20.5 }, 0)).toBeGreaterThanOrEqual(BUNKER_COVER);
    expect(coverFrom(map, { x: 30.5, y: 20.5 }, Math.PI)).toBeGreaterThanOrEqual(BUNKER_COVER);
  });

  it('engineer step clears mines slowly while stationary', () => {
    // swap the rifle team for engineers so the clearing behavior engages
    const battle = new Battle({
      mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 7, durationS: 600, difficulty: 'normal',
      forces: { german: ['ger_engineers'], soviet: ['sov_rifle_41'] },
    } as BattleConfig);
    battle.start();
    const map = battle.state.map;
    setMineAt(map, 30, 20, MINE_AP);
    const team = [...battle.state.teams.values()].find((t) => t.side === 'german')!;
    const eng = battle.state.soldiers.get(team.soldierIds[0])!;
    eng.pos = { x: 30.5, y: 20.5 };
    eng.activity = 'defending';
    let cleared = false;
    for (let i = 0; i < 400 && !cleared; i++) {
      battle.step(0.1);
      cleared = mineAt(map, 30, 20) === MINE_NONE;
    }
    expect(cleared).toBe(true);
  });
});
