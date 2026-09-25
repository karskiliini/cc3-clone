import { describe, expect, it } from 'vitest';
import type { BattleState, OrderType, Soldier } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { stepMovement } from '@/sim/movement';
import { stepMinds, onIncomingFire, TEAMMATE_FIRE_STRESS } from '@/sim/mind';
import { stepMorale } from '@/sim/morale';
import { stepCombat } from '@/sim/combat';
import { applyOrder } from '@/sim/orders';
import { hitChance } from '@/sim/ballistics';
import { infantryAimReady } from '@/sim/infantryAim';
import { WEAPONS } from '@/data/weapons';
import { makeState, mkTeam, soldier } from './vehicleDamageHelpers';

const DT = 0.1;

function obeying(rng: Rng): Rng {
  return new Proxy(rng, { get(o, p) { if (p === 'chance') return () => true; const v = Reflect.get(o, p); return typeof v === 'function' ? v.bind(o) : v; } }) as Rng;
}

/** One man (plus optional teammates) on open ground ordered east; optionally an unarmed-in-effect
 * enemy rifleman ahead, spotted, who cannot shoot back (no ammunition). */
function setup(type: OrderType, opts: { enemyAtTiles?: number; experience?: number; mates?: number } = {}) {
  const state = makeState();
  const n = 1 + (opts.mates ?? 0);
  const men: Soldier[] = [];
  for (let i = 0; i < n; i++) {
    const m = soldier(i + 1, 1, 'german', { x: 100.5, y: 100.5 + i * 1.5 }, 'kar98k', { experience: opts.experience ?? 50, isLeader: i === 0 });
    men.push(m); state.soldiers.set(m.id, m);
  }
  const team = mkTeam(1, 'rifle', men.map((m) => m.id), 'german', men[0].pos);
  state.teams.set(1, team);
  let enemy: Soldier | undefined;
  if (opts.enemyAtTiles != null) {
    enemy = soldier(50, 2, 'soviet', { x: 100.5 + opts.enemyAtTiles, y: 100.5 }, 'mosin', { ammo: 0, ammoReserve: 0, activity: 'idle', stance: 'standing' });
    state.soldiers.set(enemy.id, enemy);
    state.teams.set(2, mkTeam(2, 'rifle', [enemy.id], 'soviet', enemy.pos));
    state.spotted.german.add(enemy.id);
  }
  const rng = new Rng(11);
  applyOrder(state, team, { type, target: { x: 160.5, y: 100.5 }, issuedAt: 0 }, obeying(rng));
  let shots = 0;
  const step = (seconds: number, before?: () => void) => {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      state.time = Math.round((state.time + DT) * 1000) / 1000;
      before?.();
      stepMovement(state, rng, DT);
      stepMinds(state, rng, DT);
      stepCombat(state, rng, DT);
      stepMorale(state, rng, DT);
      if (men[0].lastFiredAt === state.time) shots++;
      if (enemy) { enemy.health = 'healthy'; enemy.stance = 'standing'; } // a steady target for counting
    }
  };
  return { state, team, men, s: men[0], enemy, rng, step, shots: () => shots };
}

/** A near miss (no known shooter) and the suppression combat.ts adds for it. */
function nearMiss(state: BattleState, rng: Rng, s: Soldier, suppression = 8): void {
  onIncomingFire(state, rng, s, null, { x: s.pos.x + 0.4, y: s.pos.y }, 'rifle');
  s.suppression = Math.min(100, s.suppression + suppression);
}

describe('Move (walk) under fire: the same hit-the-dirt rule as Move Fast', () => {
  it('a walking man drops, crawls on toward his goal, and gets up and walks when it is quiet', () => {
    const { state, s, rng, step } = setup('move');
    step(1);
    expect(s.activity).toBe('moving');
    expect(s.stance).toBe('standing');
    nearMiss(state, rng, s);
    step(0.2);
    expect(s.stance).toBe('prone');
    expect(s.activity).toBe('moving');
    expect(s.mind.downAt).toBeDefined();
    const goal = s.path[s.path.length - 1];
    step(0.5); // the drop
    const from = { ...s.pos };
    step(1, () => { if (Math.round(state.time * 10) % 5 === 0) nearMiss(state, rng, s, 1); });
    const v = dist(from, s.pos) * TILE_M;
    expect(v).toBeGreaterThan(0.15);
    expect(v).toBeLessThanOrEqual(0.3 + 1e-6);
    expect(s.path[s.path.length - 1]).toEqual(goal);
    step(20);
    expect(s.mind.downAt).toBeUndefined();
    expect(s.stance).toBe('standing');
    const from2 = { ...s.pos };
    step(1);
    expect(dist(from2, s.pos) * TILE_M).toBeCloseTo(1.1, 1);
  });
});

