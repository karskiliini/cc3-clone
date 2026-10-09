// ============================================================================
// Loads public/models/vehicles.json and the battle's .glb files (three.js
// GLTFLoader, tools/blender/vehicles_lowpoly.py) into per-node meshes with a
// matte material on the baked texture; the sprite atlases cover the wait.
// Each battle keeps only its own vehicles on the GPU: the previous battle's
// models are disposed when the next one asks for its set.
// ============================================================================
import { Mesh, MeshLambertMaterial, SRGBColorSpace, type Texture } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Season } from '@/shared/types';

export interface VehicleModel {
  hasTurret: boolean;
  /** hull-local metres (x right, y forward) the turret turns about */
  turretPivotM: { x: number; y: number } | null;
  nodes: Map<string, Mesh>;
  /** whitewashed live looks; null when the vehicle fought unwashed or the map is not winter */
  winterNodes: Map<string, Mesh> | null;
}
export interface ModelSource { get(defId: string): VehicleModel | null }

export interface ManifestVariant { file: string; nodes: string[] }
export interface ManifestEntry { hasTurret: boolean; turretPivotM: { x: number; y: number } | null; summer: ManifestVariant; winter: ManifestVariant | null }
export type Manifest = Record<string, ManifestEntry>;

type Variant = Map<string, Mesh> | 'pending' | 'failed' | 'none';
interface Entry { info: ManifestEntry | null; requested: boolean; summer: Variant; winter: Variant | null; model: VehicleModel | null }

function disposeNodes(v: Variant | null): void {
  if (!(v instanceof Map)) return;
  for (const m of v.values()) {
    const mat = m.material as MeshLambertMaterial;
    mat.map?.dispose(); mat.dispose(); m.geometry.dispose();
  }
}

/** The battle's vehicle models. `load` names the battle's vehicle set and season: models outside it
 * are disposed (GPU memory is held per battle, not per session), files load once each, and `get`
 * serves a model only when it can be drawn right: in winter only with its whitewash loaded (or
 * known not to exist), so a 3D tank never shows paint the sprite would not. */
export class ModelCache implements ModelSource {
  private manifest: Promise<Manifest | null> | null = null;
  private readonly entries = new Map<string, Entry>();
  private season: Season = 'summer';

  constructor(
    private readonly fetchManifest: () => Promise<Manifest | null>,
    private readonly loadVariant: (v: ManifestVariant) => Promise<Map<string, Mesh>>,
  ) {}

  load(defIds: readonly string[], season: Season): void {
    this.season = season;
    const want = new Set(defIds);
    for (const [id, e] of this.entries) {
      if (!want.has(id)) { disposeNodes(e.summer); disposeNodes(e.winter); this.entries.delete(id); continue; }
      if (season !== 'winter' && e.winter instanceof Map) { disposeNodes(e.winter); e.winter = null; e.model = null; }
    }
    this.manifest ??= this.fetchManifest().catch(() => null);
    for (const id of want) {
      let e = this.entries.get(id);
      if (!e) { e = { info: null, requested: false, summer: 'pending', winter: null, model: null }; this.entries.set(id, e); }
      const entry = e;
      const wantWinter = season === 'winter' && entry.winter === null;
      if (wantWinter) entry.winter = 'pending';
      const firstSummer = !entry.requested;
      entry.requested = true;
      if (!firstSummer && !wantWinter) continue;
      void this.manifest.then((mf) => {
        const info = mf?.[id];
        if (!info) { entry.summer = 'failed'; return; }
        entry.info = info;
        if (firstSummer) this.fetchVariant(id, entry, 'summer', info.summer);
        if (wantWinter) {
          if (info.winter) this.fetchVariant(id, entry, 'winter', info.winter);
          else { entry.winter = 'none'; entry.model = null; }
        }
      });
    }
  }

  get(defId: string): VehicleModel | null {
    const e = this.entries.get(defId);
    if (!e?.info || !(e.summer instanceof Map)) return null;
    let winterNodes: Map<string, Mesh> | null = null;
    if (this.season === 'winter') {
      if (e.winter instanceof Map) winterNodes = e.winter;
      else if (e.winter !== 'none') return null;          // pending / failed: the sprite shows the whitewash
    }
    if (!e.model || e.model.winterNodes !== winterNodes) {
      e.model = { hasTurret: e.info.hasTurret, turretPivotM: e.info.turretPivotM, nodes: e.summer, winterNodes };
    }
    return e.model;
  }

  private fetchVariant(id: string, entry: Entry, which: 'summer' | 'winter', v: ManifestVariant): void {
    this.loadVariant(v).then((nodes) => {
      if (this.entries.get(id) !== entry || entry[which] !== 'pending') { disposeNodes(nodes); return; }   // battle moved on
      entry[which] = nodes; entry.model = null;
    }).catch((err) => {
      console.warn('[vehicle3d] model load failed', v.file, err);
      if (this.entries.get(id) === entry) entry[which] = 'failed';
    });
  }
}

function base(): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  return `${env?.BASE_URL ?? '/'}models/`;
}

/** Paint and soot are matte: no specular at all (user, 2026-10-07: "still too glossy, way too
 * glossy"). The baked texture carries the sprites' edge and cavity shading; the lights do the rest. */
export function nodeMaterial(name: string, map: Texture | null): MeshLambertMaterial {
  const m = new MeshLambertMaterial({ map });
  if (/_(ko|blown)$/.test(name)) m.color.setScalar(BURNT_GAIN);
  return m;
}

/** Burnt looks bake darker than the sprites show them once matte (0.63x in tools/vehicle3dPreview);
 * 1.4 lands them at ~0.98x (1.6 read lighter and browner than the sprite wrecks in battle). */
export const BURNT_GAIN = 1.4;

async function loadVariant(v: ManifestVariant): Promise<Map<string, Mesh>> {
  const gltf = await new GLTFLoader().loadAsync(`${base()}${v.file}`);
  const out = new Map<string, Mesh>();
  for (const name of v.nodes) {
    const m = gltf.scene.getObjectByName(name) as Mesh | undefined;
    if (!m?.isMesh) throw new Error(`${v.file}: node ${name} missing`);
    const map = (m.material as { map?: Texture | null }).map ?? null;
    if (map) map.colorSpace = SRGBColorSpace;
    m.material = nodeMaterial(name, map);
    m.removeFromParent();
    m.position.set(0, 0, 0); m.rotation.set(0, 0, 0); m.scale.set(1, 1, 1);
    out.set(name, m);
  }
  return out;
}

/** The game's cache: public/models over fetch + GLTFLoader. */
export const modelSource = new ModelCache(
  () => fetch(`${base()}vehicles.json`).then((r) => (r.ok ? r.json() : null)).then((j) => j?.vehicles ?? null),
  loadVariant,
);

/** A battle's vehicle set and season (see ModelCache.load); no-op without fetch (Node). */
export function loadVehicleModels(defIds: string[], season: Season): void {
  if (typeof fetch === 'undefined') return;
  modelSource.load(defIds, season);
}
