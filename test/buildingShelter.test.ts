import { describe, expect, it } from 'vitest';
import type { Order, Vec2 } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { applyOrder, applyOrderToSoldier } from '@/sim/orders';
import { stepMovement, resolveSoldierOverlapForTest } from '@/sim/movement';
import { stepCoverSeeking } from '@/sim/coverSeek';
import { buildingDestination, buildingTiles, canStepAside } from '@/sim/buildingShelter';
import { makeState, mkTeam, soldier } from './vehicleDamageHelpers';

const target = { x: 30.5, y: 20.5 };
function setup(count = 8, width = 1, height = 1) {
  const state = makeState(), ids = Array.from({ length: count }, (_, i) => 100 + i);
  const team = mkTeam(1, 'rifle', ids, 'german', { x: 25.5, y: 30.5 });
  state.teams.set(team.id, team);
  for (let i = 0; i < count; i++) {
    const s = soldier(ids[i], team.id, 'german', { x: 25.5 + i * 0.9, y: 30.5 }, 'kar98k');
    s.formationOffset = { x: (i % 3 - 1) * 5, y: Math.floor(i / 3) * 4 };
    s.mind.motivation = 100; s.experience = 100; s.mind.fear = 0;
    state.soldiers.set(s.id, s);
  }
  for (let y = 20; y < 20 + height; y++) for (let x = 30; x < 30 + width; x++) {
    state.map.tiles[y * state.map.width + x] = 'buildingStone';
    state.map.buildingId[y * state.map.width + x] = 0;
  }
  return { state, team, men: ids.map(id => state.soldiers.get(id)!) };
}
function issue(ctx: ReturnType<typeof setup>, type: Order['type'] = 'move') {
  const rng = new Rng(5), order: Order = { type, target, issuedAt: ctx.state.time };
  applyOrder(ctx.state, ctx.team, order, rng);
  for (let i = 0; i < 10; i++) for (const s of ctx.men) if (!s.path.length && dist(s.pos, target) > 1) {
    s.mind.hesitation = 0; applyOrderToSoldier(ctx.state, ctx.team, s, rng);
  }
  return rng;
}
const cell = (p: Vec2) => `${Math.floor(p.x)},${Math.floor(p.y)}`;

