import type { BattleState, Vec2, Vehicle, WeaponDef, Soldier } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { hash2, Rng } from '@/shared/rng';
import * as dm from '@/shared/dmath';

/** Cosmetic placement uses a local hash, never consumes combat randomness. Metres in part space. */
export function markVehicleStrike(v: Vehicle, from: Vec2 | null, turret: boolean, penetrated: boolean, sizeM: number): void {
  const def = VEHICLE_DEFS[v.defId]; if (!def) return;
  const marks = v.strikeMarks ??= [], n = v.strikeSerial ?? 0;
  v.strikeSerial = (n + 1) >>> 0;
  turret = turret && def.hasTurret;
  const facing = turret ? v.turretFacing : v.hullFacing, c = dm.cos(facing), s = dm.sin(facing);
  const dx = from ? from.x - v.pos.x : hash2(v.id, n, 31) - 0.5;
  const dy = from ? from.y - v.pos.y : hash2(v.id, n, 32) - 0.5;
  const right = dx * c + dy * s, forward = dx * s - dy * c;
  const w = def.widthM * (turret ? 0.26 : 0.42), l = def.lengthM * (turret ? 0.16 : 0.38);
  const j = (hash2(v.id, n, 33) - 0.5) * 1.2;
  const side = Math.abs(right / w) > Math.abs(forward / l);
  marks.push({ x: side ? Math.sign(right) * w * 0.9 : j * w,
    y: side ? j * l : Math.sign(forward) * l * 0.9, part: turret ? 'turret' : 'hull', sizeM, penetrated });
  if (marks.length > 64) marks.shift();
}

/** Fragments stop at the first solid surface. Outside the HE radius, exposed infantry may be
 * hit by one fragment; inside it blastExposure already accounts for fragmentation and cover. */
export function grenadeFragments(state: BattleState, pos: Vec2, weapon: WeaponDef, hit?: (s: Soldier, rng: Rng) => void): void {
  if (weapon.cls !== 'grenade' || weapon.heRadiusM <= 0 || weapon.penetrationMm > 0) return;
  const map = state.map, marks = map.fragmentMarks ??= [], flights = map.fragmentFlights ??= [];
  const vehicles = [...state.vehicles.values()].flatMap(v => {
    const def = VEHICLE_DEFS[v.defId];
    if (!def || Math.abs(v.pos.x - pos.x) >= 12 || Math.abs(v.pos.y - pos.y) >= 12) return [];
    return [{ v, c: dm.cos(v.hullFacing), s: dm.sin(v.hullFacing), halfW: def.widthM / 2, halfL: def.lengthM / 2 }];
  });
  const soldiers = [...state.soldiers.values()].filter(s => s.vehicleId == null && s.health !== 'dead' && s.health !== 'incapacitated'
    && dm.hypot(s.pos.x - pos.x, s.pos.y - pos.y) * TILE_M > weapon.heRadiusM
    && Math.abs(s.pos.x - pos.x) < 8 && Math.abs(s.pos.y - pos.y) < 8);
  const hitMen = new Set<number>();
  const seed = Math.floor(state.time * 1000) ^ Math.floor(pos.x * 97 + pos.y * 193);
  for (let ray = 0; ray < 40; ray++) {
    const angle = (ray + hash2(seed, ray, 6)) * Math.PI * 2 / 40;
    const dx = dm.cos(angle), dy = dm.sin(angle), reach = (5 + hash2(seed, ray, 7) * 11) / TILE_M;
    let end = { ...pos }, material: 'dust' | 'wood' | 'stone' | 'brick' = 'dust', glass = false;
    for (let d = 0.15; d <= reach; d += 0.15) {
      const p = { x: pos.x + dx * d, y: pos.y + dy * d }, x = Math.floor(p.x), y = Math.floor(p.y);
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) break;
      end = p;
      let hull = false;
      for (const { v, c, s, halfW, halfL } of vehicles) {
        const ex = (p.x - v.pos.x) * TILE_M, ey = (p.y - v.pos.y) * TILE_M;
        if (Math.abs(ex * c + ey * s) < halfW && Math.abs(ex * s - ey * c) < halfL) {
          markVehicleStrike(v, pos, false, false, 0.07); hull = true; break;
        }
      }
      if (hull) { state.sparks.push({ pos: end, t: state.time, kind: 'armor' }); break; }
      const i = y * map.width + x, t = map.tiles[i];
      const wood = t === 'woods' || t === 'scatteredtrees' || t === 'buildingWood' || t === 'fence';
      const stone = t === 'buildingStone' || t === 'stonewall';
      if (wood || stone) {
        material = wood ? 'wood' : t === 'buildingStone' ? 'brick' : 'stone';
        glass = map.windows[i] === 1;
        if (glass) {
          const broken = map.shatteredWindows ??= new Set<number>();
          if (!broken.has(i)) { broken.add(i); (map.dirtyTiles ??= []).push(i); }
        }
        state.sparks.push({ pos: end, t: state.time, kind: material }); break;
      }
      let intercepted = false;
      for (const man of soldiers) {
        if (hitMen.has(man.id) || dm.hypot(man.pos.x - p.x, man.pos.y - p.y) > 0.22) continue;
        hitMen.add(man.id);
        const exposure = man.stance === 'prone' ? 0.12 : man.stance === 'crouching' ? 0.35 : 0.65;
        if (hash2(seed, man.id, ray + 17) < exposure) {
          hit?.(man, new Rng(seed ^ man.id ^ ray)); intercepted = true;
        }
        break;
      }
      if (intercepted) break;
    }
    marks.push({ pos: end, angle, material, ...(glass ? { glass: true } : {}) });
    flights.push({ from: { ...pos }, to: end, at: state.time });
  }
  if (marks.length > 1200) marks.splice(0, marks.length - 1200);
  map.fragmentFlights = flights.filter(f => state.time - f.at < 0.3).slice(-160);
  if (state.sparks.length > 64) state.sparks.splice(0, state.sparks.length - 64);
}
