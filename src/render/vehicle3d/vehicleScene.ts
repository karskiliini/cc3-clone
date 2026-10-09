// ============================================================================
// One pooled instance per vehicle id: a hull group and a turret pivot group
// holding clones (shared geometry and material) of the model's node meshes,
// shown or hidden per frame by modelNodes; the same structure again under the
// shadow root with a flat black material. Pure scene graph: tested in Node.
// ============================================================================
import { BackSide, DirectionalLight, DoubleSide, Group, HemisphereLight, Matrix4, Mesh, MeshBasicMaterial, Scene } from 'three';
import type { ModelSource, VehicleModel } from './models';
import { modelNodes, vehiclePose, type VehicleLook } from './look';
import { shadowMatrix, SUN_TO } from './projection';
import { GrassLayer } from './grassPatch';

/** Tuned against the sprites (tools/vehicle3dPreview: mean brightness of the lit hull). */
export const SUN_INTENSITY = 5.7;
export const FILL_SKY = 0xcfd8e0, FILL_GROUND = 0x6b6455, FILL_INTENSITY = 2.5;

// both faces: flattening onto the ground flips the winding of some triangles, and culling them
// left holes (a skirt plate cast a lone thin line)
const SHADOW_MAT = new MeshBasicMaterial({ color: 0x000000, side: DoubleSide });
/** Width (m) of the dark rim round every hull and turret: the sprites darken each part's silhouette
 * pixels (tools/blender OUTLINE 0.3), which is what makes a turret's outline read against its hull
 * (round T-26 turret vs the T-70's). */
export const OUTLINE_M = 0.07;
const RIM_MAT = new MeshBasicMaterial({ color: 0x000000, side: BackSide, transparent: true, opacity: 0.32, depthWrite: false });

/** self-shadow map: at zoom 1 the view's ~62 m half-diagonal gives ~3 cm per texel */
const SHADOW_MAP_PX = 4096;

interface Part { group: Group; meshes: Map<string, Mesh>; rims: Map<string, Mesh>; shadowGroup: Group; shadowMeshes: Map<string, Mesh> }
interface Instance { model: VehicleModel; hull: Part; turret: Part; used: boolean }

export class VehicleScene {
  readonly scene = new Scene();
  readonly shadowScene = new Scene();
  private readonly shadowRoot = new Group();
  private readonly inst = new Map<number, Instance>();
  /** casts the self-shadows (turret on deck, open compartments) the sprites have baked in */
  readonly sun = new DirectionalLight(0xfff5e0, SUN_INTENSITY);
  /** the 3D tall grass round the hulls standing in growth (grassField.bladesFor fills it each frame) */
  readonly grass = new GrassLayer();

