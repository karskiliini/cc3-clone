import { describe, it, expect, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshLambertMaterial, Texture } from 'three';
import { ModelCache, type Manifest } from '@/render/vehicle3d/models';

const MANIFEST: Manifest = {
  t34_76: { hasTurret: true, turretPivotM: { x: 0, y: 0.62 }, summer: { file: 't34_76.glb', nodes: ['hull_ok', 'turret_ok'] }, winter: { file: 't34_76_winter.glb', nodes: ['hull_ok', 'turret_ok'] } },
  pz3j: { hasTurret: true, turretPivotM: { x: 0, y: 0 }, summer: { file: 'pz3j.glb', nodes: ['hull_ok', 'turret_ok'] }, winter: null },
};
function nodes(names: string[]): Map<string, Mesh> {
  return new Map(names.map((n) => [n, new Mesh(new BoxGeometry(), new MeshLambertMaterial({ map: new Texture() }))] as const));
}
/** A loader whose files resolve when the test says so. */
function harness() {
  const pending = new Map<string, () => void>();
  const loads: string[] = [];
  const loader = vi.fn((v: { file: string; nodes: string[] }) => {
    loads.push(v.file);
    return new Promise<Map<string, Mesh>>((res) => pending.set(v.file, () => res(nodes(v.nodes))));
  });
  const cache = new ModelCache(async () => MANIFEST, loader);
  const finish = async (file: string): Promise<void> => { pending.get(file)!(); await new Promise((r) => setTimeout(r, 0)); };
  return { cache, loads, finish, settle: () => new Promise((r) => setTimeout(r, 0)) };
}

describe('ModelCache', () => {
  it('summer battle: a model is served once its file has loaded', async () => {
    const h = harness();
    h.cache.load(['t34_76'], 'summer');
    await h.settle();
    expect(h.cache.get('t34_76')).toBeNull();
    await h.finish('t34_76.glb');
    expect(h.cache.get('t34_76')?.winterNodes).toBeNull();
    expect(h.loads).toEqual(['t34_76.glb']);
  });

  it('forwards production articulation metadata with the loaded model', async () => {
    const metadata = { modelOriginM: { x: 0, y: 0, z: 0 }, turretPivot3M: { x: 0, y: -0.62, z: 0 },
      gunTrunnionM: { x: 0, y: -1, z: 2 }, wheels: [{ index: 0, side: 'L' as const, centreM: { x: -1, y: 0, z: 0.4 }, radiusM: 0.4 }] };
    const cache = new ModelCache(async () => ({ t34_76: { ...MANIFEST.t34_76, ...metadata } }), async variant => nodes(variant.nodes));
    cache.load(['t34_76'], 'summer');
    await new Promise(resolve => setTimeout(resolve, 0));
    const model = cache.get('t34_76')!;
    expect({ modelOriginM: model.modelOriginM, turretPivot3M: model.turretPivot3M, gunTrunnionM: model.gunTrunnionM, wheels: model.wheels }).toEqual(metadata);
  });

  it('winter battle: no model until the whitewash is in, so 3D never shows unwashed paint', async () => {
    const h = harness();
    h.cache.load(['t34_76'], 'summer');
    await h.settle(); await h.finish('t34_76.glb');
    h.cache.load(['t34_76'], 'winter');                // next battle is in winter
    await h.settle();
    expect(h.cache.get('t34_76')).toBeNull();
    await h.finish('t34_76_winter.glb');
    expect(h.cache.get('t34_76')?.winterNodes?.has('hull_ok')).toBe(true);
    expect(h.loads.filter((f) => f === 't34_76.glb')).toHaveLength(1);   // the summer file is not loaded again
  });

  it('winter battle: an unwashed vehicle (no winter variant) is served with summer paint', async () => {
    const h = harness();
    h.cache.load(['pz3j'], 'winter');
    await h.settle(); await h.finish('pz3j.glb');
    expect(h.cache.get('pz3j')?.winterNodes).toBeNull();
  });

  it('a second request while a file is in flight does not load it twice', async () => {
    const h = harness();
    h.cache.load(['t34_76'], 'summer');
    h.cache.load(['t34_76'], 'summer');
    await h.settle();
    expect(h.loads).toEqual(['t34_76.glb']);
  });

  it('a new battle releases the GPU resources of vehicles it does not use', async () => {
    const h = harness();
    h.cache.load(['t34_76', 'pz3j'], 'summer');
    await h.settle(); await h.finish('t34_76.glb'); await h.finish('pz3j.glb');
    const m = h.cache.get('pz3j')!.nodes.get('hull_ok')!;
    const geo = vi.spyOn(m.geometry, 'dispose'), mat = vi.spyOn(m.material as MeshLambertMaterial, 'dispose');
    const tex = vi.spyOn((m.material as MeshLambertMaterial).map!, 'dispose');
    h.cache.load(['t34_76'], 'summer');
    expect(geo).toHaveBeenCalled(); expect(mat).toHaveBeenCalled(); expect(tex).toHaveBeenCalled();
    expect(h.cache.get('pz3j')).toBeNull();
    expect(h.cache.get('t34_76')).not.toBeNull();
  });

  it('a vehicle with no manifest entry is never served (sprite fallback)', async () => {
    const h = harness();
    h.cache.load(['kv1'], 'summer');
    await h.settle();
    expect(h.cache.get('kv1')).toBeNull();
    expect(h.loads).toEqual([]);
  });
});

