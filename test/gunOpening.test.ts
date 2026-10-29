import { describe, expect, it } from 'vitest';
import { makeState, W } from './kitHelpers';
import { addGun } from './vehicleDamageHelpers';
import { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { stepMovement } from '@/sim/movement';
import { stepCombat } from '@/sim/combat';
import { crewShotOrigin, stepCrewWeapons, crewWeaponStatus } from '@/sim/crewWeapon';
import { applyOrder } from '@/sim/orders';
import { crewTaskAnim } from '@/render/soldierAnim';
import { crewSoldierDraws } from '@/render/unitRender';
import { hashState } from '@/sim/stateHash';

function room(material: 'buildingStone' | 'buildingWood' = 'buildingStone', weaponId = 'pak40') {
  const state = makeState(), rng = new Rng(1);
  for (let y = 5; y <= 22; y++) for (let x = 6; x <= 18; x++) {
    state.map.tiles[y * W + x] = x === 6 || x === 18 || y === 5 || y === 22 ? material : 'floor';
    state.map.buildingId[y * W + x] = 1;
  }
  const { team, gunner, men } = addGun(state, weaponId, { x: 12.5, y: 13.5 }, 3, { ammo: 5, ammoReserve: 20 });
  team.facing = 2; team.order = { type: 'fire', target: { x: 32.5, y: 13.5 }, issuedAt: state.time };
  const tick = (seconds: number, combat = false) => {
    for (let i = 0; i < Math.round(seconds / 0.1); i++) {
      state.time += 0.1; stepMovement(state, rng, 0.1); if (combat) stepCombat(state, rng, 0.1);
    }
  };
  return { state, team, gunner, men, cw: team.crewWeapon!, tick, rng };
}

describe('PAK building openings', () => {
  it('walks a worker to the wall and animates real work before changing it', () => {
    const { state, cw, tick, men, team } = room(); tick(0.1);
    expect(cw.gunOpening?.stage).toBe('work'); expect(crewWeaponStatus(team)).toBe('Setting up');
    const wall = cw.gunOpening!.wall; tick(1);
    expect(state.map.tiles[Math.floor(wall.y) * W + Math.floor(wall.x)]).toBe('buildingStone');
    expect(cw.gunOpening!.worked).toBe(0);
    tick(25);
    const worker = men.find(s => s.crewTask?.id === 'breachWall' && !s.crewTask.walking)!;
    expect(worker).toBeDefined(); expect(crewTaskAnim(worker, state.time)?.keys[0]).toBe('crew.dig');
    expect(crewSoldierDraws(state).get(worker.id)?.heading).toBeCloseTo(Math.PI / 2, 1);
    expect(dist(worker.pos, cw.gunOpening!.station)).toBeLessThan(0.4);
  });
  it('opens the wall, packs and pushes the gun, deploys with the barrel outside, and fires', () => {
    const { state, cw, tick, gunner, men } = room(); const start = { ...cw.pos };
    tick(160, true);
    expect(state.map.tiles[13 * W + 18]).toBe('rubble');
    expect(state.map.dirtyTiles).toContain(13 * W + 18);
    expect(cw.gunOpening).toBeUndefined(); expect(cw.preparedOpening).toBeDefined();
    expect(cw.phase).toBe('ready'); expect(dist(cw.pos, start)).toBeGreaterThan(3);
    expect(cw.pos.x).toBeLessThan(18); expect(crewShotOrigin(state, gunner)!.pos.x).toBeGreaterThan(19);
    expect(state.events.some(e => e.kind === 'shot' && e.weaponId === 'pak40')).toBe(true);
    expect(men.every(s => s.health === 'healthy')).toBe(true);
  });
  it('pauses when the worker is incapacitated and another crewman must approach before resuming', () => {
    const { cw, tick, men, state } = room(); tick(26);
    const worker = state.soldiers.get(cw.gunOpening!.workerId!)!;
    const worked = cw.gunOpening!.worked; worker.health = 'incapacitated';
    const other = men.find(s => s !== worker && s.id !== cw.gunnerId)!; other.pos = { x: 10, y: 15 };
    tick(0.1); expect(cw.gunOpening!.worked).toBe(worked);
    expect(cw.gunOpening!.workerId).toBe(other.id);
  });
  it('cancels on a new move order, without cutting the wall remotely', () => {
    const { state, team, cw, tick, rng } = room(); tick(1);
    applyOrder(state, team, { type: 'move', target: { x: 10, y: 12 }, issuedAt: state.time }, rng);
    expect(cw.gunOpening).toBeUndefined(); tick(4);
    expect(state.map.tiles[13 * W + 18]).toBe('buildingStone');
  });
  it('does not prepare an opening for a gun outside a building', () => {
    const { state, cw, tick } = room(); state.map.buildingId.fill(-1); tick(2);
    expect(cw.gunOpening).toBeUndefined();
  });
  it('cannot work through an impassable partition', () => {
    const { state, cw, tick } = room();
    for (let y = 6; y <= 21; y++) state.map.tiles[y * W + 16] = 'water';
    tick(70); expect(cw.gunOpening).toBeUndefined();
    expect(state.map.tiles[13 * W + 18]).toBe('buildingStone');
  });
  it('hashes work progress and reproduces the same complete drill', () => {
    const a = room(), b = room(); a.tick(25); b.tick(25);
    expect(hashState(a)).toBe(hashState(b));
    a.cw.gunOpening!.worked += 0.1; expect(hashState(a)).not.toBe(hashState(b));
    a.cw.gunOpening!.worked = b.cw.gunOpening!.worked;
    a.tick(140, true); b.tick(140, true); expect(hashState(a)).toBe(hashState(b));
  });
  it.each(['pak38', 'm1937_45mm', 'zis3'])('positions the %s barrel using its own length', weaponId => {
    const { state, cw, gunner, tick } = room('buildingWood', weaponId); tick(160, true);
    expect(cw.preparedOpening).toBeDefined(); expect(crewShotOrigin(state, gunner)!.pos.x).toBeGreaterThan(19);
    expect(state.events.some(e => e.kind === 'shot' && e.weaponId === weaponId)).toBe(true);
  });
  it('reuses an existing breach without ordering a worker to break empty air', () => {
    const { state, cw, tick } = room(); state.map.tiles[13 * W + 18] = 'rubble'; tick(0.1);
    expect(cw.gunOpening?.stage).not.toBe('work'); tick(120);
    expect(cw.preparedOpening).toBeDefined();
  });
  it('finishes a wooden wall sooner than a stone wall', () => {
    const wood = room('buildingWood'), stone = room('buildingStone'); wood.tick(40); stone.tick(40);
    expect(wood.state.map.tiles[13 * W + 18]).toBe('rubble');
    expect(stone.state.map.tiles[13 * W + 18]).toBe('buildingStone');
  });
  it('keeps the occupied emplacement stable and launches flashes and rounds from the barrel', () => {
    const { state, cw, tick, gunner } = room(); tick(140, true);
    const pos = { ...cw.pos }; tick(20, true);
    expect(cw.gunOpening).toBeUndefined(); expect(cw.pos).toEqual(pos);
    const muzzle = crewShotOrigin(state, gunner)!.pos;
    expect(state.flashes.some(f => f.kind === 'shell' && dist(f.pos, muzzle) < 0.1)).toBe(true);
    expect(state.tracers.some(t => t.kind === 'shell' && t.from.x > 19)).toBe(true);
  });
});
