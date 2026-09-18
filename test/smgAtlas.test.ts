import { describe, expect, it } from 'vitest';
import { atlasCellCount, validateAtlasMeta, type AtlasEntry, type AtlasMeta } from '@/render/spriteAtlas';
// @ts-expect-error -- this project does not install declarations for Node builtins.
import * as nodeFs from 'node:fs';

const fs = nodeFs as {
  readFileSync(path: string, encoding: 'utf8'): string;
  readFileSync(path: string): Uint8Array;
};
type SmgMeta = AtlasMeta & {
  bodyHeading: boolean;
  twistDegrees: number[];
  proneTwistDegrees: number[];
  recoilFrames: string[];
  entries: Record<string, AtlasEntry & {
    twistDegrees: number; fireMode: string; muzzleBodyM: { x: number; y: number; z: number }[];
  }>;
};

describe('generated SMG sprite assets', () => {
  for (const side of ['german', 'soviet']) for (const season of ['summer', 'winter']) {
    for (const scale of [1, 2]) {
      const name = `smg_${side}_${season}_${scale}`;
      it(`${name} contains every planted pose, twist and recoil frame in a complete PNG`, () => {
        const base = `public/sprites/${name}`;
        const meta = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8')) as SmgMeta;
        expect(validateAtlasMeta(meta)).toBeNull();
        expect(meta.scale).toBe(scale);
        expect(meta.cell).toEqual({ w: 36 * scale, h: 36 * scale });
        expect(meta.anchor).toEqual({ x: 18 * scale, y: 19 * scale });
        expect(meta.dirs).toBe(16);
        expect(meta.bodyHeading).toBe(true);
        expect(meta.twistDegrees).toEqual([-40, -20, 0, 20, 40]);
        expect(meta.proneTwistDegrees).toEqual([-20, -10, 0, 10, 20]);
        expect(meta.recoilFrames).toEqual(['rest', 'kick', 'recovery']);

        const expectedKeys: string[] = [];
        let start = 0;
        for (const posture of ['standing', 'crouched', 'kneeling', 'prone']) {
          for (const mode of posture === 'prone' ? ['aimed'] : ['aimed', 'hip']) {
            for (let twist = 0; twist < 5; twist++) {
              const key = `${posture}.${mode}.twist${twist}`;
              expectedKeys.push(key);
              expect(meta.entries[key]).toMatchObject({
                start, frames: 3, loop: false, fireMode: mode,
                twistDegrees: (posture === 'prone' ? meta.proneTwistDegrees : meta.twistDegrees)[twist],
              });
              expect(meta.entries[key].muzzleBodyM).toHaveLength(3);
              for (const muzzle of meta.entries[key].muzzleBodyM) {
                expect(Number.isFinite(muzzle.x + muzzle.y + muzzle.z)).toBe(true);
                expect(muzzle.z).toBeGreaterThan(0);
              }
              start += 16 * 3;
            }
          }
        }
        expect(Object.keys(meta.entries)).toEqual(expectedKeys);
        expect(atlasCellCount(meta)).toBe(1680);

        const png = fs.readFileSync(`${base}.png`);
        expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        const ihdr = new DataView(png.buffer, png.byteOffset, png.byteLength);
        expect(ihdr.getUint32(16)).toBe(meta.columns * meta.cell.w);
        expect(ihdr.getUint32(20)).toBe(Math.ceil(start / meta.columns) * meta.cell.h);
      });
    }
  }
});
