import { LightTransportScene } from '@/render/vehicle3d/lightTransportScene';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Mesh, MeshLambertMaterial, Vector3 } from 'three';
import { VEHICLE_DEFS } from '@/data/units';
import { actionProgress, boardingWorld, cargoLocal, localWorld, seatForSoldier, transportLayout, type TransportAction } from '@/render/lightTransport';
import { createJeepModel } from '@/render/vehicle3d/jeep';
import { vehicleLook, type VehicleLook } from '@/render/vehicle3d/look';
import { ModelCache } from '@/render/vehicle3d/models';
import { VehicleScene } from '@/render/vehicle3d/vehicleScene';
import { crewSoldierDraws, drawCrewWeapons } from '@/render/unitRender';
import { freeAllAtlases, registerAtlas, type AtlasMeta } from '@/render/spriteAtlas';
import { worldToScreen } from '@/engine/camera';
import type { Camera } from '@/shared/types';
import { addGun, addTank, makeState, soldier } from './vehicleDamageHelpers';

function look(over: Partial<VehicleLook> = {}): VehicleLook {
  return { id: 1, defId: 'jeep', posTiles: { x: 10, y: 20 }, hullRad: 0, turretRad: 0, ko: false, liveButLeft: false,
    turretBlown: false, brokenTrack: null, turretLanding: null, season: 'summer', recoil: 0, ...over };
}
const layout = transportLayout(VEHICLE_DEFS.jeep)!;
const action: TransportAction = { vehicleId: 1, phase: 'loading', startedAt: 2, until: 6, from: { x: 8, y: 19 } };

