import type { SuspensionDef, Vec3, VehicleDef } from '@/shared/types';
import * as dm from '@/shared/dmath';

type DriveKind = NonNullable<VehicleDef['driveKind']>;
export interface NormalizedVehiclePhysics {
  massT: number; hullHeightM: number; cgHeightM: number;
  suspension: SuspensionDef; driveKind: DriveKind;
  slopeComfortDeg: number; slopeTipDeg: number;
  gunDepressionDeg: number; gunElevationDeg: number;
}
export type HullParams = VehicleDef & NormalizedVehiclePhysics & {
  massKg: number; inertia: Vec3; clearanceM: number;
  contacts: { local: Vec3; side: -1 | 1; steer: boolean; driven: boolean; horn: boolean }[];
  modelOriginLocal: Vec3;
  solidBox: { min: Vec3; max: Vec3 };
  armor: VehicleDef['armor'] & { belly: number };
}
interface Provenance { status: 'model-derived' | 'estimated for simulation'; source: string }
interface ModelPhysics {
  driveKind: DriveKind; clearanceM: number; hullHeightM: number; massT?: number; cgHeightM?: number;
  provenance: { geometry: Provenance; driveKind: Provenance; massT: Provenance; cgHeightM: Provenance };
}
const estimate = (source: string): Provenance => ({ status: 'estimated for simulation', source });
/** Geometry is a conservative hull envelope calibrated to the procedural mesh's belly/roof,
 * excluding turret, gun, hatches and stowage; not a claim about the historical vehicle.
 * Dimensions in units.ts remain the gameplay footprint (notably Kettenkrad: 1.6 m versus
 * the mesh's 1.05 m). Mass, CG, gun limits and suspension are provisional simulation tuning.
 * No historical mass or gun-limit reference has been verified for this table. */
function model(source: string, belly: number, roof: number, driveKind: DriveKind = 'tracked',
  massT?: number, cgHeightM?: number): ModelPhysics {
  return { driveKind, clearanceM: belly, hullHeightM: roof - belly, massT, cgHeightM,
    provenance: {
      geometry: { status: 'model-derived', source: `tools/blender/vehicles.py:${source} belly/roof envelope` },
      driveKind: { status: 'model-derived', source: `tools/blender/vehicles.py:${source} running gear` },
      massT: estimate(massT === undefined ? 'density fallback: 2 t/m³ armored, 0.3 t/m³ unarmored' : 'approved provisional acceptance fixture'),
      cgHeightM: estimate(cgHeightM === undefined ? 'effective CG at calibrated hull-box midpoint' : 'approved effective CG acceptance tuning'),
    } };
}

/** Explicit source/estimate status for every catalog override. */
export const VEHICLE_PHYSICS_PROVENANCE: Readonly<Record<string, ModelPhysics>> = {
  tiger2: model('tiger2', 0.5, 2.02),
  pantherD: model('panther(D)', 0.5, 1.85), pantherA: model('panther(A)', 0.5, 1.85),
  pz4g: model('german_medium(pz4g)', 0.42, 1.62), stug4: model('stug3g(pz4=True)', 0.42, 1.81),
  hetzer: model('hetzer', 0.38, 1.82), flammpanzer3: model('german_medium(flammpanzer3)', 0.42, 1.55),
  kettenkrad: model('kettenkrad', 0.35, 0.78, 'halftrack'),
  kubelwagen: model('kubelwagen', 0.4, 0.98, 'wheeled'),
  sdkfz251_rocket: model('sdkfz251_rocket/sdkfz251', 0.5, 1.74, 'halftrack', 8, 1.45),
  pz3j: model('german_medium(pz3j)', 0.42, 1.55), pz4f1: model('german_medium(pz4f1)', 0.42, 1.62),
  pz4gh: model('german_medium(pz4gh)', 0.42, 1.62), stug3g: model('stug3g', 0.42, 1.81),
  panther: model('panther(G)', 0.5, 1.85), tiger: model('tiger', 0.47, 1.78),
  sdkfz251: model('sdkfz251', 0.5, 1.74, 'halftrack', 8, 1.45), marder3: model('marder3', 0.4, 2.5),
  is3: model('is3', 0.45, 1.5), is1: model('is1/is2', 0.45, 1.55),
  su152: model('su152', 0.45, 2.3), su100: model('su85(su100)', 0.42, 1.95),
  su122: model('su85(su122)', 0.42, 1.95), t28: model('t28 driver cab', 0.45, 1.97),
  ot34: model('ot34/t34_hull raised engine cover', 0.42, 1.52), sherman76: model('sherman76 driver hoods', 0.45, 1.97),
  bm13: model('bm13 chassis/cab', 0.595, 2.05, 'wheeled'),
  t26: model('t26', 0.38, 1.5), bt7: model('bt7', 0.4, 1.32),
  t34_76: model('t34_hull raised engine cover', 0.42, 1.52, 'tracked', 26), kv1: model('kv1', 0.45, 1.62, 'tracked', 45, 1.1),
  t70: model('t70_hull', 0.36, 1.2), t34_85: model('t34_hull raised engine cover', 0.42, 1.52),
  is2: model('is2', 0.45, 1.55), su76: model('su76/t70_hull', 0.36, 2.15), su85: model('su85', 0.42, 1.95),
};

