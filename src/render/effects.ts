// ============================================================================
// effects.ts — muzzle flashes, tracers, explosions, smoke and burning-vehicle
// flicker/smoke. Kept cheap: no shadows/blur, just flat fills and cached
// smoke-puff sprites.
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

// ------------------------------------------------------------------- flashes
function drawFlashes(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  for (const f of state.flashes) {
    const frac = clamp(f.t / FLASH_LIFE, 0, 1);
    if (frac >= 1) continue;
    const big = f.kind === 'shell';
    // 2-frame star: a bright first frame, then a smaller/dimmer linger frame.
    const frame: 0 | 1 = frac < 0.5 ? 0 : 1;
    const baseAlpha = clamp(1 - frac, 0, 1);
    const alpha = frame === 0 ? baseAlpha : baseAlpha * 0.6;
    const sizeMul = frame === 0 ? 1 : 0.75;
    const standoff = big ? 9 : 6;
    const dx = Math.sin(f.facing) * standoff;
    const dy = -Math.cos(f.facing) * standoff;
    const p = worldToScreen(cam, f.pos);
    const sx = p.x + dx * cam.zoom;
    const sy = p.y + dy * cam.zoom;
    const haloD = (big ? 14 : 8) * sizeMul * cam.zoom;
    const coreD = (big ? 6 : 4) * sizeMul * cam.zoom;
    ctx.save();
    ctx.globalAlpha = alpha * 0.85;
    ctx.fillStyle = '#ff9a3c';
    ctx.beginPath();
    ctx.arc(sx, sy, haloD / 2, 0, Math.PI * 2);
    ctx.fill();
    // star spikes on the bright frame only
    if (frame === 0) {
      ctx.strokeStyle = '#ff9a3c';
      ctx.lineWidth = Math.max(1, cam.zoom);
      const spike = haloD / 2 + (big ? 4 : 2) * cam.zoom;
      ctx.beginPath();
      ctx.moveTo(sx - spike, sy); ctx.lineTo(sx + spike, sy);
      ctx.moveTo(sx, sy - spike); ctx.lineTo(sx, sy + spike);
      ctx.stroke();
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#fff2b0';
    ctx.beginPath();
    ctx.arc(sx, sy, coreD / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
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
    // The visible streak travels from shooter to impact over roughly the
    // first 70% of the tracer's life, then holds briefly at the impact
    // point while fading — like a round darting in and then winking out.
    const travel = clamp(lifeFrac / 0.7, 0, 1);
    const headDist = segLen * travel;
    const tailDist = Math.max(0, headDist - 25 * cam.zoom);
    const hx = from.x + ux * headDist, hy = from.y + uy * headDist;
    const tx = from.x + ux * tailDist, ty = from.y + uy * tailDist;
    const fadeOut = lifeFrac > 0.7 ? clamp(1 - (lifeFrac - 0.7) / 0.3, 0, 1) : 1;
    let color = '#ffe08a';
    let width = 2;
    let coreColor: string | null = null;
    if (t.kind === 'mg') { color = '#ffd070'; width = 2; }
    else if (t.kind === 'shell') { color = '#ffb060'; width = 3; coreColor = '#fff6d0'; }
    ctx.save();
    ctx.globalAlpha = fadeOut * 0.95;
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    if (coreColor) {
      ctx.strokeStyle = coreColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
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
      const maxR = Math.max(6, e.radiusM * 10) * cam.zoom;

      // 0-0.15: white-yellow flash disc
      if (frac < 0.15) {
        const ff = frac / 0.15;
        ctx.save();
        ctx.globalAlpha = clamp(1 - ff, 0, 1);
        ctx.fillStyle = '#fff6d8';
        ctx.beginPath();
        ctx.arc(p.x, p.y, (6 + ff * 6) * cam.zoom, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // expanding orange -> dark-grey fireball, plus flying debris pixels
      if (frac < 0.55) {
        const bf = clamp(frac / 0.55, 0, 1);
        const r = 6 * cam.zoom + (maxR - 6 * cam.zoom) * bf;
        const alpha = clamp(1 - bf * 0.85, 0, 1);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = lerpColor('#ff9a3c', '#3a3a38', bf);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        if (bf < 0.85) {
          const n = 10;
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = '#2a2624';
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + hash2(Math.floor(e.pos.x * 4), Math.floor(e.pos.y * 4), i) * 0.6;
            const dr = r * (0.55 + hash2(i, Math.floor(e.pos.x * 4), 7) * 0.75);
            ctx.fillRect(Math.round(p.x + Math.cos(a) * dr) - 1, Math.round(p.y + Math.sin(a) * dr) - 1, 2, 2);
          }
          ctx.restore();
        }
      }

      // lingering grey smoke puffs drifting up-left for the rest of the life
      if (frac > 0.25) {
        const sf = clamp((frac - 0.25) / 0.75, 0, 1);
        const puffCount = 4;
        for (let i = 0; i < puffCount; i++) {
          const phase = clamp(sf - i * 0.12, 0, 1);
          if (phase <= 0) continue;
          const alpha = clamp(1 - phase, 0, 1) * 0.55;
          if (alpha <= 0) continue;
          const drift = phase * 22;
          const sprite = getSmokePuff(18 + i * 3);
          const sx = p.x - drift * cam.zoom + (hash2(Math.floor(e.pos.x * 4), i, 3) - 0.5) * 6 * cam.zoom;
          const sy = p.y - drift * 1.3 * cam.zoom;
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.drawImage(
            sprite,
            Math.round(sx - (sprite.width * cam.zoom) / 2), Math.round(sy - (sprite.height * cam.zoom) / 2),
            sprite.width * cam.zoom, sprite.height * cam.zoom,
          );
          ctx.restore();
        }
      }
    } else if (e.kind === 'small') {
      // small-arms bullet impact: a brief tan dust puff
      const frac = clamp(e.t / EXPLOSION_LIFE_SMALL, 0, 1);
      if (frac >= 1) continue;
      const alpha = clamp(1 - frac, 0, 1) * 0.75;
      const r = (1.5 + frac * 2) * cam.zoom;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#a89a82';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (e.kind === 'smoke') {
      // smoke round: an expanding, soft white-grey cloud of several puffs
      const frac = clamp(e.t / EXPLOSION_LIFE_SMOKE, 0, 1);
      if (frac >= 1) continue;
      const puffCount = 5;
      for (let i = 0; i < puffCount; i++) {
        const phase = clamp(frac - i * 0.08, 0, 1);
        const alpha = clamp(0.7 * (1 - phase), 0, 0.7);
        if (alpha <= 0) continue;
        const rise = phase * 16;
        const spread = phase * 14;
        const jitter = (hash2(Math.floor(e.pos.x * 4), Math.floor(e.pos.y * 4), i) - 0.5) * spread;
        const sprite = getSmokePuff(20 + i * 4);
        const sx = p.x + jitter * cam.zoom;
        const sy = p.y - rise * cam.zoom;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.drawImage(
          sprite,
          Math.round(sx - (sprite.width * cam.zoom) / 2), Math.round(sy - (sprite.height * cam.zoom) / 2),
          sprite.width * cam.zoom, sprite.height * cam.zoom,
        );
        ctx.restore();
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
      // 3 flickering flame layers at the engine deck: dark-red base, orange
      // middle, yellow-hot core, each jittering independently.
      const layers: { color: string; size: number; jitter: number; seed: number }[] = [
        { color: '#7a1a0a', size: 8, jitter: 1.0, seed: 41 },
        { color: '#ff8a3c', size: 5.5, jitter: 1.6, seed: 53 },
        { color: '#ffe27a', size: 3, jitter: 2.0, seed: 67 },
      ];
      ctx.save();
      for (const L of layers) {
        const jx = (hash2(veh.id, L.seed, Math.floor(t * 9)) - 0.5) * L.jitter;
        const jy = (hash2(veh.id, L.seed + 1, Math.floor(t * 11)) - 0.5) * L.jitter;
        const flicker = 0.75 + hash2(veh.id, L.seed + 2, Math.floor(t * 14)) * 0.25;
        ctx.globalAlpha = 0.85 * flicker;
        ctx.fillStyle = L.color;
        const sx = p.x + jx * cam.zoom;
        const sy = p.y + jy * cam.zoom - 2 * cam.zoom;
        ctx.beginPath();
        ctx.arc(sx, sy, (L.size / 2) * cam.zoom, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // a column of 6-10 rising dark-grey smoke puffs drifting NE, up to 60px high
      const puffCount = 8;
      for (let i = 0; i < puffCount; i++) {
        const phase = ((t * 0.35) + i / puffCount) % 1;
        const alpha = clamp(1 - phase, 0, 1) * 0.5;
        if (alpha <= 0) continue;
        const rise = phase * 60;
        const drift = phase * 24;
        const jitter = (hash2(veh.id, i, 99) - 0.5) * 8;
        const sprite = getSmokePuff(20 + Math.floor(phase * 10));
        const sx = p.x + (drift + jitter) * cam.zoom;
        const sy = p.y - rise * cam.zoom;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.drawImage(
          sprite,
          Math.round(sx - (sprite.width * cam.zoom) / 2), Math.round(sy - (sprite.height * cam.zoom) / 2),
          sprite.width * cam.zoom, sprite.height * cam.zoom,
        );
        ctx.restore();
      }
    } else if (veh.state === 'knockedOut' || veh.state === 'abandoned') {
      // knocked-out (not burning): a thin, slow wisp of smoke
      const phase = (state.time * 0.15 + hash2(veh.id, 1, 2)) % 1;
      const alpha = clamp(1 - phase, 0, 1) * 0.22;
      if (alpha > 0) {
        const sprite = getSmokePuff(10);
        const sx = p.x + (hash2(veh.id, 2, 3) - 0.5) * 4 * cam.zoom;
        const sy = p.y - phase * 20 * cam.zoom;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.drawImage(
          sprite,
          Math.round(sx - (sprite.width * cam.zoom) / 2), Math.round(sy - (sprite.height * cam.zoom) / 2),
          sprite.width * cam.zoom, sprite.height * cam.zoom,
        );
        ctx.restore();
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
