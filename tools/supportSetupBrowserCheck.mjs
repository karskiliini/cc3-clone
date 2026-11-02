/** Real setup/preset and two-client room controls. Own local Vite/relay only.
 * Optional CC3_PLAYWRIGHT_MODULE / CC3_CHROMIUM_EXECUTABLE reuse existing installs. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { simulationFingerprint } from './simulationFingerprint.ts';
const { chromium } = await import(process.env.CC3_PLAYWRIGHT_MODULE ?? 'playwright');
const out = process.env.CC3_SUPPORT_OUT ?? 'support-evidence/setup';
mkdirSync(out, { recursive: true }); mkdirSync('.scratch', { recursive: true });
const relayModule = resolve('.scratch/support-ui-relay.mjs');
await build({ entryPoints: ['server/relay.ts'], bundle: true, platform: 'node', format: 'esm', external: ['ws'], outfile: relayModule });
const { createRelayServer } = await import(pathToFileURL(relayModule).href);
const fingerprint = simulationFingerprint(process.cwd());
const relay = await createRelayServer({ port: 0, build: fingerprint, allowedOrigins: ['http://127.0.0.1:5201'] });
const log = openSync(out + '/server.log', 'w');
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5201', '--strictPort'], { detached: true, stdio: ['ignore', log, log] });
let browser; const result = { errors: [], passed: false, fingerprint };
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:5201')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ headless: true, ...(process.env.CC3_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CC3_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  page.on('pageerror', e => result.errors.push(String(e)));
  await page.goto('http://127.0.0.1:5201'); await page.waitForFunction(() => window.__cc3?.input);
  await page.evaluate(async () => { const { BattleSetupScreen } = await import('/src/ui/screens/battleSetup.ts'); window.__cc3.setScreen(new BattleSetupScreen()); });
  async function setupClick(key) {
    const p = await page.evaluate(async key => { const { MENU_X, MENU_Y } = await import('/src/shared/types.ts'); const r = window.__cc3.screen[key]; return { x: MENU_X + r.x + r.w / 2, y: MENU_Y + r.y + r.h / 2 }; }, key);
    await page.mouse.click(p.x, p.y); await page.waitForTimeout(100);
  }
  await setupClick('timeR'); await setupClick('weatherR'); await setupClick('dateR'); await setupClick('saveR');
  const snap = () => page.evaluate(() => { const s = window.__cc3.screen; return { timeOfDay: s.timeOfDay, weather: s.weather, month: s.scenarioMonth }; });
  result.saved = await snap(); assert.deepEqual(result.saved, { timeOfDay: 'night', weather: 'overcast', month: '11' });
  await setupClick('timeR'); await setupClick('weatherR'); await setupClick('loadR'); assert.deepEqual(await snap(), result.saved);
  await page.screenshot({ path: out + '/night-setup.png' });
  await page.mouse.click(850, 657); await page.waitForTimeout(200);
  result.requisition = await page.evaluate(() => ({ ...window.__cc3.screen.cfgBase }));
  assert.equal(result.requisition.timeOfDay, 'night'); assert.equal(result.requisition.weather, 'overcast'); assert.match(result.requisition.scenarioDate, /^194[1-5]-11-15$/);
  async function lobby(p) {
    await p.evaluate(async () => { const { OnlineLobbyScreen } = await import('/src/ui/screens/onlineLobby.ts'); window.__cc3.setScreen(new OnlineLobbyScreen()); });
    await p.getByLabel('Relay server', { exact: true }).fill(`ws://127.0.0.1:${relay.port}/relay`);
  }
  await lobby(page); await page.getByRole('button', { name: 'Create room', exact: true }).click(); await page.locator('#share-code').waitFor({ state: 'visible' });
  const code = await page.locator('#share-code').inputValue();
  await page.getByLabel('Battle year', { exact: true }).selectOption('1944');
  await page.getByLabel('Time of day', { exact: true }).selectOption('night');
  await page.getByLabel('Weather', { exact: true }).selectOption('rain');
  await page.getByLabel('Scenario date', { exact: true }).fill('1944-02-29');
  await page.getByRole('button', { name: 'Apply battle settings', exact: true }).click();
  await page.waitForFunction(() => window.__cc3.screen.client?.room?.settings.scenarioDate === '1944-02-29');
  const guest = await browser.newPage({ viewport: { width: 1024, height: 768 } }); guest.on('pageerror', e => result.errors.push(String(e)));
  await guest.goto('http://127.0.0.1:5201'); await guest.waitForFunction(() => window.__cc3?.input); await lobby(guest);
  await guest.getByLabel('Room code', { exact: true }).fill(code); await guest.getByRole('button', { name: 'Join room', exact: true }).click(); await guest.locator('#share-code').waitFor({ state: 'visible' });
  assert.equal(await guest.getByLabel('Time of day', { exact: true }).inputValue(), 'night');
  assert.equal(await guest.getByLabel('Weather', { exact: true }).inputValue(), 'rain');
  assert.equal(await guest.getByLabel('Scenario date', { exact: true }).inputValue(), '1944-02-29');
  for (const label of ['Time of day', 'Weather', 'Scenario date']) assert(await guest.getByLabel(label, { exact: true }).isDisabled());
  await guest.screenshot({ path: out + '/night-room-guest.png' });
  result.room = { timeOfDay: 'night', weather: 'rain', scenarioDate: '1944-02-29', guestControlsDisabled: true };
  assert.equal(result.errors.length, 0); result.passed = true;
} catch (error) { result.failure = String(error); process.exitCode = 1; }
finally {
  await browser?.close(); await relay.close();
  if (server.exitCode == null) { try { process.kill(-server.pid, 'SIGTERM'); } catch {} }
  await new Promise(r => server.exitCode != null ? r() : server.once('exit', r));
  result.ownedServicesStopped = true; writeFileSync(out + '/result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
