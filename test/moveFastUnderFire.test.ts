import { describe, expect, it } from 'vitest';
import type { BattleState, Soldier } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { stepMovement } from '@/sim/movement';
import { stepMinds, onIncomingFire } from '@/sim/mind';
import { stepMorale } from '@/sim/morale';
import { applyOrder } from '@/sim/orders';
import { quietNeededS, suppressionOkFor } from '@/sim/hitTheDirt';
import { actionFor, postureFor, postureDropProgress } from '@/render/soldierAnim';
import { makeState, mkTeam, soldier } from './vehicleDamageHelpers';

const DT = 0.1;

/** A four-man squad on open ground, ordered to Move Fast 60 m east. No enemy on the map: fire is
 * put on them by hand (the same mind.onIncomingFire + suppression combat.ts applies to a near miss). */
function runningSquad(experience = 50, spacingTiles = 1.5) {
  const state = makeState();
  const ids = [1, 2, 3, 4];
  const men: Soldier[] = ids.map((id, i) => soldier(id, 1, 'german', { x: 100.5, y: 100.5 + i * spacingTiles }, 'kar98k', { experience, isLeader: i === 0 }));
  for (const m of men) state.soldiers.set(m.id, m);
  const team = mkTeam(1, 'rifle', ids, 'german', men[0].pos);
  state.teams.set(1, team);
  const rng = new Rng(7);
  // everybody obeys (the obedience roll is not what these tests are about)
  const obey = new Proxy(rng, { get(o, p) { if (p === 'chance') return () => true; const v = Reflect.get(o, p); return typeof v === 'function' ? v.bind(o) : v; } }) as Rng;
  const target = { x: 130.5, y: 102.5 };
  applyOrder(state, team, { type: 'moveFast', target, issuedAt: 0 }, obey);
  const step = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      state.time += DT;
      stepMovement(state, rng, DT);
      stepMinds(state, rng, DT);
      stepMorale(state, rng, DT);
    }
  };
  return { state, team, men, rng, target, step };
}

/** A near miss on this man: rifle round cracking past, suppression as combat.ts adds it. */
function nearMiss(state: BattleState, rng: Rng, s: Soldier, suppression = 12): void {
  onIncomingFire(state, rng, s, null, { x: s.pos.x + 0.4, y: s.pos.y }, 'rifle');
  s.suppression = Math.min(100, s.suppression + suppression);
}

function obeying(rng: Rng): Rng {
  return new Proxy(rng, { get(o, p) { if (p === 'chance') return () => true; const v = Reflect.get(o, p); return typeof v === 'function' ? v.bind(o) : v; } }) as Rng;
}

function speedOver(step: (s: number) => void, s: Soldier, seconds: number): number {
  const from = { ...s.pos };
  step(seconds);
  return (dist(from, s.pos) * TILE_M) / seconds;
}

