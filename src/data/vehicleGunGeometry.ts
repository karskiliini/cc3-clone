import type { Vec3 } from '@/shared/types';

/** Shared procedural model geometry, in simulation local axes (+x right, +y rear, +z up).
 * Source: tools/blender/vehicles.py hull return (ring XY), barrel(y0,length,...,z,x).
 * Its +Y forward is negated exactly once here. Turret barrel coordinates are ring-relative
 * in XY, model-origin-relative in Z; the ring has z=0 to avoid translating height twice.
 * Casemate pivots are fixed model-origin-relative mounting positions; only the barrel traverses.
 * barrel start is a model pivot approximation, not a historical trunnion measurement.
 * Length includes the existing muzzle brake. Unknown models retain the legacy 1.5 m origin.
 * Task 9 render/export consumers should use this deterministic metadata, never load assets in sim.
 */
export interface VehicleGunGeometry { ring: Vec3; pivot: Vec3; barrelM: number }
function g(rx: number, forward: number, x: number, gunForward: number, z: number, barrelM: number): VehicleGunGeometry {
  return { ring: { x: rx, y: -forward, z: 0 }, pivot: { x, y: -gunForward, z }, barrelM };
}
export const VEHICLE_GUN_GEOMETRY: Readonly<Record<string, VehicleGunGeometry>> = {
  pz3j: g(0.0, 0.1, 0, 0.94, 1.89, 2.35),
  pz4f1: g(0.0, 0.18, 0, 1.045, 1.96, 1.05),
  pz4gh: g(0.0, 0.18, 0, 1.045, 1.96, 3.05),
  stug3g: g(0, 0, 0.18, 1.95, 1.42, 2.7),
  panther: g(0.0, 0.3, 0, 1.375, 2.25, 4.3),
  tiger: g(0.0, 0.05, 0, 1.475, 2.2, 3.75),
  marder3: g(0, 0, 0, 0.1, 2.2, 3.3),
  t26: g(0.0, 0.42, 0, 0.65, 1.84, 1.55),
  bt7: g(0.0, 0.62, 0, 0.65, 1.64, 1.6),
  t34_76: g(0.0, 0.62, 0, 1.35, 1.76, 2.2),
  kv1: g(0.0, 0.75, 0, 1.325, 2.04, 2.35),
  t70: g(-0.28, 0.05, 0, 0.6, 1.48, 1.5),
  t34_85: g(0.0, 0.55, 0, 1.35, 1.78, 4.0),
  is2: g(0.0, 0.85, 0, 1.2, 1.95, 5.1),
  su76: g(0, 0, -0.12, 0.2, 1.82, 2.75),
  su85: g(0, 0, 0.28, 2.47, 1.5, 3.6),
  tiger2: g(0.0, 0.2, 0, 1.6, 2.44, 5.0),
  pantherD: g(0.0, 0.3, 0, 1.375, 2.25, 4.3),
  pantherA: g(0.0, 0.3, 0, 1.375, 2.25, 4.3),
  pz4g: g(0.0, 0.18, 0, 1.045, 1.96, 2.75),
  stug4: g(0, 0, 0.18, 2.2, 1.42, 2.7),
  hetzer: g(0, 0, 0.38, 1.75, 1.28, 2.35),
  flammpanzer3: g(0.0, 0.1, 0, 0.94, 1.89, 2.3),
  is1: g(0.0, 0.85, 0, 1.2, 1.95, 4.35),
  is3: g(0.0, 0.55, 0, 1.35, 1.88, 4.9),
  ot34: g(0.0, 0.62, 0, 1.35, 1.76, 2.2),
  su100: g(0, 0, 0.28, 2.47, 1.5, 4.7),
  su122: g(0, 0, -0.1, 2.57, 1.5, 1.75),
  su152: g(0, 0, 0.28, 3.75, 1.6, 2.0),
  t28: g(0.0, -0.1, 0, 1.2, 2.02, 1.85),
  sherman76: g(0.0, 0.25, 0, 1.1, 2.25, 3.95),
};
