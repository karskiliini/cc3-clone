import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshLambertMaterial, SphereGeometry, type BufferGeometry } from 'three';
import type { LightTransportVisuals } from './look';

/** Hull children use the exact model-origin transform, including suspension pitch and roll. */
export class LightTransportScene {
  readonly group = new Group();
  private readonly people = new Map<number, { group: Group; arms: Group[] }>();
  private cargo: Group | null = null;
  private owned: Mesh[] = [];
  private mesh(parent: Group, geometry: BufferGeometry, color: number, x: number, y: number, z: number): Mesh {
    const m = new Mesh(geometry, new MeshLambertMaterial({ color })); m.position.set(x, z, y);
    m.castShadow = true; m.receiveShadow = true; parent.add(m); this.owned.push(m); return m;
  }
  private person(side: string): { group: Group; arms: Group[] } {
    const group = new Group(), arms: Group[] = [];
    const uniform = side === 'german' ? 0x62695c : 0x7a7651, dark = 0x343a30;
    const box = (w: number, l: number, h: number, x: number, y: number, z: number, c = uniform) => this.mesh(group, new BoxGeometry(w, h, l), c, x, y, z);
    // Seat datum is the hip. Bent thighs and shins show a seated silhouette, no standing feet.
    box(0.35, 0.22, 0.43, 0, 0, 0.24);
    for (const x of [-0.1, 0.1]) { box(0.13, 0.34, 0.13, x, -0.13, 0.02); box(0.12, 0.12, 0.31, x, -0.27, -0.15); box(0.14, 0.23, 0.1, x, -0.32, -0.31, dark); }
    this.mesh(group, new SphereGeometry(0.115, 8, 6), 0xa18b6a, 0, 0, 0.56);
    this.mesh(group, new SphereGeometry(0.14, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), uniform, 0, 0, 0.61);
    for (const x of [-0.22, 0.22]) {
      const arm = new Group(); arm.position.set(x, 0.38, 0); group.add(arm);
      const m = this.mesh(arm, new BoxGeometry(0.1, 0.12, 0.37), uniform, 0, -0.12, -0.1); m.rotation.x = -0.25;
      this.mesh(arm, new SphereGeometry(0.06, 6, 4), 0xa18b6a, 0, -0.28, -0.1); arms.push(arm);
    }
    return { group, arms };
  }
  update(visual: LightTransportVisuals | undefined): void {
    this.group.visible = !!visual;
    const shown = new Set<number>();
    for (const occupant of visual?.occupants ?? []) {
      shown.add(occupant.id);
      let person = this.people.get(occupant.id);
      if (!person) { person = this.person(occupant.side); person.group.name = `carrier_occupant_${occupant.id}`; this.people.set(occupant.id, person); this.group.add(person.group); }
      person.group.visible = true; person.group.rotation.y = -(occupant.facing ?? 0); person.group.position.set(occupant.seat.x, occupant.seat.z, occupant.seat.y);
      for (const [i, arm] of person.arms.entries()) arm.rotation.x = occupant.driver ? -0.25 + Math.sin((visual?.time ?? 0) * 2) * 0.035 * (i ? 1 : -1) : 0;
    }
    for (const [id, p] of this.people) p.group.visible = shown.has(id);
    if (visual?.cargo && !this.cargo) {
      const g = this.cargo = new Group(); g.name = 'carrier_mortar_cargo'; this.group.add(g);
      this.mesh(g, new BoxGeometry(0.45, 0.06, 0.44), 0x414a36, -0.17, 0, 0.03); // baseplate
      const tube = this.mesh(g, new CylinderGeometry(0.055, 0.065, 0.85, 10), 0x303a2c, 0, 0, 0.2); tube.rotation.x = Math.PI / 2;
      for (const x of [-0.3, 0.3]) this.mesh(g, new BoxGeometry(0.22, 0.24, 0.45), 0x726345, x, 0.2, 0.15); // ammunition panniers
      this.mesh(g, new BoxGeometry(0.12, 0.1, 0.7), 0x4b5138, 0.22, -0.05, 0.14); // folded bipod
    }
    if (this.cargo) { this.cargo.visible = !!visual?.cargo; if (visual?.cargo) this.cargo.position.set(visual.cargo.x, visual.cargo.z, visual.cargo.y); }
  }
  dispose(): void { this.group.removeFromParent(); for (const m of this.owned) { m.geometry.dispose(); (m.material as MeshLambertMaterial).dispose(); } this.owned = []; this.people.clear(); }
}