describe('light carrier visuals', () => {
  it('has a distinct locally generated Jeep with four independently centred wheels and matte paint', () => {
    const model = createJeepModel();
    expect(model.hasTurret).toBe(false);
    expect(model.wheels).toHaveLength(4);
    expect(new Set(model.wheels!.map(w => `${w.centreM.x}/${w.centreM.y}`)).size).toBe(4);
    for (const state of ['ok', 'ko']) for (const w of model.wheels!) {
      const node = model.nodes.get(`wheels_${w.side}_${w.index}_${state}`)!;
      node.geometry.computeBoundingBox();
      expect(node.geometry.boundingBox!.getCenter(new Vector3()).length()).toBeLessThan(1e-6);
      expect(node.material).toBeInstanceOf(MeshLambertMaterial);
    }
    const hull = model.nodes.get('hull_ok')!; hull.geometry.computeBoundingBox();
    expect(hull.geometry.boundingBox!.max.y).toBeGreaterThan(1.5); // upright split windscreen
    expect((hull.material as MeshLambertMaterial).vertexColors).toBe(true);
  });
  it('serves Jeep immediately without a missing GLB and releases all its resources with the battle', () => {
    const loader = vi.fn(); const cache = new ModelCache(async () => null, loader);
    cache.load(['jeep'], 'winter');
    const model = cache.get('jeep')!, hull = model.nodes.get('hull_ok')!;
    expect(model).not.toBeNull(); expect(loader).not.toHaveBeenCalled();
    const geometry = vi.spyOn(hull.geometry, 'dispose'), material = vi.spyOn(hull.material as MeshLambertMaterial, 'dispose');
    cache.load([], 'summer'); expect(cache.get('jeep')).toBeNull(); expect(geometry).toHaveBeenCalledOnce(); expect(material).toHaveBeenCalledOnce();
  });
  it('maps the actual driver and ordered passengers to separate seats without mutating state', () => {
    const state = makeState(), { v, crew } = addTank(state, 'jeep', { x: 10, y: 20 });
    v.seats = { driver: crew[0].id }; const passenger = soldier(12, 3, 'soviet', v.pos, 'rifle_mosin', { vehicleId: v.id });
    state.soldiers.set(passenger.id, passenger); v.passengerIds = [passenger.id];
    const before = structuredClone({ v, soldiers: state.soldiers });
    expect(seatForSoldier(v, crew[0], layout)).toEqual(layout.driverSeat);
    expect(seatForSoldier(v, passenger, layout)).toEqual(layout.passengerSeats[0]);
    expect(vehicleLook(v, state).lightTransport?.occupants.map(o => [o.id, o.driver])).toEqual([[crew[0].id, true], [12, false]]);
    expect({ v, soldiers: state.soldiers }).toEqual(before);
  });
  it('retains passenger seats while the first passenger dismounts, avoiding seat sliding', () => {
    const state = makeState(), { v } = addTank(state, 'jeep', { x: 10, y: 20 });
    const a = soldier(14, 3, 'soviet', v.pos, 'rifle_mosin', { vehicleId: v.id });
    const b = soldier(15, 3, 'soviet', v.pos, 'rifle_mosin', { vehicleId: v.id });
    v.passengerIds = [a.id, b.id];
    expect(seatForSoldier(v, a, layout)).toEqual(layout.passengerSeats[0]);
    expect(seatForSoldier(v, b, layout)).toEqual(layout.passengerSeats[1]);
    v.passengerIds = [b.id]; a.vehicleId = null;
    a.hatch = { vehicleId: v.id, hatch: 0, kind: 'bailout', from: v.pos, to: { x: 9, y: 20 }, start: 2, until: 6, panicked: false, passenger: true };
    expect(seatForSoldier(v, a, layout)).toEqual(layout.passengerSeats[0]);
    expect(seatForSoldier(v, b, layout)).toEqual(layout.passengerSeats[1]);
  });
  it('boarding starts on the ground, lifts through the door and finishes at the pitched seat; dismount reverses it', () => {
    const state = makeState(), { v, crew } = addTank(state, 'jeep', { x: 10, y: 20 }); v.seats = { driver: crew[0].id };
    const l = look({ bodyQuaternion: { x: 0.2, y: 0.1, z: 0, w: Math.sqrt(0.95) }, groundM: 1 });
    const s = crew[0]; s.hatch = { vehicleId: v.id, hatch: 0, kind: 'mount', from: { x: 9, y: 20 }, to: v.pos, start: 2, until: 6, panicked: false };
    expect(boardingWorld(s, v, l, layout, 2)).toEqual([18, 1, 40]);
    expect(boardingWorld(s, v, l, layout, 6)).toEqual(localWorld(l, layout.driverSeat));
    const mid = boardingWorld(s, v, l, layout, 4)!;
    expect(mid[1]).toBeCloseTo((1 + localWorld(l, layout.driverSeat)[1]) / 2 + 0.28);
    s.hatch = { ...s.hatch, kind: 'bailout', from: v.pos, to: { x: 9, y: 20 } };
    expect(boardingWorld(s, v, l, layout, 2)).toEqual(localWorld(l, layout.driverSeat));
    expect(boardingWorld(s, v, l, layout, 6)).toEqual([18, 1, 40]);
  });
  it('packed mortar cargo lifts from its ground position and unloads back, including hull pitch', () => {
    const l = look({ bodyQuaternion: { x: 0.25, y: 0, z: 0, w: Math.sqrt(0.9375) } });
    localWorld(l, cargoLocal(l, layout, action, 2)).forEach((n, i) => expect(n).toBeCloseTo([16, 0, 38][i]));
    Object.entries(cargoLocal(l, layout, action, 6)).forEach(([k, n]) => expect(n).toBeCloseTo(layout.cargo[k as keyof typeof layout.cargo]));
    Object.entries(cargoLocal(l, layout, { ...action, phase: 'unloading' }, 2)).forEach(([k, n]) => expect(n).toBeCloseTo(layout.cargo[k as keyof typeof layout.cargo]));
    const ground = localWorld(l, cargoLocal(l, layout, { ...action, phase: 'unloading' }, 6));
    ground.forEach((n, i) => expect(n).toBeCloseTo([16, 0, 38][i]));
    expect(actionProgress(action, 100)).toBe(1); expect(actionProgress(action, -1)).toBe(0);
  });
  it('keeps occupants and mortar cargo on the tilted hull and removes them on dismount/reset', () => {
    const model = createJeepModel(), scene = new VehicleScene({ get: () => model });
    const l = look({ bodyQuaternion: { x: 0.25, y: 0, z: 0, w: Math.sqrt(0.9375) }, lightTransport: {
      occupants: [{ id: 8, seat: layout.driverSeat, driver: true, side: 'soviet' }], cargo: layout.cargo, time: 3 } });
    scene.begin(); scene.add(l); scene.end(); scene.scene.updateMatrixWorld(true);
    const person = scene.scene.getObjectByName('carrier_occupant_8')!;
    person.getWorldPosition(new Vector3()).toArray().forEach((n, i) => expect(n).toBeCloseTo(localWorld(l, layout.driverSeat)[i]));
    const cargo = scene.scene.getObjectByName('carrier_mortar_cargo')!;
    cargo.getWorldPosition(new Vector3()).toArray().forEach((n, i) => expect(n).toBeCloseTo(localWorld(l, layout.cargo)[i]));
    const mesh = person.children.find(o => (o as Mesh).isMesh) as Mesh;
    const dispose = vi.spyOn(mesh.geometry, 'dispose');
    scene.begin(); scene.add({ ...l, lightTransport: { occupants: [], time: 4 } }); scene.end();
    expect(person.visible).toBe(false); expect(cargo.visible).toBe(false);
    scene.reset(); expect(dispose).toHaveBeenCalledOnce(); expect(scene.scene.getObjectByName('carrier_occupant_8')).toBeUndefined();
  });
});


