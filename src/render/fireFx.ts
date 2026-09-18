// ============================================================================
// fireFx.ts — staged vehicle burn timeline (A3) and building destruction FX
// (B3). Both are pure functions of the sim clock: no per-frame sim cost, all
// flicker/wobble from hash2 so the visuals stay deterministic.
// ============================================================================
import type { Camera, BattleState } from '@/shared/types';
import { VIEW_W, VIEW_H } from '@/shared/types';
import { clamp } from '@/shared/math';
import { hash2 } from '@/shared/rng';
import { worldToScreen } from '@/engine/camera';
import { getSmokePuff } from '@/render/sprites';

/** A3 burn timeline (seconds since `fire.t0`). After `burnt` the parent
 * switches the sprite to the blown variant; we only keep thin smoke beyond. */
export const FIRE_STAGES_S = {
  smokeStart: 0,
  flameStart: 5,
  intenseStart: 20,
  dieDown: 90,
  burnt: 150,
} as const;

function fillCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number): void {
  if (alpha <= 0 || r <= 0) return;
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPuff(ctx: CanvasRenderingContext2D, x: number, y: number, diameterPx: number, alpha: number): void {
  if (alpha <= 0 || diameterPx <= 0) return;
  const size = Math.max(2, Math.round(diameterPx));
  const sprite = getSmokePuff(size);
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.drawImage(sprite, Math.round(x - diameterPx / 2), Math.round(y - diameterPx / 2), diameterPx, diameterPx);
  ctx.restore();
}

function flameLayer(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, alpha: number): void {
  if (alpha <= 0 || w <= 0 || h <= 0) return;
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A3: staged vehicle fire. `veh.fire.t0` drives everything from the sim clock. */
export function drawVehicleFire(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, VIEW_W, VIEW_H);
  ctx.clip();
  const z = cam.zoom;
  for (const veh of state.vehicles.values()) {
    if (!veh.fire) continue;
    const age = state.time - veh.fire.t0;
    if (age < 0) continue;
    const p = worldToScreen(cam, veh.pos);
    const flickStep = Math.floor(age * 4); // ~4 Hz flicker

    // ---- smoke column (all stages; density/height scale with the stage) ----
    let puffAlpha = 0.3, puffScale = 0.7, puffCount = 6;
    if (age >= FIRE_STAGES_S.intenseStart && age < FIRE_STAGES_S.dieDown) {
      puffAlpha = 0.95; puffScale = 1.4; puffCount = 12;
    } else if (age >= FIRE_STAGES_S.dieDown) {
      const k = clamp(1 - (age - FIRE_STAGES_S.dieDown) / (FIRE_STAGES_S.burnt - FIRE_STAGES_S.dieDown), 0.2, 1);
      puffAlpha = 0.6 * k; puffScale = 1.0 * k; puffCount = 8;
    }
    for (let i = 0; i < puffCount; i++) {
      const phase = ((age * 0.25) + i / puffCount) % 1;
      const alpha = clamp(1 - phase, 0, 1) * puffAlpha;
      if (alpha <= 0) continue;
      const rise = phase * 90 * puffScale;
      const drift = phase * 34; // wind offset toward NE
      const jitter = (hash2(veh.id, i, 99) - 0.5) * 10;
      const diam = (26 + phase * 18) * puffScale * z;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#1e1b18';
      ctx.beginPath();
      ctx.arc(p.x + (drift + jitter) * z, p.y - rise * z, diam / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (age < FIRE_STAGES_S.flameStart) {
      // 0-5 s: thin gray wisps from the engine deck only
      const phase = ((age * 0.5) + hash2(veh.id, 1, 2)) % 1;
      const alpha = clamp(1 - phase, 0, 1) * 0.4;
      if (alpha > 0) {
        const sx = p.x + (hash2(veh.id, 2, 3) - 0.5) * 4 * z;
        const sy = p.y - phase * 22 * z;
        drawPuff(ctx, sx, sy, 9 * z, alpha);
      }
      continue;
    }

    // ---- flames ----
    let flameScale = 1;
    if (age >= FIRE_STAGES_S.dieDown) {
      flameScale = clamp(1 - (age - FIRE_STAGES_S.dieDown) / (FIRE_STAGES_S.burnt - FIRE_STAGES_S.dieDown), 0, 1);
      if (flameScale <= 0) continue;
    }
    const intense = age >= FIRE_STAGES_S.intenseStart && age < FIRE_STAGES_S.dieDown;
    // heat bloom under the flames
    fillCircle(ctx, p.x, p.y - 1 * z, (intense ? 16 : 12) * flameScale * z, '#8a4a20', 0.4);
    // layered noisy ellipses: dark red base -> orange -> yellow -> white core,
    // flicker phase from hash2 so it is deterministic per vehicle.
    const layers: { color: string; w: number; h: number; ox: number; oy: number; seed: number }[] = intense
      ? [
          { color: '#7a1a0a', w: 22, h: 26, ox: 0, oy: 0, seed: 41 },
          { color: '#ff8a3c', w: 16, h: 22, ox: 3, oy: -5, seed: 53 },
          { color: '#ffe27a', w: 9, h: 15, ox: 4, oy: -8, seed: 67 },
          { color: '#ffffff', w: 4, h: 7, ox: 4, oy: -10, seed: 71 },
        ]
      : [
          { color: '#7a1a0a', w: 14, h: 11, ox: 0, oy: 0, seed: 41 },
          { color: '#ff8a3c', w: 10, h: 9, ox: 3, oy: -3, seed: 53 },
          { color: '#ffe27a', w: 6, h: 5, ox: 4, oy: -4, seed: 67 },
        ];
    for (const L of layers) {
      const jx = (hash2(veh.id, L.seed + 3, flickStep) - 0.5) * 8;
      const jy = (hash2(veh.id, L.seed + 4, flickStep) - 0.5) * 8;
      const flicker = (0.8 + hash2(veh.id, L.seed + 2, Math.floor(age * 14)) * 0.2) * flameScale;
      const cx = clamp(L.ox + jx * 0.5, -4, 5);
      const cy = clamp(L.oy + jy * 0.5, -10, 4);
      flameLayer(ctx, p.x + cx * z, p.y + (cy - 2) * z, L.w * flameScale * z, L.h * flameScale * z, L.color, flicker);
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------ structure FX
const BREACH_BURST_S = 1.5;   // chips/dust burst, then a settling rubble pile
const BREACH_DUST_S = 10;     // lingering dust fade
const COLLAPSE_WALL_S = 1.5;  // wall silhouettes shrink/fall
const COLLAPSE_DUST_S = 15;   // lingering dust cloud (10-20 s)

const CHIP_COLORS: Record<'stone' | 'wood', string> = { stone: '#6a6864', wood: '#7a5a34' };

/** B3: building destruction visuals — breach, cave-in, collapse. */
export function drawStructureFx(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, VIEW_W, VIEW_H);
  ctx.clip();
  const z = cam.zoom;
  for (const fx of state.structureFx) {
    const t = state.time - fx.t0;
    if (t < 0) continue;
    const p = worldToScreen(cam, fx.pos);
    const mat: 'stone' | 'wood' = fx.stone ? 'stone' : 'wood';
    const dustColor = fx.stone ? '#a29a8c' : '#a88a68';

    if (fx.kind === 'breach' || fx.kind === 'caveIn') {
      const burst = clamp(t / BREACH_BURST_S, 0, 1);
      const fade = clamp(1 - (t - BREACH_BURST_S) / (BREACH_DUST_S - BREACH_BURST_S), 0, 1);
      if (fade > 0) {
        // outward dust burst
        drawPuff(ctx, p.x, p.y - 8 * z * burst, (16 + burst * 30) * z, (1 - burst * 0.4) * fade * 0.85);
        drawPuff(ctx, p.x + 6 * z, p.y - 12 * z * burst, (12 + burst * 22) * z, fade * 0.7);
        // material chips flying outward with small ballistic arcs
        ctx.save();
        ctx.fillStyle = CHIP_COLORS[mat];
        ctx.globalAlpha = fade;
        for (let i = 0; i < 5; i++) {
          const a = hash2(Math.round(fx.pos.x * 8), i, 61) * Math.PI * 2;
          const d = (3 + burst * (8 + hash2(i, 7, 63) * 6)) * z;
          const lift = Math.sin(Math.PI * clamp(burst, 0, 1)) * 8 * z;
          ctx.beginPath();
          ctx.arc(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d - lift, 1.5 * z, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      // settling rubble pile (breach only): dark lumps growing into place
      if (fx.kind === 'breach' && burst > 0.3) {
        const settle = clamp((burst - 0.3) / 0.7, 0, 1);
        ctx.save();
        ctx.fillStyle = fx.stone ? '#55524e' : '#5a4428';
        ctx.globalAlpha = settle * 0.9;
        for (let i = 0; i < 3; i++) {
          const rx = (hash2(Math.round(fx.pos.x * 8), i, 77) - 0.5) * 8 * z;
          ctx.beginPath();
          ctx.arc(p.x + rx, p.y + i * z, (2 + hash2(i, 9, 79) * 2) * z * settle, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    } else {
      // collapse: staged over extentTiles
      const wallPhase = clamp(t / COLLAPSE_WALL_S, 0, 1);
      const fade = clamp(1 - (t - COLLAPSE_WALL_S) / (COLLAPSE_DUST_S - COLLAPSE_WALL_S), 0, 1);
      // shrinking wall silhouettes along the wall line
      if (wallPhase < 1) {
        ctx.save();
        ctx.fillStyle = fx.stone ? '#6d6a66' : '#6b5230';
        for (const tileIdx of fx.extentTiles) {
          const tx = (tileIdx % 64) * 20, ty = Math.floor(tileIdx / 64) * 20; // TILE_PX world grid
          const sp = worldToScreen(cam, { x: tx / 20, y: ty / 20 });
          const h = 20 * z * (1 - wallPhase);
          if (h <= 0.5) continue;
          ctx.globalAlpha = clamp(1 - wallPhase * 0.5, 0, 1);
          ctx.fillRect(sp.x, sp.y + (20 * z - h), 20 * z, h);
        }
        ctx.restore();
      }
      // dust puffs along the wall line
      if (fade > 0) {
        for (let i = 0; i < fx.extentTiles.length && i < 8; i++) {
          const tileIdx = fx.extentTiles[i];
          const tx = (tileIdx % 64) * 20, ty = Math.floor(tileIdx / 64) * 20;
          const sp = worldToScreen(cam, { x: tx / 20, y: ty / 20 });
          const phase = clamp(t / COLLAPSE_DUST_S + hash2(i, 3, 81) * 0.2, 0, 1);
          drawPuff(ctx, sp.x + (hash2(i, 5, 83) - 0.5) * 10 * z, sp.y - phase * 26 * z,
            (14 + phase * 26) * z, fade * 0.8);
        }
        // bouncing debris chunks
        if (t < COLLAPSE_WALL_S + 1) {
          const bp = clamp(t / 1.2, 0, 1);
          ctx.save();
          ctx.fillStyle = CHIP_COLORS[mat];
          ctx.globalAlpha = clamp(1 - bp, 0, 1);
          for (let i = 0; i < 6; i++) {
            const a = hash2(Math.round(fx.pos.x * 8), i, 85) * Math.PI * 2;
            const d = bp * (6 + hash2(i, 11, 87) * 10) * z;
            const bounce = Math.abs(Math.sin(bp * Math.PI * 2)) * 6 * z * (1 - bp);
            ctx.beginPath();
            ctx.arc(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d - bounce, 1.6 * z, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }
      }
    }
  }
  ctx.restore();
}
