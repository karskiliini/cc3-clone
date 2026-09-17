// ============================================================================
// effects.ts — muzzle flashes, tracers, explosions, smoke and burning-vehicle
// flicker/smoke. Kept cheap: no shadows/blur, just flat fills and cached
// smoke-puff sprites. Sized boldly (per direct comparison against
// ref/ref_cc3_1482..1485.png) so effects read clearly even at 1x zoom.
// ============================================================================
import type { Camera, BattleState, Vec2 } from '@/shared/types';
import {
  VIEW_W, VIEW_H, FLASH_LIFE, TRACER_LIFE, EXPLOSION_LIFE_HE, EXPLOSION_LIFE_SMALL, EXPLOSION_LIFE_SMOKE,
} from '@/shared/types';
import { clamp } from '@/shared/math';
import { hash2 } from '@/shared/rng';
import { worldToScreen } from '@/engine/camera';
import { getSmokePuff } from '@/render/sprites';
import { tileAt } from '@/sim/map';
import { isServiceable } from '@/sim/vehicleCrew';
import type { Terrain } from '@/shared/types';

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

// Dark burning-vehicle smoke puff. Kept local (cache keyed `smokeDark|size`)
// so the shared light getSmokePuff used by muzzle/explosion/terrain smoke is
// untouched.
const darkPuffCache = new Map<string, HTMLCanvasElement>();
function getDarkSmokePuff(size: number): HTMLCanvasElement {
  const key = `smokeDark|${size}`;
  let c = darkPuffCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d')!;
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  // wf19: a darker, denser core so burning-wreck and shell smoke keep their weight on the
  // brighter ground
  grad.addColorStop(0, 'rgba(30,27,24,0.94)');
  grad.addColorStop(0.6, 'rgba(42,38,34,0.55)');
  grad.addColorStop(1, 'rgba(40,38,35,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(r, r, r, 0, Math.PI * 2);
  g.fill();
  darkPuffCache.set(key, c);
  return c;
}

function drawPuff(ctx: CanvasRenderingContext2D, x: number, y: number, diameterPx: number, alpha: number, dark = false): void {
  if (alpha <= 0 || diameterPx <= 0) return;
  const size = Math.max(2, Math.round(diameterPx));
  const sprite = dark ? getDarkSmokePuff(size) : getSmokePuff(size);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(sprite, Math.round(x - diameterPx / 2), Math.round(y - diameterPx / 2), diameterPx, diameterPx);
  ctx.restore();
}

/** wf19 additive-looking hot core: a small white centre plus an additive ('lighter') warm bloom
 * around it. On dark ground the bloom glows; on bright ground / snow, where an additive pass
 * alone would vanish, the opaque white centre and the dark rim under it keep the flash legible. */
function hotCore(ctx: CanvasRenderingContext2D, x: number, y: number, coreR: number, bloomR: number, alpha: number): void {
  if (alpha <= 0) return;
  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha * 0.55;
  ctx.fillStyle = '#ff8a30';
  ctx.beginPath(); ctx.arc(x, y, bloomR, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = alpha * 0.7;
  ctx.fillStyle = '#ffc860';
  ctx.beginPath(); ctx.arc(x, y, (coreR + bloomR) / 2, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = prev;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(x, y, Math.max(1, coreR * 0.6), 0, Math.PI * 2); ctx.fill();
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
    if (big) {
      // tank gun: small irregular yellow-white flicker (no geometric cross)
      const haloD = 12 * cam.zoom;
      const coreD = 8 * cam.zoom;
      const hx = Math.floor(f.pos.x * 4), hy = Math.floor(f.pos.y * 4);
      ctx.save();
      ctx.globalAlpha = alpha * 0.7;
      ctx.fillStyle = '#ff9a3c';
      ctx.beginPath();
      ctx.arc(sx, sy, haloD / 2, 0, Math.PI * 2);
      ctx.fill();
      // 5-7 short spokes fanned roughly along the firing direction
      const nSpokes = 5 + Math.floor(hash2(hx, hy, 31) * 3);
      ctx.strokeStyle = '#ffd070';
      ctx.lineWidth = 1; // screen-space width
      ctx.globalAlpha = alpha * 0.9;
      ctx.beginPath();
      for (let i = 0; i < nSpokes; i++) {
        const ang = f.facing + (hash2(hx, hy, i) - 0.5) * (Math.PI * 2 / 3);
        const ux = Math.sin(ang), uy = -Math.cos(ang);
        const start = coreD / 2 * 0.6;
        const len = (2 + hash2(hy, hx, i + 11) * 4) * cam.zoom + haloD / 2 - start;
        ctx.moveTo(sx + ux * start, sy + uy * start);
        ctx.lineTo(sx + ux * (start + len), sy + uy * (start + len));
      }
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#fff2b0';
      ctx.beginPath();
      ctx.arc(sx, sy, coreD / 2, 0, Math.PI * 2);
      ctx.fill();
      hotCore(ctx, sx, sy, coreD / 2, haloD * 0.9, alpha);
      ctx.restore();
    } else {
      // infantry: 10px star
      const haloD = 10 * cam.zoom;
      const coreD = 5 * cam.zoom;
      ctx.save();
      ctx.globalAlpha = alpha * 0.95;
      ctx.fillStyle = '#ff9a3c';
      ctx.beginPath();
      ctx.arc(sx, sy, haloD / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ff9a3c';
      ctx.lineWidth = 1.5; // screen-space width — not scaled with zoom
      const spike = haloD / 2 + 4 * cam.zoom;
      ctx.beginPath();
      ctx.moveTo(sx - spike, sy); ctx.lineTo(sx + spike, sy);
      ctx.moveTo(sx, sy - spike); ctx.lineTo(sx, sy + spike);
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#fff2b0';
      ctx.beginPath();
      ctx.arc(sx, sy, coreD / 2, 0, Math.PI * 2);
      ctx.fill();
      hotCore(ctx, sx, sy, coreD / 2, haloD * 0.8, alpha);
      ctx.restore();
    }

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
    // wf19: a thin dark under-stroke so the streak keeps its edge on bright grass and snow
    ctx.strokeStyle = 'rgba(40,18,4,0.4)';
    ctx.lineWidth = width + 1.5;
    ctx.globalAlpha = fadeOut;
    ctx.beginPath();
    ctx.moveTo(hbx, hby);
    ctx.lineTo(hx, hy);
    ctx.stroke();
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
      const maxR = Math.max(16, e.radiusM * 6) * cam.zoom;

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

      // irregular fireball: overlapping jittered blobs (dark -> orange -> a
      // little yellow), never concentric, handing over to smoke by frac 0.3.
      if (frac < 0.45) {
        const bf = clamp(frac / 0.28, 0, 1); // reaches full size by frac≈0.28
        const r = maxR * bf;
        const fireAlpha = clamp(1 - Math.max(0, frac - 0.28) / 0.17, 0.15, 1) * (frac < 0.3 ? 1 : clamp(1 - (frac - 0.3) / 0.15, 0, 1));
        const kx = Math.floor(e.pos.x * 4), ky = Math.floor(e.pos.y * 4);
        const blob = (i: number, color: string, sMin: number, sMax: number, spread: number): void => {
          const ox = (hash2(kx, ky, i * 3 + 1) - 0.5) * 2 * spread * r;
          const oy = (hash2(ky, kx, i * 3 + 2) - 0.5) * 2 * spread * r;
          const br = r * (sMin + hash2(kx + i, ky, 17) * (sMax - sMin));
          fillCircle(ctx, p.x + ox, p.y + oy, br, color, 0.8 * fireAlpha);
        };
        const nDark = 3 + Math.floor(hash2(kx, ky, 41) * 2); // 3-4
        const nOrange = 2 + Math.floor(hash2(ky, kx, 43) * 2); // 2-3
        const nYellow = 1 + Math.floor(hash2(kx, ky, 47) * 2); // 1-2
        let idx = 0;
        for (let i = 0; i < nDark; i++) blob(idx++, '#6a2a14', 0.45, 0.6, 0.35);
        for (let i = 0; i < nOrange; i++) blob(idx++, '#d86a2c', 0.35, 0.5, 0.35);
        for (let i = 0; i < nYellow; i++) blob(idx++, '#ffd070', 0.15, 0.25, 0.25);
        if (frac < 0.3) hotCore(ctx, p.x, p.y, r * 0.16, r * 0.55, fireAlpha * 0.9);

        // 6-8 short dark debris streaks
        const n = 6 + Math.floor(hash2(kx, ky, 53) * 3);
        ctx.save();
        ctx.strokeStyle = '#241f1c';
        ctx.lineWidth = 1; // screen-space width — not scaled with zoom
        ctx.globalAlpha = fireAlpha;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const a = hash2(kx, ky, i + 60) * Math.PI * 2;
          const dr = r * (0.6 + hash2(i, kx, 7) * 0.6);
          const len = (2 + hash2(i, 3, ky) * 3) * cam.zoom;
          const ex = p.x + Math.cos(a) * dr, ey = p.y + Math.sin(a) * dr;
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex + Math.cos(a) * len, ey + Math.sin(a) * len);
        }
        ctx.stroke();
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
            // grey-brown tint: a darker puff under the first two light ones
            if (i < 3) drawPuff(ctx, p.x + jitter, p.y + jitterY, smokeR * 0.7, smokeAlpha * 0.5, true);
          }
        }
      }
    } else if (e.kind === 'small') {
      // small-arms bullet impact: a brief dust puff
      const frac = clamp(e.t / EXPLOSION_LIFE_SMALL, 0, 1);
      if (frac >= 1) continue;
      const alpha = clamp(1 - frac, 0, 1) * 0.8;
      const d = (3 + frac * 3) * 2 * cam.zoom; // ~6px diameter
      fillCircle(ctx, p.x, p.y, d / 2 + 1, '#4a3f30', alpha * 0.45);
      fillCircle(ctx, p.x, p.y, d / 2, '#c2b394', alpha);
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
      const z = cam.zoom;
      // translucent heat bloom under the flames
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#8a4a20';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y - 1 * z, 15 * z, 12 * z, 0, 0, Math.PI * 2);
      ctx.fill();
      // 3 non-concentric flickering flame layers (<=18px across): dark-red
      // base ellipse, orange tongue offset toward the plume (NE), small yellow core.
      const layers: { color: string; w: number; h: number; ox: number; oy: number; seed: number }[] = [
        { color: '#7a1a0a', w: 16, h: 12, ox: 0, oy: 0, seed: 41 },
        { color: '#ff8a3c', w: 12, h: 10, ox: 3, oy: -3, seed: 53 },
        { color: '#ffe27a', w: 7, h: 6, ox: 4, oy: -4, seed: 67 },
      ];
      for (const L of layers) {
        const step = Math.floor(t * 8);
        const jx = (hash2(veh.id, L.seed + 3, step) - 0.5) * 8;
        const jy = (hash2(veh.id, L.seed + 4, step) - 0.5) * 8;
        const flicker = 0.8 + hash2(veh.id, L.seed + 2, Math.floor(t * 14)) * 0.2;
        const clampX = clamp(L.ox + jx * 0.5, -4, 5);
        const clampY = clamp(L.oy + jy * 0.5, -5, 4);
        ctx.globalAlpha = flicker;
        ctx.fillStyle = L.color;
        ctx.beginPath();
        ctx.ellipse(p.x + clampX * z, p.y + (clampY - 2) * z, (L.w / 2) * z, (L.h / 2) * z, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // a dense column of 10-12 dark smoke puffs (24-40px), drifting NE and
      // rising up to 90px, reading clearly as a burning-vehicle plume.
      const puffCount = 11;
      for (let i = 0; i < puffCount; i++) {
        const phase = ((t * 0.3) + i / puffCount) % 1;
        const alpha = clamp(1 - phase, 0, 1) * 0.9;
        if (alpha <= 0) continue;
        const rise = phase * 90;
        const drift = phase * 34;
        const jitter = (hash2(veh.id, i, 99) - 0.5) * 10;
        const diam = (30 + phase * 18) * cam.zoom;
        const sx = p.x + (drift + jitter) * cam.zoom;
        const sy = p.y - rise * cam.zoom;
        drawPuff(ctx, sx, sy, diam, alpha, true);
      }
    } else if (veh.state === 'knockedOut' || (veh.state === 'abandoned' && !isServiceable(veh))) {
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

// ------------------------------------------------------------- movement dust
const NO_DUST = new Set<Terrain>(['water', 'bridge', 'pavedroad', 'floor', 'buildingWood', 'buildingStone', 'mud', 'woods']);

/** wf19: small dust kicks under running soldiers' feet and a dust trail behind moving vehicles
 * on dry ground; in winter (snow everywhere, roads included) a fainter white snow spray instead.
 * Stateless — puffs are a pure function of sim time and the unit id, so there is no particle
 * list to age — and only computed for units that are actually moving and on screen. */
function drawMovementDust(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  if (cam.zoom <= 0.5) return;
  const winter = state.map.def.season === 'winter';
  const color = winter ? '#f2f5f8' : '#c4b48c';
  const base = winter ? 0.3 : 0.42;
  const z = cam.zoom;
  const viewer = state.config.playerSide;
  const dusty = (x: number, y: number): boolean => {
    const t = tileAt(state.map, Math.floor(x), Math.floor(y));
    if (NO_DUST.has(t)) return false;
    return winter || t !== 'snow';
  };
  ctx.save();
  ctx.fillStyle = color;
  for (const s of state.soldiers.values()) {
    if (s.path.length === 0 || s.vehicleId != null || s.health !== 'healthy' && s.health !== 'wounded') continue;
    if (s.activity !== 'movingFast' && s.activity !== 'panicked' && s.activity !== 'routed' && s.activity !== 'berserk') continue;
    if (s.side !== viewer && !state.spotted[viewer].has(s.id)) continue;
    const p = worldToScreen(cam, s.pos);
    if (p.x < -8 || p.y < -8 || p.x > VIEW_W + 8 || p.y > VIEW_H + 8) continue;
    if (!dusty(s.pos.x, s.pos.y)) continue;
    const a = (s.facing * Math.PI) / 4;
    const bx = -Math.sin(a), by = Math.cos(a); // behind him
    for (let i = 0; i < 2; i++) {
      const phase = (state.time * 2.4 + i * 0.5 + (s.id % 7) * 0.143) % 1;
      const r = (0.8 + phase * 1.8) * z;
      const d = (5 + phase * 5) * z;
      const side = (i === 0 ? -1 : 1) * 1.5 * z;
      ctx.globalAlpha = base * (1 - phase);
      ctx.beginPath();
      ctx.arc(p.x + bx * d - by * side, p.y + by * d + bx * side, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  for (const v of state.vehicles.values()) {
    if (v.state !== 'ok' || v.speed <= 0.3 || v.path.length === 0) continue;
    if (v.side !== viewer && !state.spottedVehicles[viewer].has(v.id)) continue;
    const p = worldToScreen(cam, v.pos);
    if (p.x < -60 || p.y < -60 || p.x > VIEW_W + 60 || p.y > VIEW_H + 60) continue;
    if (!dusty(v.pos.x, v.pos.y)) continue;
    const bx = -Math.sin(v.hullFacing), by = Math.cos(v.hullFacing);
    const k = clamp(v.speed / 6, 0.35, 1);
    for (let i = 0; i < 8; i++) {
      const phase = (state.time * 0.9 + i / 8) % 1;
      const track = (i % 2 === 0 ? -1 : 1) * 11 * z;
      const back = (26 + phase * 34) * z;
      const jit = (hash2(v.id, i, 5) - 0.5) * 6 * z;
      drawDustPuff(ctx, p.x + bx * back - by * (track + jit), p.y + by * back + bx * (track + jit) - phase * 5 * z, (9 + phase * 16) * z, base * 0.9 * k * (1 - phase) * Math.min(1, phase * 6), winter);
    }
  }
}

const dustPuffCache = new Map<string, HTMLCanvasElement>();
function drawDustPuff(ctx: CanvasRenderingContext2D, x: number, y: number, d: number, alpha: number, winter: boolean): void {
  if (alpha <= 0.01) return;
  const size = Math.max(4, Math.round(d / 4) * 4); // quantised: a handful of cached sizes
  const key = `${winter ? 'w' : 's'}${size}`;
  let c = dustPuffCache.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = size; c.height = size;
    const g = c.getContext('2d')!;
    const r = size / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    const rgb = winter ? '240,244,248' : '190,172,130';
    grad.addColorStop(0, `rgba(${rgb},0.85)`);
    grad.addColorStop(0.55, `rgba(${rgb},0.4)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.beginPath(); g.arc(r, r, r, 0, Math.PI * 2); g.fill();
    dustPuffCache.set(key, c);
  }
  ctx.globalAlpha = alpha;
  ctx.drawImage(c, x - d / 2, y - d / 2, d, d);
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------ ragdoll landing dust (§4)
interface LandingDust { x: number; y: number; t0: number; force: number }
const landings: LandingDust[] = [];
const LANDING_LIFE = 0.8;

/** A thrown body has just hit the ground at `pos` (tiles): a ring of dust, or snow spray in winter. */
export function spawnLandingDust(pos: Vec2, time: number, force = 1): void {
  if (landings.length > 40) landings.shift();
  landings.push({ x: pos.x, y: pos.y, t0: time, force: Math.max(0.4, Math.min(1.5, force)) });
}

function drawLandingDust(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  if (landings.length === 0) return;
  const winter = state.map.def.season === 'winter';
  for (let i = landings.length - 1; i >= 0; i--) {
    const L = landings[i];
    const age = state.time - L.t0;
    if (age < 0 || age > LANDING_LIFE) { landings.splice(i, 1); continue; }
    const f = age / LANDING_LIFE;
    const p = worldToScreen(cam, L);
    if (p.x < -40 || p.y < -40 || p.x > VIEW_W + 40 || p.y > VIEW_H + 40) continue;
    const z = cam.zoom;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + hash2(Math.floor(L.x * 8), Math.floor(L.y * 8), k) * 0.9;
      const r = (3 + f * 9 * L.force) * z;
      drawDustPuff(ctx, p.x + Math.cos(a) * r, p.y + Math.sin(a) * r * 0.7 - f * 3 * z, (6 + f * 10) * z * (0.7 + 0.3 * L.force), (winter ? 0.5 : 0.6) * (1 - f), winter);
    }
  }
}

export function drawEffects(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, VIEW_W, VIEW_H);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;

  drawMovementDust(ctx, cam, state);
  drawLandingDust(ctx, cam, state);
  drawBurningVehicles(ctx, cam, state);
  drawExplosions(ctx, cam, state);
  drawTracers(ctx, cam, state);
  drawFlashes(ctx, cam, state);

  ctx.restore();
}