/** Common values are gameplay assumptions, never historical climbing/gun specifications. */
export const HULL_TUNING_PROVENANCE = estimate('approved P2 tuning: damping 0.9; travel 0.28 m tracked/halftrack, 0.22 m wheeled; equilibrium 0.35 travel; comfort 12° tracked/halftrack, 10° wheeled; gun -5°/+20°; tip from support width/CG; legacy hull height 1.2 m and clearance 0.35 m tracked/halftrack, 0.25 m wheeled');

function contactsFor(id: string, driveKind: DriveKind, widthM: number, lengthM: number,
  cgHeightM: number, travelM: number): HullParams['contacts'] {
  const contacts: HullParams['contacts'] = [], z = -cgHeightM - 0.35 * travelM;
  function point(side: -1 | 1, x: number, y: number, steer = false, driven = true, horn = false): void {
    contacts.push({ local: { x, y, z: z + (horn ? 0.2 : 0) }, side, steer, driven, horn });
  }
  // Stable order: left then right; within each run front-to-rear supports then horns.
  if (driveKind === 'wheeled') {
    // Actual procedural axle positions, expressed in sim's rear-positive local y.
    const axles = id === 'kubelwagen' ? [-lengthM / 2 + 0.62, lengthM / 2 - 0.62]
      : id === 'bm13' ? [-lengthM / 2 + 1.05, lengthM / 2 - 2.3, lengthM / 2 - 1.25]
      : [-0.36 * lengthM, 0.36 * lengthM]; // legacy fixture fallback
    for (const side of [-1, 1] as const)
      for (let i = 0; i < axles.length; i++) point(side, side * 0.42 * widthM, axles[i], i === 0, i !== 0);
  } else {
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < 6; i++) point(side, side * 0.42 * widthM,
        driveKind === 'tracked' ? (-0.36 + 0.72 * i / 5) * lengthM : 0.36 * i / 5 * lengthM);
      point(side, side * 0.42 * widthM, (driveKind === 'tracked' ? -0.48 : -0.12) * lengthM, false, false, true);
      point(side, side * 0.42 * widthM, 0.48 * lengthM, false, false, true);
    }
    if (driveKind === 'halftrack') {
      if (id === 'kettenkrad') point(1, 0, -0.36 * lengthM, true, false);
      else for (const side of [-1, 1] as const) point(side, side * 0.42 * widthM, -0.36 * lengthM, true, false);
    }
  }
  return contacts;
}

/** Also resolves old test-only VehicleDef literals. Catalog ids use explicit model metadata;
 * class-based defaults only serve definitions with no model entry. Does not mutate the input. */
