import { describe, expect, it } from 'vitest';
import { Rng } from '@/shared/rng';
import { TILE_M } from '@/shared/types';
import { dist } from '@/shared/math';
import { bailOut } from '@/sim/vehicleDamage';
import { stepVehicleCrews } from '@/sim/vehicleCrew';
import { stepMovement } from '@/sim/movement';
import { stepCoverSeeking } from '@/sim/coverSeek';
import { stepMinds } from '@/sim/mind';
import { stepCombat } from '@/sim/combat';
import { applyOrder } from '@/sim/orders';
import { Battle } from '@/sim/battle';
import { actionFor, hatchClimbAnim, hatchClimbFrame, postureFor } from '@/render/soldierAnim';
import { addTank, makeState, mkTeam, soldier } from './vehicleDamageHelpers';

function scene(seed = 7) {
  const state = makeState();
  const { v, team, crew } = addTank(state, 'pz4gh', { x: 100, y: 100 });
  const s = crew[0];
  for (const other of crew.slice(1)) other.health = 'dead';
  const rng = new Rng(seed);
  bailOut(state, v, team, 'abandoned');
  v.noReturn = true;
  return { state, v, team, s, rng };
}

function landed(seed = 7) {
  const result = scene(seed);
  result.state.time = result.s.hatch!.until;
  stepVehicleCrews(result.state, result.rng, 0.05);
  return result;
}