describe('transport ground-weapon pictures', () => {
  beforeEach(() => freeAllAtlases());
  const cam: Camera = { x: 0, y: 0, zoom: 1 };
  function atlas(id: string): void {
    const meta: AtlasMeta = { scale: 1, cell: { w: 36, h: 36 }, anchor: { x: 18, y: 18 }, columns: 32, dirs: 32,
      entries: { [`${id}.setup`]: { start: 0, frames: 1, fps: 0, loop: false },
        [`${id}.trailsClosed`]: { start: 32, frames: 1, fps: 0, loop: false } } };
    registerAtlas('weapons_1', meta, {} as CanvasImageSource);
  }
  function canvas() {
    const calls: number[][] = [], lines: number[][] = [];
    const ctx = { save() {}, restore() {}, beginPath() {}, stroke() {}, fill() {}, arc() {}, moveTo() {},
      lineTo(...args: number[]) { lines.push(args); },
      drawImage(_image: unknown, ...args: number[]) { calls.push(args); } } as unknown as CanvasRenderingContext2D;
    return { ctx, calls, lines };
  }
  it.each(['loading', 'loaded', 'unloading'] as const)('suppresses the duplicate ground mortar while %s', phase => {
    const state = makeState(), { team } = addGun(state, 'mortar81', { x: 12, y: 12 }); atlas('mortar81');
    const { ctx, calls } = canvas(); team.crewWeapon!.transport = { ...action, phase };
    drawCrewWeapons(ctx, cam, state, 'german'); expect(calls).toEqual([]);
    team.crewWeapon!.transport = undefined; drawCrewWeapons(ctx, cam, state, 'german'); expect(calls).toHaveLength(1);
  });
  it('draws the limbered gun at its canonical axle and facing, with hitch link and moving wheel spokes', () => {
    const state = makeState(), { v } = addTank(state, 'jeep', { x: 10, y: 10 }); v.speed = 2;
    const { team } = addGun(state, 'm1937_45mm', { x: 12, y: 12 }); atlas('m1937_45mm');
    const cw = team.crewWeapon!; cw.phase = 'packed'; cw.facing = Math.PI / 2;
    cw.transport = { ...action, vehicleId: v.id, phase: 'towed' };
    const before = structuredClone(cw), a = canvas();
    drawCrewWeapons(a.ctx, cam, state, 'german');
    const p = worldToScreen(cam, cw.pos);
    expect(a.calls).toEqual([[8 * 36, 36, 36, 36, p.x - 18, p.y - 18, 36, 36]]);
    expect(a.lines).toHaveLength(5); // drawbar plus the crossed spokes of both wheels
    state.time = 0.25; const b = canvas(); drawCrewWeapons(b.ctx, cam, state, 'german');
    expect(b.lines.slice(1)).not.toEqual(a.lines.slice(1)); expect(cw).toEqual(before);
    expect(crewSoldierDraws(state).size).toBe(0); // nobody serves a travelling gun
  });
  it('animates the crew lifting or unhooking without pulling them back to firing stations', () => {
    const state = makeState(), { v } = addTank(state, 'jeep', { x: 10, y: 10 });
    const { team } = addGun(state, 'mortar81', { x: 12, y: 12 });
    team.crewWeapon!.transport = { ...action, vehicleId: v.id, phase: 'loading' }; state.time = 4;
    const poses = crewSoldierDraws(state); expect(poses.size).toBe(2);
    for (const [id, pose] of poses) { expect(pose.pos).toEqual(state.soldiers.get(id)!.pos); expect(pose.progress).toBe(0.5); expect(pose.keys?.[0]).toBe('crew.tube'); }
    team.crewWeapon!.transport.phase = 'uncoupling';
    for (const pose of crewSoldierDraws(state).values()) expect(pose.keys?.[0]).toBe('crew.haul');
  });
});


it('seats Kettenkrad rear-bench passengers facing rearward with the driver forward', () => {
  const state=makeState(), {v,crew}=addTank(state,'kettenkrad',{x:20,y:20},0,50,'german');
  v.seats={driver:crew[0].id};
  const passenger=soldier(991,v.teamId,'german',v.pos,'kar98k',{vehicleId:v.id,seat:'passenger'});
  state.soldiers.set(passenger.id,passenger);v.passengerIds=[passenger.id];
  const visual=vehicleLook(v,state).lightTransport!;
  expect(visual.occupants.find(o=>o.id===crew[0].id)?.facing).toBe(0);
  expect(visual.occupants.find(o=>o.id===passenger.id)?.facing).toBe(Math.PI);
  const scene=new LightTransportScene();scene.update(visual);
  expect(scene.group.getObjectByName(`carrier_occupant_${passenger.id}`)?.rotation.y).toBe(-Math.PI);
  scene.dispose();
});
