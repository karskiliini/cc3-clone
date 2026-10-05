// ============================================================================
// tools/determinism.ts — the determinism check in a browser (see determinismCore.ts). Open
// /tools/determinism.html?maps=a,b&seeds=1,2&minutes=10 on the dev server; the runs print as they
// finish, and `window.__determinism` holds { engine, minutes, runs, done } for a test driver.
// `&report=<url>` also POSTs that result as JSON when done (for browsers no driver can automate,
// e.g. `open -a Safari`), and `&record=1` first records a scripted battle as a replay log
// (`result.replay`) for tools/replay.ts to reproduce in Node.
// ============================================================================
import { DEFAULT_MAPS, DEFAULT_SEEDS, formatRun, runDeterminism, type DeterminismRun } from './determinismCore';
import { Battle } from '@/sim/battle';
import { makeReplayLog, type ReplayLog } from '@/sim/replay';
import { DEFAULT_FORCES } from '@/data/operation';

const params = new URLSearchParams(location.search);
const maps = params.get('maps')?.split(',') ?? DEFAULT_MAPS;
const seeds = params.get('seeds')?.split(',').map(Number) ?? DEFAULT_SEEDS;
const minutes = Number(params.get('minutes') ?? 10);
const out = document.getElementById('out')!;
const report = params.get('report');
const result = {
  engine: navigator.userAgent, minutes, runs: [] as DeterminismRun[], done: false,
  error: null as string | null, replay: null as ReplayLog | null,
};
(window as unknown as { __determinism: typeof result }).__determinism = result;
out.textContent = `${result.engine}\n${minutes} sim-minutes per run\n\n`;

/** A scripted single-player battle with orders, saved as a replay log. */
function recordReplay(): ReplayLog {
  const b = new Battle({
    mapId: 'steppe_1943', playerSide: 'soviet', year: 1943, seed: 11, durationS: 1200,
    difficulty: 'normal', forces: DEFAULT_FORCES[1943],
  });
  const t = b.selectableTeams('soviet');
  b.submit('soviet', { type: 'ready' });
  for (let i = 0; i < 3000 && b.state.phase !== 'ended'; i++) {
    if (i === 20) b.submit('soviet', { type: 'order', teamId: t[0].id, order: { type: 'moveFast', target: { x: t[0].pos.x, y: t[0].pos.y - 30 }, issuedAt: 0 } });
    if (i === 400) b.submit('soviet', { type: 'order', teamId: t[1].id, order: { type: 'fire', target: { x: t[1].pos.x + 5, y: t[1].pos.y - 40 }, issuedAt: 0 } });
    b.step(0.1);
  }
  return makeReplayLog(b);
}

async function send(): Promise<void> {
  if (report) await fetch(report, { method: 'POST', body: JSON.stringify(result) });
}

async function main(): Promise<void> {
  if (params.get('record') === '1') {
    result.replay = recordReplay();
    out.textContent += `replay recorded: final tick ${result.replay.final?.tick} hash ${result.replay.final?.hash}\n\n`;
  }
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
  await send();
}
main().catch((e) => {
  result.error = String(e?.stack ?? e);
  out.textContent += `\nERROR ${result.error}\n`;
  void send();
});
