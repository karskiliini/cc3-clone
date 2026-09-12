// ============================================================================
// effects.ts — muzzle flashes, tracers, explosions, smoke and burning-vehicle
// flicker/smoke. Kept cheap: no shadows/blur, just flat fills.
// ============================================================================
import type { Camera, BattleState } from '@/shared/types';
import { VIEW_W, VIEW_H } from '@/shared/types';
import { clamp } from '@/shared/math';
import { hash2 } from '@/shared/rng';
import { worldToScreen } from '@/engine/camera';
import { getSmokePuff } from '@/render/sprites';

const FLASH_LIFE = 0.1;
const TRACER_LIFE = 0.15;
const EXPLOSION_LIFE = 1.0;

function drawFlashes(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  for (const f of state.flashes) {
    const alpha = clamp(1 - f.t / FLASH_LIFE, 0, 1);
    if (alpha <= 0) continue;
    const dx = Math.sin(f.facing) * 6;
    const dy = -Math.cos(f.facing) * 6;
    const p = worldToScreen(cam, { x: f.pos.x, y: f.pos.y });
    const sx = p.x + dx * cam.zoom;
    const sy = p.y + dy * cam.zoom;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#fff6c8';
    ctx.fillRect(Math.round(sx) - 1, Math.round(sy) - 1, 2, 2);
    ctx.fillStyle = '#ffe08a';
    ctx.fillRect(Math.round(sx) - 2, Math.round(sy), 4, 1);
    ctx.fillRect(Math.round(sx), Math.round(sy) - 2, 1, 4);
    ctx.restore();
  }
}

function drawTracers(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  for (const t of state.tracers) {
    if (t.kind === 'mortar') continue;
    const alpha = clamp(1 - t.t / TRACER_LIFE, 0, 1) * (t.kind === 'shell' ? 0.9 : 0.8);
    if (alpha <= 0) continue;
    const from = worldToScreen(cam, t.from);
    const to = worldToScreen(cam, t.to);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = t.kind === 'shell' ? '#ff9a3c' : '#ffe08a';
    ctx.lineWidth = t.kind === 'shell' ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }
}

function drawExplosions(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  for (const e of state.explosions) {
    const frac = clamp(e.t / EXPLOSION_LIFE, 0, 1);
    const p = worldToScreen(cam, e.pos);
    if (e.kind === 'he') {
      const maxR = Math.max(3, e.radiusM * 5) * cam.zoom;
      const r = (3 + (maxR - 3) * frac);
      const coreAlpha = clamp(1 - frac * 1.3, 0, 1);
      const smokeAlpha = clamp(1 - frac, 0, 1) * 0.6;
      ctx.save();
      ctx.globalAlpha = smokeAlpha;
      ctx.strokeStyle = '#6a6a6a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = coreAlpha;
      ctx.fillStyle = '#ff9a3c';
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1, r * 0.5), 0, Math.PI * 2);
      ctx.fill();
      if (frac < 0.4) {
        ctx.globalAlpha = clamp(1 - frac / 0.4, 0, 1);
        ctx.fillStyle = '#ffe08a';
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const sr = r * 1.1;
          ctx.fillRect(Math.round(p.x + Math.cos(a) * sr), Math.round(p.y + Math.sin(a) * sr), 1, 1);
        }
      }
      ctx.restore();
    } else if (e.kind === 'small') {
      const alpha = clamp(1 - frac, 0, 1) * 0.8;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#8a8a86';
      ctx.fillRect(Math.round(p.x - 2), Math.round(p.y - 2), 4, 4);
      ctx.restore();
    } else if (e.kind === 'smoke') {
      const alpha = clamp(1 - frac, 0, 1) * 0.5;
      const r = (4 + frac * 10) * cam.zoom;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#c9c9c0';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

function drawBurningVehicles(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  for (const veh of state.vehicles.values()) {
    if (veh.state !== 'burning') continue;
    const p = worldToScreen(cam, veh.pos);
    const t = veh.burnTimer;
    // flicker
    const flick = hash2(Math.floor(t * 8), veh.id, 42);
    if (flick > 0.35) {
      ctx.save();
      ctx.fillStyle = flick > 0.7 ? '#ffcf6a' : '#ff8a3c';
      ctx.fillRect(Math.round(p.x - 1), Math.round(p.y - 1), 3, 3);
      ctx.restore();
    }
    // rising smoke puffs
    const puffCount = 3;
    for (let i = 0; i < puffCount; i++) {
      const phase = ((t * 0.6) + i / puffCount) % 1;
      const alpha = clamp(1 - phase, 0, 1) * 0.6;
      if (alpha <= 0) continue;
      const jitter = (hash2(veh.id, i, 99) - 0.5) * 6;
      const sprite = getSmokePuff(16);
      const sx = p.x + jitter * cam.zoom;
      const sy = p.y - phase * 8 * cam.zoom;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, Math.round(sx - (sprite.width * cam.zoom) / 2), Math.round(sy - (sprite.height * cam.zoom) / 2), sprite.width * cam.zoom, sprite.height * cam.zoom);
      ctx.restore();
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
