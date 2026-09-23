import { describe, expect, it } from 'vitest';
import type { Activity, Soldier, Stance } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { stepMovement } from '@/sim/movement';
import { addGun, makeState, mkTeam, soldier } from './vehicleDamageHelpers';
import { haulStationM, stepCrewWeapons, taskStation, weaponFramePoint } from '@/sim/crewWeapon';

function walking(over: Partial<Soldier> = {}) {
  const state = makeState();
  const s = soldier(1, 1, 'german', { x: 100.5, y: 100.5 }, 'kar98k', {
    activity: 'moving', stance: 'standing', path: [{ x: 150.5, y: 100.5 }], ...over,
  });
  state.soldiers.set(s.id, s);
  state.teams.set(1, mkTeam(1, 'rifle', [s.id], 'german', s.pos));
  const rng = new Rng(5);
  const advance = (seconds: number, dt = 0.1) => {
    for (let i = 0; i < Math.round(seconds / dt); i++) { state.time += dt; stepMovement(state, rng, dt); }
  };
  return { state, s, rng, advance };
}

describe('loaded infantry movement pacing', () => {
  it.each<[Activity, Stance, number]>([
    ['moving', 'standing', 1.1], ['movingFast', 'standing', 2.4],
    ['moving', 'crouching', 0.7], ['movingFast', 'crouching', 0.7],
    ['moving', 'prone', 0.3], ['movingFast', 'prone', 0.3], ['sneaking', 'prone', 0.3],
    ['panicked', 'standing', 2.6], ['panicked', 'prone', 0.3],
  ])('%s while %s covers %s metres in one second', (activity, stance, metres) => {
    const { s, advance } = walking({ activity, stance });
    const from = { ...s.pos };
    advance(1);
    expect(dist(from, s.pos) * TILE_M).toBeCloseTo(metres, 6);
    expect(s.stance).toBe(stance);
  });

  it('wounds, fatigue and mud still slow a prone man instead of restoring a running speed', () => {
    const { state, s, advance } = walking({ stance: 'prone', health: 'wounded', fatigue: 80 });
    state.map.tiles[100 * state.map.width + 100] = 'mud';
    const from = { ...s.pos };
    advance(1);
    expect(dist(from, s.pos) * TILE_M).toBeCloseTo(0.063, 6); // .3 × .7 × .5 × .6
  });

  it('carrying a casualty halves the loaded walking pace', () => {
    const { s, advance } = walking({ carrying: { patientId: 2, since: 0 } });
    const from = { ...s.pos };
    advance(1);
    expect(dist(from, s.pos) * TILE_M).toBeCloseTo(0.55, 6);
  });

  it('a short emergency dodge is brisk, while a prone man still has to crawl', () => {
    for (const [stance, metres] of [['standing', 3], ['prone', 0.3]] as const) {
      const { s, advance } = walking({ stance, dodgeUntil: 2 });
      const from = { ...s.pos };
      advance(1);
      expect(dist(from, s.pos) * TILE_M).toBeCloseTo(metres, 6);
    }
  });

  it('a panicked passenger clears the vehicle at an emergency pace without teleporting', () => {
    const { s, advance } = walking({ bailRun: { to: { x: 130.5, y: 100.5 }, until: 3 } });
    const from = { ...s.pos };
    advance(1);
    expect(dist(from, s.pos) * TILE_M).toBeCloseTo(2.6, 6);
  });

  it('a dazed survivor crawls slowly toward cover', () => {
    const { s, advance } = walking({ dazedUntil: 20,
      dazeCrawl: { path: [{ x: 130.5, y: 100.5 }], lookAt: 20 } });
    const from = { ...s.pos };
    advance(1);
    expect(dist(from, s.pos) * TILE_M).toBeCloseTo(0.3, 6);
    expect(s.stance).toBe('prone');
  });

  it('gentle overlap separation scales with elapsed time instead of the number of updates', () => {
    const separate = (dt: number) => {
      const { state, s, advance } = walking({ activity: 'idle', path: [], pos: { x: 100.45, y: 100.5 } });
      const other = soldier(2, 1, 'german', { x: 100.5, y: 100.5 }, 'kar98k');
      state.soldiers.set(2, other);
      advance(0.1, dt);
      return [s.pos.x, other.pos.x];
    };
    const coarse = separate(0.1), fine = separate(0.025);
    expect(coarse[0]).toBeCloseTo(fine[0], 8);
    expect(coarse[1]).toBeCloseTo(fine[1], 8);
    expect((100.45 - coarse[0]) * TILE_M).toBeLessThanOrEqual(0.030001);
  });

  it('a dense group cannot multiply separation into a sprint', () => {
    const { state, s, advance } = walking({ activity: 'idle', path: [] });
    const from = { ...s.pos };
    for (let i = 2; i <= 7; i++) state.soldiers.set(i, soldier(i, 1, 'german', { x: 100.5 + i * 0.001, y: 100.5 }, 'kar98k'));
    advance(0.1);
    expect(dist(from, s.pos) * TILE_M).toBeLessThanOrEqual(0.030001);
  });

  it('holds an aiming man through crowd separation and resumes his preserved path afterwards', () => {
    const { state, s, advance } = walking();
    s.aiming = { startedAt: 0, readyAt: 2, fromFacing: 0, from: { ...s.pos }, at: { x: 130, y: 100 },
      targetKind: 'point', weaponId: s.weaponId, stance: s.stance };
    state.soldiers.set(2, soldier(2, 1, 'german', { x: 100.6, y: 100.5 }, 'kar98k'));
    const from = { ...s.pos }, path = s.path.map((p) => ({ ...p }));
    advance(1);
    expect(s.pos).toEqual(from);
    expect(s.path).toEqual(path);
    expect(s.activity).toBe('moving');
    s.aiming = undefined;
    state.soldiers.delete(2);
    advance(1);
    expect(dist(from, s.pos) * TILE_M).toBeCloseTo(1.1, 6);
  });

  it('an emergency dodge still moves a soldier whose previous aim has not yet been cleared', () => {
    const { s, advance } = walking({ dodgeUntil: 2 });
    s.aiming = { startedAt: 0, readyAt: 2, fromFacing: 0, from: { ...s.pos }, at: { x: 130, y: 100 },
      targetKind: 'point', weaponId: s.weaponId, stance: s.stance };
    const from = { ...s.pos };
    advance(1);
    expect(dist(from, s.pos) * TILE_M).toBeCloseTo(3, 6);
  });

  it('men haul a heavy gun at a slow push and walk its trail around a turn', () => {
    const state = makeState();
    const { team, men } = addGun(state, 'pak40', { x: 100, y: 100 });
    const cw = team.crewWeapon!;
    cw.phase = 'packed'; cw.facing = Math.PI / 2;
    team.order = { type: 'move', target: { x: 130, y: 100 }, issuedAt: 0 };
    men.forEach((s, i) => {
      s.path = [{ x: 130, y: 100 }]; s.activity = 'moving';
      s.pos = weaponFramePoint(cw.pos, cw.facing, haulStationM('pak40', i === 0 ? 0 : 1));
    });
    const from = { ...cw.pos };
    state.time += 0.1; stepCrewWeapons(state, 0.1);
    expect(dist(from, cw.pos) * TILE_M).toBeCloseTo(0.065, 6);
    men[0].path = [{ x: cw.pos.x, y: cw.pos.y + 30 }];
    const beforeTurn = { ...men[0].pos }, oldFacing = cw.facing;
    state.time += 0.1; stepCrewWeapons(state, 0.1);
    expect(Math.abs(cw.facing - oldFacing)).toBeLessThanOrEqual(0.025001);
    expect(dist(beforeTurn, men[0].pos) * TILE_M).toBeLessThanOrEqual(0.11);
  });

  it('a gunner walks to the trail before hauling instead of snapping several metres to it', () => {
    const state = makeState();
    const { team, gunner } = addGun(state, 'pak40', { x: 100, y: 100 });
    const cw = team.crewWeapon!;
    cw.phase = 'packed'; cw.facing = Math.PI / 2;
    team.order = { type: 'move', target: { x: 130, y: 100 }, issuedAt: 0 };
    gunner.path = [{ x: 130, y: 100 }]; gunner.activity = 'moving';
    const from = { ...gunner.pos }, axle = { ...cw.pos };
    state.time = 0.1; stepMovement(state, new Rng(1), 0.1);
    expect(dist(from, gunner.pos) * TILE_M).toBeGreaterThan(0);
    expect(dist(from, gunner.pos) * TILE_M).toBeLessThanOrEqual(0.110001);
    expect(cw.pos).toEqual(axle);
    expect(gunner.path).toHaveLength(1);
  });

  it('crewmen approach weapon stations at a loaded pace instead of shuffling faster than infantry', () => {
    const state = makeState();
    const { team, men } = addGun(state, 'pak40', { x: 100, y: 100 });
    team.crewWeapon!.phase = 'settingUp';
    const before = new Map(men.map((s) => [s.id, { ...s.pos }]));
    state.time = 0.1;
    stepCrewWeapons(state, 0.1);
    const worker = men.find((s) => s.crewTask?.walking)!;
    expect(worker).toBeDefined();
    const station = taskStation(team.crewWeapon!, 'atgun', worker.crewTask!.id);
    expect(dist(worker.pos, station)).toBeLessThan(dist(before.get(worker.id)!, station));
    expect(dist(worker.pos, before.get(worker.id)!) * TILE_M).toBeLessThanOrEqual(0.110001);
  });
});
