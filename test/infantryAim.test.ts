import { describe, expect, it } from 'vitest';
import { Rng } from '@/shared/rng';
import { stepCombat } from '@/sim/combat';
import { stepMovement } from '@/sim/movement';
import { Battle } from '@/sim/battle';
import { actionFor } from '@/render/soldierAnim';
import { makeState, mkTeam, soldier } from './vehicleDamageHelpers';

function scene(weaponId = 'kar98k', rangeM = 100) {
  const state = makeState();
  const s = soldier(1, 1, 'german', { x: 20, y: 30 }, weaponId, { ammo: 50, stance: 'standing' });
  const team = mkTeam(1, 'rifle', [1], 'german', s.pos);
  team.order = { type: 'fire', target: { x: 20 + rangeM / 2, y: 30 }, issuedAt: 0 };
  state.soldiers.set(1, s); state.teams.set(1, team);
  const rng = new Rng(17);
  const tick = (seconds: number, move = false) => {
    for (let i = 0; i < Math.round(seconds / 0.05); i++) {
      state.time += 0.05;
      if (move) stepMovement(state, rng, 0.05);
      stepCombat(state, rng, 0.05);
    }
  };
  const firstShot = () => {
    while (s.ammo === 50 && state.time < 15) tick(0.05);
    expect(s.ammo).toBeLessThan(50);
    return state.time;
  };
  return { state, s, team, tick, firstShot };
}

describe('infantry acquisition and aiming', () => {
  it('raises and steadies the rifle before the first shot, with a visible aiming state', () => {
    const { s, state, tick } = scene();
    tick(0.05);
    expect(s.ammo).toBe(50);
    expect(s.aiming).toBeDefined();
    expect(actionFor(s, state.time)).toBe('aim');
    tick(1);
    expect(s.ammo).toBe(50);
    tick(4);
    expect(s.ammo).toBeLessThan(50);
  });

  it('takes longer at long range and with fatigue, suppression or limited experience', () => {
    const close = scene('kar98k', 30); close.s.experience = 85;
    const far = scene('kar98k', 350); far.s.experience = 85;
    const strained = scene('kar98k', 350);
    strained.s.experience = 15; strained.s.fatigue = 70; strained.s.suppression = 50;
    expect(far.firstShot()).toBeGreaterThan(close.firstShot() + 0.5);
    expect(strained.firstShot()).toBeGreaterThan(far.state.time + 1);
  });

  it('reacquires a newly ordered target instead of transferring nearly completed aim', () => {
    const { s, team, tick } = scene();
    tick(1.5);
    team.order = { type: 'fire', target: { x: 20, y: 100 }, issuedAt: 1.5 };
    tick(1);
    expect(s.ammo).toBe(50);
    tick(5);
    expect(s.ammo).toBeLessThan(50);
  });

  it('loses readiness after relocating or being stunned', () => {
    const { s, state, tick } = scene();
    tick(1.5); s.pos.x += 3; tick(1);
    expect(s.ammo).toBe(50);
    s.stunnedUntil = state.time + 1;
    tick(1.1); tick(1);
    expect(s.ammo).toBe(50);
    tick(4);
    expect(s.ammo).toBeLessThan(50);
  });

  it('cannot finish a shot through newly intervening cover', () => {
    const { state, s, tick } = scene();
    tick(1);
    state.map.tiles[30 * state.map.width + 40] = 'buildingStone';
    tick(4);
    expect(s.ammo).toBe(50);
    expect(s.aiming).toBeUndefined();
  });

  it('uses controlled MG bursts with time to recover the sight picture', () => {
    const { s, state, tick, firstShot } = scene('mg34');
    const first = firstShot();
    const afterBurst = s.ammo;
    tick(0.5);
    expect(s.ammo).toBe(afterBurst);
    tick(2);
    expect(s.ammo).toBeLessThan(afterBurst);
    expect(state.time - first).toBeCloseTo(2.5);
  });

  it('holds an MG target during acquisition instead of rotating targets every simulation tick', () => {
    const { s, state, team, tick } = scene('mg34');
    const enemyTeam = mkTeam(2, 'rifle', [2, 3, 4], 'soviet', { x: 70, y: 30 });
    state.teams.set(2, enemyTeam);
    for (const id of enemyTeam.soldierIds) {
      state.soldiers.set(id, soldier(id, 2, 'soviet', { x: 70, y: 29 + id }, 'none'));
      state.spotted.german.add(id);
    }
    team.order!.targetTeamId = 2;
    tick(0.05);
    const targetId = s.aiming?.targetId;
    expect(targetId).toBeDefined();
    tick(1);
    expect(s.aiming?.targetId).toBe(targetId);
    expect(s.ammo).toBe(50);
    tick(4);
    expect(s.ammo).toBeLessThan(50);
  });

  it('turns into the aim instead of instantly pointing a rifle behind his back', () => {
    const { s, team, tick } = scene();
    team.order!.target = { x: 20, y: 80 }; // Starts facing north, target south.
    tick(0.05);
    expect(s.facing).toBe(0);
    tick(0.4);
    expect(s.facing).not.toBe(0);
    expect(s.facing).not.toBe(4);
    tick(1);
    expect(s.facing).toBe(4);
    expect(s.ammo).toBe(50);
  });

  it('halts an advancing rifleman to aim, then lets him continue his move after firing', () => {
    const { s, state, team, tick } = scene('kar98k', 50);
    team.order = { type: 'move', target: { x: 80, y: 30 }, issuedAt: 0 };
    s.activity = 'moving'; s.path = [{ x: 80, y: 30 }];
    const enemy = soldier(2, 2, 'soviet', { x: 45, y: 30 }, 'none');
    state.soldiers.set(2, enemy); state.spotted.german.add(2);
    tick(0.05, true); const halt = { ...s.pos };
    tick(1, true);
    expect(s.pos).toEqual(halt);
    expect(s.ammo).toBe(50);
    while (s.ammo === 50 && state.time < 10) tick(0.05, true);
    expect(s.ammo).toBeLessThan(50);
    const firedAt = { ...s.pos };
    tick(2, true);
    expect(s.pos.x).toBeGreaterThan(firedAt.x + 0.5);
  });

  it('preserves acquisition through the complete battle loop, and pauses it with the battle clock', () => {
    const { state, s } = scene();
    // The remote team keeps both sides present without interrupting this ordered area-fire drill.
    const enemy = soldier(2, 2, 'soviet', { x: 350, y: 350 }, 'none');
    state.soldiers.set(2, enemy);
    state.teams.set(2, mkTeam(2, 'rifle', [2], 'soviet', enemy.pos));
    const battle = new Battle({ ...state.config, mapId: 'steppe_1943' });
    battle.state = state;
    battle.step(0.5);
    expect(s.aiming).toBeDefined();
    expect(s.ammo).toBe(50);
    const started = s.aiming!.startedAt;
    battle.pause(); battle.step(10);
    expect(state.time).toBe(0.5);
    expect(s.ammo).toBe(50);
    battle.resume(); battle.step(0.5);
    expect(s.aiming?.startedAt).toBe(started);
    expect(s.ammo).toBe(50);
    battle.step(5);
    expect(s.ammo).toBeLessThan(50);
  });
});
