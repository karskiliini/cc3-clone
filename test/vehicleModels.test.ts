import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { VEHICLE_DEFS } from '@/data/units';

const DIR = path.resolve(__dirname, '../public/models');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'vehicles.json'), 'utf8'));
const BUDGET: Record<string, number> = { hull: 2400, turret: 1200 };

function glbJson(file: string): any {
  const buf = fs.readFileSync(path.join(DIR, file));
  expect(buf.readUInt32LE(0)).toBe(0x46546c67);          // 'glTF'
  expect(buf.readUInt32LE(4)).toBe(2);
  expect(buf.readUInt32LE(16)).toBe(0x4e4f534a);         // 'JSON'
  return JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
}
function nodeTris(g: any, nodeName: string): number {
  const node = g.nodes.find((n: any) => n.name === nodeName);
  expect(node, nodeName).toBeTruthy();
  return g.meshes[node.mesh].primitives.reduce((t: number, p: any) => t + g.accessors[p.indices].count / 3, 0);
}

describe('vehicle models', () => {
  it('every vehicle def has a model entry', () => {
    for (const id of Object.keys(VEHICLE_DEFS)) expect(manifest.vehicles[id], id).toBeTruthy();
  });
  for (const [id, m] of Object.entries<any>(manifest.vehicles)) {
    it(`${id}: nodes, budgets, size, pivot`, () => {
      expect(m.hasTurret).toBe(VEHICLE_DEFS[id].hasTurret);
      expect(m.summer.nodes).toEqual(expect.arrayContaining(['hull_ok', 'hull_ko']));
      if (m.hasTurret) {
        expect(m.summer.nodes).toEqual(expect.arrayContaining(['hull_blown', 'turret_ok', 'turret_ko', 'turret_blown']));
        expect(m.turretPivotM).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
      } else expect(m.turretPivotM).toBeNull();
      for (const variant of [m.summer, m.winter].filter(Boolean)) {
        expect(fs.statSync(path.join(DIR, variant.file)).size).toBeLessThanOrEqual(1.5 * 1024 * 1024);
        const g = glbJson(variant.file);
        for (const n of variant.nodes) expect(nodeTris(g, n)).toBeLessThanOrEqual(BUDGET[n.split('_')[0]]);
      }
      if (m.winter) expect(m.winter.nodes).toContain('hull_ok');
    });
  }
});
