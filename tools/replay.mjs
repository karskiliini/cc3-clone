// Offline entry point: use the installed Vite transformer/aliases rather than an implicit
// `npx vite-node` download (vite-node is no longer a transitive Vitest dependency).
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom' });
try {
  await server.ssrLoadModule('/tools/replay.ts');
} finally {
  await server.close();
}
