// ============================================================================
// One pooled instance per vehicle id: a hull group and a turret pivot group
// holding clones (shared geometry and material) of the model's node meshes,
// shown or hidden per frame by modelNodes; the same structure again under the
// shadow root with a flat black material. Pure scene graph: tested in Node.
// ============================================================================
import { DirectionalLight, Group, HemisphereLight, Matrix4, Mesh, MeshBasicMaterial, Scene } from 'three';
import type { ModelSource, VehicleModel } from './models';
import { modelNodes, vehiclePose, type VehicleLook } from './look';
import { shadowMatrix, SUN_TO } from './projection';

/** Tuned against the sprites (tools/vehicle3dPreview: mean brightness of the lit hull). */
export const SUN_INTENSITY = 2.6;
export const FILL_SKY = 0xcfd8e0, FILL_GROUND = 0x6b6455, FILL_INTENSITY = 1.1;

const SHADOW_MAT = new MeshBasicMaterial({ color: 0x000000 });

interface Part { group: Group; meshes: Map<string, Mesh>; shadowGroup: Group; shadowMeshes: Map<string, Mesh> }
interface Instance { model: VehicleModel; hull: Part; turret: Part; used: boolean }

export class VehicleScene {
  readonly scene = new Scene();
  readonly shadowScene = new Scene();
  private readonly shadowRoot = new Group();
  private readonly inst = new Map<number, Instance>();

  constructor(private readonly models: ModelSource) {
    const sun = new DirectionalLight(0xfff5e0, SUN_INTENSITY);
    sun.position.set(SUN_TO[0] * 100, SUN_TO[1] * 100, SUN_TO[2] * 100);
    this.scene.add(sun, sun.target, new HemisphereLight(FILL_SKY, FILL_GROUND, FILL_INTENSITY));
    this.shadowRoot.matrixAutoUpdate = false;
    this.shadowRoot.matrix = new Matrix4().fromArray(shadowMatrix());
    this.shadowScene.add(this.shadowRoot);
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
    this.show(it.hull, model, names.hull, names.winterHull, null);
    it.hull.group.position.fromArray(pose.hullPos);
    it.hull.group.rotation.set(0, pose.hullYaw, 0);
    if (names.turret && pose.turretPivot && model.turretPivotM) {
      this.show(it.turret, model, names.turret, names.winterTurret, model.turretPivotM);
      it.turret.group.position.fromArray(pose.turretPivot);
      it.turret.group.rotation.set(0, pose.turretYaw, 0);
    } else this.show(it.turret, model, null, false, null);
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

  visibleCount(): number { let n = 0; for (const i of this.inst.values()) if (i.used) n++; return n; }

  private part(): Part {
    const p: Part = { group: new Group(), meshes: new Map(), shadowGroup: new Group(), shadowMeshes: new Map() };
    this.scene.add(p.group);
    this.shadowRoot.add(p.shadowGroup);
    return p;
  }

  /** Shows one node (winter variant if asked and present) in the part, hides the rest. pivot: the
   * node's meshes are in the hull frame, so they sit at -pivot inside the pivot group (three's
   * (x, z) = Blender (x, -y)). */
  private show(p: Part, model: VehicleModel, name: string | null, winter: boolean, pivot: { x: number; y: number } | null): void {
    const useWinter = winter && !!model.winterNodes?.has(name ?? '');
    const key = name ? `${useWinter ? 'w:' : ''}${name}` : null;
    if (name && key && !p.meshes.has(key)) {
      const srcMesh = (useWinter ? model.winterNodes!.get(name) : model.nodes.get(name))!;
      const m = srcMesh.clone();
      const s = new Mesh(srcMesh.geometry, SHADOW_MAT);
      s.name = m.name;
      if (pivot) { m.position.set(-pivot.x, 0, pivot.y); s.position.copy(m.position); }
      p.meshes.set(key, m); p.group.add(m);
      p.shadowMeshes.set(key, s); p.shadowGroup.add(s);
    }
    for (const [k, m] of p.meshes) m.visible = k === key;
    for (const [k, s] of p.shadowMeshes) s.visible = k === key;
  }

  private dispose(it: Instance): void {
    for (const p of [it.hull, it.turret]) { p.group.removeFromParent(); p.shadowGroup.removeFromParent(); }
  }
}
