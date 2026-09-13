// ============================================================================
// effects.ts — muzzle flashes, tracers, explosions, smoke and burning-vehicle
// flicker/smoke. Kept cheap: no shadows/blur, just flat fills and cached
// smoke-puff sprites. Sized boldly (per direct comparison against
// ref/ref_cc3_1482..1485.png) so effects read clearly even at 1x zoom.
// ============================================================================
import type { Camera, BattleState } from '@/shared/types';
import {
  VIEW_W, VIEW_H, FLASH_LIFE, TRACER_LIFE, EXPLOSION_LIFE_HE, EXPLOSION_LIFE_SMALL, EXPLOSION_LIFE_SMOKE,
} from '@/shared/types';
import { clamp } from '@/shared/math';
import { hash2 } from '@/shared/rng';
import { worldToScreen } from '@/engine/camera';
import { getSmokePuff } from '@/render/sprites';

function hex(n: number): number { return clamp(Math.round(n), 0, 255); }

/** Linear-interpolate two '#rrggbb' colors by `t` (0..1). */
function lerpColor(a: string, b: string, t: number): string {
  const ar = parseInt(a.slice(1, 3), 16), ag = parseInt(a.slice(3, 5), 16), ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16), bg = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
  const r = hex(ar + (br - ar) * t), g = hex(ag + (bg - ag) * t), bl = hex(ab + (bb - ab) * t);
  return `rgb(${r},${g},${bl})`;
}

function fillCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number): void {
  if (alpha <= 0 || r <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPuff(ctx: CanvasRenderingContext2D, x: number, y: number, diameterPx: number, alpha: number): void {
  if (alpha <= 0 || diameterPx <= 0) return;
  const sprite = getSmokePuff(Math.max(2, Math.round(diameterPx)));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(sprite, Math.round(x - diameterPx / 2), Math.round(y - diameterPx / 2), diameterPx, diameterPx);
  ctx.restore();
}

// ------------------------------------------------------------------- flashes
function drawFlashes(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  for (const f of state.flashes) {
    const frac = clamp(f.t / FLASH_LIFE, 0, 1);
    if (frac >= 1) continue;
    const big = f.kind === 'shell';
    // Full brightness for the first ~0.1s of life, then fade for the rest.
    const holdFrac = clamp(0.1 / FLASH_LIFE, 0, 1);
    const alpha = frac < holdFrac ? 1 : clamp(1 - (frac - holdFrac) / (1 - holdFrac), 0, 1);
    const standoff = big ? 12 : 8;
    const dx = Math.sin(f.facing) * standoff;
    const dy = -Math.cos(f.facing) * standoff;
    const p = worldToScreen(cam, f.pos);
    const sx = p.x + dx * cam.zoom;
    const sy = p.y + dy * cam.zoom;
    // infantry: 10px star; tank gun: 22px star + a puff of muzzle smoke
    const haloD = (big ? 22 : 10) * cam.zoom;
    const coreD = (big ? 11 : 5) * cam.zoom;
    ctx.save();
    ctx.globalAlpha = alpha * 0.95;
    ctx.fillStyle = '#ff9a3c';
    ctx.beginPath();
    ctx.arc(sx, sy, haloD / 2, 0, Math.PI * 2);
    ctx.fill();
    // star spikes for a "muzzle flash" silhouette, not just a blob
    ctx.strokeStyle = '#ff9a3c';
    ctx.lineWidth = big ? 2.5 : 1.5; // screen-space width — not scaled with zoom
    const spike = haloD / 2 + (big ? 8 : 4) * cam.zoom;
    ctx.beginPath();
    ctx.moveTo(sx - spike, sy); ctx.lineTo(sx + spike, sy);
    ctx.moveTo(sx, sy - spike); ctx.lineTo(sx, sy + spike);
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#fff2b0';
    ctx.beginPath();
    ctx.arc(sx, sy, coreD / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (big) {
      // a small puff of muzzle smoke lingers a bit longer than the flash itself
      const smokeAlpha = clamp(1 - frac, 0, 1) * 0.5;
      drawPuff(ctx, sx + Math.sin(f.facing) * 6 * cam.zoom, sy - Math.cos(f.facing) * 6 * cam.zoom, 14 * cam.zoom, smokeAlpha);
    }
  }
}

// ------------------------------------------------------------------- tracers
function drawTracers(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  for (const t of state.tracers) {
    if (t.kind === 'mortar') continue;
    const lifeFrac = clamp(t.t / TRACER_LIFE, 0, 1);
    if (lifeFrac >= 1) continue;
    const from = worldToScreen(cam, t.from);
    const to = worldToScreen(cam, t.to);
    const dx = to.x - from.x, dy = to.y - from.y;
    const segLen = Math.hypot(dx, dy) || 1;
    const ux = dx / segLen, uy = dy / segLen;
    // The visible streak travels from shooter to impact over the first 70%
    // of the tracer's life, then holds briefly at the impact point while
    // fading — like a round darting in and then winking out.
    const travel = clamp(lifeFrac / 0.7, 0, 1);
    const headDist = segLen * travel;
    const headLen = 12 * cam.zoom;
    const tailLen = 20 * cam.zoom;
    const headBackDist = Math.max(0, headDist - headLen);
    const tailBackDist = Math.max(0, headDist - headLen - tailLen);
    const hx = from.x + ux * headDist, hy = from.y + uy * headDist;
    const hbx = from.x + ux * headBackDist, hby = from.y + uy * headBackDist;
    const tbx = from.x + ux * tailBackDist, tby = from.y + uy * tailBackDist;
    const fadeOut = lifeFrac > 0.7 ? clamp(1 - (lifeFrac - 0.7) / 0.3, 0, 1) : 1;
    let color = '#ffe08a';
    let width = 2;
    let coreColor: string | null = null;
    if (t.kind === 'mg') { color = '#ffd070'; width = 2.5; }
    else if (t.kind === 'shell') { color = '#ffb060'; width = 3; coreColor = '#fff6d0'; }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    ctx.lineWidth = width; // screen-space width — not scaled with zoom
    // fading tail (behind the bright head)
    ctx.globalAlpha = fadeOut * 0.45;
    ctx.beginPath();
    ctx.moveTo(tbx, tby);
    ctx.lineTo(hbx, hby);
    ctx.stroke();
    // full-alpha bright head
    ctx.globalAlpha = fadeOut;
    ctx.beginPath();
    ctx.moveTo(hbx, hby);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    if (coreColor) {
      ctx.strokeStyle = coreColor;
      ctx.lineWidth = 1; // screen-space width — not scaled with zoom
      ctx.beginPath();
      ctx.moveTo(hbx, hby);
      ctx.lineTo(hx, hy);
      ctx.stroke();
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------- explosions
function drawExplosions(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  for (const e of state.explosions) {
    const p = worldToScreen(cam, e.pos);
    if (e.kind === 'he') {
      const frac = clamp(e.t / EXPLOSION_LIFE_HE, 0, 1);
      if (frac >= 1) continue;
      // Peak fireball radius, reached around frac≈0.25 (t≈0.25s on a 0.9s life).
      const maxR = Math.max(24, e.radiusM * 10) * cam.zoom;

      // brief 40px flash ring right at detonation
      if (frac < 0.12) {
        const ff = frac / 0.12;
        const ringR = (10 + ff * 30) * cam.zoom;
        ctx.save();
        ctx.globalAlpha = clamp(1 - ff, 0, 1) * 0.9;
        ctx.strokeStyle = '#fff6d8';
        ctx.lineWidth = 2; // screen-space width — not scaled with zoom
        ctx.beginPath();
        ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = clamp(1 - ff, 0, 1) * 0.6;
        ctx.fillStyle = '#fff6d8';
        ctx.beginPath();
        ctx.arc(p.x, p.y, ringR * 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // solid, opaque fireball core: dark-red outer -> orange -> yellow-white
      // inner rings, growing quickly to maxR then fading into the smoke ball.
      if (frac < 0.45) {
        const bf = clamp(frac / 0.28, 0, 1); // reaches full size by frac≈0.28
        const r = maxR * bf;
        const fireAlpha = clamp(1 - Math.max(0, frac - 0.28) / 0.17, 0.15, 1);
        fillCircle(ctx, p.x, p.y, r, '#5a1c10', fireAlpha);
        fillCircle(ctx, p.x, p.y, r * 0.72, '#ff8a3c', fireAlpha);
        fillCircle(ctx, p.x, p.y, r * 0.4, '#fff2c0', fireAlpha);

        // 12-16 dark debris streaks flying outward
        const n = 14;
        ctx.save();
        ctx.strokeStyle = '#241f1c';
        ctx.lineWidth = 1.5; // screen-space width — not scaled with zoom
        ctx.globalAlpha = fireAlpha;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + hash2(Math.floor(e.pos.x * 4), Math.floor(e.pos.y * 4), i) * 0.5;
          const dr = r * (0.7 + hash2(i, Math.floor(e.pos.x * 4), 7) * 0.9);
          const len = (5 + hash2(i, 3, Math.floor(e.pos.y * 4)) * 6) * cam.zoom;
          const ex = p.x + Math.cos(a) * dr, ey = p.y + Math.sin(a) * dr;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex + Math.cos(a) * len, ey + Math.sin(a) * len);
          ctx.stroke();
        }
        ctx.restore();
      }

      // black-grey smoke ball: follows the fireball, expands to 1.6x maxR and
      // lingers at high opacity for the rest of the explosion's life.
      {
        const sf = clamp((frac - 0.1) / 0.9, 0, 1);
        if (sf > 0) {
          const smokeR = maxR * (0.5 + sf * 1.1); // grows toward ~1.6x maxR
          const smokeAlpha = (frac > 0.8 ? clamp(1 - (frac - 0.8) / 0.2, 0, 1) : 1) * 0.85;
          const puffCount = 4;
          for (let i = 0; i < puffCount; i++) {
            const jitter = (hash2(Math.floor(e.pos.x * 4), i, 3) - 0.5) * smokeR * 0.5;
            const jitterY = (hash2(Math.floor(e.pos.y * 4), i, 9) - 0.5) * smokeR * 0.5 - sf * 10 * cam.zoom;
            drawPuff(ctx, p.x + jitter, p.y + jitterY, smokeR * (0.8 + i * 0.12), smokeAlpha * (1 - i * 0.08));
          }
        }
      }
    } else if (e.kind === 'small') {
      // small-arms bullet impact: a brief dust puff
      const frac = clamp(e.t / EXPLOSION_LIFE_SMALL, 0, 1);
      if (frac >= 1) continue;
      const alpha = clamp(1 - frac, 0, 1) * 0.8;
      const d = (3 + frac * 3) * 2 * cam.zoom; // ~6px diameter
      fillCircle(ctx, p.x, p.y, d / 2, '#a89a82', alpha);
    } else if (e.kind === 'smoke') {
      // smoke round: an initial white burst, then several overlapping puffs
      // building an 80px cloud over the ~2s life.
      const frac = clamp(e.t / EXPLOSION_LIFE_SMOKE, 0, 1);
      if (frac >= 1) continue;
      if (frac < 0.15) {
        const bf = frac / 0.15;
        fillCircle(ctx, p.x, p.y, (15 + bf * 10) * cam.zoom, '#e8e8e2', clamp(1 - bf, 0, 1) * 0.9);
      }
      const puffCount = 6;
      for (let i = 0; i < puffCount; i++) {
        const phase = clamp(frac - i * 0.08, 0, 1);
        if (phase <= 0) continue;
        const alpha = clamp(0.85 * (frac > 0.85 ? clamp(1 - (frac - 0.85) / 0.15, 0, 1) : 1), 0, 0.85);
        if (alpha <= 0) continue;
        const spread = 10 + phase * 30; // builds toward an 80px-wide cloud
        const jitterX = (hash2(Math.floor(e.pos.x * 4), Math.floor(e.pos.y * 4), i) - 0.5) * spread;
        const jitterY = (hash2(i, Math.floor(e.pos.x * 4), 5) - 0.5) * spread * 0.6 - phase * 10;
        const diam = (30 + hash2(i, 9, Math.floor(e.pos.y * 4)) * 20) * cam.zoom;
        drawPuff(ctx, p.x + jitterX * cam.zoom, p.y + jitterY * cam.zoom, diam, alpha);
      }
    }
  }
}

// ------------------------------------------------------------ vehicle fires
function drawBurningVehicles(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  for (const veh of state.vehicles.values()) {
    const p = worldToScreen(cam, veh.pos);
    if (veh.state === 'burning') {
      const t = veh.burnTimer;
      // 3 flickering, fully-opaque flame layers at the engine deck: dark-red
      // base, orange middle, yellow-hot core (12-16px), jittering independently.
      const layers: { color: string; size: number; jitter: number; seed: number }[] = [
        { color: '#7a1a0a', size: 16, jitter: 1.2, seed: 41 },
        { color: '#ff8a3c', size: 13, jitter: 1.8, seed: 53 },
        { color: '#ffe27a', size: 8, jitter: 2.2, seed: 67 },
      ];
      ctx.save();
      for (const L of layers) {
        const jx = (hash2(veh.id, L.seed, Math.floor(t * 9)) - 0.5) * L.jitter;
        const jy = (hash2(veh.id, L.seed + 1, Math.floor(t * 11)) - 0.5) * L.jitter;
        const flicker = 0.85 + hash2(veh.id, L.seed + 2, Math.floor(t * 14)) * 0.15;
        ctx.globalAlpha = flicker;
        ctx.fillStyle = L.color;
        const sx = p.x + jx * cam.zoom;
        const sy = p.y + jy * cam.zoom - 2 * cam.zoom;
        ctx.beginPath();
        ctx.arc(sx, sy, (L.size / 2) * cam.zoom, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // a dense column of 10-12 dark smoke puffs (24-40px), drifting NE and
      // rising up to 90px, reading clearly as a burning-vehicle plume.
      const puffCount = 11;
      for (let i = 0; i < puffCount; i++) {
        const phase = ((t * 0.3) + i / puffCount) % 1;
        const alpha = clamp(1 - phase, 0, 1) * 0.75;
        if (alpha <= 0) continue;
        const rise = phase * 90;
        const drift = phase * 34;
        const jitter = (hash2(veh.id, i, 99) - 0.5) * 10;
        const diam = (24 + phase * 16) * cam.zoom;
        const sx = p.x + (drift + jitter) * cam.zoom;
        const sy = p.y - rise * cam.zoom;
        drawPuff(ctx, sx, sy, diam, alpha);
      }
    } else if (veh.state === 'knockedOut' || veh.state === 'abandoned') {
      // knocked-out (not burning): a thin, slow wisp of smoke
      const phase = (state.time * 0.15 + hash2(veh.id, 1, 2)) % 1;
      const alpha = clamp(1 - phase, 0, 1) * 0.35;
      if (alpha > 0) {
        const sx = p.x + (hash2(veh.id, 2, 3) - 0.5) * 4 * cam.zoom;
        const sy = p.y - phase * 20 * cam.zoom;
        drawPuff(ctx, sx, sy, 10 * cam.zoom, alpha);
      }
    }
  }
}

export function drawEffects(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, VIEW_W, VIEW_H);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;

  drawBurningVehicles(ctx, cam, state);
  drawExplosions(ctx, cam, state);
  drawTracers(ctx, cam, state);
  drawFlashes(ctx, cam, state);

  ctx.restore();
}
