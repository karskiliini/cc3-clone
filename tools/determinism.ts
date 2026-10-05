// ============================================================================
// tools/determinism.ts — the determinism check in a browser (see determinismCore.ts). Open
// /tools/determinism.html?maps=a,b&seeds=1,2&minutes=10 on the dev server; the runs print as they
// finish, and `window.__determinism` holds { engine, minutes, runs, done } for a test driver.
// ============================================================================
import { DEFAULT_MAPS, DEFAULT_SEEDS, formatRun, runDeterminism, type DeterminismRun } from './determinismCore';

const params = new URLSearchParams(location.search);
const maps = params.get('maps')?.split(',') ?? DEFAULT_MAPS;
const seeds = params.get('seeds')?.split(',').map(Number) ?? DEFAULT_SEEDS;
const minutes = Number(params.get('minutes') ?? 10);
const out = document.getElementById('out')!;
const result = { engine: navigator.userAgent, minutes, runs: [] as DeterminismRun[], done: false, error: null as string | null };
(window as unknown as { __determinism: typeof result }).__determinism = result;
out.textContent = `${result.engine}\n${minutes} sim-minutes per run\n\n`;

async function main(): Promise<void> {
  for (const mapId of maps) {
    for (const seed of seeds) {
      // yield between runs so the page paints its progress
      await new Promise((r) => setTimeout(r, 0));
      const r = runDeterminism(mapId, seed, minutes);
      result.runs.push(r);
      out.textContent += formatRun(r) + '\n';
    }
  }
  result.done = true;
  out.textContent += '\ndone\n';
}
main().catch((e) => { result.error = String(e?.stack ?? e); out.textContent += `\nERROR ${result.error}\n`; });
