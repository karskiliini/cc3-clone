// Engineering capture on the Mac mini, with an isolated headless Chrome profile.
// node tools/captureVehicle3d.mjs <output-directory> [preview-base-url]
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const output = resolve(process.argv[2]), base = process.argv[3] ?? 'http://127.0.0.1:5187';
const representativeIds = process.argv[4] ?? 't34_76,stug3g,sdkfz251_rocket';
const selectedScenarios = process.argv[5]?.split(',');
await mkdir(output, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--password-store=basic', '--use-mock-keychain',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9339',
  `--user-data-dir=${output}/headless-profile`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const messages = []; chrome.stderr.on('data', chunk => messages.push(String(chunk)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
const errors = [], diagnostics = [];
try {
  let targets;
  for (let i = 0; i < 60; i++) {
    try { targets = await fetch('http://127.0.0.1:9339/json/list').then(r => r.json()); break; } catch { await delay(500); }
  }
  const target = targets?.find(t => t.type === 'page');
  if (!target) throw new Error('isolated headless page failed to start');
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
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
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
} finally {
  socket?.close(); chrome.kill('SIGTERM');
  await writeFile(`${output}/chrome.log`, messages.join(''));
  await writeFile(`${output}/diagnostics.json`, JSON.stringify({ errors, diagnostics }, null, 1));
}
