// Read-only anchors shared by 3D occupants, cargo and the 2D boarding animation.
import type { BattleState, CrewWeaponState, Soldier, Vec2, Vec3, Vehicle, VehicleDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { Quaternion, Vector3 } from 'three';
import { vehiclePose, type VehicleLook } from './vehicle3d/look';

export interface LightTransportLayout { driverSeat: Vec3; passengerSeats: Vec3[]; passengerFacing?: number[]; access: Vec2; cargo: Vec3; hitch: Vec3; towMaxKg: number }
export interface TransportAction { vehicleId: number; phase: 'loading' | 'loaded' | 'unloading' | 'coupling' | 'towed' | 'uncoupling'; startedAt: number; until: number; from: Vec2 }
export const transportAction = (cw: CrewWeaponState): TransportAction | undefined => (cw as CrewWeaponState & { transport?: TransportAction }).transport;
export const transportLayout = (def: VehicleDef | undefined): LightTransportLayout | undefined => (def as (VehicleDef & { lightTransport?: LightTransportLayout }) | undefined)?.lightTransport;
export const actionProgress = (a: { startedAt: number; until: number }, time: number): number => Math.max(0, Math.min(1, (time - a.startedAt) / Math.max(0.001, a.until - a.startedAt)));
// Retain a passenger's visual seat while his id leaves passengerIds during dismount.
// Weak ownership also prevents ids reused by a new battle from inheriting old assignments.
const passengerSeats = new WeakMap<Vehicle, Map<number, number>>();
export function seatForSoldier(v: Vehicle, s: Soldier, layout: LightTransportLayout): Vec3 | null {
  if (v.seats?.driver === s.id || (s.hatch?.vehicleId === v.id && !s.hatch.passenger)) return layout.driverSeat;
  let assigned = passengerSeats.get(v);
  if (!assigned) { assigned = new Map(); passengerSeats.set(v, assigned); }
  const aboard = v.passengerIds ?? [];
  const used = new Set(aboard.flatMap(id => assigned!.has(id) ? [assigned!.get(id)!] : []));
  for (const id of aboard) if (!assigned.has(id)) {
    const index = layout.passengerSeats.findIndex((_, i) => !used.has(i));
    if (index >= 0) { assigned.set(id, index); used.add(index); }
  }
  if (!assigned.has(s.id) && s.hatch?.vehicleId === v.id && s.hatch.passenger) {
    const index = layout.passengerSeats.findIndex((_, i) => !used.has(i));
    if (index >= 0) assigned.set(s.id, index);
  }
  const index = assigned.get(s.id);
  return index != null ? layout.passengerSeats[index] ?? null : null;
}
export function localWorld(look: VehicleLook, point: Vec3): [number, number, number] {
  const pose = vehiclePose(look, false, null);
  return new Vector3(point.x, point.z, point.y).applyQuaternion(new Quaternion().fromArray(pose.hullQuaternion)).add(new Vector3().fromArray(pose.hullPos)).toArray();
}
/** Boarding uses the visible seat as its hull endpoint, including pitch and roll. */
export function boardingWorld(s: Soldier, v: Vehicle, look: VehicleLook, layout: LightTransportLayout, time: number): [number, number, number] | null {
  const h = s.hatch;
  if (!h || h.vehicleId !== v.id) return null;
  const seat = seatForSoldier(v, s, layout) ?? (h.passenger ? layout.passengerSeats[h.hatch % Math.max(1, layout.passengerSeats.length)] : layout.driverSeat);
  if (!seat) return null;
  const mounted = localWorld(look, seat), p = actionProgress({ startedAt: h.start, until: h.until }, time);
  const ground = h.kind === 'mount' ? h.from : h.to;
  const end: [number, number, number] = [ground.x * TILE_M, look.groundM ?? 0, ground.y * TILE_M];
  const a = h.kind === 'mount' ? end : mounted, b = h.kind === 'mount' ? mounted : end;
  return [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p + Math.sin(p * Math.PI) * 0.28, a[2] + (b[2] - a[2]) * p];
}
export function cargoLocal(look: VehicleLook, layout: LightTransportLayout, action: TransportAction, time: number): Vec3 {
  if (action.phase === 'loaded') return layout.cargo;
  const p = actionProgress(action, time), t = action.phase === 'unloading' ? 1 - p : p;
  const pose = vehiclePose(look, false, null), inverse = new Quaternion().fromArray(pose.hullQuaternion).invert();
  const ground = new Vector3(action.from.x * TILE_M, look.groundM ?? 0, action.from.y * TILE_M).sub(new Vector3().fromArray(pose.hullPos)).applyQuaternion(inverse);
  const seat = new Vector3(layout.cargo.x, layout.cargo.z, layout.cargo.y);
  ground.lerp(seat, t); ground.y += Math.sin(t * Math.PI) * 0.5;
  return { x: ground.x, y: ground.z, z: ground.y };
}
