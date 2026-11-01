import type { BattleState, HullQuat, Vec2, Vec3, Vehicle } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { hullParams } from '@/data/vehiclePhysics';
import * as dm from '@/shared/dmath';
import { rotate, yawQuat } from './hullMath';
import { towLengthM } from './crewWeapon';
import { isPassable } from './path';

/** Conservative transport envelopes, in metres about the axle. These include
 * wheels, shield, muzzle and the closed trails; dimensions follow weapons.py.
 * Unknown equipment is deliberately not given an arbitrary towable envelope. */
const ENVELOPES: Record<string, { halfWidth: number; forward: number }> = {
  pak38: { halfWidth: 0.95, forward: 3.2 },
  pak40: { halfWidth: 1.15, forward: 3.8 },
  m1937_45mm: { halfWidth: 0.9, forward: 2.7 },
  zis3: { halfWidth: 1.2, forward: 3.7 },
  nebel41: { halfWidth: 0.9, forward: 2.1 },
};
/** Fallback gameplay estimates, not a replacement for an explicit data value. */
const MASSES: Record<string, number> = { pak38: 1000, pak40: 1425, m1937_45mm: 560, zis3: 1200, nebel41: 540 };
export function towingMassKg(weaponId: string): number {
  return WEAPONS[weaponId]?.transportMassKg ?? MASSES[weaponId] ?? Infinity;
}
export function canTowWeapon(v: Vehicle, weaponId: string): boolean {
  const capacity = VEHICLE_DEFS[v.defId]?.lightTransport?.towMaxKg;
  const mass = towingMassKg(weaponId);
  return !!ENVELOPES[weaponId] && capacity != null && Number.isFinite(capacity)
    && Number.isFinite(mass) && mass > 0 && mass <= capacity;
}

/** World metres. Anchors use the model frame (+y rear), translated to the CG. */
export function rearHitch(v: Vehicle, positionM?: Vec3, orientation?: HullQuat): Vec3 | null {
  const def = VEHICLE_DEFS[v.defId], anchor = def?.lightTransport?.hitch;
  if (!anchor) return null;
  const p = hullParams(def), position = positionM ?? v.body?.position
    ?? { x: v.pos.x * TILE_M, y: v.pos.y * TILE_M, z: p.cgHeightM };
  const r = rotate(orientation ?? v.body?.orientation ?? yawQuat(v.hullFacing), {
    x: anchor.x + p.modelOriginLocal.x, y: anchor.y + p.modelOriginLocal.y, z: anchor.z + p.modelOriginLocal.z,
  });
  return { x: position.x + r.x, y: position.y + r.y, z: position.z + r.z };
}

interface Pose { x: number; y: number; facing: number }
interface Bounds { minX: number; maxX: number; minY: number; maxY: number }
function bounds(points: Vec2[], pad = 0): Bounds {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
}
function rectangle(b: Bounds): Vec2[] {
  return [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];
}
function gunCorners(p: Pose, weaponId: string): Vec2[] {
  const e = ENVELOPES[weaponId], c = dm.cos(p.facing), s = dm.sin(p.facing), tail = towLengthM(weaponId);
  return [{ x: -e.halfWidth, y: -e.forward }, { x: e.halfWidth, y: -e.forward },
    { x: e.halfWidth, y: tail }, { x: -e.halfWidth, y: tail }]
    .map(a => ({ x: p.x + a.x * c - a.y * s, y: p.y + a.x * s + a.y * c }));
}
/** SAT for the gun rectangle enlarged by an axis-aligned padding square.
 * Other hull projections may contain interior/unordered corners: projection
 * intervals remain valid, and using their edge normals only adds safe tests. */
function overlaps(a: Vec2[], b: Vec2[], pad: number): boolean {
  const axes: Vec2[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }];
  for (const points of [a, b]) for (let i = 0; i < points.length; i++) {
    const p = points[i], q = points[(i + 1) % points.length];
    axes.push({ x: p.y - q.y, y: q.x - p.x });
  }
  for (const n of axes) {
    let alo = Infinity, ahi = -Infinity, blo = Infinity, bhi = -Infinity;
    for (const p of a) { const d = p.x * n.x + p.y * n.y; alo = Math.min(alo, d); ahi = Math.max(ahi, d); }
    for (const p of b) { const d = p.x * n.x + p.y * n.y; blo = Math.min(blo, d); bhi = Math.max(bhi, d); }
    const extra = pad * (Math.abs(n.x) + Math.abs(n.y));
    if (ahi + extra < blo || bhi < alo - extra) return false;
  }
  return true;
}
function otherHullCorners(v: Vehicle): Vec2[] {
  const def = VEHICLE_DEFS[v.defId], p = hullParams(def), box = p.solidBox;
  const q = v.body?.orientation ?? yawQuat(v.hullFacing);
  const position = v.body?.position ?? { x: v.pos.x * TILE_M, y: v.pos.y * TILE_M, z: p.cgHeightM };
  const points: Vec2[] = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const r = rotate(q, { x, y, z }); points.push({ x: position.x + r.x, y: position.y + r.y });
  }
  return points;
}
function clear(state: BattleState, tractor: Vehicle, corners: Vec2[], pad: number): boolean {
  const b = bounds(corners, pad), map = state.map;
  if (!(b.minX >= 0 && b.minY >= 0 && b.maxX < map.width * TILE_M && b.maxY < map.height * TILE_M)) return false;
  for (let y = Math.floor(b.minY / TILE_M); y <= Math.floor(b.maxY / TILE_M); y++) {
    for (let x = Math.floor(b.minX / TILE_M); x <= Math.floor(b.maxX / TILE_M); x++) {
      if (isPassable(map, x, y, 'vehicle')) continue;
      const tile = rectangle({ minX: x * TILE_M, maxX: (x + 1) * TILE_M, minY: y * TILE_M, maxY: (y + 1) * TILE_M });
      if (overlaps(corners, tile, pad)) return false;
    }
  }
  for (const v of state.vehicles.values()) {
    if (v.id === tractor.id || !VEHICLE_DEFS[v.defId]) continue;
    const other = otherHullCorners(v), ob = bounds(other);
    if (b.maxX < ob.minX || ob.maxX < b.minX || b.maxY < ob.minY || ob.maxY < b.minY) continue;
    if (overlaps(corners, other, pad)) return false;
  }
  return true;
}