describe('individual building shelter', () => {
  for (const type of ['move', 'moveFast', 'sneak', 'assault'] as const) it(`${type}: every follower enters the ordered house despite formation offsets`, () => {
    const ctx = setup(8, 3, 3); issue(ctx, type);
    const rooms = new Set(buildingTiles(ctx.state.map, target).map(cell));
    for (const s of ctx.men) expect(rooms.has(cell(s.path.at(-1)!))).toBe(true);
    expect(new Set(ctx.men.map(s => cell(s.path.at(-1)!))).size).toBe(8);
  });

  it('crowds into a small house rather than retaining exposed formation slots, and stays after arrival', () => {
    const ctx = setup(), rng = issue(ctx);
    const destinations = ctx.men.map(s => s.path.at(-1)!);
    for (const p of destinations) expect(cell(p)).toBe(cell(target));
    for (let i = 0; i < destinations.length; i++) for (let j = i + 1; j < destinations.length; j++) expect(dist(destinations[i], destinations[j])).toBeGreaterThanOrEqual(0.3);
    for (let i = 0; i < 700; i++) {
      ctx.state.time += 0.1; stepCoverSeeking(ctx.state, rng, 0.1); stepMovement(ctx.state, rng, 0.1);
    }
    for (const s of ctx.men) { expect(cell(s.pos)).toBe(cell(target)); expect(s.path).toHaveLength(0); }
  });

  it('uses comparable outdoor cover once comfortable indoor places are occupied', () => {
    const ctx = setup(2), [s, other] = ctx.men;
    other.pos = { ...target };
    ctx.state.map.tiles[20 * ctx.state.map.width + 34] = 'woods';
    const dest = buildingDestination(ctx.state, s, target, target)!;
    expect(cell(dest)).toBe('34,20');
  });

  it('counts physical capacity and other friendly groups instead of overlapping a full room', () => {
    const ctx = setup(1), s = ctx.men[0];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      const p = { x: 30 + (x + 0.5) / 3, y: 20 + (y + 0.5) / 3 }, other = soldier(200 + y * 3 + x, 99, 'german', p, 'kar98k');
      if (x === 0 && y === 0) other.health = 'incapacitated'; // still occupies real floor space
      ctx.state.soldiers.set(other.id, other);
    }
    ctx.state.map.tiles[20 * ctx.state.map.width + 34] = 'scatteredtrees';
    expect(cell(buildingDestination(ctx.state, s, target, target)!)).toBe('34,20');
  });

  it('reserves approaching teammates during individual re-evaluation of newly available shelter', () => {
    const ctx = setup(10);
    ctx.team.order = { type: 'move', target, issuedAt: 0 };
    for (let i = 0; i < 9; i++) {
      ctx.men[i].path = [{ x: 30 + (i % 3 + 0.5) / 3, y: 20 + (Math.floor(i / 3) + 0.5) / 3 }];
      ctx.men[i].activity = 'moving';
    }
    const waiting = ctx.men[9]; waiting.activity = 'idle'; waiting.mind.lastCoverSeekAt = -Infinity;
    ctx.state.map.tiles[20 * ctx.state.map.width + 34] = 'woods';
    stepCoverSeeking(ctx.state, new Rng(4), 0.1);
    expect(cell(waiting.path.at(-1)!)).toBe('34,20');
  });

  it('chooses reachable outdoor cover instead of claiming an inaccessible room across water', () => {
    const ctx = setup(1), s = ctx.men[0];
    for (let y = 19; y <= 21; y++) for (let x = 29; x <= 31; x++) if (x !== 30 || y !== 20) ctx.state.map.tiles[y * ctx.state.map.width + x] = 'water';
    ctx.state.map.tiles[23 * ctx.state.map.width + 33] = 'woods';
    expect(cell(buildingDestination(ctx.state, s, target, target)!)).toBe('33,23');
  });

  it('uses each man’s known threats, not the spotted set or an unseen enemy position', () => {
    const ctx = setup(2), s = ctx.men[0]; ctx.men[1].pos = { ...target };
    const first = buildingDestination(ctx.state, s, target, target);
    const enemy = soldier(999, 9, 'soviet', { x: 31, y: 20 }, 'mosin');
    ctx.state.soldiers.set(enemy.id, enemy); ctx.state.spotted.german.add(enemy.id);
    expect(buildingDestination(ctx.state, s, target, target)).toEqual(first);
  });

  it('lets personal caution decide whether the extra protection warrants crowding', () => {
    const ctx = setup(2), s = ctx.men[0]; ctx.men[1].pos = { ...target };
    ctx.state.map.tiles[20 * ctx.state.map.width + 34] = 'scatteredtrees';
    s.mind.trait = 'cautious';
    expect(cell(buildingDestination(ctx.state, s, target, target)!)).toBe(cell(target));
    s.mind.trait = 'reckless';
    expect(cell(buildingDestination(ctx.state, s, target, target)!)).toBe('34,20');
  });

  it('chooses exterior protection against the individual’s known direction of fire', () => {
    const ctx = setup(2), s = ctx.men[0]; ctx.men[1].pos = { ...target };
    s.mind.threatLevel = 1; s.mind.threatDir = -Math.PI / 2;
    const westThreat = buildingDestination(ctx.state, s, target, target)!;
    s.mind.threatDir = Math.PI / 2;
    const eastThreat = buildingDestination(ctx.state, s, target, target)!;
    expect(westThreat.x).toBeGreaterThan(target.x);
    expect(eastThreat.x).toBeLessThan(target.x);
  });

  it('honours an explicit route returning to the same shelter even when already inside', () => {
    const ctx = setup(1), s = ctx.men[0], rng = new Rng(5);
    s.pos = { ...target };
    const via = { x: 25.5, y: 25.5 };
    applyOrder(ctx.state, ctx.team, { type: 'move', target, waypoints: [via], issuedAt: 0 }, rng);
    for (let i = 0; i < 10 && !s.path.length; i++) { s.mind.hesitation = 0; applyOrderToSoldier(ctx.state, ctx.team, s, rng); }
    expect(s.path.some(p => cell(p) === cell(via))).toBe(true);
    expect(cell(s.path.at(-1)!)).toBe(cell(target));
  });

  it('does not sidestep out of markedly better shelter, but may use a protected exterior', () => {
    const ctx = setup(2), [s, other] = ctx.men;
    s.pos = { x: 30.95, y: 20.5 }; other.pos = { x: 30.8, y: 20.5 };
    expect(canStepAside(ctx.state, s, { x: 31.2, y: 20.5 })).toBe(false);
    for (let i = 0; i < 50; i++) resolveSoldierOverlapForTest(ctx.state, s, new Rng(i));
    expect(cell(s.pos)).toBe(cell(target));
    ctx.state.map.tiles[20 * ctx.state.map.width + 31] = 'trench';
    expect(canStepAside(ctx.state, s, { x: 31.2, y: 20.5 })).toBe(true);
  });

  it('does not treat destroyed building tiles as indoor capacity or require precomputed ids', () => {
    const ctx = setup(1); ctx.state.map.buildingId.fill(-1);
    expect(buildingTiles(ctx.state.map, target)).toHaveLength(1);
    ctx.state.map.tiles[20 * ctx.state.map.width + 30] = 'rubble';
    expect(buildingDestination(ctx.state, ctx.men[0], target, target)).toBeNull();
  });
});
