import { defineConfig } from 'vite';
import { simulationFingerprint } from './tools/simulationFingerprint';
import path from 'node:path';
import { execSync } from 'node:child_process';

/** The commit this build is made from (src/shared/version.ts), for replays and multiplayer. */
function buildVersion(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  define: { __BUILD_VERSION__: JSON.stringify(buildVersion()), __SIMULATION_BUILD__: JSON.stringify(simulationFingerprint(__dirname)) },
  server: { port: 5173, strictPort: true, proxy: { '/relay': { target: 'ws://127.0.0.1:8787', ws: true } } },
  test: { environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 30000 },
} as any);