describe('crawling men take the shot that is there, and keep crawling', () => {
  const keepDown = (state: BattleState, rng: Rng, s: Soldier) => () => {
    if (Math.round(state.time * 10) % 15 === 0) nearMiss(state, rng, s, 2);
  };

  it('a crawler with an enemy ahead fires and still closes on his goal', () => {
    const { state, s, rng, step, shots } = setup('moveFast', { enemyAtTiles: 30 });
    step(0.5);
    nearMiss(state, rng, s);
    const x0 = s.pos.x;
    step(30, keepDown(state, rng, s));
    expect(s.mind.downAt).toBeDefined();
    expect(s.stance).toBe('prone');
    expect(shots()).toBeGreaterThanOrEqual(2);
    expect(shots()).toBeLessThanOrEqual(6); // ~one aimed shot per 6 s of crawling, not a firefight
    expect((s.pos.x - x0) * TILE_M).toBeGreaterThan(3); // still closing on the goal
    expect(s.activity).toBe('movingFast');
  });

  it('a crawler with nothing in his field of fire does not turn to hunt for it', () => {
    const { state, s, rng, step, shots } = setup('moveFast', { enemyAtTiles: -30 }); // enemy behind him
    step(0.5);
    nearMiss(state, rng, s);
    step(20, keepDown(state, rng, s));
    expect(shots()).toBe(0);
  });

  it('a man running upright does not fire (his mind is on getting there)', () => {
    const { s, step, shots } = setup('moveFast', { enemyAtTiles: 30 });
    step(3);
    expect(s.stance).toBe('standing');
    expect(shots()).toBe(0);
  });

  it('a shaken crawler fires less often and worse than a calm one', () => {
    const run = (shaken: boolean) => {
      const { state, s, rng, step, shots } = setup('moveFast', { enemyAtTiles: 30 });
      step(0.5);
      nearMiss(state, rng, s);
      step(40, () => { keepDown(state, rng, s)(); if (shaken) s.mind.state = 'shaken'; else { s.mind.state = 'alert'; s.mind.stress = 0; } });
      return shots();
    };
    const calm = run(false), shaken = run(true);
    expect(shaken).toBeLessThan(calm);
    const s = soldier(9, 1, 'german', { x: 1, y: 1 }, 'kar98k', { activity: 'movingFast', stance: 'prone' });
    const calmP = hitChance(WEAPONS.kar98k, 60, 0, 'standing', s, false);
    s.mind.state = 'shaken';
    expect(hitChance(WEAPONS.kar98k, 60, 0, 'standing', s, false)).toBeLessThan(calmP);
  });

  it('a pinned crawler keeps his head down and does not fire', () => {
    const { state, s, rng, step, shots } = setup('moveFast', { enemyAtTiles: 30 });
    step(0.5);
    nearMiss(state, rng, s);
    step(1);
    expect(s.mind.downAt).toBeDefined();
    step(20, () => { s.suppression = 70; s.lastFiredAt = -1; nearMiss(state, rng, s, 0); });
    expect(s.mind.state === 'pinned' || s.mind.state === 'cowering').toBe(true);
    expect(shots()).toBe(0);
  });
});

describe('being shot at is stressful, and stress costs performance', () => {
  it('a near miss stresses a man who is already down, and his teammates within 10 m', () => {
    const { state, men, rng } = setup('moveFast', { mates: 3 });
    const [a, b, , d] = men;
    a.stance = 'prone';
    d.pos = { x: a.pos.x, y: a.pos.y + 20 }; // 40 m away
    nearMiss(state, rng, a);
    expect(a.mind.stress).toBeGreaterThan(2);
    expect(b.mind.stress).toBeGreaterThan(0);
    expect(b.mind.stress).toBeLessThanOrEqual(TEAMMATE_FIRE_STRESS * 1.3 + 1e-9);
    expect(d.mind.stress).toBe(0);
  });

  it('higher stress lowers accuracy and slows the aim', () => {
    const s = soldier(9, 1, 'german', { x: 10.5, y: 10.5 }, 'kar98k', { activity: 'idle', stance: 'prone' });
    const e = soldier(10, 2, 'soviet', { x: 40.5, y: 10.5 }, 'mosin');
    const p0 = hitChance(WEAPONS.kar98k, 60, 0, 'standing', s, false);
    infantryAimReady(s, WEAPONS.kar98k, { kind: 'soldier', soldier: e }, undefined, 100);
    const aim0 = s.aiming!.readyAt - s.aiming!.startedAt;
    s.aiming = undefined;
    s.mind.stress = 80;
    expect(hitChance(WEAPONS.kar98k, 60, 0, 'standing', s, false)).toBeLessThan(p0);
    infantryAimReady(s, WEAPONS.kar98k, { kind: 'soldier', soldier: e }, undefined, 200);
    expect(s.aiming!.readyAt - s.aiming!.startedAt).toBeGreaterThan(aim0);
  });
});
