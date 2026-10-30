import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const output = resolve(option('--out', 'determinism-results'));
const minutes = Number(option('--minutes', '10'));
const base = option('--base', 'http://127.0.0.1:5197');
const maps = option('--maps', ''), seeds = option('--seeds', '1,2');
const engines = option('--engines', 'chromium,webkit,chrome,safari').split(',');
const playwrightRoot = option('--playwright-root', '');
const query = new URLSearchParams({ minutes: String(minutes), seeds });
if (maps) query.set('maps', maps);
const url = `${base}/tools/determinism.html?${query}`;
const pause = ms => new Promise(r => setTimeout(r, ms));
await mkdir(output, { recursive: true });
let pw;
const results = [];
async function runPlaywright(engine, runUrl = url) {
  pw ??= await import(playwrightRoot ? pathToFileURL(resolve(playwrightRoot, 'index.mjs')).href : 'playwright');
  let browser;
  try {
    browser = await (engine === 'webkit' ? pw.webkit : pw.chromium).launch({ headless: true,
      ...(engine === 'chrome' ? { channel: 'chrome' } : {}) });
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await page.goto(runUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__determinism?.done || window.__determinism?.error, undefined, { timeout: 3600000 });
    const data = await page.evaluate(() => window.__determinism);
    if (data.error) throw new Error(data.error);
    return { name: engine, version: browser.version(), status: 'complete', ...data };
  } finally { await browser?.close(); }
}
async function runSafari(runUrl = url) {
  const port = await new Promise((resolvePort, reject) => {
    const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => {
      const port = s.address().port; s.close(() => resolvePort(port));
    });
  });
  const child = spawn('/usr/bin/safaridriver', ['-p', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let error, diagnostics = '', session;
  child.once('error', e => { error = e; }); child.stderr.on('data', d => { diagnostics += d; });
  const endpoint = `http://127.0.0.1:${port}`;
  const request = async (path, data) => {
    if (error || child.exitCode != null) throw error ?? new Error(`owned safaridriver exited: ${diagnostics}`);
    const response = await fetch(endpoint + path, data === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    const body = await response.json();
    if (!response.ok || body.value?.error) throw new Error(body.value?.message ?? JSON.stringify(body));
    return body.value;
  };
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { await request('/status'); ready = true; break; } catch (e) { if (child.exitCode != null || error) throw e; }
      await pause(100);
    }
    if (!ready) throw new Error(`owned safaridriver startup timeout: ${diagnostics}`);
    const created = await request('/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
    session = created.sessionId;
    await request(`/session/${session}/timeouts`, { script: 3600000, pageLoad: 3600000 });
    await request(`/session/${session}/url`, { url: runUrl });
    let data;
    const limit = Date.now() + 3600000;
    while (Date.now() < limit) {
      data = await request(`/session/${session}/execute/sync`, { script: 'return window.__determinism || null;', args: [] });
      if (data?.error) throw new Error(data.error);
      if (data?.done) return { name: 'safari', version: created.capabilities?.browserVersion, status: 'complete', ...data };
      await pause(500);
    }
    throw new Error('Safari determinism timeout');
  } finally {
    if (session && child.exitCode == null) await fetch(`${endpoint}/session/${session}`, { method: 'DELETE' }).catch(() => {});
    if (child.exitCode == null) child.kill('SIGTERM');
    await writeFile(resolve(output, 'safari-driver.log'), diagnostics);
  }
}
for (const engine of engines) {
  let result;
  try {
    const launch = runUrl => engine === 'safari' ? runSafari(runUrl) : runPlaywright(engine, runUrl);
    const metadata = await launch(url + '&list=1');
    const cases = metadata.cases;
    if (!cases?.maps?.length || !cases.seeds?.length) throw new Error('No determinism cases selected');
    const runs = [];
    result = { name: engine, version: metadata.version, engine: metadata.engine, minutes,
      status: 'running', expectedRuns: cases.maps.length * cases.seeds.length, runs };
    for (const mapId of cases.maps) for (const seed of cases.seeds) {
      // A new browser process/session per case bounds retained engine memory.
      const caseQuery = new URLSearchParams({ maps: mapId, seeds: String(seed), minutes: String(minutes) });
      const completed = await launch(`${base}/tools/determinism.html?${caseQuery}`);
      if (completed.version !== result.version || completed.runs?.length !== 1) throw new Error('Invalid case result or changed browser version');
      const run = completed.runs[0];
      if (run.mapId !== mapId || run.seed !== seed) throw new Error('Wrong case returned by browser');
      runs.push(run);
      await writeFile(resolve(output, `${engine}.json`), JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ name: engine, mapId, seed, completed: runs.length, expected: result.expectedRuns }));
    }
    result.status = 'complete';
  } catch (error) { result = { ...result, name: engine, status: 'unfulfilled', error: String(error.stack ?? error) }; }
  results.push(result);
  await writeFile(resolve(output, `${engine}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ name: engine, status: result.status, runs: result.runs?.length, error: result.error }));
}
await writeFile(resolve(output, 'summary.json'), JSON.stringify({ url, minutes, results }, null, 2));
if (results.some(r => r.status !== 'complete')) process.exitCode = 2;
