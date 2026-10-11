import { describe, it, expect } from 'vitest';
import { BackSide, Box3, BoxGeometry, DoubleSide, Mesh, MeshLambertMaterial, Vector3 } from 'three';
import { OUTLINE_M } from '@/render/vehicle3d/vehicleScene';
import { VehicleScene } from '@/render/vehicle3d/vehicleScene';
import type { ModelSource, VehicleModel } from '@/render/vehicle3d/models';
import { GlOutput } from '@/render/vehicle3d/glOutput';
import type { VehicleLook } from '@/render/vehicle3d/look';

function model(names: string[], hasTurret = true): VehicleModel {
  const nodes = new Map(names.map((n) => [n, new Mesh(new BoxGeometry(1, 1, 1), new MeshLambertMaterial())] as const));
  for (const [n, m] of nodes) m.name = n;
  return { hasTurret, turretPivotM: hasTurret ? { x: 0, y: 0.5 } : null, nodes, winterNodes: null };
}
const T34 = model(['hull_ok', 'hull_ko', 'hull_blown', 'turret_ok', 'turret_ko', 'turret_blown']);
const src: ModelSource = { get: (id) => (id === 't34_76' ? T34 : null) };
function look(over: Partial<VehicleLook> = {}): VehicleLook {
  return { id: 7, defId: 't34_76', posTiles: { x: 10, y: 20 }, hullRad: 0, turretRad: 0, ko: false, liveButLeft: false,
    turretBlown: false, brokenTrack: null, turretLanding: null, season: 'summer', recoil: 0, ...over };
}
function visibleNames(vs: VehicleScene): string[] {
  const out: string[] = [];
  vs.scene.traverseVisible((o) => { if ((o as Mesh).isMesh && !o.name.endsWith('_rim')) out.push(o.name); });
  return out.sort();
}

describe('VehicleScene', () => {
  it('returns false for a vehicle without a loaded model, so the caller draws the sprite', () => {
    const vs = new VehicleScene(src);
    vs.begin();
    expect(vs.add(look({ defId: 'kv1' }))).toBe(false);
    vs.end();
    expect(vs.visibleCount()).toBe(0);
  });
  it('shows exactly the chosen nodes, and switches them when the look changes', () => {
    const vs = new VehicleScene(src);
    vs.begin(); expect(vs.add(look())).toBe(true); vs.end();
    expect(visibleNames(vs)).toEqual(['hull_ok', 'turret_ok']);
    vs.begin(); vs.add(look({ ko: true })); vs.end();
    expect(visibleNames(vs)).toEqual(['hull_ko', 'turret_ko']);
  });
  it('hides a vehicle not added this frame (fog of war, off screen)', () => {
    const vs = new VehicleScene(src);
    vs.begin(); vs.add(look()); vs.end();
    vs.begin(); vs.end();
    expect(visibleNames(vs)).toEqual([]);
  });
  it('poses the hull in world metres and the turret (built about its ring centre) on its pivot', () => {
    const vs = new VehicleScene(src);
    vs.begin(); vs.add(look({ hullRad: Math.PI / 2, turretRad: 1 })); vs.end();
    vs.scene.updateMatrixWorld(true);
    const hull = vs.scene.getObjectByName('hull_ok')!;
    const turret = vs.scene.getObjectByName('turret_ok')!;
    expect(hull.getWorldPosition(new Vector3()).toArray().map((v) => +v.toFixed(6))).toEqual([20, 0, 40]);
    // pivot 0.5 m forward of the hull centre, hull facing east
    expect(turret.getWorldPosition(new Vector3()).toArray().map((v) => +v.toFixed(6))).toEqual([20.5, 0, 40]);
  });
  it('every shown hull and turret gets a dark rim like the sprites (a slightly larger back-face copy)', () => {
    const vs = new VehicleScene(src);
    vs.begin(); vs.add(look()); vs.end();
    vs.scene.updateMatrixWorld(true);
    for (const name of ['hull_ok', 'turret_ok']) {
      const body = vs.scene.getObjectByName(name) as Mesh;
      const rim = vs.scene.getObjectByName(name + '_rim') as Mesh;
      expect(rim, name).toBeTruthy();
      expect((rim.material as MeshLambertMaterial).side).toBe(BackSide);
      expect(rim.visible).toBe(true);
      const a = new Box3().setFromObject(body), b = new Box3().setFromObject(rim);
      expect(b.max.x - a.max.x).toBeCloseTo(OUTLINE_M, 6);
      expect(a.min.z - b.min.z).toBeCloseTo(OUTLINE_M, 6);
    }
    vs.begin(); vs.add(look({ ko: true })); vs.end();
    expect(vs.scene.getObjectByName('hull_ok_rim')!.visible && vs.scene.getObjectByName('hull_ok')!.visible).toBe(false);
  });
  it('ground-shadow copies draw both faces (flattening flips some triangles; culling them leaves holes)', () => {
    const vs = new VehicleScene(src);
    vs.begin(); vs.add(look()); vs.end();
    vs.shadowScene.traverse((o) => { if ((o as Mesh).isMesh) expect(((o as Mesh).material as MeshLambertMaterial).side).toBe(DoubleSide); });
  });
  it('mirrors every visible vehicle into the shadow scene', () => {
    const vs = new VehicleScene(src);
    vs.begin(); vs.add(look()); vs.add(look({ id: 8 })); vs.end();
    let n = 0;
    vs.shadowScene.traverseVisible((o) => { if ((o as Mesh).isMesh) n++; });
    expect(n).toBe(4);
  });
});