  constructor(private readonly models: ModelSource) {
    const sun = this.sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP_PX, SHADOW_MAP_PX);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    this.fitSun(0, 0, 50);
    this.scene.add(sun, sun.target, new HemisphereLight(FILL_SKY, FILL_GROUND, FILL_INTENSITY));
    this.scene.add(this.grass.grass, this.grass.wheat);
    this.shadowRoot.matrixAutoUpdate = false;
    this.shadowRoot.matrix = new Matrix4().fromArray(shadowMatrix());
    this.shadowScene.add(this.shadowRoot);
  }

  /** Aims the sun's orthographic shadow camera at the view centre (world metres) so it covers a
   * circle of radiusM: the view's half-diagonal plus margin. */
  fitSun(centerX: number, centerZ: number, radiusM: number): void {
    this.sun.target.position.set(centerX, 0, centerZ);
    this.sun.position.set(centerX + SUN_TO[0] * 100, SUN_TO[1] * 100, centerZ + SUN_TO[2] * 100);
    const c = this.sun.shadow.camera;
    c.left = -radiusM; c.right = radiusM; c.top = radiusM; c.bottom = -radiusM;
    c.near = 1; c.far = 220;
    c.updateProjectionMatrix();
    this.sun.target.updateMatrixWorld();
  }

  begin(): void { for (const i of this.inst.values()) i.used = false; }

  /** Poses one vehicle for this frame; false = no model yet (the caller draws the sprite). */
  add(look: VehicleLook): boolean {
    const model = this.models.get(look.defId);
    if (!model) return false;
    let it = this.inst.get(look.id);
    if (!it || it.model !== model) {
      if (it) this.dispose(it);
      it = { model, hull: this.part(), turret: this.part(), used: false };
      this.inst.set(look.id, it);
    }
    const names = modelNodes(look, new Set(model.nodes.keys()), model.winterNodes !== null);
    const pose = vehiclePose(look, model.hasTurret, model.turretPivotM);
    this.show(it.hull, model, names.hull, names.winterHull);
    it.hull.group.position.fromArray(pose.hullPos);
    it.hull.group.rotation.set(0, pose.hullYaw, 0);
    if (names.turret && pose.turretPivot && model.turretPivotM) {
      this.show(it.turret, model, names.turret, names.winterTurret);
      it.turret.group.position.fromArray(pose.turretPivot);
      it.turret.group.rotation.set(0, pose.turretYaw, 0);
    } else this.show(it.turret, model, null, false);
    for (const p of [it.hull, it.turret]) {
      p.shadowGroup.position.copy(p.group.position);
      p.shadowGroup.rotation.copy(p.group.rotation);
    }
    it.used = true;
    return true;
  }

  end(): void {
    for (const it of this.inst.values()) {
      for (const p of [it.hull, it.turret]) { p.group.visible = it.used; p.shadowGroup.visible = it.used; }
    }
  }

  /** Drops every pooled instance: a new battle (vehicle ids restart at 1, other vehicle types). The
   * meshes share the model cache's geometry and materials, which the cache disposes. */
  reset(): void {
    for (const it of this.inst.values()) this.dispose(it);
    this.inst.clear();
    this.grass.clear();
  }

  visibleCount(): number { let n = 0; for (const i of this.inst.values()) if (i.used) n++; return n; }

  private part(): Part {
    const p: Part = { group: new Group(), meshes: new Map(), rims: new Map(), shadowGroup: new Group(), shadowMeshes: new Map() };
    this.scene.add(p.group);
    this.shadowRoot.add(p.shadowGroup);
    return p;
  }

  /** Shows one node (winter variant if asked and present) in the part, hides the rest. Hull nodes
   * are built about the hull centre and turret nodes about their ring centre, so both sit at the
   * origin of their group. */
  private show(p: Part, model: VehicleModel, name: string | null, winter: boolean): void {
    const useWinter = winter && !!model.winterNodes?.has(name ?? '');
    const key = name ? `${useWinter ? 'w:' : ''}${name}` : null;
    if (name && key && !p.meshes.has(key)) {
      const srcMesh = (useWinter ? model.winterNodes!.get(name) : model.nodes.get(name))!;
      const m = srcMesh.clone();
      m.castShadow = true; m.receiveShadow = true;
      const s = new Mesh(srcMesh.geometry, SHADOW_MAT);
      s.name = m.name;
      p.meshes.set(key, m); p.group.add(m);
      const rim = rimFor(srcMesh);
      p.rims.set(key, rim); p.group.add(rim);
      p.shadowMeshes.set(key, s); p.shadowGroup.add(s);
    }
    for (const [k, m] of p.meshes) m.visible = k === key;
    for (const [k, r] of p.rims) r.visible = k === key;
    for (const [k, s] of p.shadowMeshes) s.visible = k === key;
  }

  private dispose(it: Instance): void {
    for (const p of [it.hull, it.turret]) { p.group.removeFromParent(); p.shadowGroup.removeFromParent(); }
  }
}

/** A back-face copy grown OUTLINE_M on every side about the mesh's box centre: drawn behind the
 * body, only its fringe shows, as a thin translucent dark rim. */
function rimFor(src: Mesh): Mesh {
  const g = src.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  const bb = g.boundingBox!;
  const rim = new Mesh(g, RIM_MAT);
  rim.name = `${src.name}_rim`;
  const axes = ['x', 'y', 'z'] as const;
  for (const a of axes) {
    const size = Math.max(bb.max[a] - bb.min[a], 1e-3), c = (bb.max[a] + bb.min[a]) / 2;
    const k = 1 + (2 * OUTLINE_M) / size;
    rim.scale[a] = k;
    rim.position[a] = c * (1 - k);
  }
  rim.renderOrder = 1;
  return rim;
}