describe('panicked crew escape', () => {
  it('spends several seconds climbing near the hatch before dropping over the side', () => {
    const { state, s, rng } = scene();
    const climb = s.hatch!;
    expect(climb.until - climb.start).toBeGreaterThan(2.5);
    const length = dist(climb.from, climb.to);
    state.time = (climb.start + climb.until) / 2;
    stepVehicleCrews(state, rng, 0.05);
    expect(dist(s.pos, climb.from)).toBeLessThan(length * 0.2);
    state.time = climb.until - 0.01;
    stepVehicleCrews(state, rng, 0.05);
    expect(dist(s.pos, climb.to)).toBeLessThan(length * 0.05);
    expect(s.hatch).toBeDefined();
  });

  it('lands prone and stationary in shock despite movement orders and combat opportunities', () => {
    const { state, team, s, rng } = landed();
    const at = { ...s.pos };
    expect(s.bailRun).toBeUndefined();
    expect(s.stunnedUntil).toBeGreaterThan(state.time + 2);
    expect(s.dazedUntil).toBeGreaterThan(s.stunnedUntil!);
    expect(s.stance).toBe('prone');
    const enemy = soldier(99, 99, 'soviet', { x: 100, y: 90 }, 'mosin');
    state.soldiers.set(enemy.id, enemy);
    state.teams.set(99, mkTeam(99, 'rifle', [99], 'soviet', enemy.pos));
    state.spotted.german.add(99);
    const ammo = s.ammo;
    applyOrder(state, team, { type: 'moveFast', target: { x: 130, y: 130 }, issuedAt: state.time }, rng, true);
    for (let i = 0; i < 20; i++) {
      state.time += 0.05;
      stepCoverSeeking(state, rng, 0.05);
      stepMovement(state, rng, 0.05);
      stepMinds(state, rng, 0.05);
      stepCombat(state, rng, 0.05);
    }
    expect(s.pos).toEqual(at);
    expect(s.ammo).toBe(ammo);
    expect(s.lastFiredAt).toBe(-999);
    expect(actionFor(s, state.time)).toBe('hide');
  });

  it('after the stationary shock crawls slowly toward nearby cover and stays prone', () => {
    const { state, s, rng } = landed();
    const at = { ...s.pos };
    const cover = { x: Math.floor(at.x) + 2.5, y: Math.floor(at.y) + 0.5 };
    state.map.tiles[Math.floor(cover.y) * state.map.width + Math.floor(cover.x)] = 'trench';
    state.time = (s.stunnedUntil ?? state.time) + 0.01;
    // Simulate an ordinary AI path change immediately before the recovery owns movement.
    s.path = [{ x: at.x - 20, y: at.y }];
    s.activity = 'movingFast';
    stepCoverSeeking(state, rng, 0.05);
    stepMovement(state, rng, 1);
    expect(dist(s.pos, at) * TILE_M).toBeGreaterThan(0.1);
    expect(dist(s.pos, at) * TILE_M).toBeLessThan(0.5);
    expect(dist(s.pos, cover)).toBeLessThan(dist(at, cover));
    expect(postureFor(s, state.time)).toBe('prone');
    expect(actionFor(s, state.time)).toBe('crawl');
    expect(s.bailRun).toBeUndefined();
  });

  it('does not assign a cover path during a hatch climb', () => {
    const { state, s, rng } = scene();
    s.mind.threatDir = 0;
    s.mind.threatLevel = 1;
    state.map.tiles[102 * state.map.width + 102] = 'trench';
    stepCoverSeeking(state, rng, 0.05);
    expect(s.path).toEqual([]);
  });

  it('crawls toward cover outside a burning hull danger zone after the shock', () => {
    const { state, v, s, rng } = scene();
    v.state = 'burning';
    const at = { ...s.hatch!.to };
    const cover = { x: Math.floor(at.x) - 6.5, y: Math.floor(at.y) + 0.5 };
    state.map.tiles[Math.floor(cover.y) * state.map.width + Math.floor(cover.x)] = 'trench';
    state.time = s.hatch!.until;
    stepVehicleCrews(state, rng, 0.05);
    state.time = s.stunnedUntil! + 0.01;
    stepMovement(state, rng, 1);
    expect(dist(s.pos, at)).toBeGreaterThan(0);
    expect(dist(s.pos, cover)).toBeLessThan(dist(at, cover));
    expect(s.stance).toBe('prone');
  });

  it('uses the seeded RNG for repeatable but staggered landing shock', () => {
    const a = landed(7), b = landed(7), c = landed(23);
    expect(a.s.stunnedUntil).toBeDefined();
    expect(a.s.stunnedUntil).toBe(b.s.stunnedUntil);
    expect(a.s.dazedUntil).toBe(b.s.dazedUntil);
    expect(a.s.stunnedUntil).not.toBe(c.s.stunnedUntil);
  });

  it('animation keeps the climbing frames before the drop starts', () => {
    const { s } = scene();
    const c = s.hatch!;
    const anim = hatchClimbAnim(s, (c.start + c.until) / 2)!;
    expect(anim.progress).toBeLessThan(0.5);
    expect(anim.keys[0]).toBe('crew.bailout');
    const dropping = hatchClimbAnim(s, c.start + (c.until - c.start) * 0.85)!;
    // Atlas frame 4 has the legs clear of the hull; frame 5 lands crouched before shock flattens him.
    expect(hatchClimbFrame(dropping.keys[0], 6, dropping.progress, c.until)).toBe(4);
  });

  it('the complete Battle pipeline preserves landing shock and slow cover crawl after a player order', () => {
    const { state, team, s, rng } = scene();
    const battle = new Battle({ ...state.config, mapId: 'border_1941' });
    battle.state = state;
    battle.rng = rng;
    const landing = { ...s.hatch!.to };
    const cover = { x: Math.floor(landing.x) - 1.5, y: Math.floor(landing.y) + 0.5 };
    state.map.tiles[Math.floor(cover.y) * state.map.width + Math.floor(cover.x)] = 'trench';
    // A nearby wounded crewman offers the medic pass a tempting task; the crew stays associated
    // with its vehicle and must remain outside the infantry treatment/transport behaviour.
    const wounded = state.soldiers.get(team.soldierIds[1])!;
    wounded.health = 'wounded'; wounded.vehicleId = null;
    wounded.pos = { x: landing.x + 0.7, y: landing.y };
    wounded.stunnedUntil = 100; wounded.dazedUntil = 100;
    const enemy = soldier(99, 99, 'soviet', { x: 100, y: 90 }, 'mosin', { ammo: 0, ammoReserve: 0 });
    state.soldiers.set(99, enemy);
    state.teams.set(99, mkTeam(99, 'rifle', [99], 'soviet', enemy.pos));
    // A bailed-out vehicle alone counts as a beaten side; another friendly team keeps the battle running.
    const ally = soldier(88, 88, 'german', { x: 80, y: 110 }, 'kar98k', { ammo: 0, ammoReserve: 0 });
    state.soldiers.set(88, ally);
    state.teams.set(88, mkTeam(88, 'rifle', [88], 'german', ally.pos));
    for (let i = 0; i < 120 && s.hatch; i++) battle.step(0.05);
    expect(s.hatch).toBeUndefined();
    expect(s.pos).toEqual(landing);
    const ammo = s.ammo;
    battle.issueOrder(team.id, { type: 'moveFast', target: { x: 125, y: 125 }, issuedAt: state.time });
    battle.step(1);
    expect(s.pos).toEqual(landing);
    expect(actionFor(s, state.time)).toBe('hide');
    while (state.time < s.stunnedUntil! + 0.05) battle.step(0.05);
    const beforeCrawl = { ...s.pos };
    battle.step(1);
    const movedM = dist(beforeCrawl, s.pos) * TILE_M;
    expect(movedM).toBeGreaterThan(0.1);
    expect(movedM).toBeLessThan(0.5);
    expect(dist(s.pos, cover)).toBeLessThan(dist(landing, cover));
    expect(postureFor(s, state.time)).toBe('prone');
    expect(actionFor(s, state.time)).toBe('crawl');
    expect(s.ammo).toBe(ammo);
    expect(s.lastFiredAt).toBe(-999);
    expect(s.bandageUntil).toBeUndefined();
    expect(wounded.health).toBe('wounded');
    expect(state.phase).toBe('running');
  });
});
