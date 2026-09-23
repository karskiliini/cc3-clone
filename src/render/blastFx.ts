// ============================================================================
// blastFx.ts — render-side extras for a vehicle blowing up (sim event 'vehicleExplosion') and
// for rounds cooking off in a burning hull ('cookOffPop'): a white flash, a ground glow and a
// camera shake that falls off with distance from the view centre. The fireball flipbook comes
// from the sim's explosion record (effects.ts), the smoke column from the burning wreck (fireFx.ts);
// nothing here feeds back into the sim. Time base is the battle clock.
// ============================================================================
import type { BattleEvent, Camera, Vec2 } from '@/shared/types';
import { TILE_PX, VIEW_H, VIEW_W } from '@/shared/types';
import { worldToScreen } from '@/engine/camera';
import { hash2 } from '@/shared/rng';
import { drawGlow } from '@/render/fxSprites';

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
    this.blasts = this.blasts.filter((b) => time - b.t0 < 1.2);
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

  /** Flash and glow; draw after the ordinary effects, inside the map clip. */
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
        drawGlow(ctx, p.x, p.y, 14 * z, 0.8 * Math.max(0, 1 - f * 3));
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
      // the fireball lights the ground around it (the burst itself is the he.big flipbook, the
      // smoke column the burning wreck's, fireFx.ts)
      if (age < 1.2) drawGlow(ctx, p.x, p.y, b.radiusM * 10 * z * (0.6 + age * 0.6), 0.9 * (1 - age / 1.2) ** 1.5);
    }
  }
}
