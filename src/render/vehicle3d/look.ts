// ============================================================================
// What a vehicle looks like this frame: one decision shared by the sprite and
// the 3D path (live / knocked out / blown turret / thrown track / recoil /
// where the blown turret landed), plus the 3D node choice and pose.
// Render-side only; never read by the sim.
// ============================================================================
import type { BattleState, Season, Vec2, Vec3, HullQuat, Vehicle } from '@/shared/types';
import { TILE_M, TILE_PX } from '@/shared/types';
import { vehicleDamageView } from '@/sim/vehicleDamage';
import { isServiceable } from '@/sim/vehicleCrew';
import { Quaternion, Vector3 } from 'three';
import { VEHICLE_DEFS } from '@/data/units';
import { TILT_RAD, type ViewCam } from './projection';
import { cargoLocal, seatForSoldier, transportAction, transportLayout } from '../lightTransport';
import { heightAt } from '@/sim/heightField';
import { hullParams } from '@/data/vehiclePhysics';

/** How far (m) the shot throws a gun back, and for how long (s) the kick eases out. */
export const RECOIL_M = 0.26;
const RECOIL_S = 0.4;
export const CENTRELINE_WHEEL_EPS_M = 1e-9;
export function recoilOf(veh: Vehicle, time: number): number {
  if (veh.lastMainShotAt == null) return 0;
  const t = (time - veh.lastMainShotAt) / RECOIL_S;
  return t >= 0 && t < 1 ? (1 - t) * (1 - t) : 0;
}

export interface LightTransportVisuals {
  occupants: { id: number; seat: Vec3; driver: boolean; side: string; facing?: number;
    posture?: 'crouched' | 'firing' | 'casualty'; body?: Vec3[]; weapon?: boolean }[];
  cargo?: Vec3;
  time: number;
}
export interface VehicleLook {
  lightTransport?: LightTransportVisuals;
  id: number;
  defId: string;
  posTiles: Vec2;
  hullRad: number;
  turretRad: number;
  /** burnt / knocked-out look (knocked out, burning, or abandoned and unserviceable) */
  ko: boolean;
  /** a serviceable hull whose crew is outside: live look, hatches open (spec §10) */
  liveButLeft: boolean;
  turretBlown: boolean;
  brokenTrack: 'L' | 'R' | 'both' | null;
  /** where the sim threw the blown-off turret and how it lies */
  turretLanding: { posTiles: Vec2; dirRad: number } | null;
  season: Season;
  /** 0..1 main-gun recoil (1 = the instant of the shot) */
  recoil: number;
  /** Copied canonical simulation local-to-world pose in metres; never initialized by rendering. */
  bodyQuaternion?: HullQuat;
  worldCG?: Vec3;
  modelOriginLocal?: Vec3;
  gunElevationRad?: number;
  /** Side-average non-horn compression relative to the existing 0.35 travel loaded datum. */
  wheelTravelM?: { L: number; R: number };
  /** Existing centreline non-horn supports, copied in the same rear-positive local-Y frame. */
  centreWheelTravelM?: { yM: number; travelM: number }[];
  /** Cosmetic current speed × absolute simulation time; never feeds physics/hash. */
  wheelDistanceM?: number;
  groundM?: number;
  turretLandingGroundM?: number;
}

