// ============================================================================
// fireFx.ts — fires and building destruction, drawn from pre-rendered sprites (fxSprites.ts):
//  * burning vehicles: the staged burn timeline (spec A3) driven by `veh.fire.t0` — smoke only,
//    small flames on the engine deck, the fierce fire with a black column, dying down, then a
//    smouldering wisp; wrecks knocked out without fire only smoke thinly;
//  * burning trees (sim/trees.ts treeFires);
//  * building breach / cave-in / collapse dust (spec B3).
// Pure functions of the battle clock; flicker and scatter from hash2 (never the sim RNG).
// ============================================================================
import type { Camera, BattleState } from '@/shared/types';
import { VIEW_W, VIEW_H } from '@/shared/types';
import { clamp } from '@/shared/math';
import { hash2 } from '@/shared/rng';
import { worldToScreen } from '@/engine/camera';
import { isServiceable } from '@/sim/vehicleCrew';
import { treeFires } from '@/sim/trees';
import { drawFxAt, drawFxFrame, drawGlow } from '@/render/fxSprites';

/** Burn timeline (s). The flames follow the SIM: they burn while the vehicle is in the 'burning'
 * state (burnTimer counts those seconds) and are out the moment the sim ends the fire; the wreck
 * then smoulders, thick at first, and keeps a thin wisp for good. */
export const FIRE_STAGES_S = {
  /** thick smoke pours out before the flames show */
  flameStart: 2,
  /** flames reach full size */
  fullFlame: 8,
  /** after the fire is out: the smoke thins to a wisp over this long */
  smoulder: 60,
} as const;

/** Flame size (0..1) and smoke strength (0..1) `age` s after the fire started; `burning` = the sim
 * still has the vehicle on fire, `burntS` = how long it burned (veh.burnTimer). Pure (tested). */
export function burnStage(age: number, burning: boolean, burntS: number): { flame: number; smoke: number } {
  const S = FIRE_STAGES_S;
  if (age < 0) return { flame: 0, smoke: 0 };
  if (burning) {
    const flame = clamp((age - S.flameStart) / (S.fullFlame - S.flameStart), 0, 1);
    return { flame: age < S.flameStart ? 0 : 0.35 + 0.65 * flame, smoke: 0.7 + 0.3 * flame };
  }
  const since = Math.max(0, age - burntS);
  return { flame: 0, smoke: 0.25 + 0.45 * Math.max(0, 1 - since / S.smoulder) };
}

const PUFF_PX = 28; // diameter of the rendered puff at scale 1

/** A rising, wind-drifted column of smoke puffs born at `rate` per second at (x, y). Stateless:
 * puff k was born at k / rate; everything follows from `age`. */
export function drawSmokeColumn(
  ctx: CanvasRenderingContext2D, x: number, y: number, age: number, z: number,
  o: { seed: number; rate: number; life: number; size: number; grow: number; alpha: number; dark: boolean; rise?: number },
): void {
  const key = o.dark ? 'puff.dark' : 'puff.light';
  const newest = Math.floor(age * o.rate);
  const n = Math.ceil(o.life * o.rate);
  const rise = o.rise ?? 1;
  for (let j = n; j >= 0; j--) {
    const k = newest - j;
    if (k < 0) continue;
    const pa = age - k / o.rate;
    if (pa < 0 || pa > o.life) continue;
    const f = pa / o.life;
    const jx = (hash2(o.seed, k, 1) - 0.5) * 6, jy = (hash2(o.seed, k, 2) - 0.5) * 4;
    // wind from the south-west: drifts north-east, slowly spreading; rising reads as up-screen
    const px = x + (jx * (0.4 + f) + pa * 3 + f * f * 22) * z;
    const py = y + (jy * (0.4 + f) - (pa * 4.2 + f * 14) * rise) * z;
    const d = (o.size + o.grow * f) * z;
    const a = o.alpha * Math.min(1, pa / 0.6) * (1 - f) ** 1.5;
    drawFxFrame(ctx, key, Math.floor(hash2(o.seed, k, 3) * 6), px, py, d / PUFF_PX, a);
  }
}

function onScreen(x: number, y: number, m: number): boolean {
  return x > -m && y > -m * 2 && x < VIEW_W + m && y < VIEW_H + m;
}

