import { describe, expect, it } from 'vitest';
import { acceptedFootprintTiles, type AcceptedHullPose } from '@/sim/hullFootprint';
import { referenceFootprintTiles } from './hullFootprintReference';
import { VEHICLE_DEFS } from '@/data/units';
import { hullParams, type HullParams } from '@/data/vehiclePhysics';
import { multiply, normalize, yawQuat } from '@/sim/hullMath';
import { Rng } from '@/shared/rng';
import type { BattleState } from '@/shared/types';

const map = { width: 40, height: 40 };
const state = { map } as BattleState;
function compare(p: HullParams, poses: AcceptedHullPose[]) {
  expect([...acceptedFootprintTiles(map, p.solidBox, poses)]).toEqual([...referenceFootprintTiles(state, p, poses)]);
}
describe('exact accepted footprint optimization', () => {
  it('preserves tile membership and insertion order for every vehicle, orientation and clipped map edge', () => {
    const rng = new Rng(117);
    for (const def of Object.values(VEHICLE_DEFS)) {
      const p = hullParams(def);
      for (let i = 0; i < 100; i++) {
        const orientation = normalize({ x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1), w: rng.range(-1, 1) });
        const position = { x: rng.range(-4, 84), y: rng.range(-4, 84), z: rng.range(-3, 3) };
        const poses = [{ position, orientation }, { position: { ...position, x: position.x + 0.15 }, orientation }];
        compare(p, [...poses, poses[0], poses[1]]);
      }
    }
  });
  it('retains exact boundary contacts, signed zeros and overlapping-pose ownership', () => {
    const p = hullParams(VEHICLE_DEFS.pz4gh);
    for (const x of [-0, 0, 2, 2 - Number.EPSILON, 2 + Number.EPSILON * 2, -p.solidBox.min.x, 2 - p.solidBox.min.x, 80 - p.solidBox.max.x, 80]) {
      for (const yaw of [-Math.PI, -Math.PI / 2, -0, 0, Math.PI / 2, Math.PI]) {
        const orientation = yawQuat(yaw), position = { x, y: 20, z: 0 };
        compare(p, [{ position, orientation }, { position: { ...position }, orientation: { ...orientation } }]);
      }
    }
  });
  it('keeps degenerate projections and overturned roof corners in the footprint', () => {
    const p = hullParams(VEHICLE_DEFS.sdkfz251);
    for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
      const orientation = multiply(yawQuat(angle), { x: Math.sin(angle / 2), y: 0, z: 0, w: Math.cos(angle / 2) });
      compare(p, [{ position: { x: 20, y: 20, z: 2 }, orientation }]);
    }
    compare({ ...p, solidBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } } },
      [{ position: { x: 20, y: 20, z: 0 }, orientation: yawQuat(0) }]);
    compare({ ...p, solidBox: { min: { x: 0, y: -2, z: 0 }, max: { x: 0, y: 2, z: 0 } } },
      [{ position: { x: 20, y: 20, z: 0 }, orientation: yawQuat(0) }]);
    expect([...acceptedFootprintTiles(map, p.solidBox, [])]).toEqual([]);
  });
});
