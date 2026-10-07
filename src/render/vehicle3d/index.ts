// The battle view's 3D vehicle layer (BACKLOG 050 P1).
import { VIEW_W, VIEW_H } from '@/shared/types';
import { GlOutput } from './glOutput';
import { VehicleScene } from './vehicleScene';
import { modelSource } from './models';

export { loadVehicleModels } from './models';

let single: { scene: VehicleScene; out: GlOutput } | null | undefined;

/** The 3D vehicle layer, or null: Node, `?vehicles=sprites`, no WebGL, or a lost context. */
export function vehicles3d(): { scene: VehicleScene; out: GlOutput } | null {
  if (single !== undefined) return single && single.out.ready ? single : null;
  if (typeof document === 'undefined' || new URLSearchParams(location.search).get('vehicles') === 'sprites') return (single = null);
  const out = GlOutput.create(VIEW_W, VIEW_H);
  single = out ? { scene: new VehicleScene(modelSource), out } : null;
  return single;
}
