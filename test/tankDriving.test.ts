import { expect, it } from 'vitest';
import { Battle } from '@/sim/battle';
import { DEFAULT_FORCES } from '@/data/operation';
import { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { isPassable } from '@/sim/path';
// Tanks alone on real maps drive a series of long move orders: they must arrive, and spend little
// of the drive standing (a tile-by-tile route used to make them pivot on the spot for points
// they had just passed, and get stuck on each other).
it('tanks drive long routes on real maps without stopping for waypoints they have passed', () => {
  let totT = 0, totStop = 0, arrived = 0, legs = 0;
  for (const [mapId, yr] of [['steppe_1943', 1943], ['village_1942', 1942]] as [string, number][]) {
    const b = new Battle({ mapId, playerSide: 'german', year: yr, seed: 3, durationS: 3600, difficulty: 'normal', forces: DEFAULT_FORCES[yr] ?? DEFAULT_FORCES[1941] });
    b.start();
    const st = b.state;
    // only one side's tanks, nobody else: pure driving
    const tanks = [...st.teams.values()].filter((t) => t.side === 'german' && t.vehicleId != null && st.vehicles.get(t.vehicleId)!.defId !== 'sdkfz251');
    for (const t of [...st.teams.values()]) if (!tanks.includes(t)) { for (const id of t.soldierIds) st.soldiers.delete(id); if (t.vehicleId != null) st.vehicles.delete(t.vehicleId); st.teams.delete(t.id); }
    const rng = new Rng(9);
    for (let leg = 0; leg < 2; leg++) {
      const goals = new Map<number, { x: number; y: number }>();
      for (const t of tanks) {
        const v = st.vehicles.get(t.vehicleId!)!;
        let g; for (let k = 0; k < 200; k++) { g = { x: 5 + rng.next() * (st.map.width - 10), y: 5 + rng.next() * (st.map.height - 10) }; if (isPassable(st.map, Math.floor(g.x), Math.floor(g.y), 'vehicle') && dist(g, v.pos) > 30 && dist(g, v.pos) < 70) break; }
        goals.set(t.id, g!);
        b.issueOrder(t.id, { type: 'move', target: g!, issuedAt: st.time });
      }
      const done = new Set<number>();
      for (let i = 0; i < 20 * 150 && done.size < tanks.length; i++) {
        b.step(0.05);
        for (const t of tanks) {
          if (done.has(t.id)) continue;
          const v = st.vehicles.get(t.vehicleId!)!;
          totT += 0.05;
          if (Math.abs(v.speed) < 0.05) totStop += 0.05;
          if (v.path.length === 0) { done.add(t.id); if (dist(v.pos, goals.get(t.id)!) < 3) arrived++; }
        }
      }
      legs += tanks.length;
    }
  }
  expect(arrived).toBe(legs);
  expect(totStop / totT).toBeLessThan(0.25);
}, 600000);