/** Read only: production ticks own field construction and crater synchronization. */
function cachedGround(state: BattleState, pos: Vec2): number {
  if (state.map.heightField) return heightAt(state.map.heightField, pos.x, pos.y);
  const map = state.map, field = map.ground;
  if (!field) return 0;
  const fx = pos.x - 0.5, fy = pos.y - 0.5;
  const x = Math.max(0, Math.min(map.width - 1, Math.floor(fx))), y = Math.max(0, Math.min(map.height - 1, Math.floor(fy)));
  const x1 = Math.min(map.width - 1, x + 1), y1 = Math.min(map.height - 1, y + 1);
  const ax = Math.max(0, Math.min(1, fx - x)), ay = Math.max(0, Math.min(1, fy - y));
  return (field[y * map.width + x] * (1 - ax) + field[y * map.width + x1] * ax) * (1 - ay)
    + (field[y1 * map.width + x] * (1 - ax) + field[y1 * map.width + x1] * ax) * ay;
}
export function vehicleLook(veh: Vehicle, state: BattleState): VehicleLook {
  const liveButLeft = veh.state === 'abandoned' && isServiceable(veh);
  const ko = veh.state === 'knockedOut' || veh.state === 'burning' || (veh.state === 'abandoned' && !liveButLeft);
  const dmg = vehicleDamageView(veh);
  const def = VEHICLE_DEFS[veh.defId], p = veh.body && def ? hullParams(def) : null;
  const wheelTravelM = p ? Object.fromEntries((['L', 'R'] as const).map(side => {
    const travel = p.contacts.flatMap((c, i) => !c.horn && Math.abs(c.local.x) > CENTRELINE_WHEEL_EPS_M && c.side === (side === 'L' ? -1 : 1) ? [veh.body!.suspensionTravel[i] ?? 0] : []);
    return [side, travel.reduce((a, b) => a + b, 0) / Math.max(1, travel.length) - 0.35 * p.suspension.travelM];
  })) as { L: number; R: number } : undefined;
  const centreWheelTravelM = p?.contacts.flatMap((c, i) => !c.horn && Math.abs(c.local.x) <= CENTRELINE_WHEEL_EPS_M
    ? [{ yM: c.local.y, travelM: (veh.body!.suspensionTravel[i] ?? 0) - 0.35 * p.suspension.travelM }] : []);
  const look: VehicleLook = {
    ...(veh.body ? { bodyQuaternion: { ...veh.body.orientation }, worldCG: { ...veh.body.position } } : {}),
    ...(p ? { modelOriginLocal: { ...p.modelOriginLocal }, wheelTravelM, centreWheelTravelM } : {}),
    groundM: cachedGround(state, veh.pos),
    turretLandingGroundM: veh.turretLanding ? cachedGround(state, veh.turretLanding) : undefined,
    gunElevationRad: veh.gunElevationRad ?? 0, wheelDistanceM: veh.speed * state.time,
    id: veh.id, defId: veh.defId, posTiles: { ...veh.pos }, hullRad: veh.hullFacing, turretRad: veh.turretFacing,
    ko, liveButLeft, turretBlown: dmg.turretBlown, brokenTrack: dmg.brokenTrack,
    turretLanding: veh.turretLanding ? { posTiles: { ...veh.turretLanding }, dirRad: veh.turretLandingDir ?? veh.turretFacing + 2.3 } : null,
    season: state.map.def.season, recoil: ko ? 0 : recoilOf(veh, state.time),
  };
  const layout = transportLayout(def);
  if (layout && (!ko || def.passengerCompartment)) {
    const occupants: LightTransportVisuals['occupants'] = [];
    for (const s of state.soldiers.values()) {
      if (s.vehicleId !== veh.id || s.hatch) continue;
      const casualty = s.health === 'dead' || s.health === 'incapacitated';
      if (casualty && !s.rider?.body) continue;
      if (def.passengerCompartment && s.seat !== 'passenger') continue;
      const seat = seatForSoldier(veh, s, layout);
      if (seat) {
        const pose = s.rider?.body ? vehiclePose(look, false, null) : null;
        const inverse = pose ? new Quaternion().fromArray(pose.hullQuaternion).invert() : null;
        const body = s.rider?.body?.map(p => {
          const v = new Vector3(p.position.x, p.position.z, p.position.y).sub(new Vector3().fromArray(pose!.hullPos)).applyQuaternion(inverse!);
          return { x: v.x, y: v.z, z: v.y };
        });
        occupants.push({ id: s.id, seat, driver: veh.seats?.driver === s.id, side: s.side,
          facing: s.rider?.posture === 'firing' ? s.facing * Math.PI / 4 - veh.hullFacing : layout.passengerFacing?.[layout.passengerSeats.indexOf(seat)] ?? 0,
          ...(s.rider ? { posture: s.rider.posture, body, weapon: !casualty } : {}) });
      }
    }
    const action = [...state.teams.values()].map(t => t.crewWeapon && transportAction(t.crewWeapon)).find(a => a?.vehicleId === veh.id && ['loading', 'loaded', 'unloading'].includes(a.phase));
    look.lightTransport = { occupants, time: state.time, ...(action ? { cargo: cargoLocal(look, layout, action, state.time) } : {}) };
  }
  return look;
}

export interface ModelNodes { hull: string; turret: string | null; winterHull: boolean; winterTurret: boolean }

/** The model nodes (glb node names, see tools/blender/vehicles_lowpoly.py) for a look; the same
 * choice drawVehicleSprite makes between atlas entries. */