describe('VehicleScene.reset', () => {
  it('drops every instance (a new battle reuses vehicle ids from 1)', () => {
    const vs = new VehicleScene(src);
    vs.begin(); vs.add(look()); vs.add(look({ id: 8 })); vs.end();
    vs.reset();
    expect(vs.visibleCount()).toBe(0);
    let meshes = 0;
    vs.scene.traverse((o) => { if ((o as Mesh).isMesh && !o.name.startsWith('grass3d_')) meshes++; });   // the grass layer stays
    vs.shadowScene.traverse((o) => { if ((o as Mesh).isMesh) meshes++; });
    expect(meshes).toBe(0);
  });
});

describe('VehicleScene self-shadows', () => {
  it('vehicle meshes cast and receive the sun shadow; shadow-scene copies do not', () => {
    const vs = new VehicleScene(src);
    vs.begin(); vs.add(look()); vs.end();
    const hull = vs.scene.getObjectByName('hull_ok') as Mesh;
    expect(hull.castShadow && hull.receiveShadow).toBe(true);
    let flat = 0;
    vs.shadowScene.traverse((o) => { if ((o as Mesh).isMesh && !(o as Mesh).castShadow) flat++; });
    expect(flat).toBe(2);
  });
  it('fitSun aims the sun shadow camera at the view and covers it', () => {
    const vs = new VehicleScene(src);
    vs.fitSun(100, 60, 70);
    const sun = vs.sun;
    expect(sun.castShadow).toBe(true);
    expect(sun.target.position.toArray()).toEqual([100, 0, 60]);
    expect(sun.position.distanceTo(sun.target.position)).toBeGreaterThan(50);
    const c = sun.shadow.camera;
    expect(c.right - c.left).toBeGreaterThanOrEqual(140);
    expect(c.top - c.bottom).toBeGreaterThanOrEqual(140);
  });
});

describe('GlOutput', () => {
  it('turns shadow maps on and aims the sun at the view centre each frame', () => {
    const fake = { shadowMap: { enabled: false, type: 0 }, setPixelRatio() {}, setSize() {}, setClearColor() {}, clear() {}, render() {},
      getContext: () => ({ isContextLost: () => false }) };
    const canvas = { addEventListener() {} } as unknown as HTMLCanvasElement;
    const out = GlOutput.create(1000, 600, () => fake as never, canvas)!;
    expect(fake.shadowMap.enabled).toBe(true);
    const vs = new VehicleScene(src);
    const ctx = { drawImage() {}, globalAlpha: 1, imageSmoothingEnabled: false, imageSmoothingQuality: 'low' } as unknown as CanvasRenderingContext2D;
    out.draw(ctx, vs, { x: 10, y: 20, zoom: 1 });     // 10 px/m: view 100 m x 60 m from (20 m, 40 m)
    expect(vs.sun.target.position.toArray()).toEqual([70, 0, 70]);
    expect(vs.sun.shadow.camera.right).toBeGreaterThanOrEqual(Math.hypot(50, 30));
  });
  it('is not ready once the canvas reports the context lost (event) or the GL says so (before the event)', () => {
    let lost = false; let onLost: ((e: Event) => void) | null = null;
    const fake = { shadowMap: { enabled: false, type: 0 }, setPixelRatio() {}, setSize() {}, setClearColor() {}, clear() {}, render() {},
      getContext: () => ({ isContextLost: () => lost }) };
    const canvas = { addEventListener(t: string, f: (e: Event) => void) { if (t === 'webglcontextlost') onLost = f; } } as unknown as HTMLCanvasElement;
    const out = GlOutput.create(100, 100, () => fake as never, canvas)!;
    expect(out.ready).toBe(true);
    lost = true;
    expect(out.ready).toBe(false);
    lost = false;
    onLost!({ preventDefault() {} } as Event);
    expect(out.ready).toBe(false);
  });
  it('a renderer failure mid-draw reports false and stops 3D (the caller draws sprites), never throws', () => {
    const fake = { shadowMap: { enabled: false, type: 0 }, setPixelRatio() {}, setSize() {}, setClearColor() {}, clear() {},
      render() { throw new Error('GL_OUT_OF_MEMORY'); }, getContext: () => ({ isContextLost: () => false }) };
    const canvas = { addEventListener() {} } as unknown as HTMLCanvasElement;
    const out = GlOutput.create(100, 100, () => fake as never, canvas)!;
    const ctx = { drawImage() {}, globalAlpha: 1, imageSmoothingEnabled: false, imageSmoothingQuality: 'low' } as unknown as CanvasRenderingContext2D;
    expect(out.draw(ctx, new VehicleScene(src), { x: 0, y: 0, zoom: 1 })).toBe(false);
    expect(ctx.globalAlpha).toBe(1);
    expect(out.ready).toBe(false);
  });
  it('returns null when WebGL cannot be created', () => {
    expect(GlOutput.create(1024, 670, () => { throw new Error('no webgl'); })).toBeNull();
  });
});


