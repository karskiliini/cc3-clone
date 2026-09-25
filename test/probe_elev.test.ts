import { describe, it } from 'vitest';
import { buildMap } from '@/sim/map';
import { ElevationPainter } from '@/sim/mapdsl';
import { MAPS } from '@/data/maps';

describe('probe', () => {
  it('kremlin x=114 street crossing the Spree', () => {
    const def = MAPS.find((m) => m.id === 'kremlin_1945')!;
    const w = def.width, hgt = def.height;
    let idHash = 0;
    for (let i = 0; i < def.id.length; i++) idHash = (idHash * 31 + def.id.charCodeAt(i)) | 0;
    const seed = (idHash >>> 0) % 100000;
    type Api = Parameters<NonNullable<typeof def.elevation>>[0];
    const pAmb = new ElevationPainter(w, hgt, seed);
    const skip = new Proxy({} as Api, {
      get(_t, prop) {
        const real = (pAmb as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof real !== 'function') return () => undefined;
        if (prop === 'gradeRoad' || prop === 'smoothElevation') return () => undefined;
        return real.bind(pAmb);
      },
    });
    def.elevation!(skip);
    const real = buildMap(def);
    const gA = pAmb.e as Float32Array;
    const gR = real.ground as Float32Array;
    console.log('y    amb    real   dAmb(3t)% dReal(3t)%');
    const pts: { x: number; y: number }[] = [];
    for (let y = 96; y >= 56; y--) pts.push({ x: 114, y });
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k];
      const b = pts[Math.min(k + 3, pts.length - 1)];
      const run = Math.max(0.5, Math.hypot(b.x - a.x, b.y - a.y) * 2);
      const dAmb = Math.abs(gA[b.y * w + b.x] - gA[a.y * w + a.x]) / run;
      const dReal = Math.abs(gR[b.y * w + b.x] - gR[a.y * w + a.x]) / run;
      console.log(`${String(a.y).padStart(3)} ${gA[a.y * w + a.x].toFixed(2)} ${gR[a.y * w + a.x].toFixed(2)} ${(dAmb * 100).toFixed(1)}% ${(dReal * 100).toFixed(1)}%`);
    }
  });
});
