// A small Willys MB silhouette, generated locally rather than borrowing the Kübelwagen mesh.
import { BoxGeometry, BufferAttribute, Color, CylinderGeometry, Mesh, MeshLambertMaterial, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { VehicleModel, WheelMetadata } from './models';

export function createJeepModel(): VehicleModel {
  const nodes = new Map<string, Mesh>();
  const wheels: WheelMetadata[] = [-0.64, 0.64].flatMap((x, side) => [-1.03, 0.98].map((y, axle) =>
    ({ index: side * 2 + axle, side: side === 0 ? 'L' as const : 'R' as const, centreM: { x, y, z: 0.35 }, radiusM: 0.35 })));
  for (const state of ['ok', 'ko']) {
    const pieces: BufferGeometry[] = [];
    const paint = state === 'ko' ? 0x343329 : 0x62674a;
    const add = (g: BufferGeometry, x: number, y: number, z: number, color: number) => {
      g = g.index ? g.toNonIndexed() : g; g.translate(x, z, y);
      const c = new Color(color), a = new Float32Array(g.getAttribute('position').count * 3);
      for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
      g.setAttribute('color', new BufferAttribute(a, 3)); pieces.push(g);
    };
    const box = (w: number, l: number, h: number, x: number, y: number, z: number, c = paint) => add(new BoxGeometry(w, h, l), x, y, z, c);
    box(1.28, 2.9, 0.13, 0, 0, 0.5); // chassis
    box(1.22, 0.82, 0.16, 0, -1.08, 0.94); // flat hood
    box(1.22, 0.1, 0.5, 0, -1.49, 0.74); // upright grille
    for (let i = -3; i <= 3; i++) box(0.045, 0.025, 0.33, i * 0.12, -1.55, 0.75, 0x252b23);
    for (const x of [-0.49, 0.49]) { box(0.16, 0.08, 0.16, x, -1.56, 0.89, 0xb8b698); box(0.13, 1.42, 0.44, x * 1.3, 0.63, 0.77); }
    box(1.28, 0.12, 0.48, 0, 1.4, 0.79); // rear tub
    box(1.5, 0.12, 0.12, 0, -1.63, 0.46); // bumper
    for (const x of [-0.66, 0.66]) for (const y of [-1.03, 0.98]) box(0.24, 0.93, 0.08, x, y, 0.78);
    // Thin upright split windshield, open cabin and individual canvas seats.
    for (const x of [-0.61, 0, 0.61]) box(0.035, 0.045, 0.6, x, -0.64, 1.29);
    for (const z of [1.01, 1.58]) box(1.25, 0.045, 0.035, 0, -0.64, z);
    for (const x of [-0.35, 0.35]) { box(0.43, 0.48, 0.12, x, -0.35, 0.64, 0x454b37); box(0.43, 0.1, 0.42, x, -0.1, 0.85, 0x454b37); }
    box(1.02, 0.43, 0.13, 0, 0.6, 0.68, 0x454b37);
    const spare = new CylinderGeometry(0.32, 0.32, 0.18, 12); spare.rotateX(Math.PI / 2); add(spare, 0.31, 1.55, 1, 0x262822);
    const g = mergeGeometries(pieces)!; pieces.forEach(q => q.dispose());
    const hull = new Mesh(g, new MeshLambertMaterial({ vertexColors: true })); hull.name = `hull_${state}`; nodes.set(hull.name, hull);
    for (const wheel of wheels) {
      const g = new CylinderGeometry(wheel.radiusM, wheel.radiusM, 0.2, 12); g.rotateZ(Math.PI / 2);
      const m = new Mesh(g, new MeshLambertMaterial({ color: state === 'ko' ? 0x23231f : 0x292c25 }));
      m.name = `wheels_${wheel.side}_${wheel.index}_${state}`; nodes.set(m.name, m);
    }
  }
  return { hasTurret: false, turretPivotM: null, modelOriginM: { x: 0, y: 0, z: 0 }, nodes, winterNodes: null, wheels };
}
