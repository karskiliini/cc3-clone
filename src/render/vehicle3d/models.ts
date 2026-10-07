// ============================================================================
// Loads public/models/vehicles.json and the battle's .glb files (three.js
// GLTFLoader, tools/blender/vehicles_lowpoly.py) into per-node meshes with a
// standard material (roughness 0.85, like the sprites' paint) on the baked texture; the sprite atlases cover the wait.
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

interface ManifestVariant { file: string; nodes: string[] }
interface ManifestEntry { hasTurret: boolean; turretPivotM: { x: number; y: number } | null; summer: ManifestVariant; winter: ManifestVariant | null }

function base(): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  return `${env?.BASE_URL ?? '/'}models/`;
}

const loaded = new Map<string, VehicleModel>();
const requested = new Set<string>();
let manifest: Promise<Record<string, ManifestEntry> | null> | null = null;

function getManifest(): Promise<Record<string, ManifestEntry> | null> {
  manifest ??= fetch(`${base()}vehicles.json`).then((r) => (r.ok ? r.json() : null)).then((j) => j?.vehicles ?? null).catch(() => null);
  return manifest;
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

/** Starts loading the models of these vehicle defs (idempotent); the winter set only for winter maps. */
export function loadVehicleModels(defIds: string[], season: Season): void {
  if (typeof fetch === 'undefined') return;
  for (const id of defIds) {
    const key = `${id}|${season}`;
    if (requested.has(key)) continue;
    requested.add(key);
    void getManifest().then(async (mf) => {
      const e = mf?.[id];
      if (!e) return;
      const nodes = loaded.get(id)?.nodes ?? await loadVariant(e.summer);
      const winterNodes = season === 'winter' && e.winter ? await loadVariant(e.winter) : loaded.get(id)?.winterNodes ?? null;
      loaded.set(id, { hasTurret: e.hasTurret, turretPivotM: e.turretPivotM, nodes, winterNodes });
    }).catch((err) => console.warn('[vehicle3d] model load failed', id, err));
  }
}

export const modelSource: ModelSource = { get: (id) => loaded.get(id) ?? null };
