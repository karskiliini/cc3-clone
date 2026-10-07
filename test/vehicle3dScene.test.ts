import { describe, it, expect } from 'vitest';
import { BoxGeometry, DoubleSide, Mesh, MeshLambertMaterial, Vector3 } from 'three';
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
  vs.scene.traverseVisible((o) => { if ((o as Mesh).isMesh) out.push(o.name); });
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
    const fake = { shadowMap: { enabled: false, type: 0 }, setPixelRatio() {}, setSize() {}, setClearColor() {}, clear() {}, render() {} };
    const canvas = { addEventListener() {} } as unknown as HTMLCanvasElement;
    const out = GlOutput.create(1000, 600, () => fake as never, canvas)!;
    expect(fake.shadowMap.enabled).toBe(true);
    const vs = new VehicleScene(src);
    const ctx = { drawImage() {}, globalAlpha: 1, imageSmoothingEnabled: false, imageSmoothingQuality: 'low' } as unknown as CanvasRenderingContext2D;
    out.draw(ctx, vs, { x: 10, y: 20, zoom: 1 });     // 10 px/m: view 100 m x 60 m from (20 m, 40 m)
    expect(vs.sun.target.position.toArray()).toEqual([70, 0, 70]);
    expect(vs.sun.shadow.camera.right).toBeGreaterThanOrEqual(Math.hypot(50, 30));
  });
  it('returns null when WebGL cannot be created', () => {
    expect(GlOutput.create(1024, 670, () => { throw new Error('no webgl'); })).toBeNull();
  });
});
