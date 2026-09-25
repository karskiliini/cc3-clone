import { defineConfig } from 'vite';
import path from 'node:path';
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: { port: 5173, strictPort: true },
  test: { environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 30000 },
} as any);
