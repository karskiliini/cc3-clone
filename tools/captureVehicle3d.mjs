// Engineering capture on the Mac mini, with an isolated headless Chrome profile.
// node tools/captureVehicle3d.mjs <output-directory> [preview-base-url]
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Connect only to the endpoint written by this child in its fresh, exclusively owned profile. */
export async function launchCaptureBrowser(output, { spawnChild = spawn, fetchEndpoint = fetch, attempts = 60, pollMs = 500 } = {}) {
  const profile = await mkdtemp(join(output, 'headless-profile-'));
  const messages = [], lifetime = new AbortController();
  let chrome, failure, exited = false, closed = false;
  const alive = () => chrome?.pid != null && !exited && chrome.exitCode == null && chrome.signalCode == null;
  const assertAlive = () => {
    if (failure || !alive()) throw failure ?? new Error('owned Chrome child exited during startup');
  };
  const fail = error => { failure = error; lifetime.abort(error); };
  const waitForExit = async () => {
    if (!alive()) return;
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); chrome.removeListener('exit', done); resolve(); };
      const timer = setTimeout(done, 1500); chrome.once('exit', done);
    });
  };
  const close = async () => {
    if (closed) return;
    lifetime.abort();
    if (alive()) {
      chrome.kill('SIGTERM'); await waitForExit();
      if (alive()) { chrome.kill('SIGKILL'); await waitForExit(); }
      if (alive()) throw new Error('owned Chrome did not stop; preserving its profile');
    }
    await rm(profile, { recursive: true, force: true }); closed = true;
  };
  try {
    chrome = spawnChild('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-component-update', '--password-store=basic', '--use-mock-keychain',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    chrome.stderr.on('data', chunk => messages.push(String(chunk)));
    chrome.once('error', error => fail(new Error(`owned Chrome startup failed: ${error.message}`)));
    chrome.once('exit', (code, signal) => { exited = true; fail(new Error(`owned Chrome exited: ${code ?? signal}`)); });
    let browserEndpoint, origin;
    for (let i = 0; i < attempts; i++) {
      assertAlive();
      let activePort;
      try { activePort = await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      assertAlive();
      if (activePort) {
        const [portText, browserPath] = activePort.trim().split(/\r?\n/);
        const port = Number(portText);
        if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535
          || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(browserPath)) throw new Error('invalid owned Chrome endpoint file');
        origin = `http://127.0.0.1:${port}`;
        browserEndpoint = `ws://127.0.0.1:${port}${browserPath}`; break;
      }
      await delay(pollMs);
    }
    assertAlive();
    if (!browserEndpoint) throw new Error('owned Chrome startup timed out without its endpoint file');
    const get = async path => {
      assertAlive();
      const response = await fetchEndpoint(origin + path, { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]) });
      if (!response.ok) throw new Error('owned Chrome endpoint request failed');
      const value = await response.json(); assertAlive(); return value;
    };
    // The browser UUID must also match the child profile, before any page is selected.
    const version = await get('/json/version');
    if (version.webSocketDebuggerUrl !== browserEndpoint) throw new Error('owned Chrome browser endpoint identity mismatch');
    const targets = await get('/json/list');
    const target = targets.find(t => t.type === 'page' && t.url === 'about:blank');
    if (!target) throw new Error('owned Chrome blank page failed to start');
    const pageEndpoint = new URL(target.webSocketDebuggerUrl);
    if (pageEndpoint.protocol !== 'ws:' || pageEndpoint.host !== new URL(browserEndpoint).host
      || !/^\/devtools\/page\/[a-zA-Z0-9-]+$/.test(pageEndpoint.pathname)) throw new Error('owned Chrome page endpoint identity mismatch');
    assertAlive();
    return { chrome, profile, browserEndpoint, target, messages, assertAlive, close };
  } catch (error) {
    error.chromeMessages = messages;
    await close(); throw error;
  }
}
async function capture() {
const output = resolve(process.argv[2]), base = process.argv[3] ?? 'http://127.0.0.1:5187';
const representativeIds = process.argv[4] ?? 't34_76,stug3g,sdkfz251_rocket';
const selectedScenarios = process.argv[5]?.split(',');
await mkdir(output, { recursive: true });
let owner, socket, startupMessages = [];
const errors = [], diagnostics = [];
try {
  owner = await launchCaptureBrowser(output);
  const { target } = owner;
  await writeFile(`${output}/browser-owner.json`, JSON.stringify({ pid: owner.chrome.pid, profile: owner.profile, browserEndpoint: owner.browserEndpoint, pageId: target.id }, null, 1));
  owner.assertAlive();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map(); let next = 1;
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id) { const handler = pending.get(message.id); pending.delete(message.id); message.error ? handler?.reject(new Error(JSON.stringify(message.error))) : handler?.resolve(message.result); }
    else if (message.method === 'Runtime.exceptionThrown') { errors.push(message.params); console.error(JSON.stringify(message.params)); }
    else if (message.method === 'Runtime.consoleAPICalled' || message.method === 'Network.loadingFailed'
      || message.method === 'Network.responseReceived' && message.params.response.status >= 400) diagnostics.push({ method: message.method, params: message.params });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { owner.assertAlive(); const id = next++; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  const results = [];
  const scenarios = [
    ['level-summer', 'summer', 'ok', {}], ['level-winter', 'winter', 'ok', {}],
    ['wreck', 'summer', 'ko', {}], ['detached', 'summer', 'blown', {}], ['trackL', 'summer', 'trackL', {}],
    ['pitch-summer', 'summer', 'ok', { pitch: 20, turret: 90, elevation: 15 }],
    ['pitch-winter', 'winter', 'ok', { pitch: 20, turret: 90, elevation: 15 }],
    ['roll-summer', 'summer', 'ok', { roll: 20, travelL: 0.1, travelR: -0.05, distance: 1.4 }],
    ['roll-winter', 'winter', 'ok', { roll: 20, travelL: 0.1, travelR: -0.05, distance: 1.4 }],
  ];
  for (const [name, season, state, extras] of scenarios.filter(s => !selectedScenarios || selectedScenarios.includes(s[0]))) for (const zoom of [1, 2]) {
    const query = new URLSearchParams({ only: representativeIds, season, state, zoom: String(zoom), ...Object.fromEntries(Object.entries(extras).map(([key, value]) => [key, String(value)])) });
    const url = `${base}/tools/vehicle3dPreview.html?${query}`;
    await send('Page.navigate', { url });
    let ready = false;
    for (let i = 0; i < 180; i++) {
      const value = await send('Runtime.evaluate', { expression: `location.href === ${JSON.stringify(url)} && typeof window.__vehicle3dMetrics === 'function'`, returnByValue: true });
      if (value.result?.value) { ready = true; break; }
      if (errors.length) throw new Error(`${name}: preview runtime exception`);
      await delay(500);
    }
    if (!ready) throw new Error(`${name}: preview did not complete`);
    const value = await send('Runtime.evaluate', { expression: "document.getElementById('c').toDataURL('image/png')", returnByValue: true });
    const filename = `${name}-${zoom}x.png`; await writeFile(`${output}/${filename}`, Buffer.from(value.result.value.split(',')[1], 'base64'));
    const metrics = await send('Runtime.evaluate', { expression: 'window.__vehicle3dMetrics()', awaitPromise: true, returnByValue: true });
    results.push({ filename, url, metrics: metrics.result.value });
    console.log(`captured ${filename}`);
  }
  await writeFile(`${output}/captures.json`, JSON.stringify({ results, errors }, null, 1));
  if (errors.length) throw new Error(`headless preview raised ${errors.length} exceptions`);
} catch (error) {
  startupMessages = error.chromeMessages ?? []; throw error;
} finally {
  socket?.close(); await owner?.close();
  await writeFile(`${output}/chrome.log`, (owner?.messages ?? startupMessages).join(''));
  await writeFile(`${output}/diagnostics.json`, JSON.stringify({ errors, diagnostics }, null, 1));
}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await capture();