export interface TowStep {
  /** Stages accepted substeps; a rejection leaves the previous staged pose intact. */
  accept(positionM: Vec3, orientation: HullQuat): boolean;
  /** Call only after the tractor tick, including its final orientation, is accepted. */
  commit(): void;
}

/** Kinematic articulated trailer in the ground plane. The axle-to-eye length is
 * fixed; hitch height comes from the real hull pose. No canonical state changes
 * until commit. A missing attachment returns null; an invalid attachment blocks
 * acceptance rather than silently letting the tractor leave its weapon behind. */
export function createTowStep(state: BattleState, v: Vehicle): TowStep | null {
  if (v.towedTeamId == null) return null;
  const team = state.teams.get(v.towedTeamId), cw = team?.crewWeapon;
  const attachment = cw?.transport;
  let hitch = rearHitch(v);
  if (!cw || !attachment || attachment.phase !== 'towed' || attachment.vehicleId !== v.id
    || cw.destroyed || !hitch || !canTowWeapon(v, cw.weaponId)) return { accept: () => false, commit() {} };
  const weaponId = cw.weaponId, length = towLengthM(weaponId), e = ENVELOPES[weaponId];
  const reach = Math.max(e.forward, length), radius = Math.sqrt(e.halfWidth * e.halfWidth + reach * reach);
  let pose: Pose = { x: cw.pos.x * TILE_M, y: cw.pos.y * TILE_M, facing: cw.facing };
  const validInitial = Number.isFinite(pose.facing) && Number.isFinite(hitch.z)
    && Math.abs(dm.hypot(pose.x - hitch.x, pose.y - hitch.y) - length) < 1e-7
    && dm.hypot(pose.x - dm.sin(pose.facing) * length - hitch.x,
      pose.y + dm.cos(pose.facing) * length - hitch.y) < 1e-7;
  let accepted = false;
  return {
    accept(positionM, orientation) {
      accepted = false;
      if (!validInitial || !Number.isFinite(positionM.x) || !Number.isFinite(positionM.y) || !Number.isFinite(positionM.z)
        || !Number.isFinite(orientation.x) || !Number.isFinite(orientation.y) || !Number.isFinite(orientation.z) || !Number.isFinite(orientation.w)
        || Math.abs(orientation.x * orientation.x + orientation.y * orientation.y + orientation.z * orientation.z + orientation.w * orientation.w - 1) > 1e-6) return false;
      const end = rearHitch(v, positionM, orientation)!;
      const distance = dm.hypot(end.x - hitch!.x, end.y - hitch!.y);
      // Bounds precede subdivision, preventing overflow/unbounded allocations.
      if (!Number.isFinite(distance) || !Number.isFinite(end.z) || end.x < 0 || end.y < 0
        || end.x >= state.map.width * TILE_M || end.y >= state.map.height * TILE_M) return false;
      const count = Math.max(1, Math.ceil(distance / 0.05));
      if (count > 4096) return false; // invalid giant substep, never teleport or allocate a huge sweep
      let next = { ...pose };
      for (let i = 1; i <= count; i++) {
        const hx = hitch!.x + (end.x - hitch!.x) * (i / count), hy = hitch!.y + (end.y - hitch!.y) * (i / count);
        const dx = next.x - hx, dy = next.y - hy, d = dm.hypot(dx, dy);
        if (!Number.isFinite(d) || d < length / 2) return false;
        const stepDistance = distance / count;
        // Under radial projection, axle displacement <= 2*dh and orientation
        // change <= 2*dh/L (dh < L/2). This square expansion contains EVERY
        // intermediate gun/drawbar point, not just sampled endpoints.
        const pad = 2 * stepDistance * (1 + radius / length) + 2e-7;
        if (!clear(state, v, gunCorners(next, weaponId), pad)) return false;
        next = { x: hx + dx * length / d, y: hy + dy * length / d, facing: dm.atan2(dx, -dy) };
      }
      if (!clear(state, v, gunCorners(next, weaponId), 1e-9)) return false;
      pose = next; hitch = end; accepted = true;
      return true;
    },
    commit() {
      if (!accepted || cw.transport !== attachment || v.towedTeamId !== team!.id
        || attachment.phase !== 'towed' || attachment.vehicleId !== v.id) return;
      cw.pos = { x: pose.x / TILE_M, y: pose.y / TILE_M }; cw.facing = pose.facing;
    },
  };
}