export function modelNodes(look: VehicleLook, available: ReadonlySet<string>, hasWinter: boolean): ModelNodes {
  const want = look.turretBlown ? 'hull_blown'
    : look.ko ? 'hull_ko'
    : look.brokenTrack ? (look.brokenTrack === 'R' ? 'hull_trackR' : 'hull_trackL')
    : 'hull_ok';
  const hull = available.has(want) ? want : look.ko ? 'hull_ko' : 'hull_ok';
  const turret = available.has('turret_ok')
    ? (look.turretBlown ? 'turret_blown' : look.ko ? 'turret_ko' : 'turret_ok')
    : null;
  const winter = hasWinter && look.season === 'winter' && !look.ko && !look.turretBlown;
  return { hull, turret, winterHull: winter, winterTurret: winter && turret === 'turret_ok' };
}

export interface VehiclePose {
  /** Three world metres (x east, y up, z south). */
  hullPos: [number, number, number];
  hullYaw: number;
  hullQuaternion: [number, number, number, number];
  turretPivot: [number, number, number] | null;
  turretYaw: number;
  turretQuaternion: [number, number, number, number];
}

/** Axis permutation changes handedness: qThree=(-qx,-qz,-qy,qw). */
export function threeQuaternion(q: HullQuat): Quaternion { return new Quaternion(-q.x, -q.z, -q.y, q.w); }
function local(v: Vec3): Vector3 { return new Vector3(v.x, v.z, v.y); }
export function vehiclePose(look: VehicleLook, hasTurret: boolean, turretPivotM: { x: number; y: number } | null,
  turretPivot3M?: Vec3 | null): VehiclePose {
  const hullQ = look.bodyQuaternion ? threeQuaternion(look.bodyQuaternion) : new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -look.hullRad);
  const origin = look.worldCG && look.modelOriginLocal
    ? local(look.worldCG).add(local(look.modelOriginLocal).applyQuaternion(hullQ))
    : new Vector3(look.posTiles.x * TILE_M, look.groundM ?? 0, look.posTiles.y * TILE_M);
  const turretQ = hullQ.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -(look.turretRad - look.hullRad)));
  const pose: VehiclePose = { hullPos: origin.toArray(), hullYaw: -look.hullRad, hullQuaternion: hullQ.toArray(),
    turretPivot: null, turretYaw: -look.turretRad, turretQuaternion: turretQ.toArray() };
  if (!hasTurret || (!turretPivotM && !turretPivot3M)) return pose;
  if (look.turretBlown) {
    if (look.turretLanding) {
      pose.turretPivot = [look.turretLanding.posTiles.x * TILE_M, look.turretLandingGroundM ?? 0, look.turretLanding.posTiles.y * TILE_M];
      pose.turretYaw = -look.turretLanding.dirRad;
    } else {
      const c = Math.cos(look.hullRad), sn = Math.sin(look.hullRad);
      pose.turretPivot = [origin.x + (2.2 * c + 1.0 * sn) * 0.9, look.groundM ?? 0, origin.z + (2.2 * sn - 1.0 * c) * 0.9];
      pose.turretYaw = -(look.turretRad + 2.3);
    }
    pose.turretQuaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), pose.turretYaw).toArray();
    return pose;
  }
  const ring = turretPivot3M ?? { x: turretPivotM!.x, y: -turretPivotM!.y, z: 0 };
  pose.turretPivot = origin.clone().add(local(ring).applyQuaternion(hullQ)).toArray();
  return pose;
}

/** Project the same model-origin frame used by 3D for fallback and overlay anchors. */
export function vehicleScreenPoint(cam: ViewCam, look: VehicleLook, point: Vec3 = { x: 0, y: 0, z: 0 }): Vec2 {
  const pose = vehiclePose(look, false, null);
  const world = new Vector3(point.x, point.z, point.y).applyQuaternion(new Quaternion().fromArray(pose.hullQuaternion)).add(new Vector3().fromArray(pose.hullPos));
  return projectVehicleWorldPoint(cam, world.toArray());
}
export function projectVehicleWorldPoint(cam: ViewCam, world: [number, number, number]): Vec2 {
  return { x: (world[0] / TILE_M - cam.x) * TILE_PX * cam.zoom,
    y: (world[2] / TILE_M - cam.y) * TILE_PX * cam.zoom - world[1] * Math.sin(TILT_RAD) * TILE_PX / TILE_M * cam.zoom };
}
