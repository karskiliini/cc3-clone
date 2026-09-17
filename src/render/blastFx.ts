// ============================================================================
// blastFx.ts — render-side extras for a vehicle blowing up (sim event 'vehicleExplosion') and
// for rounds cooking off in a burning hull ('cookOffPop'): a white flash, a camera shake that
// falls off with distance from the view centre, and a tall smoke column that stands for a while.
// The blast, crater, casualties and the ordinary HE fireball come from the sim; nothing here
// feeds back into it. Time base is the battle clock, so the column freezes when paused.
// ============================================================================
import type { BattleEvent, Camera, Vec2 } from '@/shared/types';
import { TILE_PX, VIEW_H, VIEW_W } from '@/shared/types';
import { worldToScreen } from '@/engine/camera';
import { hash2 } from '@/shared/rng';

export const COLUMN_LIFE_S = 40;
export const SHAKE_LIFE_S = 0.9;
interface Blast { pos: Vec2; radiusM: number; t0: number; seed: number; small: boolean }

/** Shake amplitude (px) at `age` seconds for a blast `distTiles` from the view centre. Pure. */
export function shakeAmplitude(age: number, radiusM: number, distTiles: number): number {
  if (age < 0 || age >= SHAKE_LIFE_S) return 0;
  const size = Math.min(1, radiusM / 14);
  const near = Math.max(0, 1 - distTiles / 60);
  const fade = (1 - age / SHAKE_LIFE_S) ** 2;
  return 7 * size * near * fade;
}

export class BlastFx {
  private blasts: Blast[] = [];

  onEvents(events: readonly BattleEvent[], time: number): void {
    for (const ev of events) {
      if (ev.kind === 'vehicleExplosion' && ev.pos) {
        this.blasts.push({ pos: { ...ev.pos }, radiusM: (ev as { radiusM?: number }).radiusM ?? 10, t0: time, seed: Math.floor(ev.pos.x * 31 + ev.pos.y * 17), small: false });
      } else if (ev.kind === 'cookOffPop' && ev.pos) {
        this.blasts.push({ pos: { ...ev.pos }, radiusM: 2, t0: time, seed: Math.floor(ev.pos.x * 13 + ev.pos.y * 7 + time * 10), small: true });
      }
    }
  }

  private prune(time: number): void {
    if (this.blasts.length && time < this.blasts[0].t0 - 1) this.blasts = []; // a new battle
    this.blasts = this.blasts.filter((b) => time - b.t0 < (b.small ? 1.2 : COLUMN_LIFE_S));
  }

  /** Camera offset in screen px for this frame. */
  shake(cam: Camera, time: number): Vec2 {
    this.prune(time);
    const tilePx = TILE_PX * cam.zoom;
    const cx = cam.x + VIEW_W / tilePx / 2, cy = cam.y + VIEW_H / tilePx / 2;
    let amp = 0;
    for (const b of this.blasts) if (!b.small) amp = Math.max(amp, shakeAmplitude(time - b.t0, b.radiusM, Math.hypot(b.pos.x - cx, b.pos.y - cy)));
    if (amp <= 0.05) return { x: 0, y: 0 };
    const k = Math.floor(time * 30);
    return { x: Math.round((hash2(k, 1, 91) - 0.5) * 2 * amp), y: Math.round((hash2(k, 2, 93) - 0.5) * 2 * amp) };
  }

  /** Flash and smoke column; draw after the ordinary effects, inside the map clip. */
  draw(ctx: CanvasRenderingContext2D, cam: Camera, time: number): void {
    this.prune(time);
    for (const b of this.blasts) {
      const age = time - b.t0;
      const p = worldToScreen(cam, b.pos);
      const z = cam.zoom;
      if (b.small) {
        // a round cooking off: a quick spark fan and a puff
        const f = age / 1.2;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - f * 2.2);
        ctx.strokeStyle = '#ffe9a0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < 7; i++) {
          const a = hash2(i, b.seed, 3) * Math.PI * 2, r = (4 + hash2(i, b.seed, 4) * 14) * z * Math.min(1, f * 4);
          ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r - r * 0.3);
        }
        ctx.stroke();
        ctx.restore();
        continue;
      }
      if (p.x < -300 || p.y < -500 || p.x > VIEW_W + 300 || p.y > VIEW_H + 300) continue;
      // white-out flash over the whole view, then a bright ground glow
      if (age < 0.18) {
        ctx.save();
        ctx.globalAlpha = 0.35 * (1 - age / 0.18);
        ctx.fillStyle = '#fff4d0';
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);
        ctx.restore();
      }
      if (age < 1.2) {
        const r = b.radiusM * 10 * z * (0.5 + age * 0.6);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        const a = 0.55 * (1 - age / 1.2);
        g.addColorStop(0, `rgba(255,220,140,${a})`);
        g.addColorStop(0.5, `rgba(240,120,40,${a * 0.5})`);
        g.addColorStop(1, 'rgba(240,120,40,0)');
        ctx.fillStyle = g;
        ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      }
      // smoke column: puffs born at the hull for the first ~25 s, rising (up-screen) and drifting
      // with the wind to the north-east, growing and thinning as they go
      const born = Math.min(age, 25), puffs = Math.floor(born * 2.2);
      const fadeAll = age > COLUMN_LIFE_S - 8 ? (COLUMN_LIFE_S - age) / 8 : 1;
      ctx.save();
      for (let i = 0; i < puffs; i++) {
        const pa = age - i / 2.2; // this puff's own age
        if (pa < 0 || pa > 16) continue;
        const k = pa / 16;
        const jx = (hash2(i, b.seed, 11) - 0.5) * 10, jy = (hash2(i, b.seed, 12) - 0.5) * 6;
        const x = p.x + (jx + pa * 2.6 + k * k * 22) * z;
        const y = p.y + (jy - pa * 5.5 - k * 18) * z;
        const r = (5 + pa * 1.9 + hash2(i, b.seed, 13) * 4) * z;
        const hot = pa < 1.2 ? 1 - pa / 1.2 : 0;
        const shade = Math.round(28 + k * 70 + hash2(i, b.seed, 14) * 18);
        ctx.globalAlpha = Math.max(0, (0.5 - k * 0.42)) * fadeAll;
        ctx.fillStyle = hot > 0 ? `rgb(${Math.round(shade + 150 * hot)},${Math.round(shade + 60 * hot)},${shade})` : `rgb(${shade},${shade},${shade + 3})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }
}
