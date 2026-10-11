import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';
const server = await createServer({ server: { middlewareMode: true } });
try {
  const module = await server.ssrLoadModule('/tools/vehicle3dPoseParity.ts');
  await writeFile(process.argv[2], JSON.stringify(module.vehicleRenderParity(), null, 1) + '\n');
} finally { await server.close(); }
