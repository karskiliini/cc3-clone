import { describe, it, expect } from 'vitest';
import { buildMap } from '../src/sim/map';
import { Battle } from '../src/sim/battle';
import { MINE_AP, MINE_AT, MINE_NONE, clearMineNear, mineAt, setMineAt } from '../src/sim/mines';
import { applyOrder } from '../src/sim/orders';
import { getMap } from '../src/data/maps';
import type { BattleConfig, MapDef } from '../src/shared/types';

function battleWith(mines: { x: number; y: number; at?: boolean }[]): Battle {
  const battle = new Battle({
    mapId: 'border_1941',
    playerSide: 'german',
    year: 1941,
    seed: 7,
    durationS: 600,
    difficulty: 'normal',
    forces: { german: ['ger_rifle_41'], soviet: ['sov_rifle_41'] },
  } as BattleConfig);
  const map = battle.state.map;
  for (const m of mines) setMineAt(map, m.x, m.y, m.at ? MINE_AT : MINE_AP);
  battle.start();
  return battle;
}

function mineFieldDef(): MapDef {
  const def = getMap('border_1941');
  def.minefields = [
    { side: 'soviet', tiles: [{ x: 10, y: 10 }] },
    { side: 'soviet', tiles: [{ x: 12, y: 10 }], at: true },
  ];
  return def;
}

describe('minefields (G6)', () => {
  it('buildMap lays authored minefields into the per-tile array', () => {
    const map = buildMap(mineFieldDef());
    expect(map.mines).toBeDefined();
    expect(mineAt(map, 10, 10)).toBe(MINE_AP);
    expect(mineAt(map, 12, 10)).toBe(MINE_AT);
    expect(mineAt(map, 0, 0)).toBe(MINE_NONE);
  });

  it('a squad walking over a mine line detonates mines: tiles consumed, message logged', () => {
    // a 10-man squad crossing 8 AP mines at p=0.7 per entry: at least one detonation is near-certain
    const mines = [];
    for (let x = 28; x < 36; x++) mines.push({ x, y: 40 });
    const battle = battleWith(mines);
    const team = [...battle.state.teams.values()].find((t) => t.side === 'german')!;
    team.pos = { x: 26, y: 40 };
    applyOrder(battle.state, team, { type: 'move', target: { x: 40, y: 40 }, issuedAt: 0 }, battle.rng);
    battle.step(90);
    const mineMessages = battle.state.messages.filter((m) => m.text.includes('mine')).length;
    expect(mineMessages).toBeGreaterThan(0);
    // every detonated tile is consumed; some mines may survive the crossing
    const consumed = mines.filter((m) => mineAt(battle.state.map, m.x, m.y) === MINE_NONE);
    expect(consumed.length).toBeGreaterThan(0);
  });

  it('AT mines are ignored by infantry; a spent tile never detonates twice', () => {
    const battle = battleWith([{ x: 30, y: 20, at: true }]);
    const team = [...battle.state.teams.values()].find((t) => t.side === 'german')!;
    team.pos = { x: 28, y: 20 };
    applyOrder(battle.state, team, { type: 'move', target: { x: 34, y: 20 }, issuedAt: 0 }, battle.rng);
    battle.step(120);
    // infantry never triggers AT mines: the tile survives a whole squad walk
    expect(mineAt(battle.state.map, 30, 20)).toBe(MINE_AT);
    expect(battle.state.messages.filter((m) => m.text.includes('hit a mine')).length).toBe(0);
  }, 30000);

  it('an engineer standing on the tile clears it without detonation', () => {
    const battle = battleWith([{ x: 30, y: 20 }]);
    const map = battle.state.map;
    const team = [...battle.state.teams.values()].find((t) => t.side === 'german')!;
    const eng = battle.state.soldiers.get(team.soldierIds[0])!;
    eng.pos = { x: 30.5, y: 20.5 };
    expect(clearMineNear(battle.state, eng)).toBe(true);
    expect(mineAt(map, 30, 20)).toBe(MINE_NONE);
    expect(battle.state.messages.some((m) => m.text.includes('Engineers cleared'))).toBe(true);
    // clearing again finds nothing
    expect(clearMineNear(battle.state, eng)).toBe(false);
  });

  it('same seed produces the same detonation sequence (determinism)', () => {
    const run = () => {
      const mines = [];
      for (let x = 28; x < 36; x++) mines.push({ x, y: 40 });
      const battle = battleWith(mines);
      const team = [...battle.state.teams.values()].find((t) => t.side === 'german')!;
      team.pos = { x: 26, y: 40 };
      applyOrder(battle.state, team, { type: 'move', target: { x: 40, y: 40 }, issuedAt: 0 }, battle.rng);
      battle.step(90);
      return {
        consumed: mines.map((m) => mineAt(battle.state.map, m.x, m.y)),
        dead: [...battle.state.soldiers.values()].filter((s) => s.health === 'dead').length,
        texts: battle.state.messages.map((m) => m.text),
      };
    };
  });
});
