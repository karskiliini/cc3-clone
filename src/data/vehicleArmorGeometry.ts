import type { Vec3 } from '@/shared/types';

export interface VehicleArmorGeometry { min: Vec3; max: Vec3; source: string }
/** Static conservative OBB enclosing procedural armored shell, mantlet and cupola.
 * Ring-relative XY, model-origin-relative Z; source forward +Y is negated once.
 * Barrel tubes, non-armored MG tubes, bins, antennas and cosmetics are excluded.
 * Circular primitives use their radius envelope. Empty corners are an approximation,
 * not mesh collision or historical armor geometry. Task 9 must consume/verify this source. */
function box(source: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): VehicleArmorGeometry {
  return { source: `tools/blender/vehicles.py:${source}; extrude shell, armored bustle where present, box/cyl mantlet and armored rear MG ball, closed hatch plates, cupola cyl/hatch where present`,
    min: { x: x0, y: -y1, z: z0 }, max: { x: x1, y: -y0, z: z1 } };
}
export const VEHICLE_ARMOR_GEOMETRY: Readonly<Record<string, VehicleArmorGeometry>> = {
  pz3j: box('german_medium_turret(pz3j)', -0.9, -1.0, 1.57, 0.9, 1.03, 2.45),
  pz4f1: box('german_medium_turret(pz4f1)', -0.975, -1.125, 1.64, 0.975, 1.135, 2.52),
  pz4gh: box('german_medium_turret(pz4gh)', -0.975, -1.125, 1.64, 0.975, 1.135, 2.52),
  pz4g: box('german_medium_turret(pz4g)', -0.975, -1.125, 1.64, 0.975, 1.135, 2.52),
  flammpanzer3: box('german_medium_turret(flammpanzer3)', -0.9, -1.0, 1.57, 0.9, 1.03, 2.45),
  panther: box('panther_turret(G)', -1.15, -1.275, 1.87, 1.15, 1.515, 2.9),
  pantherA: box('panther_turret(G)', -1.15, -1.275, 1.87, 1.15, 1.515, 2.9),
  pantherD: box('panther_turret(D)', -1.15, -1.275, 1.87, 1.15, 1.515, 3.01),
  tiger: box('tiger_turret', -1.25, -1.525, 1.8, 1.25, 1.555, 2.84),
  t26: box('t26_turret', -0.65, -1.155, 1.52, 0.65, 0.73, 2.16),
  bt7: box('bt7_turret', -0.7, -1.125, 1.34, 0.7, 0.745, 1.96),
  t34_76: box('t34_76_turret', -0.975, -1.15, 1.44, 0.975, 1.8, 2.08),
  ot34: box('t34_76_turret', -0.975, -1.15, 1.44, 0.975, 1.8, 2.08),
  t34_85: box('t34_85_turret', -1.125, -1.75, 1.44, 1.125, 1.85, 2.38),
  kv1: box('kv1_turret', -1.075, -1.695, 1.64, 1.075, 1.675, 2.51),
  t70: box('t70_turret', -0.62, -0.72, 1.22, 0.62, 0.7, 1.79),
  is1: box('is2_turret(85)', -1.1, -2.025, 1.55, 1.1, 1.3, 2.6),
  is2: box('is2_turret(122)', -1.1, -2.025, 1.55, 1.1, 1.3, 2.6),
  is3: box('is3_turret', -1.25, -1.725, 1.52, 1.25, 1.55, 2.32),
  tiger2: box('tiger2_turret', -1.375, -2.018, 2.04, 1.375, 1.7, 3.1),
  t28: box('t28_turret', -0.925, -1.5, 1.64, 0.925, 1.25, 2.46),
  sherman76: box('sherman76_turret', -0.975, -1.525, 1.87, 0.975, 1.15, 2.85),
};
