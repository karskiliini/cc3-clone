// ============================================================================
// tools/determinismNode.ts — the determinism check in Node (see determinismCore.ts).
//
//   npx vite-node tools/determinismNode.ts [--maps a,b] [--seeds 1,2] [--minutes 10] [--json out.json]
// ============================================================================
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
// Each run owns a fresh process. Long suites must not accumulate engine caches or
// depend on an enlarged heap, and a crash must leave the completed cases on disk.
const isolated = !args.includes('--in-process');
const scratch = isolated ? mkdtempSync(join(tmpdir(), 'cc3-determinism-')) : null;
try {
  for (const mapId of maps) {
    for (const seed of seeds) {
      let r: DeterminismRun;
      if (scratch) {
        const output = join(scratch, `${runs.length}.json`);
        const entry = fileURLToPath(import.meta.url);
        const runner = /vite-node(?:\.mjs|[/\\]dist[/\\]cli\.mjs)$/.test(process.argv[1])
          ? [process.argv[1], entry] : [entry];
        const child = spawnSync(process.execPath, [...runner,
          '--in-process', '--maps', mapId, '--seeds', String(seed), '--minutes', String(minutes), '--json', output],
          { stdio: 'inherit' });
        if (child.error || child.status !== 0) throw child.error ?? new Error(`Determinism child failed: ${mapId}/${seed}, status ${child.status}, signal ${child.signal}`);
        const result = JSON.parse(readFileSync(output, 'utf8'));
        if (result.runs.length !== 1) throw new Error('Child did not return exactly one run');
        r = result.runs[0];
      } else {
        r = runDeterminism(mapId, seed, minutes);
        console.log(formatRun(r));
      }
      runs.push(r);
      const output = opt('--json');
      if (output) writeFileSync(output, JSON.stringify({ engine: `node ${process.version}`, minutes,
        complete: runs.length === maps.length * seeds.length, expectedRuns: maps.length * seeds.length, runs }, null, 1));
    }
  }
} finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
const out = opt('--json');
if (out) writeFileSync(out, JSON.stringify({ engine: `node ${process.version}`, minutes, complete: true, expectedRuns: maps.length * seeds.length, runs }, null, 1));