describe('Move Fast under fire: hit the dirt, crawl on, get up and run when it is quiet', () => {
  it('running men go prone under fire and keep crawling toward their goal at crawl pace', () => {
    const { state, men, rng, step, target } = runningSquad();
    step(1);
    for (const m of men) { expect(m.activity).toBe('movingFast'); expect(m.stance).toBe('standing'); }
    expect(speedOver(step, men[1], 1)).toBeGreaterThan(2);

    // rounds crack around the man in the middle: he and his neighbours within 10 m drop
    nearMiss(state, rng, men[1]);
    step(0.2);
    for (const m of men) {
      expect(m.stance).toBe('prone');
      expect(m.activity).toBe('movingFast');        // still under his order, route kept
      expect(m.path.length).toBeGreaterThan(0);
      expect(m.mind.downAt).toBeDefined();
    }
    const goal = men[1].path[men[1].path.length - 1];
    // keep the fire coming for a few seconds: they crawl on (after the half-second drop)
    const before = dist(men[1].pos, target);
    for (let i = 0; i < 6; i++) { nearMiss(state, rng, men[1], 4); step(0.5); }
    for (const m of men) expect(m.stance).toBe('prone');
    const v = speedOver((s) => { nearMiss(state, rng, men[1], 2); step(s); }, men[1], 1);
    expect(v).toBeGreaterThan(0.15);
    expect(v).toBeLessThanOrEqual(0.3 + 1e-6);
    expect(dist(men[1].pos, target)).toBeLessThan(before);
    expect(men[1].path[men[1].path.length - 1]).toEqual(goal); // same destination
  });

  it('the renderer shows the drop, then the prone crawl', () => {
    const { state, men, rng, step } = runningSquad();
    step(1);
    const s = men[0];
    nearMiss(state, rng, s);
    step(0.1);
    expect(postureFor(s, state.time, 0)).toBe('prone');
    // held still for the drop: the get-down plays (standing -> prone, not moving)
    expect(postureDropProgress('standing', 'prone', 0.1, 0)).not.toBeNull();
    step(1);
    expect(actionFor(s, state.time, 'prone', 0.3)).toBe('crawl');
  });

  it('once the fire stops they get up and run again, each on his own judgement', () => {
    const { state, men, rng, step } = runningSquad();
    step(1);
    nearMiss(state, rng, men[0]);
    step(0.5);
    for (const m of men) expect(m.stance).toBe('prone');
    step(20);
    for (const m of men) {
      if (m.path.length === 0) continue;
      expect(m.mind.downAt).toBeUndefined();
      expect(m.stance).toBe('standing');
      expect(m.activity).toBe('movingFast');
    }
    const runner = men.find((m) => m.path.length > 0)!;
    expect(speedOver(step, runner, 0.5)).toBeGreaterThan(2);
  });

  it('they do not stand up while their suppression is still high', () => {
    const { state, men, rng, step } = runningSquad();
    step(1);
    const s = men[0];
    nearMiss(state, rng, s, 90);
    step(quietNeededS(state, s) + 0.5);
    expect(s.suppression).toBeGreaterThan(suppressionOkFor(s));
    expect(s.stance).toBe('prone');
  });

  it('a veteran judges the fire over sooner than a green soldier', () => {
    const riseTime = (experience: number) => {
      const { state, men, rng, step } = runningSquad(experience);
      step(1);
      nearMiss(state, rng, men[2]);
      step(0.2);
      expect(men[2].stance).toBe('prone');
      const t0 = state.time;
      while (men[2].mind.downAt != null && state.time - t0 < 30) step(DT);
      return state.time - t0;
    };
    const veteran = riseTime(85);
    const green = riseTime(15);
    expect(veteran).toBeLessThan(green - 2);
    expect(veteran).toBeLessThan(6);
  });

  it('fire coming again drops them again', () => {
    const { state, men, rng, step } = runningSquad(70);
    step(1);
    nearMiss(state, rng, men[0]);
    step(15);
    const s = men[0];
    expect(s.stance).toBe('standing');
    expect(s.mind.downAt).toBeUndefined();
    nearMiss(state, rng, s);
    step(0.2);
    expect(s.stance).toBe('prone');
    expect(s.activity).toBe('movingFast');
    expect(s.mind.downAt).toBeDefined();
  });

  it('a re-issued Move Fast does not stand a man up who is still down', () => {
    const { state, team, men, rng, step, target } = runningSquad();
    step(1);
    nearMiss(state, rng, men[0]);
    step(0.5);
    const obey = new Proxy(rng, { get(o, p) { if (p === 'chance') return () => true; const v = Reflect.get(o, p); return typeof v === 'function' ? v.bind(o) : v; } }) as Rng;
    applyOrder(state, team, { type: 'moveFast', target: { x: target.x + 2, y: target.y }, issuedAt: state.time }, obey);
    for (const m of men) { expect(m.stance).toBe('prone'); expect(m.activity).toBe('movingFast'); }
  });

  it('a crawler falling behind is not dragged upright by his team; a new Move keeps him down, an Assault stands him up', () => {
    // a loose file, men 12 m apart: fire on the flank man is not fire on the others
    const { state, team, men, rng, step } = runningSquad(50, 6);
    step(1);
    const rear = men[3];
    nearMiss(state, rng, rear);
    step(0.2);
    for (let i = 0; i < 8; i++) { nearMiss(state, rng, rear, 3); step(0.5); }
    expect(rear.stance).toBe('prone');
    expect(men[0].stance).toBe('standing');
    expect(men[0].pos.x - rear.pos.x).toBeGreaterThan(3); // the others ran on; nobody waited
    applyOrder(state, team, { type: 'move', target: { x: 110.5, y: 101.5 }, issuedAt: state.time }, obeying(rng));
    expect(rear.mind.downAt).toBeDefined();
    expect(rear.stance).toBe('prone');
    applyOrder(state, team, { type: 'assault' as never, target: { x: 110.5, y: 101.5 }, issuedAt: state.time }, obeying(rng));
    expect(rear.mind.downAt).toBeUndefined();
    expect(rear.stance).toBe('standing');
  });

  it('an Assault keeps going on its feet under fire (only pinning stops a charging man)', () => {
    const { state, team, men, rng, step } = runningSquad();
    const obey = new Proxy(rng, { get(o, p) { if (p === 'chance') return () => true; const v = Reflect.get(o, p); return typeof v === 'function' ? v.bind(o) : v; } }) as Rng;
    team.order = null;
    applyOrder(state, team, { type: 'assault' as never, target: { x: 130.5, y: 102.5 }, issuedAt: 0 }, obey);
    step(1);
    nearMiss(state, rng, men[0], 5);
    step(0.3);
    expect(men[0].stance).toBe('standing');
    expect(men[0].mind.downAt).toBeUndefined();
  });
});
