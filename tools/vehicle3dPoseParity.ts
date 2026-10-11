// Small exact-output local/mini parity payload, no renderer, GPU, or simulation step.
import { BoxGeometry, Mesh, MeshLambertMaterial, Vector3, Quaternion } from 'three';
import { vehiclePose, vehicleScreenPoint, type VehicleLook } from '@/render/vehicle3d/look';
import { VehicleScene } from '@/render/vehicle3d/vehicleScene';
import type { VehicleModel } from '@/render/vehicle3d/models';

export function vehicleRenderParity(): unknown {
  const nodes = new Map(['hull_ok', 'turret_ok', 'gun_ok', 'wheels_L_0_ok', 'wheels_R_1_ok'].map(name => {
    const mesh = new Mesh(new BoxGeometry(), new MeshLambertMaterial()); mesh.name = name; return [name, mesh] as const;
  }));
  const model: VehicleModel = { hasTurret: true, turretPivotM: { x: 0, y: 0.62 },
    turretPivot3M: { x: 0, y: -0.62, z: 0 }, gunTrunnionM: { x: 0, y: -1.35, z: 1.76 },
    wheels: [{ index: 0, side: 'L', radiusM: 0.3, centreM: { x: -1, y: -2, z: 0.3 } },
      { index: 1, side: 'R', radiusM: 0.3, centreM: { x: 0, y: -1, z: 0.3 } }], nodes, winterNodes: null };
  return [0, Math.PI / 2, Math.PI, Math.PI * 3 / 2].map((heading, i) => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), heading)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.4))
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -0.3));
    const look: VehicleLook = { id: i, defId: 't34_76', posTiles: { x: 10, y: 20 }, hullRad: heading,
      turretRad: heading + Math.PI / 2, ko: false, liveButLeft: false, turretBlown: false, brokenTrack: null,
      turretLanding: null, season: 'summer', recoil: 0.6, gunElevationRad: 0.2, wheelTravelM: { L: 0.04, R: -0.02 },
      centreWheelTravelM: [{ yM: -1.1, travelM: 0.06 }], wheelDistanceM: 1.2, bodyQuaternion: { x: q.x, y: q.y, z: q.z, w: q.w }, worldCG: { x: 20, y: 40, z: 8 },
      modelOriginLocal: { x: 0, y: 0, z: -1 }, groundM: 7 };
    const scene = new VehicleScene({ get: () => model }); scene.begin(); scene.add(look); scene.end();
    scene.scene.updateMatrixWorld(true); scene.shadowScene.updateMatrixWorld(true);
    return { pose: vehiclePose(look, true, model.turretPivotM, model.turretPivot3M),
      screen: vehicleScreenPoint({ x: 0, y: 0, zoom: 2 }, look),
      matrices: [...nodes.keys()].map(name => ({ name, body: scene.scene.getObjectByName(name)!.matrixWorld.toArray(), shadow: scene.shadowScene.getObjectByName(name)!.matrixWorld.toArray() })) };
  });
}
