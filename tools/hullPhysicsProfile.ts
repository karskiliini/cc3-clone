// Native Node bundle: hullPhysicsProfile --scene flat-awake --out /tmp/hull.cpuprofile
// Profile only warmed production updates; keep profiled timing separate from the benchmark.
import { Session } from 'node:inspector/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hashState } from '@/sim/stateHash';
import { makePhysicsScene, type PhysicsScene } from './hullPhysicsScenarios';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const kind = option('--scene', 'flat-awake') as PhysicsScene;
if (!['flat-awake', 'flat-sleepers', 'mixed-resting', 'log-crater', 'routing'].includes(kind)) throw new Error(`Unknown scene: ${kind}`);
const count = Number(option('--count', '40')), warmup = Number(option('--warmup', '1000')), ticks = Number(option('--ticks', '5000'));
if (![count, warmup, ticks].every(x => Number.isSafeInteger(x) && x > 0)) throw new Error('Positive integer profile sizes required');
const output = option('--out', '');
if (!output) throw new Error('Provide --out /path/to/hull.cpuprofile');
const path = resolve(output);
mkdirSync(dirname(path), { recursive: true });
const scene = makePhysicsScene(kind, count, Math.max(1400, Math.ceil((warmup + ticks) / 10) + 100));
for (let tick = 0; tick < warmup; tick++) scene.step();
const inspector = new Session();
inspector.connect();
try {
  await inspector.post('Profiler.enable');
  await inspector.post('Profiler.start');
  const start = performance.now();
  for (let tick = 0; tick < ticks; tick++) scene.step();
  const msPerTick = (performance.now() - start) / ticks;
  const { profile } = await inspector.post('Profiler.stop');
  writeFileSync(path, JSON.stringify(profile));
  const vehicles = [...scene.state.vehicles.values()];
  const summary = { engine: process.version, arch: process.arch, scene: kind, count, warmup, ticks,
    profiledTiming: true, msPerTick, finalHash: hashState(scene),
    awake: vehicles.filter(v => !v.body!.asleep).length, asleep: vehicles.filter(v => v.body!.asleep).length };
  writeFileSync(path + '.json', JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
} finally { inspector.disconnect(); }