import { readFileSync } from 'node:fs';
import { VEHICLE_GUN_GEOMETRY } from '@/data/vehicleGunGeometry';
import { VEHICLE_ARMOR_GEOMETRY } from '@/data/vehicleArmorGeometry';
import type { ManifestEntry } from '@/render/vehicle3d/models';

it('production catalog exports origin, shared ring/trunnion/proxy frames and independently centred wheels', () => {
  const manifest = JSON.parse(readFileSync('public/models/vehicles.json', 'utf8')).vehicles as Record<string, ManifestEntry & { armorProxy: unknown; geometryFingerprints: { gun: string; armor: string } }>;
  expect(Object.keys(manifest)).toHaveLength(36);
  for (const [id, entry] of Object.entries(manifest)) {
    expect(entry.modelOriginM, id).toEqual({ x: 0, y: 0, z: 0 });
    const gun = VEHICLE_GUN_GEOMETRY[id], armor = VEHICLE_ARMOR_GEOMETRY[id];
    expect(entry.gunTrunnionM, id).toEqual(gun?.pivot ?? null);
    if (entry.hasTurret) expect(entry.turretPivot3M, id).toEqual(gun.ring);
    else expect(entry.turretPivot3M, id).toBeNull();
    expect(entry.armorProxy, id).toEqual(armor ? { min: armor.min, max: armor.max } : null);
    expect(entry.geometryFingerprints.gun, id).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.geometryFingerprints.armor, id).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.wheels!.length, id).toBeGreaterThan(0);
    for (const wheel of entry.wheels!) { expect(wheel.radiusM, id).toBeGreaterThan(0); expect(wheel.centreM.z, id).toBeGreaterThan(0); }
    for (const variant of [entry.summer, entry.winter].filter(v => v !== null)) {
      const bytes = readFileSync(`public/models/${variant.file}`);
      expect(bytes.readUInt32LE(0), variant.file).toBe(0x46546c67);
      const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
      const nodes = gltf.nodes.filter((node: { mesh?: number }) => node.mesh != null) as { name: string; mesh: number; translation?: number[] }[];
      expect(nodes.map(node => node.name).sort(), variant.file).toEqual([...variant.nodes].sort());
      for (const chassis of variant.nodes.filter(name => name.startsWith('hull_'))) {
        const state = chassis.slice(5);
        for (const wheel of entry.wheels!) expect(variant.nodes, `${variant.file}:${state}`).toContain(`wheels_${wheel.side}_${wheel.index}_${state}`);
        if (gun && !entry.hasTurret) expect(variant.nodes, variant.file).toContain(`gun_${state}`);
      }
      for (const turret of variant.nodes.filter(name => name.startsWith('turret_'))) if (gun) expect(variant.nodes, variant.file).toContain(`gun_${turret.slice(7)}`);
      for (const side of ['L', 'R']) for (const chassis of variant.nodes.filter(name => name.startsWith('hull_'))) {
        const suffix = `_${chassis.slice(5)}`;
        const bank = nodes.filter(node => node.name.startsWith(`wheels_${side}_`) && node.name.endsWith(suffix));
        const materials = bank.map(node => gltf.meshes[node.mesh].primitives[0].material);
        expect(new Set(materials).size, `${variant.file}:${side}${suffix}`).toBe(1);
        expect(variant.nodes, variant.file).not.toContain(`wheels_${side}${suffix}`);
      }
      for (const node of nodes) expect(node.translation ?? [0, 0, 0], `${variant.file}:${node.name}`).toEqual([0, 0, 0]);
    }
  }
});