it('context loss during render reports false in the same frame without needing an exception', () => {
  let lost = false;
  const fake = { shadowMap: { enabled: false, type: 0 }, setPixelRatio() {}, setSize() {}, setClearColor() {}, clear() {},
    render() { lost = true; }, getContext: () => ({ isContextLost: () => lost }) };
  const canvas = { addEventListener() {} } as unknown as HTMLCanvasElement;
  const out = GlOutput.create(100, 100, () => fake as never, canvas)!;
  const ctx = { drawImage() {}, globalAlpha: 1, imageSmoothingEnabled: false, imageSmoothingQuality: 'low' } as unknown as CanvasRenderingContext2D;
  expect(out.draw(ctx, new VehicleScene(src), { x: 0, y: 0, zoom: 1 })).toBe(false);
});

import { VEHICLE_DEFS } from '@/data/units';
import { hullParams } from '@/data/vehiclePhysics';
import { createHullBody } from '@/sim/hullPhysics';
import { rotate } from '@/sim/hullMath';
import { vehicleLook } from '@/render/vehicle3d/look';
import { Rng } from '@/shared/rng';
import { hashState } from '@/sim/stateHash';
import { addTank, makeState } from './vehicleDamageHelpers';
import { flat } from './hullPhysicsHelpers';

it('renders rotated model origin without mutating physical pose or hash', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
  const def = VEHICLE_DEFS[v.defId], p = hullParams(def);
  v.body = createHullBody(def, v.pos, 0, flat);
  v.body.orientation = { x: 0.25881904510252074, y: 0, z: 0, w: 0.9659258262890683 };
  const m = model(['hull_ok'], false), scene = new VehicleScene({ get: () => m });
  const saved = JSON.stringify(v.body), hash = hashState({ state, rng: new Rng(1) });
  const l = vehicleLook(v, state), offset = rotate(v.body.orientation, p.modelOriginLocal);
  for (let i = 0; i < 3; i++) { scene.begin(); expect(scene.add(l)).toBe(true); scene.end(); }
  scene.scene.updateMatrixWorld(true);
  const actual = scene.scene.getObjectByName('hull_ok')!.getWorldPosition(new Vector3());
  expect(actual.x).toBeCloseTo(v.body.position.x + offset.x, 12);
  expect(actual.y).toBeCloseTo(v.body.position.z + offset.z, 12);
  expect(actual.z).toBeCloseTo(v.body.position.y + offset.y, 12);
  expect(JSON.stringify(v.body)).toBe(saved); expect(hashState({ state, rng: new Rng(1) })).toBe(hash);
});

