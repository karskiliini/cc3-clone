/** Run against a caller-owned Vite server; never modifies/stops that server.
 * CC3_PLAYWRIGHT_MODULE and CC3_*_EXECUTABLE optionally reuse installed browsers. */
import { writeFileSync } from 'node:fs';
const pw = await import(process.env.CC3_PLAYWRIGHT_MODULE ?? 'playwright');
const engine = process.argv[2] ?? 'chromium';
const executablePath = process.env[engine === 'webkit' ? 'CC3_WEBKIT_EXECUTABLE' : 'CC3_CHROMIUM_EXECUTABLE'];
const browser = await pw[engine].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  const page = await browser.newPage();
  await page.goto((process.env.CC3_GAME_URL ?? 'http://127.0.0.1:5199') + '/tools/determinism.html?list=1');
  const result = await page.evaluate(async () => {
    const { supportTrace } = await import('/tools/supportTrace.ts');
    return [supportTrace(false), supportTrace(true)];
  });
  writeFileSync(process.argv[3], JSON.stringify(result));
} finally { await browser.close(); }
