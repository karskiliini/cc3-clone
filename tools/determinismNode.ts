// ============================================================================
// tools/determinismNode.ts — the determinism check in Node (see determinismCore.ts).
//
//   npx vite-node tools/determinismNode.ts [--maps a,b] [--seeds 1,2] [--minutes 10] [--json out.json]
// ============================================================================
import { writeFileSync } from 'node:fs';
import { DEFAULT_MAPS, DEFAULT_SEEDS, formatRun, runDeterminism, type DeterminismRun } from './determinismCore';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const maps = opt('--maps')?.split(',') ?? DEFAULT_MAPS;
const seeds = opt('--seeds')?.split(',').map(Number) ?? DEFAULT_SEEDS;
const minutes = Number(opt('--minutes') ?? 10);
const runs: DeterminismRun[] = [];
for (const mapId of maps) {
  for (const seed of seeds) {
    const r = runDeterminism(mapId, seed, minutes);
    runs.push(r);
    console.log(formatRun(r));
  }
}
const out = opt('--json');
if (out) writeFileSync(out, JSON.stringify({ engine: `node ${process.version}`, minutes, runs }, null, 1));
