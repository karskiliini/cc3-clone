// Node: vite-node tools/hullPhysicsBench.ts [--ticks 1000 --batches 10 --warmup 1000 --json result.json]
import { writeFileSync } from 'node:fs';
import { VEHICLE_DEFS } from '@/data/units';
import { hashState } from '@/sim/stateHash';
import { makePhysicsScene, makePureSolverScene, type PhysicsScene } from './hullPhysicsScenarios';
const args = process.argv.slice(2);
const arg = (key: string, fallback: string) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const ticks = Number(arg('--ticks', '1000')), batches = Number(arg('--batches', '10')), warmup = Number(arg('--warmup', '1000'));
if (![ticks, batches, warmup].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Positive integer benchmark sizes required');
function measure(step: () => void, observeWarmup?: () => void) {
  for (let i = 0; i < warmup; i++) { step(); observeWarmup?.(); }
  const samples: number[] = [];
  for (let b = 0; b < batches; b++) {
    const t = performance.now(); for (let i = 0; i < ticks; i++) step();
    samples.push((performance.now() - t) / ticks);
  }
  const sorted = [...samples].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { samples, medianMsPerTick: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    maxMsPerTick: sorted.at(-1)! };
}
const definitionsBefore = JSON.stringify(VEHICLE_DEFS);
const results: any[] = [];
for (const kind of ['flat-awake', 'flat-sleepers', 'mixed-resting', 'log-crater'] as PhysicsScene[]) {
  const scene = makePhysicsScene(kind, 40, Math.max(1400, Math.ceil((warmup + batches * ticks) / 10) + 100));
  const starts = new Map([...scene.state.vehicles.values()].map(v => [v.id, { ...v.pos }]));
  const featureEncountered = new Set<number>();
  const result = measure(scene.step, () => {
    if (kind !== 'log-crater') return;
    for (const v of scene.state.vehicles.values()) {
      const phase = ((v.pos.y - 20.5) % 30 + 30) % 30;
      if (Math.min(phase, 30 - phase) < 1 && v.body!.suspensionTravel.some(c => c > 0)) featureEncountered.add(v.id);
    }
  }), vehicles = [...scene.state.vehicles.values()];
  const moving = vehicles.filter(v => Math.hypot(v.body!.velocity.x, v.body!.velocity.y) > 0.05).length;
  const minNorthTiles = Math.min(...vehicles.map(v => starts.get(v.id)!.y - v.pos.y));
  const touchesBorder = vehicles.some(v => v.pos.x < 2 || v.pos.x > scene.state.map.width - 2 || v.pos.y < 2);
  if (kind === 'flat-awake' && (moving !== 40 || minNorthTiles < (warmup + batches * ticks) * 0.08 || touchesBorder))
    throw new Error('Flat awake fixture failed sustained northward driving');
  if (kind === 'flat-sleepers' && warmup >= 1000 && vehicles.some(v => !v.body!.asleep)) throw new Error('Sleeper fixture did not settle all 40 bodies');
  if (kind === 'log-crater' && warmup >= 1000 && featureEncountered.size !== 40) throw new Error('Feature fixture did not encounter the authored raised strip');
  if (!vehicles.every(v => v.body && [...Object.values(v.body.position), ...Object.values(v.body.orientation)].every(Number.isFinite))) throw new Error('Nonfinite body');
  const row = { kind, moving, minNorthTiles, touchesBorder, featureEncountered: featureEncountered.size, fleet: kind === 'flat-sleepers' ? '40 T-34/76' : 'mixed T-34/76, SdKfz251, KV1, PzIVH', ...result, awake: vehicles.filter(v => !v.body!.asleep).length,
    asleep: vehicles.filter(v => v.body!.asleep).length, hungUp: vehicles.filter(v => v.body!.hungUp).length,
    finalHash: hashState(scene), cost: 'production begin + accepted hull completion including blockers, probes, effects, synchronization' };
  results.push(row); console.log(JSON.stringify(row));
}
const pure = { kind: 'pure-solver-diagnostic', ...measure(makePureSolverScene().step) };
console.log(JSON.stringify(pure)); results.push(pure);
if (JSON.stringify(VEHICLE_DEFS) !== definitionsBefore) throw new Error('Input definitions mutated');
const report = { engine: process.version, count: 40, ticks, batches, warmup, targetMs: 0.5,
  acceptanceSized: ticks === 1000 && batches === 10 && warmup === 1000, results };
const output = arg('--json', ''); if (output) writeFileSync(output, JSON.stringify(report, null, 2));
