import { describe, it, expect } from 'vitest';
import { Battle } from '@/sim/battle';
import { applyOrder } from '@/sim/orders';
import { aiDeploy } from '@/sim/ai';
import { MAPS } from '@/data/maps';
import { DEFAULT_FORCES } from '@/data/operation';
import { SIM_DT } from '@/shared/types';
import type { BattleConfig, Side } from '@/shared/types';
import type { Rng } from '@/shared/rng';

const baseConfig: BattleConfig = {
  mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 1, durationS: 600,
  difficulty: 'normal', forces: { german: ['ger_rifle_41'], soviet: ['sov_rifle_41'] },
};

describe('orders: refused orders are retried after hesitation', () => {
  it('a soldier who fails the obedience roll on Move Fast obeys once his hesitation runs out', () => {
    const battle = new Battle(baseConfig);
    battle.start();
    const team = battle.selectableTeams('german')[0];
    const s = battle.state.soldiers.get(team.soldierIds[1])!;
    const target = { x: s.pos.x + 12, y: s.pos.y };

    const failing = new Proxy(battle.rng, {
      get(obj, prop) {
        if (prop === 'chance') return () => false;
        const v = Reflect.get(obj, prop);
        return typeof v === 'function' ? v.bind(obj) : v;
      },
    }) as Rng;
    applyOrder(battle.state, team, { type: 'moveFast', target, issuedAt: battle.state.time }, failing);
    expect(s.path.length).toBe(0);
    expect(s.mind.hesitation).toBeGreaterThan(0);
    expect(s.mind.pendingOrderAt).toBe(battle.state.time);

    // Retries with the real rng; a repeat refusal just brings another 1-3 s hesitation, so allow a
    // few; with rested troops (p ~0.9) the soldier is moving well within 4 s in practice.
    battle.step(4);
    expect(s.activity).toBe('movingFast');
    expect(s.path.length).toBeGreaterThan(0);
    expect(s.mind.pendingOrderAt).toBeUndefined();
  });

  it('a replaced order clears the pending retry', () => {
    const battle = new Battle(baseConfig);
    battle.start();
    const team = battle.selectableTeams('german')[0];
    const s = battle.state.soldiers.get(team.soldierIds[1])!;
    s.mind.hesitation = 2; // refuses immediately
    applyOrder(battle.state, team, { type: 'moveFast', target: { x: s.pos.x + 12, y: s.pos.y }, issuedAt: 0 }, battle.rng);
    expect(s.mind.pendingOrderAt).toBe(0);
    team.order = { type: 'defend', target: { ...s.pos }, issuedAt: 1 }; // replaced without re-applying
    battle.step(3);
    expect(s.mind.pendingOrderAt).toBeUndefined();
    expect(s.activity).not.toBe('movingFast');
  });
});

describe('deployment keeps every soldier on the map', () => {
  const SIDES: Side[] = ['german', 'soviet'];
  for (const m of MAPS) {
    for (const seed of [1, 2]) {
      it(`${m.id} seed ${seed}`, () => {
        const year = Number(/(\d{4})$/.exec(m.id)?.[1] ?? 1943);
        const forces = DEFAULT_FORCES[year] ?? DEFAULT_FORCES[1943];
        const battle = new Battle({ ...baseConfig, mapId: m.id, year, seed, forces, aiBothSides: true });
        for (const side of SIDES) aiDeploy(battle.state, side, battle.rng, battle);
        battle.start();
        const { width, height } = battle.state.map;
        for (const s of battle.state.soldiers.values()) {
          expect(s.pos.x >= 0 && s.pos.x < width && s.pos.y >= 0 && s.pos.y < height, `soldier ${s.id} at ${s.pos.x},${s.pos.y}`).toBe(true);
        }
      });
    }
  }
});

describe('suppression pins regardless of fear', () => {
  it('a calm rifleman at 100 suppression goes pinned and prone within a second', () => {
    const battle = new Battle(baseConfig);
    battle.start();
    const team = battle.selectableTeams('german')[0];
    const s = battle.state.soldiers.get(team.soldierIds[1])!;
    s.suppression = 100;
    battle.step(SIM_DT * 2);
    expect(['pinned', 'cowering']).toContain(s.mind.state);
    expect(s.stance).toBe('prone');
    expect(s.path.length).toBe(0);
  });
});

describe('orders perf: AI re-plan tick', () => {
  // The merged sim (attack-plan AI + medic/projectile steps) runs the 120 s battle in ~5.3 s
  // wall; bun's default 5 s test timeout times out the SIM, not the assertion (issueOrder ~21 ms).
  // Explicit timeout: supported by both vitest and bun test.
  it('border_1941 seed 1 spends under 300 ms in issueOrder over 120 s', () => {
    const cfg: BattleConfig = { ...baseConfig, seed: 1, durationS: 1200, forces: DEFAULT_FORCES[1941], aiBothSides: true };
    const battle = new Battle(cfg);
    for (const side of ['german', 'soviet'] as Side[]) aiDeploy(battle.state, side, battle.rng, battle);
    battle.start();
    const orig = battle.issueOrder.bind(battle);
    let total = 0, worst = 0;
    battle.issueOrder = (id, o) => { const t0 = performance.now(); orig(id, o); const d = performance.now() - t0; total += d; };
    for (let i = 0; i < 120 / SIM_DT; i++) {
      const t0 = performance.now();
      const before = total;
      battle.step(SIM_DT);
      const orderMs = total - before;
      worst = Math.max(worst, orderMs);
      if (orderMs > 20) console.log(`slow t=${battle.state.time} ${orderMs.toFixed(1)}ms`);
      void t0;
    }
    console.log(`issueOrder total=${total.toFixed(1)}ms worst step=${worst.toFixed(1)}ms`);
    expect(total).toBeLessThan(300);
  }, 30000);
});
