import { describe, expect, it } from 'vitest';
import { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { stepMovement } from '@/sim/movement';
import { stepCombat } from '@/sim/combat';
import { ableToLoot, stepPickups } from '@/sim/pickup';
import { stepItemDrops } from '@/sim/items';
import { doorSpot, onPassengerBoarded, stepTransport } from '@/sim/transport';
import { VEHICLE_DEFS } from '@/data/units';
import { applyOrder } from '@/sim/orders';
import { stepCrewWeapons, isInAction, crewWeaponStatus } from '@/sim/crewWeapon';
import { addGun, addTank, makeState, soldier } from './vehicleDamageHelpers';

function scene(weaponId = 'mg34_hmg', n = 2, packed = false) {
  const state = makeState(), rng = new Rng(7);
  const { team, gunner, men } = addGun(state, weaponId, { x: 30, y: 30 }, n, { ammo: 200, ammoReserve: 300 });
  team.type = 'mg'; const cw = team.crewWeapon!;
  if (packed) { cw.phase = 'packed'; cw.setAt = -1;
    team.order = { type: 'move', target: { x: 70, y: 30 }, issuedAt: 0 };
    for (const s of men) { s.path = [{ x: 70, y: 30 }]; s.activity = 'moving'; s.stance = 'standing'; }
  }
  const tick = (seconds: number, combat = false) => {
    for (let i = 0; i < Math.round(seconds / 0.1); i++) {
      state.time += 0.1; stepMovement(state, rng, 0.1); if (combat) stepCombat(state, rng, 0.1);
    }
  };
  return { state, team, gunner, men, cw, tick };
}

describe('physical machine-gun mounts', () => {
  it.each(['mg34_hmg', 'mg42_hmg', 'maxim'])('assigns the %s mount to a different man while travelling', (id) => {
    const { cw, gunner, men, tick } = scene(id, 2, true); tick(0.1);
    expect(cw.mount?.state).toBe('carried'); expect(cw.mount?.carrierId).toBe(men[1].id);
    expect(cw.mount?.carrierId).not.toBe(gunner.id);
    const before = { ...men[1].pos }; tick(1);
    expect(dist(men[1].pos, before)).toBeGreaterThan(0);
    expect(dist(cw.mount!.pos, men[1].pos)).toBeLessThan(0.2);
  });

  it.each(['mg34_hmg', 'mg42_hmg'])('drops the carried %s mount and continues with the light gun', (id) => {
    const { cw, gunner, men, tick, team } = scene(id, 2, true); tick(0.1);
    const fallen = { ...men[1].pos }; men[1].health = 'incapacitated'; tick(0.1);
    expect(cw.mount?.state).toBe('ground'); expect(cw.mount?.pos).toEqual(fallen);
    expect(gunner.weaponId).toBe(id.replace('_hmg', '')); expect(cw.lightMode).toBe(true);
    expect(gunner.ammo + gunner.ammoReserve).toBe(500);
    const before = { ...gunner.pos }; tick(1); expect(dist(gunner.pos, before)).toBeGreaterThan(0.1);
    gunner.path = []; team.order = { type: 'fire', target: { x: 60, y: 30 }, issuedAt: 2 };
    tick(8, true); expect(gunner.ammo + gunner.ammoReserve).toBeLessThan(500);
    expect(cw.mount!.pos).toEqual(fallen);
  });

  it('keeps a deployed gun mounted and firing after its assistant is incapacitated', () => {
    const { cw, gunner, men, tick, team } = scene(); tick(0.1);
    men[1].health = 'incapacitated'; const pivot = { ...cw.pos };
    team.order = { type: 'fire', target: { x: 30, y: 5 }, issuedAt: 0.1 };
    tick(15, true);
    expect(cw.mount?.state).toBe('deployed'); expect(cw.pos).toEqual(pivot);
    expect(isInAction(cw)).toBe(true); expect(gunner.weaponId).toBe('mg34_hmg');
    expect(gunner.ammo + gunner.ammoReserve).toBeLessThan(500);
  });

  it('lets a lone MG34 gunner pack the gun and leave its tripod in place', () => {
    const { state, cw, gunner, men, tick, team } = scene(); tick(0.1);
    men[1].health = 'dead'; const mount = { ...cw.pos };
    applyOrder(state, team, { type: 'move', target: { x: 65, y: 30 }, issuedAt: state.time }, new Rng(7)); tick(25);
    expect(cw.lightMode).toBe(true); expect(gunner.weaponId).toBe('mg34');
    expect(cw.mount!.pos).toEqual(mount); expect(dist(gunner.pos, mount)).toBeGreaterThan(3);
  });

  it('resumes the move after reloading an empty gun during the switch to light mode', () => {
    const { state, cw, gunner, men, tick, team } = scene(); tick(0.1);
    men[1].health = 'dead'; gunner.ammo = 0; const start = { ...gunner.pos };
    applyOrder(state, team, { type: 'move', target: { x: 65, y: 30 }, issuedAt: state.time }, new Rng(7));
    tick(30, true);
    expect(cw.lightMode).toBe(true); expect(gunner.ammo).toBe(50);
    expect(dist(gunner.pos, start)).toBeGreaterThan(4);
  });

  it.each([true, false])('holds a Maxim without its assistant (initially packed: %s)', (packed) => {
    const { state, team, cw, gunner, men, tick } = scene('maxim', 2, packed); tick(0.1);
    men[1].health = 'incapacitated'; const start = { ...gunner.pos };
    if (!packed) applyOrder(state, team, { type: 'move', target: { x: 65, y: 30 }, issuedAt: state.time }, new Rng(7));
    tick(15);
    expect(gunner.weaponId).toBe('maxim'); expect(cw.lightMode).not.toBe(true);
    expect(dist(gunner.pos, start)).toBeLessThan(0.2);
    expect(crewWeaponStatus(team)).toBe('Need carrier');
    if (!packed) expect(isInAction(cw)).toBe(true);
  });

  it('packs and moves a deployed Maxim when both load carriers are capable', () => {
    const { state, team, cw, gunner, men, tick } = scene('maxim'); tick(0.1);
    const start = { ...gunner.pos };
    applyOrder(state, team, { type: 'move', target: { x: 65, y: 30 }, issuedAt: state.time }, new Rng(7));
    tick(30);
    expect(cw.phase).toBe('packed'); expect(cw.mount?.state).toBe('carried');
    expect(cw.mount?.carrierId).toBe(men[1].id); expect(cw.mountBlocked).toBe(false);
    expect(dist(gunner.pos, start)).toBeGreaterThan(3);
  });

  it('requires a replacement to reach the fallen mount before carrying it', () => {
    const { cw, men, tick } = scene('mg34_hmg', 3, true); tick(0.1);
    const carrier = men.find(s => s.id === cw.mount!.carrierId)!;
    const replacement = men.find(s => s !== carrier && s.id !== cw.gunnerId)!;
    replacement.pos = { x: carrier.pos.x - 4, y: carrier.pos.y }; carrier.health = 'dead';
    const dropped = { ...carrier.pos }; tick(0.1);
    expect(cw.mount?.state).toBe('ground'); expect(cw.mount?.pos).toEqual(dropped);
    tick(0.5); expect(cw.mount?.state).toBe('ground');
    tick(18); expect(cw.mount?.state).toBe('carried'); expect(cw.mount?.carrierId).toBe(replacement.id);
  });

  it('cannot place a carried tripod across impassable ground', () => {
    const { state, cw, gunner, men, tick, team } = scene('mg34_hmg', 2, true); tick(0.1);
    gunner.pos = { x: 32, y: 30 }; men[1].pos = { x: 25, y: 30 };
    for (const s of men) { s.path = []; s.activity = 'idle'; }
    team.order = { type: 'defend', target: gunner.pos, issuedAt: 0.1 };
    for (let y = 0; y < state.map.height; y++) state.map.tiles[y * state.map.width + 28] = 'water';
    tick(30);
    expect(cw.mount?.state).toBe('carried'); expect(cw.mount!.pos.x).toBeLessThan(28);
    expect(isInAction(cw)).toBe(false);
  });

  it('does not conjure a new mount when the light gun stops far from a lost tripod', () => {
    const { cw, gunner, men, tick, team } = scene('mg42_hmg', 2, true); tick(0.1);
    men[1].health = 'dead'; tick(1); const dropped = { ...cw.mount!.pos };
    gunner.pos = { x: 100, y: 30 }; gunner.path = []; team.order = null; tick(20);
    expect(gunner.weaponId).toBe('mg42'); expect(cw.lightMode).toBe(true);
    expect(cw.mount!.pos).toEqual(dropped); expect(cw.mount!.state).toBe('ground');
  });

  it.each([false, true])('keeps the two physical loads while their crew rides in a transport (light mode: %s)', (light) => {
    const { state, team, cw, gunner, men, tick } = scene('mg34_hmg', 2, true); tick(0.1);
    if (light) { cw.lightMode = true; gunner.weaponId = 'mg34'; }
    const { v } = addTank(state, 'sdkfz251', { x: 50, y: 50 }, 0);
    for (const s of men) { s.vehicleId = v.id; s.seat = 'passenger'; s.pos = { ...v.pos }; }
    team.transportId = v.id; stepCrewWeapons(state, 0.1);
    expect(cw.mount?.state).toBe('carried'); expect(cw.mount?.carrierId).toBe(men[1].id);
    expect(cw.mount?.pos).toEqual(v.pos); expect(gunner.weaponId).toBe(light ? 'mg34' : 'mg34_hmg');
  });

  it('cannot bypass a missing Maxim carrier by boarding a nearby transport', () => {
    const { state, team, gunner, men, tick } = scene('maxim', 2, true); tick(0.1);
    men[1].health = 'dead';
    const { v } = addTank(state, 'sdkfz251', { x: 35, y: 35 }, 0);
    const door = doorSpot(state, v, VEHICLE_DEFS.sdkfz251);
    gunner.pos = { ...door }; team.transportId = v.id;
    team.order = { type: 'move', target: door, issuedAt: state.time, mountVehicleId: v.id };
    tick(0.1); stepTransport(state, 0.1);
    expect(gunner.hatch).toBeUndefined(); expect(gunner.vehicleId).toBeNull();
    expect(team.order?.mountVehicleId).toBe(v.id);
  });

  it.each(['maxim', 'mg34_hmg'])('lets the %s gunner board after the separate mount carrier boards first', (id) => {
    const { state, team, cw, gunner, men, tick } = scene(id, 2, true); tick(0.1);
    if (id === 'mg34_hmg') { cw.lightMode = true; gunner.weaponId = 'mg34'; }
    const { v } = addTank(state, 'sdkfz251', { x: 35, y: 35 }, 0);
    const door = doorSpot(state, v, VEHICLE_DEFS.sdkfz251), carrier = men[1];
    gunner.pos = { ...door }; carrier.pos = { ...door }; team.transportId = v.id;
    team.order = { type: 'move', target: door, issuedAt: state.time, mountVehicleId: v.id };
    stepTransport(state, 0.1); expect(carrier.hatch?.kind).toBe('mount');
    stepCrewWeapons(state, 0.1); expect(cw.mountBlocked).toBe(false);
    onPassengerBoarded(state, v, carrier); carrier.hatch = undefined; state.time += 2;
    stepCrewWeapons(state, 0.1); stepTransport(state, 0.1);
    expect(cw.mount?.state).toBe('carried'); expect(gunner.hatch?.kind).toBe('mount');
  });

  it('keeps a mount carrier from firing or throwing grenades while his hands are occupied', () => {
    const { state, men, tick } = scene('mg34_hmg', 2, true); tick(0.1);
    const carrier = men[1]; carrier.grenades = 2;
    expect(ableToLoot(state, carrier)).toBe(false);
    const enemy = soldier(500, 500, 'soviet', { x: carrier.pos.x + 4, y: carrier.pos.y }, 'none');
    state.soldiers.set(enemy.id, enemy); state.spotted.german.add(enemy.id);
    const ammo = carrier.ammo; tick(3, true);
    expect(carrier.ammo).toBe(ammo); expect(carrier.grenades).toBe(2);
  });

  it('redeploys only after a recovered mount and its gun are reunited', () => {
    const { cw, gunner, men, tick, team } = scene('mg34_hmg', 3, true); tick(0.1);
    const carrier = men.find(s => s.id === cw.mount!.carrierId)!;
    carrier.health = 'dead'; tick(0.1); expect(cw.lightMode).toBe(true);
    for (const s of men) { s.path = []; s.activity = 'idle'; }
    team.order = { type: 'defend', target: gunner.pos, issuedAt: 1 };
    tick(0.5); expect(gunner.weaponId).toBe('mg34');
    tick(30); expect(gunner.weaponId).toBe('mg34_hmg');
    expect(cw.mount?.state).toBe('deployed'); expect(isInAction(cw)).toBe(true);
  });

  it('lets a survivor physically recover the light gun after both gunner and carrier fall', () => {
    const { state, cw, gunner, men, tick, team } = scene('mg34_hmg', 3, true); tick(0.1);
    const carrier = men.find(s => s.id === cw.mount!.carrierId)!;
    const survivor = men.find(s => s !== carrier && s !== gunner)!;
    survivor.mind.state = 'pinned'; carrier.health = 'dead'; tick(0.1);
    expect(gunner.weaponId).toBe('mg34');
    gunner.health = 'dead'; const rng = new Rng(4); stepItemDrops(state, rng);
    survivor.mind.state = 'calm'; survivor.path = []; survivor.activity = 'idle'; team.order = null;
    for (let i = 0; i < 300; i++) { tick(0.1); stepPickups(state, rng, 0.1); }
    expect(survivor.weaponId).toBe('mg34'); expect(cw.gunnerId).toBe(survivor.id);
    expect(state.items?.filter(item => item.kind === 'weapon' && item.weaponId === 'mg34')).toHaveLength(0);
    expect(cw.mount?.state).not.toBe('carried');
  });

  it('treats a pinned, exhausted, or already burdened assistant as unable to carry a mount', () => {
    for (const condition of ['pinned', 'exhausted', 'carrying'] as const) {
      const { state, cw, gunner, men } = scene('mg34_hmg', 2, true);
      if (condition === 'pinned') men[1].mind.state = 'pinned';
      if (condition === 'exhausted') men[1].fatigue = 95;
      if (condition === 'carrying') men[1].carrying = { patientId: 999, since: 0 };
      stepCrewWeapons(state, 0.1);
      expect(cw.mount?.state).toBe('ground'); expect(gunner.weaponId).toBe('mg34');
    }
  });
});
