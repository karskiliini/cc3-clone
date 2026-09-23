import { describe, expect, it } from 'vitest';
import { Rng } from '@/shared/rng';
import { stepCombat } from '@/sim/combat';
import { addTank, makeState, mkTeam, soldier } from './vehicleDamageHelpers';

function mgScenario(screen: 'woods' | 'smoke' | 'buildingStone' = 'woods') {
  const state = makeState();
  state.time = 10;
  const gunner = soldier(1, 1, 'german', { x: 10.5, y: 10.5 }, 'mg34', { ammo: 50 });
  const team = mkTeam(1, 'rifle', [1], 'german', gunner.pos);
  team.order = { type: 'fire', target: { x: 30.5, y: 10.5 }, issuedAt: 10 };
  state.soldiers.set(1, gunner); state.teams.set(1, team);
  for (let y = 0; y < state.map.height; y++) {
    if (screen === 'smoke') state.map.smoke[y * state.map.width + 20] = 1;
    else state.map.tiles[y * state.map.width + 20] = screen;
  }
  return { state, gunner, team };
}

describe('obscured area fire', () => {
  it.each(['woods', 'smoke'] as const)('an ordered MG spends a burst through %s at scattered estimated positions', (screen) => {
    const { state, gunner, team } = mgScenario(screen);
    const rng = new Rng(7);
    stepCombat(state, rng, 0.05);
    expect(gunner.ammo).toBe(50); // An obscured order still needs acquisition and aim.
    for (let i = 0; i < 120 && gunner.ammo === 50; i++) {
      state.time += 0.05; stepCombat(state, rng, 0.05);
    }
    expect(gunner.ammo).toBe(45);
    expect(state.tracers.length).toBeGreaterThanOrEqual(5);
    expect(state.tracers.some((t) => Math.abs(t.to.y - team.order!.target.y) > 0.1)).toBe(true);
    expect(state.spotted.german.size).toBe(0);
  });

  it('does not fire through a stone building toward an obscured point', () => {
    const { state, gunner } = mgScenario('buildingStone');
    stepCombat(state, new Rng(7), 0.05);
    expect(gunner.ammo).toBe(50);
  });

  it('fires on a remembered firing position without following an unseen enemy', () => {
    const { state, gunner, team } = mgScenario('smoke');
    team.order = null;
    const remembered = { x: 30.5, y: 10.5 };
    gunner.mind.beliefs = [{ pos: remembered, kind: 'fired', confidence: 0.9, time: 10, count: 1, deadSeen: 0 }];
    state.soldiers.set(2, soldier(2, 2, 'soviet', { x: 90, y: 90 }, 'mosin'));
    const rng = new Rng(7);
    for (let i = 0; i < 120 && gunner.ammo === 50; i++) {
      state.time += 0.05; stepCombat(state, rng, 0.05);
    }
    expect(gunner.ammo).toBe(45);
    expect(state.tracers.every((t) => t.to.x < 40 && t.to.y < 20)).toBe(true);
  });

  it('an unspotted enemy alone does not authorize blind fire', () => {
    const { state, gunner, team } = mgScenario('smoke');
    team.order = null;
    state.soldiers.set(2, soldier(2, 2, 'soviet', { x: 30.5, y: 10.5 }, 'mosin'));
    stepCombat(state, new Rng(7), 1);
    expect(gunner.ammo).toBe(50);
  });

  it('a tank lays and fires its main gun and MGs on an obscured ordered area', () => {
    const { state, team: oldTeam } = mgScenario('smoke');
    state.soldiers.clear(); state.teams.clear();
    const { v, team } = addTank(state, 'pz4gh', { x: 10.5, y: 10.5 }, Math.PI / 2);
    team.order = oldTeam.order;
    const rng = new Rng(31);
    for (let i = 0; i < 400 && v.lastMainShotAt == null; i++) {
      state.time += 0.05; stepCombat(state, rng, 0.05);
    }
    expect(v.lastMainShotAt).toBeDefined();
    expect(v.coaxAmmo).toBeLessThan(250);
    expect(v.bowAmmo).toBeLessThan(250);
    expect(state.tracers.some((t) => t.kind === 'shell' && Math.abs(t.to.y - 10.5) > 0.1)).toBe(true);
  });

  it('a failed aimed MG hit roll cannot receive a second casualty roll at the exact target position', () => {
    let misses = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const state = makeState();
      const { v } = addTank(state, 'pz4gh', { x: 20, y: 180 }, 0);
      v.mainAmmo = 0; v.coaxAmmo = 1; v.bowAmmo = 0;
      const victim = soldier(1, 1, 'soviet', { x: 20, y: 30 }, 'mosin', { stance: 'prone', ammo: 0 });
      state.soldiers.set(1, victim); state.spotted.german.add(1);
      stepCombat(state, new Rng(seed), 0.05);
      if (state.tracers.length && !state.tracers[0].hit) {
        misses++;
        expect(victim.health).toBe('healthy');
      }
    }
    expect(misses).toBeGreaterThan(10);
  });

  it('a bow gun chooses an in-arc belief even when a stronger report is behind the hull', () => {
    const state = makeState(); state.time = 10;
    const { v, crew } = addTank(state, 'pz4gh', { x: 50, y: 50 }, 0);
    v.mainAmmo = 0; v.coaxAmmo = 0;
    crew[0].mind.beliefs = [
      { pos: { x: 50, y: 70 }, confidence: 0.9, kind: 'fired', time: 10, count: 1, deadSeen: 0 },
      { pos: { x: 50, y: 30 }, confidence: 0.8, kind: 'fired', time: 10, count: 1, deadSeen: 0 },
    ];
    stepCombat(state, new Rng(7), 0.05);
    expect(v.bowAmmo).toBeLessThan(250);
    expect(state.tracers.every((t) => t.to.y < 50)).toBe(true);
  });

  it('does not keep blindly shelling an attack-unit position after its suppress window expires', () => {
    const { state } = mgScenario('smoke'); state.soldiers.clear(); state.teams.clear(); state.time = 100;
    const { v, team } = addTank(state, 'pz4gh', { x: 10.5, y: 10.5 }, Math.PI / 2);
    const enemy = mkTeam(2, 'rifle', [], 'soviet', { x: 30.5, y: 10.5 });
    state.teams.set(enemy.id, enemy);
    team.order = { type: 'fire', target: { ...enemy.pos }, targetTeamId: 2, issuedAt: 0, lastSeenAt: 0 };
    const rng = new Rng(31);
    for (let i = 0; i < 400; i++) { state.time += 0.05; stepCombat(state, rng, 0.05); }
    expect(v.lastMainShotAt).toBeUndefined();
    expect(v.coaxAmmo).toBe(250);
  });

  it('the coax traverses toward an estimated area before firing when the main gun is empty', () => {
    const state = makeState();
    const { v, team } = addTank(state, 'pz4gh', { x: 50, y: 50 }, 0);
    v.mainAmmo = 0; v.bowAmmo = 0;
    team.order = { type: 'fire', target: { x: 50, y: 70 }, issuedAt: 0 };
    state.map.smoke[60 * state.map.width + 50] = 1;
    const rng = new Rng(9);
    stepCombat(state, rng, 0.05);
    expect(v.coaxAmmo).toBe(250);
    for (let i = 0; i < 600 && v.coaxAmmo === 250; i++) { state.time += 0.05; stepCombat(state, rng, 0.05); }
    expect(v.coaxAmmo).toBeLessThan(250);
    expect(Math.abs(v.turretFacing)).toBeGreaterThan(2.9);
  });
});
