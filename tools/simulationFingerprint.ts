import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Content identity, including dirty source; independent of checkout path or git metadata. */
export function simulationFingerprint(root: string): string {
  const files: string[] = [];
  function walk(dir: string): void {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.name.endsWith('.ts')) files.push(path);
    }
  }
  for (const dir of ['sim', 'data', 'shared', 'net']) walk(join(root, 'src', dir));
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(relative(root, file).replaceAll('\\', '/')); hash.update('\0');
    hash.update(readFileSync(file)); hash.update('\0');
  }
  return hash.digest('hex');
}
