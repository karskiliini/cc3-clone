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
