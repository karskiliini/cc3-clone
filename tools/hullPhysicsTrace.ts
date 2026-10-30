import { writeFileSync } from 'node:fs';
import { hashState } from '@/sim/stateHash';
import { makePhysicsScene, type PhysicsScene } from './hullPhysicsScenarios';
const data = new DataView(new ArrayBuffer(8));
const bits = (v: number) => { data.setFloat64(0, v); return data.getBigUint64(0).toString(16).padStart(16, '0'); };
function exact(v: unknown): unknown {
  if (typeof v === 'number') return bits(v);
  if (Array.isArray(v)) return v.map(exact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, exact(x)]));
  return v;
}
const result = [];
for (const kind of ['flat-awake', 'flat-sleepers', 'log-crater'] as PhysicsScene[]) {
  const scene = makePhysicsScene(kind, 4, 180), frames = [];
  for (let i = 0; i < Number(process.argv[3] ?? 400); i++) { scene.step(); frames.push({ hash: hashState(scene),
    bodies: [...scene.state.vehicles.values()].map(v => exact(v.body)) }); }
  result.push({ kind, frames });
}
writeFileSync(process.argv[2], JSON.stringify(result));
