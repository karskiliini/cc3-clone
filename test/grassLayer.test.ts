import { describe, it, expect } from 'vitest';
import { InstancedBufferAttribute, Matrix4, ShaderLib, Vector3 } from 'three';
import { bendPoint, bladeGeometry, GrassLayer, patchBladeShader } from '@/render/vehicle3d/grassPatch';
import type { BladeInst } from '@/render/vehicle3d/grassField';
import { VehicleScene } from '@/render/vehicle3d/vehicleScene';

const inst = (over: Partial<BladeInst> = {}): BladeInst => ({ kind: 'grass', xM: 10, zM: 20, heightM: 0.8, widthM: 0.05, restAngle: 0.4, restDir: 0, colour: 0x5c6829,
  dirX: 1, dirZ: 0, angle: 0.5, heightScale: 1, fade: 0.75, ...over });

describe('blade bend (TS mirror of the shader)', () => {
  it('straight when unbent, an arc otherwise', () => {
    expect(bendPoint(1, 0)).toEqual([1, 0]);
    const [up, along] = bendPoint(1, Math.PI / 2);
    expect(up).toBeCloseTo(2 / Math.PI); expect(along).toBeCloseTo(2 / Math.PI);
    expect(bendPoint(1, 0.3)[1]).toBeCloseTo(0.149, 2);
  });
});

describe('blade geometry', () => {
  it('grass: a 3-segment tapered strip, base to tip, darker at the base', () => {
    const g = bladeGeometry('grass');
    expect(g.index!.count / 3).toBe(6);
    const y = g.getAttribute('position'), c = g.getAttribute('color');
    let minY = 1, maxY = 0;
    for (let i = 0; i < y.count; i++) { minY = Math.min(minY, y.getY(i)); maxY = Math.max(maxY, y.getY(i)); }
    expect(minY).toBe(0); expect(maxY).toBe(1);
    expect(c.getX(0)).toBeLessThan(c.getX(c.count - 1));
  });
  it('wheat: a stem with a wider, lighter ear on top', () => {
    const g = bladeGeometry('wheat'), p = g.getAttribute('position');
    let earHalf = 0, stemHalf = 0;
    for (let i = 0; i < p.count; i++) (p.getY(i) >= 0.85 ? (earHalf = Math.max(earHalf, Math.abs(p.getX(i)))) : (stemHalf = Math.max(stemHalf, Math.abs(p.getX(i)))));
    expect(earHalf).toBeGreaterThan(stemHalf);
  });
});

describe('blade shader patch', () => {
  it('the lambert chunks it hooks into exist in this three.js', () => {
    expect(ShaderLib.lambert.vertexShader).toContain('#include <begin_vertex>');
    expect(ShaderLib.lambert.vertexShader).toContain('#include <beginnormal_vertex>');
    expect(ShaderLib.lambert.fragmentShader).toContain('#include <clipping_planes_fragment>');
  });
  it('bends the vertices and dithers the fade', () => {
    const sh = { vertexShader: ShaderLib.lambert.vertexShader, fragmentShader: ShaderLib.lambert.fragmentShader };
    patchBladeShader(sh);
    expect(sh.vertexShader).toContain('aBendFade');
    expect(sh.vertexShader).not.toContain('#include <begin_vertex>');
    expect(sh.fragmentShader).toContain('discard');
  });
});

describe('GrassLayer', () => {
  it('places each blade at its spot, turned toward its bend, with its bend and fade', () => {
    const L = new GrassLayer(100);
    L.update([inst(), inst({ xM: 11 }), inst({ kind: 'wheat', heightM: 1.1 })]);
    expect(L.grass.count).toBe(2); expect(L.wheat.count).toBe(1);
    const m = new Matrix4(); L.grass.getMatrixAt(0, m);
    expect(new Vector3().setFromMatrixPosition(m).toArray()).toEqual([10, 0, 20]);
    const bendWay = new Vector3(0, 0, 1).transformDirection(m);
    expect(bendWay.x).toBeCloseTo(1); expect(bendWay.z).toBeCloseTo(0);   // local +z -> east
    const a = L.grass.geometry.getAttribute('aBendFade') as InstancedBufferAttribute;
    expect(a.getX(0)).toBeCloseTo(0.5); expect(a.getY(0)).toBeCloseTo(0.75);
  });
  it('never exceeds its capacity, and clears to nothing', () => {
    const L = new GrassLayer(2);
    L.update([inst(), inst(), inst(), inst()]);
    expect(L.grass.count).toBe(2);
    L.clear();
    expect(L.grass.count).toBe(0); expect(L.wheat.count).toBe(0);
  });
  it('lives in the vehicle scene; a new battle clears it', () => {
    const vs = new VehicleScene({ get: () => null });
    expect(vs.scene.children).toContain(vs.grass.grass);
    expect(vs.scene.children).toContain(vs.grass.wheat);
    vs.grass.update([inst()]);
    vs.reset();
    expect(vs.grass.grass.count).toBe(0);
  });
});
