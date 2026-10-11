// Physical direct-fire paths, independent of whether the firer can see the aim point.
import type { BattleState, Tracer, Vec2, Vehicle, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { clamp, dist } from '@/shared/math';
import type { Rng } from '@/shared/rng';
import type { LosHeights } from './los';
import { groundAtTile, inBounds } from './map';
import { GROWTH_HEIGHT_M, cutGrowthAt } from './growth';
import { damageVegetation } from './trees';
import * as dm from '@/shared/dmath';
import type { HullIntersection, HullRay } from './hullAim';

export interface TraceVehicleContact { vehicle: Vehicle; hit: HullIntersection; ray: HullRay }
export interface RoundTraceOptions {
  /** Opt-in AT behavior; ordinary infantry traces retain their existing policy. */
  atPolicy?: 'ap' | 'he' | 'rocket';
  /** Pure nearest finite contact query; invoked again after each physical deflection. */
  vehicleContact?: (ray: HullRay, maxDistance: number) => Omit<TraceVehicleContact, 'ray'> | null;
}
export interface RoundTrace {
  impact: Vec2;
  /** Absolute height at the resolved end of the current physical leg. */
  impactZ: number;
  points: Vec2[];
  /** Absolute heights paired with each leg endpoint, including deflections. */
  pointsZ: number[];
  blocked: boolean;
  deflected: boolean;
  vehicleContact?: TraceVehicleContact;
}

/** Scatter around knowledge supplied by an order or belief, never around an unseen entity. */
export function estimateAim(state: BattleState, rng: Rng, from: Vec2, aim: Vec2): Vec2 {
  const radius = (2.5 + dist(from, aim) * TILE_M * 0.025) / TILE_M;
  const angle = rng.range(0, Math.PI * 2), r = radius * Math.sqrt(rng.next());
  return {
    x: clamp(aim.x + dm.cos(angle) * r, 0.01, state.map.width - 0.01),
    y: clamp(aim.y + dm.sin(angle) * r, 0.01, state.map.height - 0.01),
  };
}

/** Sample a straight round every half metre. Vegetation contacts can turn its remaining path;
 * that new path is traced again, including hard cover. Lobbed projectiles use their own model. */
export function traceRound(
  state: BattleState, rng: Rng, from: Vec2, to: Vec2, weapon: WeaponDef, heights: LosHeights = {}, options: RoundTraceOptions = {},
): RoundTrace {
  const points = [{ ...from }];
  const pointsZ = [heights.eyeZ ?? (groundAtTile(state.map, Math.floor(from.x), Math.floor(from.y)) + (heights.eyeM ?? 1.7))];
  if (weapon.indirect || weapon.cls === 'mortar' || weapon.cls === 'grenade') {
    return { impact: { ...to }, impactZ: heights.targetZ ?? (groundAtTile(state.map, Math.floor(to.x), Math.floor(to.y)) + (heights.targetM ?? 1.7)), points: [...points, { ...to }], pointsZ: [...pointsZ, heights.targetZ ?? (groundAtTile(state.map, Math.floor(to.x), Math.floor(to.y)) + (heights.targetM ?? 1.7))], blocked: false, deflected: false };
  }
  const map = state.map;
  let start = { ...from }, end = { ...to }, deflected = false, contacts = 0;
  let startZ = heights.eyeZ ?? (groundAtTile(map, Math.floor(from.x), Math.floor(from.y)) + (heights.eyeM ?? 1.7));
  let endZ = heights.targetZ ?? (groundAtTile(map, Math.floor(to.x), Math.floor(to.y)) + (heights.targetM ?? 1.7));
  const visited = new Set<number>();
  const shell = weapon.cls === 'tankgun' || weapon.cls === 'atgun' || weapon.cls === 'atrocket';
  const finish = (impact: Vec2, blocked: boolean, impactZ = endZ): RoundTrace => {
    points.push({ ...impact }); pointsZ.push(impactZ);
    return { impact: { ...impact }, impactZ, points, pointsZ, blocked, deflected };
  };
  const spark = (pos: Vec2, kind: BattleState['sparks'][number]['kind']) => {
    state.sparks.push({ pos: { ...pos }, kind, t: state.time });
  };
  // At most three changes of direction: bounded cost even in deep woodland.
  for (let leg = 0; leg < 4; leg++) {
    const length = dist(start, end), steps = Math.max(1, Math.ceil(length * 4));
    const ray: HullRay = { origin: { x: start.x * TILE_M, y: start.y * TILE_M, z: startZ }, direction: { x: (end.x - start.x) * TILE_M, y: (end.y - start.y) * TILE_M, z: endZ - startZ } };
    const rayLength = Math.sqrt(ray.direction.x ** 2 + ray.direction.y ** 2 + ray.direction.z ** 2);
    const candidate = options.vehicleContact?.(ray, rayLength);
    const contact = candidate && candidate.hit.distance >= 0 && candidate.hit.distance <= rayLength ? candidate : null;
    const contactFraction = contact && rayLength > 0 ? contact.hit.distance / rayLength : Infinity;
    const finishContact = (): RoundTrace => ({ ...finish({ x: contact!.hit.point.x / TILE_M, y: contact!.hit.point.y / TILE_M }, true, contact!.hit.point.z), vehicleContact: { ...contact!, ray } });
    let turned = false;
    for (let step = 1; step <= steps; step++) {
      const f = step / steps;
      // Terrain wins exact sampled-distance ties. Never touch growth/RNG beyond armor.
      if (f > contactFraction) return finishContact();
      const p = { x: start.x + (end.x - start.x) * f, y: start.y + (end.y - start.y) * f };
      const x = Math.floor(p.x), y = Math.floor(p.y);
      const z = startZ + (endZ - startZ) * f;
      if (!inBounds(map, x, y)) return finish({ x: clamp(p.x, 0, map.width - 0.001), y: clamp(p.y, 0, map.height - 0.001) }, true, z);
      const i = y * map.width + x, terrain = map.tiles[i];
      const above = z - groundAtTile(map, x, y);
      if (above < -0.2) { spark(p, 'dust'); return finish(p, true, z); }
      const startTile = x === Math.floor(from.x) && y === Math.floor(from.y);
      const endTile = x === Math.floor(to.x) && y === Math.floor(to.y);
      const wall = terrain === 'buildingStone' || terrain === 'buildingWood' || terrain === 'stonewall';
      const window = map.windows[i] && (
        Math.max(Math.abs(x - Math.floor(from.x)), Math.abs(y - Math.floor(from.y))) <= 1
        || Math.max(Math.abs(x - Math.floor(to.x)), Math.abs(y - Math.floor(to.y))) <= 1);
      // The aim tile can contain the target at a wall/window, matching LOS endpoint semantics.
      if (wall && !startTile && !endTile && !window && !(terrain === 'buildingWood' && options.atPolicy === 'ap')) {
        spark(p, terrain === 'buildingWood' ? 'wood' : 'stone'); return finish(p, true, z);
      }
      if (options.atPolicy === 'rocket' && !startTile && !endTile && (terrain === 'hedge' || terrain === 'fence')) {
        spark(p, 'wood'); return finish(p, true, z);
      }
      if (GROWTH_HEIGHT_M[terrain] && cutGrowthAt(map, p, above) && !visited.has(i)) spark(p, 'leaf');
      if (visited.has(i) || startTile) { if (f === contactFraction) return finishContact(); continue; }
      visited.add(i);
      const woody = terrain === 'woods' || terrain === 'scatteredtrees' || (terrain === 'hedge' && above < 2);
      if (!woody) { if (f === contactFraction) return finishContact(); continue; }
      // A shell clips the screen and bursts; small arms sometimes pass between branches.
      if (!shell && !rng.chance(terrain === 'woods' ? 0.65 : terrain === 'hedge' ? 0.55 : 0.35)) { if (f === contactFraction) return finishContact(); continue; }
      damageVegetation(map, x, y, shell ? 50 : 1);
      spark(p, 'wood');
      contacts++;
      if ((shell && weapon.heRadiusM > 0) || contacts >= 3 || (!shell && rng.chance(0.18))) return finish(p, true, z);
      if (!rng.chance(shell ? 0.12 : 0.5)) { if (f === contactFraction) return finishContact(); continue; }
      deflected = true;
      spark(p, 'ricochet');
      points.push({ ...p }); pointsZ.push(z);
      const angle = dm.atan2(end.y - start.y, end.x - start.x) + (rng.chance(0.5) ? 1 : -1) * rng.range(0.08, 0.35);
      const remaining = length * (1 - f) * 0.75;
      start = p; startZ = z;
      end = { x: p.x + dm.cos(angle) * remaining, y: p.y + dm.sin(angle) * remaining };
      endZ = heights.targetZ ?? (groundAtTile(map, Math.floor(end.x), Math.floor(end.y)) + (heights.targetM ?? 1.7));
      turned = true;
      break;
    }
    if (!turned) return finish(end, false);
  }
  return finish(start, true, startZ);
}

export function traceTracers(state: BattleState, shot: RoundTrace, kind: Tracer['kind'], hit = false): void {
  for (let i = 1; i < shot.points.length; i++) {
    state.tracers.push({ from: { ...shot.points[i - 1] }, to: { ...shot.points[i] }, t: 0,
      hit: hit && i === shot.points.length - 1, kind, deflected: i > 1 });
  }
}
