import { describe, expect, it } from 'vitest';
import { Rng } from '@/shared/rng';
import { WEAPONS } from '@/data/weapons';
import { angleTo, wrapAngle } from '@/shared/math';
import { stepCombat } from '@/sim/combat';
import { stepMovement } from '@/sim/movement';
import { chooseSmgHandling, createSmgBurst, smgRoundAim } from '@/sim/smgFire';
import { addTank, makeState, mkTeam, soldier } from './vehicleDamageHelpers';

function scene(weaponId = 'mp40', rangeM = 40) {
  const state = makeState();
  const s = soldier(1, 1, 'german', { x: 30, y: 60 }, weaponId, { ammo: WEAPONS[weaponId].ammo, stance: 'standing', facing: 2 });
  const team = mkTeam(1, 'smg', [1], 'german', s.pos);
  team.order = { type: 'fire', target: { x: s.pos.x + rangeM / 2, y: s.pos.y }, issuedAt: 0 };
  state.soldiers.set(1, s); state.teams.set(1, team);
  const rng = new Rng(19);
  const tick = (seconds: number, move = false) => {
    for (let i = 0; i < Math.round(seconds / 0.02); i++) {
      state.time += 0.02;
      if (move) stepMovement(state, rng, 0.02);
      stepCombat(state, rng, 0.02);
    }
  };
  const start = () => {
    for (let i = 0; i < 1000 && !s.smgBurst; i++) tick(0.02);
    expect(s.smgBurst).toBeDefined();
    return s.smgBurst!;
  };
  return { state, s, team, tick, start };
}

describe('SMG fire discipline and handling', () => {
  it('uses deliberate shoulder fire at range, with short trigger pulls', () => {
    const { s, team } = scene('mp40', 100);
    const h = chooseSmgHandling(s, team.order!.target, team, new Rng(1));
    expect(h).toEqual({ mode: 'aimed', uncontrolled: false });
    const b = createSmgBurst(s, WEAPONS.mp40, team.order!.target, team, 2, new Rng(1));
    expect(b.rounds).toBe(2);
  });

  it('makes magazine dumps more likely near panic and less likely with training', () => {
    const { s, team } = scene();
    const count = (stress: number, experience: number) => {
      s.mind.stress = stress; s.mind.fear = stress; s.experience = experience;
      s.mind.state = stress > 50 ? 'shaken' : 'calm';
      let n = 0;
      for (let seed = 1; seed <= 300; seed++) if (chooseSmgHandling(s, team.order!.target, team, new Rng(seed)).uncontrolled) n++;
      return n;
    };
    const calm = count(0, 20), frightened = count(95, 20), veteran = count(95, 90);
    expect(calm).toBe(0);
    expect(frightened).toBeGreaterThan(130);
    expect(veteran).toBeLessThan(frightened * 0.6);
  });

  it('offers hip fire for a close assault but never while prone or at long range', () => {
    const { s, team } = scene('mp40', 15);
    team.order!.type = 'assault'; s.activity = 'moving';
    let hip = 0;
    for (let seed = 1; seed <= 100; seed++) if (chooseSmgHandling(s, team.order!.target, team, new Rng(seed)).mode === 'hip') hip++;
    expect(hip).toBeGreaterThan(20);
    s.stance = 'prone';
    for (let seed = 1; seed <= 30; seed++) expect(chooseSmgHandling(s, team.order!.target, team, new Rng(seed)).mode).toBe('aimed');
    s.stance = 'standing'; team.order!.target.x += 60;
    expect(chooseSmgHandling(s, team.order!.target, team, new Rng(1)).mode).toBe('aimed');
  });

  it('produces a wider, less controlled fan from the hip and a steadier prone burst', () => {
    const { s, team } = scene();
    const spread = (mode: 'aimed' | 'hip', prone: boolean) => {
      s.stance = prone ? 'prone' : 'standing';
      s.aiming = { startedAt: 0, readyAt: 1, fromFacing: Math.PI / 2, from: { ...s.pos }, at: team.order!.target,
        targetKind: 'point', weaponId: s.weaponId, stance: s.stance, fireMode: mode, uncontrolled: true };
      const b = createSmgBurst(s, WEAPONS.mp40, team.order!.target, team, 1, new Rng(1));
      const rng = new Rng(7), headings: number[] = [], recoils: number[] = [];
      for (let i = 0; i < b.rounds; i++) { const a = smgRoundAim(s, b, i, rng); headings.push(a.heading); recoils.push(a.recoil); }
      return { span: Math.max(...headings) - Math.min(...headings), recoil: Math.max(...recoils) };
    };
    const hip = spread('hip', false), aimed = spread('aimed', false), prone = spread('aimed', true);
    expect(hip.span).toBeGreaterThan(aimed.span);
    expect(aimed.span).toBeGreaterThan(prone.span);
    expect(hip.recoil).toBeGreaterThan(aimed.recoil);
    expect(prone.recoil).toBeLessThan(aimed.recoil);
  });
});