export function resolveVehiclePhysics(def: VehicleDef): NormalizedVehiclePhysics {
  const m = VEHICLE_PHYSICS_PROVENANCE[def.id];
  const driveKind = def.driveKind ?? m?.driveKind ?? (def.kind === 'halftrack' ? 'halftrack' : def.kind === 'armoredcar' ? 'wheeled' : 'tracked');
  const clearanceM = m?.clearanceM ?? (driveKind === 'wheeled' ? 0.25 : 0.35);
  const hullHeightM = def.hullHeightM ?? m?.hullHeightM ?? 1.2;
  const cgHeightM = def.cgHeightM ?? m?.cgHeightM ?? (clearanceM + hullHeightM / 2);
  const armored = def.armor.front > 0 || def.armor.side > 0 || def.armor.rear > 0 || def.armor.top > 0;
  const massT = def.massT ?? m?.massT ?? (armored ? 2 : 0.3) * def.lengthM * def.widthM * hullHeightM;
  const travelM = def.suspension?.travelM ?? (driveKind === 'wheeled' ? 0.22 : 0.28);
  const supports = contactsFor(def.id, driveKind, def.widthM, def.lengthM, cgHeightM, travelM).filter(c => !c.horn).length;
  return { massT, hullHeightM, cgHeightM, driveKind,
    suspension: def.suspension ? { ...def.suspension } : {
      springKNm: massT * 1000 * 9.81 / (supports * 0.35 * travelM) / 1000, damping: 0.9, travelM },
    slopeComfortDeg: def.slopeComfortDeg ?? (driveKind === 'wheeled' ? 10 : 12),
    slopeTipDeg: def.slopeTipDeg ?? dm.atan2(0.42 * def.widthM, cgHeightM) * 180 / Math.PI,
    gunDepressionDeg: def.gunDepressionDeg ?? 5, gunElevationDeg: def.gunElevationDeg ?? 20 };
}

export function hullParams(def: VehicleDef): HullParams {
  const physics = resolveVehiclePhysics(def), { massT, hullHeightM, cgHeightM, suspension, driveKind } = physics;
  const { lengthM, widthM } = def, massKg = massT * 1000;
  const clearanceM = VEHICLE_PHYSICS_PROVENANCE[def.id]?.clearanceM ?? (driveKind === 'wheeled' ? 0.25 : 0.35);
  const p: HullParams = { ...def, ...physics, massKg, clearanceM,
    armor: { ...def.armor, belly: def.armor.belly ?? def.armor.top },
    inertia: { x: massKg * (lengthM * lengthM + hullHeightM * hullHeightM) / 12,
      y: massKg * (widthM * widthM + hullHeightM * hullHeightM) / 12,
      z: massKg * (lengthM * lengthM + widthM * widthM) / 12 },
    contacts: contactsFor(def.id, driveKind, widthM, lengthM, cgHeightM, suspension.travelM),
    modelOriginLocal: { x: 0, y: 0, z: -cgHeightM },
    solidBox: { min: { x: -widthM / 2, y: -lengthM / 2, z: clearanceM - cgHeightM },
      max: { x: widthM / 2, y: lengthM / 2, z: clearanceM + hullHeightM - cgHeightM } } };
  for (const n of [massKg, lengthM, widthM, hullHeightM, cgHeightM, suspension.travelM, suspension.springKNm,
    p.inertia.x, p.inertia.y, p.inertia.z]) {
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${def.id}: invalid hull physical parameter`);
  }
  for (const n of [clearanceM, suspension.damping, p.slopeComfortDeg, p.slopeTipDeg, p.gunDepressionDeg, p.gunElevationDeg])
    if (!Number.isFinite(n) || n < 0) throw new Error(`${def.id}: invalid hull tuning`);
  for (const axis of ['x', 'y', 'z'] as const)
    if (!Number.isFinite(p.solidBox.min[axis]) || !Number.isFinite(p.solidBox.max[axis]) || p.solidBox.max[axis] <= p.solidBox.min[axis])
      throw new Error(`${def.id}: invalid hull solid box`);
  for (const c of p.contacts) for (const n of [c.local.x, c.local.y, c.local.z])
    if (!Number.isFinite(n)) throw new Error(`${def.id}: invalid hull contact`);
  return p;
}
