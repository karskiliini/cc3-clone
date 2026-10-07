// ============================================================================
// What a vehicle looks like this frame: one decision shared by the sprite and
// the 3D path (live / knocked out / blown turret / thrown track / recoil /
// where the blown turret landed), plus the 3D node choice and pose.
// Render-side only; never read by the sim.
// ============================================================================
import type { BattleState, Season, Vec2, Vehicle } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { vehicleDamageView } from '@/sim/vehicleDamage';
import { isServiceable } from '@/sim/vehicleCrew';
import { localToWorldXZ } from './projection';

/** How far (m) the shot throws a gun back, and for how long (s) the kick eases out. */
export const RECOIL_M = 0.26;
const RECOIL_S = 0.4;
export function recoilOf(veh: Vehicle, time: number): number {
  if (veh.lastMainShotAt == null) return 0;
  const t = (time - veh.lastMainShotAt) / RECOIL_S;
  return t >= 0 && t < 1 ? (1 - t) * (1 - t) : 0;
}

export interface VehicleLook {
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
}

export function vehicleLook(veh: Vehicle, state: BattleState): VehicleLook {
  const liveButLeft = veh.state === 'abandoned' && isServiceable(veh);
  const ko = veh.state === 'knockedOut' || veh.state === 'burning' || (veh.state === 'abandoned' && !liveButLeft);
  const dmg = vehicleDamageView(veh);
  return {
    id: veh.id, defId: veh.defId, posTiles: veh.pos, hullRad: veh.hullFacing, turretRad: veh.turretFacing,
    ko, liveButLeft, turretBlown: dmg.turretBlown, brokenTrack: dmg.brokenTrack,
    turretLanding: veh.turretLanding ? { posTiles: veh.turretLanding, dirRad: veh.turretLandingDir ?? veh.turretFacing + 2.3 } : null,
    season: state.map.def.season, recoil: ko ? 0 : recoilOf(veh, state.time),
  };
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
  /** three world metres (x east, y up, z south) */
  hullPos: [number, number, number];
  /** three rotation.y (= -facing) */
  hullYaw: number;
  turretPivot: [number, number, number] | null;
  turretYaw: number;
}

export function vehiclePose(look: VehicleLook, hasTurret: boolean, turretPivotM: { x: number; y: number } | null): VehiclePose {
  let e = look.posTiles.x * TILE_M, s = look.posTiles.y * TILE_M;
  // recoil, as drawVehicleSprite: the hull rocks back half the recoil; a casemate kicks back the other half too
  const r = RECOIL_M * look.recoil;
  if (r > 0) {
    e -= Math.sin(look.hullRad) * r * 0.5; s += Math.cos(look.hullRad) * r * 0.5;
    if (!hasTurret) { e -= Math.sin(look.hullRad) * r * 0.5; s += Math.cos(look.hullRad) * r * 0.5; }
  }
  const pose: VehiclePose = { hullPos: [e, 0, s], hullYaw: -look.hullRad, turretPivot: null, turretYaw: -look.turretRad };
  if (!hasTurret || !turretPivotM) return pose;
  if (look.turretBlown && look.turretLanding) {
    pose.turretPivot = [look.turretLanding.posTiles.x * TILE_M, 0, look.turretLanding.posTiles.y * TILE_M];
    pose.turretYaw = -look.turretLanding.dirRad;
    return pose;
  }
  const [pe, ps] = localToWorldXZ(turretPivotM.x, turretPivotM.y, look.hullRad);
  let te = e + pe, ts = s + ps;
  if (look.turretBlown) {
    // no landing recorded: beside the hull, as drawVehicleSprite does
    const c = Math.cos(look.hullRad), sn = Math.sin(look.hullRad);
    te += (2.2 * c + 1.0 * sn) * 0.9; ts += (2.2 * sn - 1.0 * c) * 0.9;
    pose.turretYaw = -(look.turretRad + 2.3);
  } else if (r > 0) {
    te -= Math.sin(look.turretRad) * r * 0.5; ts += Math.cos(look.turretRad) * r * 0.5;
  }
  pose.turretPivot = [te, 0, ts];
  return pose;
}
