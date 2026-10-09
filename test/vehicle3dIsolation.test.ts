import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
}

describe('the sim stays render-free', () => {
  it('no sim, shared or net file imports three or src/render', () => {
    const root = path.resolve(__dirname, '../src');
    for (const f of ['sim', 'shared', 'net'].flatMap((d) => files(path.join(root, d)))) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/from ['"]three/);
      expect(src, f).not.toMatch(/from ['"]@\/render\//);
    }
  });
});
