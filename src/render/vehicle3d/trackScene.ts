import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import type { VehicleLook } from './look';

/** World-space shoes: an open run remains on the ground when its hull moves away. */
export class TrackScene {
 readonly group = new Group();
 private readonly geometry = new BoxGeometry(1, 1, 1);
 private readonly material = new MeshStandardMaterial({ color: 0x393932, roughness: .95 });
 private readonly pools = new Map<number, { group: Group; shoes: Mesh[]; used: boolean }>();
 begin(): void { for (const p of this.pools.values()) p.used = false; }
 add(look: VehicleLook): void {
  if (!look.trackChains?.length) return;
  let p = this.pools.get(look.id);
  if (!p) { p = { group: new Group(), shoes: [], used: false }; this.pools.set(look.id, p); this.group.add(p.group); }
  p.used = true; let n = 0;
  for (const c of look.trackChains) for (let i = 0; i < c.points.length - 1; i++) {
   if (c.tears.includes(i)) continue;
   const a = c.points[i], b = c.points[i + 1];
   let shoe = p.shoes[n++];
   if (!shoe) { shoe = new Mesh(this.geometry, this.material); shoe.castShadow = shoe.receiveShadow = true; p.shoes.push(shoe); p.group.add(shoe); }
   const d = new Vector3(b.x-a.x, b.z-a.z, b.y-a.y), length = d.length();
   shoe.position.set((a.x+b.x)/2, (a.z+b.z)/2, (a.y+b.y)/2);
   shoe.scale.set(.35, .08, Math.max(.02, length*.94));
   if (length > 0) shoe.quaternion.setFromUnitVectors(new Vector3(0,0,1), d.divideScalar(length));
   shoe.visible = true;
  }
  for (let i=n; i<p.shoes.length; i++) p.shoes[i].visible=false;
 }
 end(): void { for (const p of this.pools.values()) p.group.visible=p.used; }
 reset(): void { for (const p of this.pools.values()) p.group.removeFromParent(); this.pools.clear(); }
}
