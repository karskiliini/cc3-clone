import { BufferGeometry, Mesh } from 'three';
/** A baked damage node also contains a decorative thrown run. Keep only triangles
 * shared with the intact hull; this retains its armor/paint and the unbroken side.
 * Position keys ignore independently unwrapped UV seams. Source models are static. */
function triangleKeys(g: BufferGeometry): string[] {
 const p=g.getAttribute('position'), index=g.index, n=index?.count??p.count, keys:string[]=[];
 for(let i=0;i<n;i+=3){const points:string[]=[];
  for(let j=0;j<3;j++){const k=index?index.getX(i+j):i+j;points.push([p.getX(k),p.getY(k),p.getZ(k)].map(v=>Math.round(v*100000)).join(','));}
  keys.push(points.sort().join(';'));
 }return keys;
}
export function withoutBrokenRuns(base: Mesh, brokenVariants: Mesh[], intact: Mesh = base): Mesh {
 const g=base.geometry, keys=triangleKeys(g), allowed=brokenVariants.map(m=>new Set(triangleKeys(m.geometry)));
 const removed=new Set(triangleKeys(intact.geometry).filter(key=>!allowed.every(set=>set.has(key))));
 const indices:number[]=[];
 keys.forEach((key,i)=>{if(!removed.has(key))for(let j=0;j<3;j++)indices.push(g.index?g.index.getX(i*3+j):i*3+j);});
 const geometry=g.clone();geometry.setIndex(indices);
 const mesh=base.clone();mesh.geometry=geometry;return mesh;
}