/** Burning / burnt-out vehicles and burning trees. */
export function drawFires(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  const z = cam.zoom;
  const t = state.time;
  for (const veh of state.vehicles.values()) {
    const p = worldToScreen(cam, veh.pos);
    if (!onScreen(p.x, p.y, 140 * z)) continue;
    const fireT0 = veh.fire?.t0 ?? (veh.state === 'burning' ? t - veh.burnTimer : null);
    if (fireT0 == null) {
      if (veh.state === 'knockedOut' || (veh.state === 'abandoned' && !isServiceable(veh))) {
        // knocked out without fire: a thin slow wisp
        drawSmokeColumn(ctx, p.x, p.y - 2 * z, t + hash2(veh.id, 1, 2) * 20, z, { seed: veh.id, rate: 1.1, life: 6, size: 7, grow: 16, alpha: 0.5, dark: true, rise: 0.9 });
      }
      continue;
    }
    const age = t - fireT0;
    const st = burnStage(age, veh.state === 'burning', veh.burnTimer);
    // the fire sits on the engine deck, toward the rear of the hull
    const bx = p.x - Math.sin(veh.hullFacing) * 12 * z, by = p.y + Math.cos(veh.hullFacing) * 12 * z;
    if (st.flame > 0.02) {
      const flick = 0.85 + 0.15 * hash2(veh.id, Math.floor(t * 12), 9);
      drawGlow(ctx, bx, by, (26 + 22 * st.flame) * z * flick, 0.5 * st.flame * flick);
      drawFxAt(ctx, 'fire', t + veh.id * 0.37, bx, by, z * (0.5 + 0.5 * st.flame));
      if (st.flame > 0.7) {
        // a second tongue through the turret / fighting compartment when it really goes
        drawFxAt(ctx, 'fire', t * 1.13 + veh.id, bx + Math.sin(veh.hullFacing) * 9 * z + 2 * z, by - Math.cos(veh.hullFacing) * 9 * z, z * 0.55 * st.flame);
      }
    }
    if (st.smoke > 0) {
      drawSmokeColumn(ctx, bx, by - 2 * z, age, z, {
        seed: veh.id * 7 + 1, rate: 1.5 + 2.5 * st.smoke, life: 5 + 5 * st.smoke,
        size: 7 + 7 * st.smoke, grow: 20 + 30 * st.smoke, alpha: 0.3 + 0.45 * st.smoke, dark: true,
      });
    }
  }
  const trees = treeFires(state.map);
  for (let i = 0; i < trees.length; i++) {
    const tr = trees[i];
    const p = worldToScreen(cam, tr);
    if (!onScreen(p.x, p.y, 100 * z)) continue;
    const seed = Math.floor(tr.x) * 131 + Math.floor(tr.y);
    const flick = 0.85 + 0.15 * hash2(seed, Math.floor(t * 12), 5);
    drawGlow(ctx, p.x, p.y, 24 * z * flick, 0.4 * flick);
    drawFxAt(ctx, 'fire', t + hash2(seed, 1, 1) * 4, p.x, p.y, z * 0.75);
    drawSmokeColumn(ctx, p.x, p.y - 3 * z, t + hash2(seed, 2, 2) * 30, z, { seed, rate: 1.8, life: 7, size: 7, grow: 24, alpha: 0.45, dark: true });
  }
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
        drawDust(ctx, p.x, p.y - 8 * z * burst, (16 + burst * 30) * z, (1 - burst * 0.4) * fade * 0.85);
        drawDust(ctx, p.x + 6 * z, p.y - 12 * z * burst, (12 + burst * 22) * z, fade * 0.7, 3);
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
          const sp = worldToScreen(cam, { x: tileIdx % state.map.width, y: Math.floor(tileIdx / state.map.width) });
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
          const sp = worldToScreen(cam, { x: tileIdx % state.map.width, y: Math.floor(tileIdx / state.map.width) });
          const phase = clamp(t / COLLAPSE_DUST_S + hash2(i, 3, 81) * 0.2, 0, 1);
          drawDust(ctx, sp.x + (hash2(i, 5, 83) - 0.5) * 10 * z, sp.y - phase * 26 * z,
            (14 + phase * 26) * z, fade * 0.8, i);
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



/** A dust puff (building dust): the lit light smoke puff at diameter `d` px. */
function drawDust(ctx: CanvasRenderingContext2D, x: number, y: number, d: number, alpha: number, variant = 0): void {
  if (alpha <= 0 || d <= 0) return;
  drawFxFrame(ctx, 'puff.light', variant % 6, x, y, d / PUFF_PX, clamp(alpha, 0, 1));
}