it('elevates and recoils the gun about its trunnion and moves each wheel bank independently', () => {
  const m = model(['hull_ok', 'turret_ok', 'gun_ok', 'wheels_L_ok', 'wheels_R_ok']);
  Object.assign(m, { gunTrunnionM: { x: 0, y: -1.35, z: 1.76 }, turretPivot3M: { x: 0, y: -0.62, z: 0 }, wheels: [] });
  const vs = new VehicleScene({ get: () => m });
  vs.begin(); vs.add(look({ gunElevationRad: Math.PI / 6, recoil: 1, wheelTravelM: { L: 0.1, R: 0.2 } } as Partial<VehicleLook>)); vs.end();
  vs.scene.updateMatrixWorld(true);
  const hull = vs.scene.getObjectByName('hull_ok')!.getWorldPosition(new Vector3());
  expect(hull.toArray()).toEqual([20, 0, 40]);
  const gun = vs.scene.getObjectByName('gun_ok')!;
  expect(gun.getWorldPosition(new Vector3()).y).toBeCloseTo(1.76 - 0.26 * 0.5, 9);
  expect(new Vector3(0, 0, -1).transformDirection(gun.matrixWorld).y).toBeCloseTo(0.5, 9);
  expect(vs.scene.getObjectByName('wheels_L_ok')!.getWorldPosition(new Vector3()).y).toBeCloseTo(0.1);
  expect(vs.scene.getObjectByName('wheels_R_ok')!.getWorldPosition(new Vector3()).y).toBeCloseTo(0.2);
});

it('individual wheels spin around their own source centres under the tilted suspension bank', () => {
  const m = model(['hull_ok', 'wheels_L_0_ok', 'wheels_L_1_ok', 'wheels_R_2_ok'], false);
  m.wheels = [
    { index: 0, side: 'L', centreM: { x: -1, y: -2, z: 0.3 }, radiusM: 0.3 },
    { index: 1, side: 'L', centreM: { x: -1, y: 2, z: 0.3 }, radiusM: 0.3 },
    { index: 2, side: 'R', centreM: { x: 1, y: 0, z: 0.4 }, radiusM: 0.4 },
  ];
  const vs = new VehicleScene({ get: () => m });
  const l = look({ bodyQuaternion: { x: 0.5, y: 0, z: 0, w: Math.sqrt(3) / 2 }, wheelTravelM: { L: 0.1, R: -0.1 }, wheelDistanceM: 0 });
  vs.begin(); vs.add(l); vs.end(); vs.scene.updateMatrixWorld(true);
  const centres = m.wheels.map(w => vs.scene.getObjectByName(`wheels_${w.side}_${w.index}_ok`)!.getWorldPosition(new Vector3()).toArray());
  const chassis = vs.scene.getObjectByName('hull_ok')!.matrixWorld.clone();
  vs.begin(); vs.add({ ...l, wheelDistanceM: 1.4 }); vs.end(); vs.scene.updateMatrixWorld(true);
  m.wheels.forEach((w, i) => {
    const node = vs.scene.getObjectByName(`wheels_${w.side}_${w.index}_ok`)!;
    expect(node.getWorldPosition(new Vector3()).toArray()).toEqual(centres[i]);
    expect(node.parent!.quaternion.x).toBeCloseTo(Math.sin(-1.4 / w.radiusM / 2));
  });
  expect(vs.scene.getObjectByName('hull_ok')!.matrixWorld.elements).toEqual(chassis.elements);
  expect(centres[1][2] - centres[0][2]).toBeCloseTo(2); // pitch rotates the 4m bank span, spin does not orbit centres
});

it('casemate gun trunnion stays fixed while only its tube traverses and elevates', () => {
  const m = model(['hull_ok', 'gun_ok'], false);
  m.gunTrunnionM = { x: 0.18, y: -1.95, z: 1.42 };
  const vs = new VehicleScene({ get: () => m });
  vs.begin(); vs.add(look({ defId: 'stug3g', turretRad: Math.PI / 2, gunElevationRad: Math.PI / 6 })); vs.end(); vs.scene.updateMatrixWorld(true);
  const gun = vs.scene.getObjectByName('gun_ok')!;
  expect(gun.getWorldPosition(new Vector3()).toArray()).toEqual([20.18, 1.42, 38.05]);
  const forward = new Vector3(0, 0, -1).transformDirection(gun.matrixWorld);
  expect(forward.x).toBeCloseTo(Math.sqrt(3) / 2); expect(forward.y).toBeCloseTo(0.5);
  expect(vs.scene.getObjectByName('hull_ok')!.getWorldPosition(new Vector3()).toArray()).toEqual([20, 0, 40]);
});

