import { describe, expect, it } from 'vitest';
import { stepCoverSeeking } from '@/sim/coverSeek';
import { seekBuildingStation } from '@/sim/buildingStations';
import { stepMovement } from '@/sim/movement';
import { stepCombat } from '@/sim/combat';
import { hasLineOfFire } from '@/sim/los';
import { Rng } from '@/shared/rng';
import { makeSoldier, makeState, makeTeam, W } from './kitHelpers';

function room() {
  const state = makeState(), s = makeSoldier({ pos: { x: 12.5, y: 13.5 }, grenades: 0, facing: 2 });
  const team = makeTeam(state, 1, [s]); team.facing = 2;
  for (let y = 10; y <= 16; y++) for (let x = 10; x <= 16; x++) {
    const i = y * W + x; state.map.tiles[i] = x === 10 || x === 16 || y === 10 || y === 16 ? 'buildingStone' : 'floor';
    state.map.buildingId[i] = 1;
  }
  state.map.windows[12 * W + 16] = 1; state.map.windows[14 * W + 16] = 1;
  team.order = { type: 'fire', target: { x: 30.5, y: 13.5 }, issuedAt: state.time };
  return { state, s, team };
}

describe('building firing stations', () => {
  it('finds a reachable window toward ordered fire and keeps the fire order', () => {
    const { state, s, team } = room(), order = team.order;
    expect(hasLineOfFire(state.map, s.pos, order!.target)).toBe(false);
    stepCoverSeeking(state, new Rng(1), 0.1);
    const end = s.path.at(-1)!;
    expect(end.x).toBe(16.5); expect([12.5, 14.5]).toContain(end.y);
    expect(hasLineOfFire(state.map, end, order!.target)).toBe(true);
    expect(s.path.every(p => state.map.buildingId[Math.floor(p.y) * W + Math.floor(p.x)] === 1)).toBe(true);
    expect(team.order).toBe(order); expect(s.activity).toBe('moving');
  });
  it('moves there and actually fires through the opening in the real movement/combat loop', () => {
    const { state, s } = room(), rng = new Rng(3), ammo = s.ammo;
    for (let i = 0; i < 500; i++) {
      state.time += 0.1; stepCoverSeeking(state, rng, 0.1); stepMovement(state, rng, 0.1); stepCombat(state, rng, 0.1);
    }
    expect(s.pos.x).toBeGreaterThan(15.5); expect(s.ammo).toBeLessThan(ammo);
    expect(state.events.some(e => e.kind === 'shot')).toBe(true);
  });
  it('reserves different openings for nearby squad members', () => {
    const { state, s, team } = room();
    const second = makeSoldier({ id: 2, pos: { x: 12.5, y: 14.5 }, grenades: 0 });
    state.soldiers.set(2, second); team.soldierIds.push(2);
    seekBuildingStation(state, s, team); seekBuildingStation(state, second, team);
    expect(s.path.at(-1)).not.toEqual(second.path.at(-1));
    expect(s.path.length).toBeGreaterThan(0); expect(second.path.length).toBeGreaterThan(0);
    const third = makeSoldier({ id: 3, pos: { x: 11.5, y: 13.5 }, grenades: 0 });
    state.soldiers.set(3, third); team.soldierIds.push(3); seekBuildingStation(state, third, team);
    expect(third.path).toEqual([]);
  });
  it('settles at a window without needing a contact first', () => {
    const { state, s, team } = room(); team.order = null;
    expect(seekBuildingStation(state, s, team)).toBe(true); expect(s.path.at(-1)?.x).toBe(16.5);
  });
  it.each(['defend', 'ambush'] as const)('uses the %s facing to choose the correct wall', type => {
    const { state, s, team } = room(); team.facing = 0;
    state.map.windows[10 * W + 12] = 1;
    team.order = { type, target: { x: 12.5, y: 0.5 }, issuedAt: state.time };
    seekBuildingStation(state, s, team);
    expect(s.path.at(-1)).toEqual({ x: 12.5, y: 10.5 });
  });
  it('does not override movement, treatment, panic, or incapacitation', () => {
    for (const condition of ['move', 'treat', 'reload', 'panic', 'incapacitated'] as const) {
      const { state, s, team } = room();
      if (condition === 'move') team.order!.type = 'move';
      if (condition === 'treat') s.bandageUntil = state.time + 10;
      if (condition === 'reload') s.reloadTimer = 3;
      if (condition === 'panic') s.mind.state = 'panicked';
      if (condition === 'incapacitated') s.health = 'incapacitated';
      expect(seekBuildingStation(state, s, team)).toBe(false); expect(s.path).toEqual([]);
    }
  });
  it('stays indoors when all openings are blocked or occupied', () => {
    const { state, s, team } = room(); state.map.windows.fill(0);
    seekBuildingStation(state, s, team); expect(s.path).toEqual([]);
  });
  it('lets ordinary cover seeking handle a destroyed room instead of treating rubble as an interior', () => {
    const { state, s, team } = room();
    state.map.tiles[Math.floor(s.pos.y) * W + Math.floor(s.pos.x)] = 'rubble';
    expect(seekBuildingStation(state, s, team)).toBe(false); expect(s.path).toEqual([]);
  });
});