describe('SMG timed rounds in combat', () => {
  it('spends ammunition round by round instead of firing a whole burst at once', () => {
    const { s, tick, start } = scene();
    const b = start();
    expect(s.ammo).toBe(31);
    expect(b.fired).toBe(1);
    tick(0.06); expect(s.ammo).toBe(31);
    tick(0.08); expect(s.ammo).toBe(30);
    tick(0.5); expect(s.ammo).toBe(32 - b.rounds);
  });

  it('turns the muzzle and sends consecutive rounds through the actual sweeping fan', () => {
    const { state, s, tick, start } = scene();
    tick(0.02); s.aiming!.uncontrolled = true; s.aiming!.fireMode = 'hip';
    const b = start();
    expect(b.rounds).toBe(32);
    const rays: number[] = [];
    for (let i = 0; i < 40 && s.ammo; i++) {
      state.tracers.length = 0; state.flashes.length = 0;
      tick(0.12);
      const ray = state.tracers.at(-1);
      if (ray) {
        const direction = angleTo(ray.from, ray.to); rays.push(direction);
        expect(Math.abs(wrapAngle(direction - b.heading))).toBeLessThan(0.001);
        expect(Math.abs(wrapAngle(state.flashes.at(-1)!.facing - b.heading))).toBeLessThan(0.001);
      }
    }
    expect(s.ammo).toBe(0);
    expect(rays.length).toBeGreaterThan(20);
    expect(Math.max(...rays) - Math.min(...rays)).toBeGreaterThan(0.3);
  });

  it.each(['stun', 'panic', 'brokenMind', 'death', 'order', 'weapon', 'indirectWeapon', 'stance'] as const)('interrupts a burst on %s without spending unfired rounds', (reason) => {
    const { s, state, team, start, tick } = scene();
    start(); const ammo = s.ammo;
    if (reason === 'stun') s.stunnedUntil = state.time + 3;
    if (reason === 'panic') { s.activity = 'panicked'; s.mind.state = 'panicked'; }
    if (reason === 'brokenMind') s.mind.state = 'broken';
    if (reason === 'death') s.health = 'dead';
    if (reason === 'order') team.order = { type: 'moveFast', target: { x: 10, y: 10 }, issuedAt: state.time };
    if (reason === 'weapon') s.weaponId = 'kar98k';
    if (reason === 'indirectWeapon') s.weaponId = 'mortar81';
    if (reason === 'stance') s.stance = 'prone';
    tick(0.3);
    expect(s.ammo).toBe(ammo);
    expect(s.smgBurst).toBeUndefined();
  });

  it('cannot throw a grenade while holding the trigger down', () => {
    const { s, state, start, tick } = scene('mp40', 15);
    start(); s.grenades = 2;
    state.soldiers.set(2, soldier(2, 2, 'soviet', { x: 37.5, y: 60 }, 'none'));
    state.spotted.german.add(2);
    tick(0.2);
    expect(s.grenades).toBe(2);
    expect(s.throwAt).toBeUndefined();
  });

  it('hits a hull along the firing ray and protects infantry behind it', () => {
    const { s, state, start, tick } = scene();
    start(); state.tracers.length = 0;
    const { v } = addTank(state, 't34_76', { x: 40, y: 60 }, 0);
    const behind = soldier(2, 2, 'soviet', { x: 49.5, y: 60 }, 'none');
    state.soldiers.set(2, behind);
    tick(0.3);
    expect(state.sparks.some(spark => spark.kind === 'armor')).toBe(true);
    expect(state.tracers.every(ray => ray.to.x < v.pos.x)).toBe(true);
    expect(behind.health).toBe('healthy');
    expect(behind.suppression).toBe(0);
    expect(s.ammo).toBeLessThan(31);
  });

  it('does not hit a soldier just beyond an intervening solid wall', () => {
    const { state, start, tick } = scene();
    start();
    for (let y = 55; y < 65; y++) state.map.tiles[y * state.map.width + 40] = 'stonewall';
    const behind = soldier(2, 2, 'soviet', { x: 40.2, y: 60.1 }, 'none');
    state.soldiers.set(2, behind); state.tracers.length = 0;
    tick(0.3);
    expect(state.tracers.length).toBeGreaterThan(0);
    expect(behind.health).toBe('healthy');
    expect(behind.suppression).toBe(0);
  });

  it('holds a moving soldier through the entire burst, then releases his route', () => {
    const { s, state, team, start, tick } = scene();
    start(); const b = s.smgBurst!;
    s.activity = 'moving'; s.path = [{ x: 70, y: 60 }];
    const p = { ...s.pos };
    tick(0.2, true); expect(s.pos).toEqual(p);
    tick(1, true); expect(s.pos.x).toBeGreaterThan(p.x);
    expect(state.time).toBeGreaterThan(b.until);
    expect(team.order).toBeDefined();
  });
});