it('cached composite hull and independent landing grounds flatten all shadows without modifying field/body/hash', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 0.5, y: 0.5 });
  v.turretLanding = { x: 1.5, y: 1.5 }; v.turretLandingDir = 0.7;
  const heights = new Float32Array([7, 8, 10, 12]);
  state.map.heightField = { res: 1, w: 2, h: 2, ground: heights.slice(), base: heights.slice(), dig: new Float32Array(4), height: heights, canopy: new Float32Array(4), version: 1, marksApplied: 0 };
  const field = state.map.heightField, snapshot = JSON.stringify(field), hash = hashState({ state, rng: new Rng(1) });
  v.body = createHullBody(VEHICLE_DEFS[v.defId], v.pos, 0, flat); v.body.position.z += 7;
  const beforeHash = hashState({ state, rng: new Rng(1) }), savedBody = JSON.stringify(v.body);
  const m = model(['hull_ok', 'turret_ok', 'gun_ok', 'hull_blown', 'turret_blown', 'gun_blown']); m.gunTrunnionM = { x: 0, y: -1.35, z: 1.76 };
  const vs = new VehicleScene({ get: () => m }), l = vehicleLook(v, state);
  expect(l.groundM).toBe(7); expect(l.turretLandingGroundM).toBe(12);
  for (let i = 0; i < 4; i++) { vs.begin(); vs.add(l); vs.end(); }
  vs.shadowScene.updateMatrixWorld(true);
  for (const name of ['hull_ok', 'turret_ok', 'gun_ok']) expect(vs.shadowScene.getObjectByName(name)!.getWorldPosition(new Vector3()).y).toBeCloseTo(7.002);
  vs.begin(); vs.add({ ...l, turretBlown: true }); vs.end(); vs.shadowScene.updateMatrixWorld(true);
  expect(vs.shadowScene.getObjectByName('hull_blown')!.getWorldPosition(new Vector3()).y).toBeCloseTo(7.002);
  expect(vs.shadowScene.getObjectByName('turret_blown')!.getWorldPosition(new Vector3()).y).toBeCloseTo(12.002);
  expect(vs.shadowScene.getObjectByName('gun_blown')!.getWorldPosition(new Vector3()).y).toBeCloseTo(12.002);
  expect(state.map.heightField).toBe(field); expect(JSON.stringify(field)).toBe(snapshot); expect(JSON.stringify(v.body)).toBe(savedBody);
  expect(hashState({ state, rng: new Rng(1) })).toBe(beforeHash); expect(beforeHash).not.toBe(hash);
});

it('centreline wheel follows its own copied support while track banks and chassis stay fixed', () => {
  const m = model(['hull_ok', 'wheels_L_0_ok', 'wheels_R_1_ok', 'wheels_R_2_ok'], false);
  m.wheels = [
    { index: 0, side: 'L', centreM: { x: -1, y: 0, z: 0.3 }, radiusM: 0.3 },
    { index: 1, side: 'R', centreM: { x: 1, y: 0, z: 0.3 }, radiusM: 0.3 },
    { index: 2, side: 'R', centreM: { x: 0, y: -1, z: 0.3 }, radiusM: 0.3 },
  ];
  const vs = new VehicleScene({ get: () => m });
  const l = look({ wheelTravelM: { L: 0.02, R: -0.03 }, centreWheelTravelM: [{ yM: -1.1, travelM: 0 }] });
  const draw = (travelM: number | null): number[] => {
    vs.begin(); vs.add({ ...l, centreWheelTravelM: travelM === null ? undefined : [{ yM: -1.1, travelM }] }); vs.end(); vs.scene.updateMatrixWorld(true);
    return ['hull_ok', 'wheels_L_0_ok', 'wheels_R_1_ok', 'wheels_R_2_ok'].map(name => vs.scene.getObjectByName(name)!.getWorldPosition(new Vector3()).y);
  };
  const nominal = draw(0);
  const close = (actual: number[], expected: number[]): void => actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 12));
  close(nominal, [0, 0.32, 0.27, 0.3]);
  close(draw(0.06), [0, 0.32, 0.27, 0.36]);
  close(draw(-0.04), [0, 0.32, 0.27, 0.26]);
  close(draw(null), [0, 0.32, 0.27, 0.27]); // old optional fixtures retain bank behavior
  const state = makeState(), { v } = addTank(state, 'kettenkrad', { x: 20, y: 20 });
  v.body = createHullBody(VEHICLE_DEFS[v.defId], v.pos, 0, flat);
  const hash = hashState({ state, rng: new Rng(1) }), saved = JSON.stringify(v.body);
  for (let i = 0; i < 3; i++) { vs.begin(); vs.add(vehicleLook(v, state)); vs.end(); }
  expect(JSON.stringify(v.body)).toBe(saved); expect(hashState({ state, rng: new Rng(1) })).toBe(hash);
  expect(state.map.heightField).toBeUndefined();
});
