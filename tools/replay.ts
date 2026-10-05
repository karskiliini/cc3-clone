// ============================================================================
// tools/replay.ts — replays a saved battle log in Node and prints its per-tick state-hash chain
// (multiplayer plan §7 P4). Two runs of the same log, on any machine or engine, must print the
// same chain; the first differing line is the tick a desync entered.
//
//   npx vite-node tools/replay.ts <replay.json> [--until <tick>] [--out <chain.txt>] [--quiet]
//
// The chain is one line per tick: "<tick> <hash as 8 hex digits>". --out writes it to a file
// (and --quiet then prints only the summary). The summary says whether the replay reached the
// log's recorded final tick and hash.
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { runReplay, type ReplayLog } from '@/sim/replay';
import { hashHex, hashState } from '@/sim/stateHash';
import { BUILD_VERSION } from '@/shared/version';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--until' && args[i - 1] !== '--out');
if (!file) {
  console.error('usage: npx vite-node tools/replay.ts <replay.json> [--until <tick>] [--out <chain.txt>] [--quiet]');
  process.exit(2);
}

const log = JSON.parse(readFileSync(file, 'utf8')) as ReplayLog;
const until = opt('--until') != null ? Number(opt('--until')) : undefined;
const t0 = performance.now();
const { battle, chain } = runReplay(log, until);
const ms = performance.now() - t0;
const lines = chain.map((h, i) => `${i + 1} ${hashHex(h)}`);
const out = opt('--out');
if (out) writeFileSync(out, lines.join('\n') + '\n');
if (!args.includes('--quiet')) for (const line of lines) console.log(line);

const last = chain.length > 0 ? chain[chain.length - 1] : null;
const f = log.final;
// compare the state after the last tick's trailing commands (runTicks flushed them), not chain's last
const reached = f ? battle.state.tick === f.tick && hashState(battle) === f.hash : null;
if (log.buildVersion !== BUILD_VERSION) console.error(`note: recorded by build ${log.buildVersion}, replayed by ${BUILD_VERSION}`);
console.error(`replayed ${log.config.mapId} seed ${log.config.seed}: ${chain.length} ticks, ${log.commands.length} commands, `
  + `final ${last == null ? '-' : hashHex(last)} in ${(ms / 1000).toFixed(1)} s`
  + (reached == null ? '' : reached ? ' — matches the recorded final hash' : ` — DIFFERS from the recorded tick ${f!.tick} ${hashHex(f!.hash)}`));
if (reached === false) process.exit(1);
