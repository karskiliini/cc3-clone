import { describe, expect, it } from 'vitest';
import type { CrewWeaponState, Vec3 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { hullParams } from '@/data/vehiclePhysics';
import { canTowWeapon, createTowStep, rearHitch } from '@/sim/vehicleTow';
import { towLengthM, weaponFramePoint } from '@/sim/crewWeapon';
import { multiply, rotate, yawQuat } from '@/sim/hullMath';
import { addTank, makeState, mkTeam } from './vehicleDamageHelpers';

function scene() {
  const state = makeState(), { v } = addTank(state, 'jeep', { x: 100, y: 100 });
  const h = rearHitch(v)!, length = towLengthM('m1937_45mm');
  const cw: CrewWeaponState = {
    weaponId: 'm1937_45mm', pos: { x: h.x / TILE_M, y: (h.y + length) / TILE_M }, facing: Math.PI,
    phase: 'packed', timer: 0, phaseTotal: 0, gunnerId: -1, abandoned: false, abandonedAt: 0, setAt: 0,
    transport: { vehicleId: v.id, phase: 'towed', startedAt: 0, until: 0, from: { x: 100, y: 102 } },
  };
  const team = mkTeam(700, 'atgun', [], v.side, cw.pos); team.crewWeapon = cw;
  state.teams.set(team.id, team); v.towedTeamId = team.id;
  const p: Vec3 = { x: v.pos.x * TILE_M, y: v.pos.y * TILE_M, z: hullParams(VEHICLE_DEFS[v.defId]).cgHeightM };
  return { state, v, cw, team, p };
}
function expectConnected(cw: CrewWeaponState, hitch: Vec3) {
  const eye = weaponFramePoint(cw.pos, cw.facing, { x: 0, y: towLengthM(cw.weaponId) });
  expect(eye.x * TILE_M).toBeCloseTo(hitch.x, 10);
  expect(eye.y * TILE_M).toBeCloseTo(hitch.y, 10);
}

describe('staged articulated gun towing', () => {
  it('keeps the axle at a fixed drawbar length through a turn and reversing, committing only at the end', () => {
    const { state, v, cw, p } = scene(), original = structuredClone(cw), step = createTowStep(state, v)!;
    const q = yawQuat(0), next = { ...p, y: p.y - 2 };
    expect(step.accept(next, q)).toBe(true);
    expect(cw).toEqual(original);
    const turn = { ...next, x: next.x + 2, y: next.y - 1 }, turnedQ = yawQuat(0.4);
    expect(step.accept(turn, turnedQ)).toBe(true);
    const reverse = { ...turn, y: turn.y + 0.5 };
    expect(step.accept(reverse, turnedQ)).toBe(true);
    step.commit();
    expectConnected(cw, rearHitch(v, reverse, turnedQ)!);
    expect(cw.facing).not.toBe(original.facing);
    expect(cw.pos).not.toEqual(original.pos);
  });

  it('rejects an intervening solid tile even when the proposed end is far beyond it', () => {
    const { state, v, cw, p } = scene();
    // A wall behind the barrel, crossed while reversing; the start is clear.
    state.map.tiles[105 * state.map.width + 100] = 'stonewall';
    const original = structuredClone(cw), step = createTowStep(state, v)!;
    expect(step.accept(p, yawQuat(0))).toBe(true);
    expect(step.accept({ ...p, y: p.y + 15 }, yawQuat(0))).toBe(false);
    step.commit();
    expect(cw).toEqual(original);
  });

  it('rejects a corner obstacle swept by the turning barrel', () => {
    const { state, v, cw, p } = scene(), original = structuredClone(cw);
    // A narrow wall east of the initial envelope, not under the tractor.
    for (let y = 98; y <= 108; y++) state.map.tiles[y * state.map.width + 103] = 'stonewall';
    const step = createTowStep(state, v)!;
    expect(step.accept(p, yawQuat(0))).toBe(true);
    expect(step.accept({ ...p, x: p.x + 12, y: p.y - 2 }, yawQuat(0.9))).toBe(false);
    step.commit(); expect(cw).toEqual(original);
  });

  it('blocks another hull, including a wreck, while excluding its own tractor', () => {
    const { state, v, cw, p } = scene();
    const other = addTank(state, 't34_76', { x: cw.pos.x, y: cw.pos.y + 5 }).v;
    other.state = 'knockedOut';
    const step = createTowStep(state, v)!;
    expect(step.accept(p, yawQuat(0))).toBe(true);
    expect(step.accept({ ...p, y: p.y + 10 }, yawQuat(0))).toBe(false);
  });

  it('uses the full hull orientation and model-origin offset for the rear hitch', () => {
    const { v, p } = scene(), def = VEHICLE_DEFS[v.defId], anchor = def.lightTransport!.hitch;
    const q = multiply(yawQuat(0.6), { x: Math.sin(0.2), y: 0, z: 0, w: Math.cos(0.2) });
    const local = { x: anchor.x, y: anchor.y, z: anchor.z + hullParams(def).modelOriginLocal.z };
    const r = rotate(q, local), h = rearHitch(v, p, q)!;
    expect(h).toEqual({ x: p.x + r.x, y: p.y + r.y, z: p.z + r.z });
    expect(h.z).not.toBe(anchor.z);
  });

  it('leaves detached guns alone and refuses stale, malformed or oversized attachments', () => {
    const { state, v, cw, p } = scene();
    delete v.towedTeamId; expect(createTowStep(state, v)).toBeNull();
    v.towedTeamId = 700; cw.transport!.phase = 'uncoupling';
    expect(createTowStep(state, v)!.accept(p, yawQuat(0))).toBe(false);
    cw.transport!.phase = 'towed'; cw.pos.x += 1;
    expect(createTowStep(state, v)!.accept(p, yawQuat(0))).toBe(false);
    expect(canTowWeapon(v, 'pak40')).toBe(false);
    expect(canTowWeapon(v, 'unknown')).toBe(false);
    expect(canTowWeapon(v, 'm1937_45mm')).toBe(true);
  });

  it('bounds nonfinite and out-of-map sweeps without moving the gun', () => {
    const { state, v, cw, p } = scene(), original = structuredClone(cw), step = createTowStep(state, v)!;
    for (const x of [NaN, Infinity, -1e100, 1e100, -1]) expect(step.accept({ ...p, x }, yawQuat(0))).toBe(false);
    expect(step.accept(p, { x: 0, y: 0, z: 0, w: 0 })).toBe(false);
    step.commit(); expect(cw).toEqual(original);
  });
});
