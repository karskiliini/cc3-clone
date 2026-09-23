// ============================================================================
// effects.ts — everything short-lived on the battlefield: bursts (pre-rendered flipbooks from
// tools/blender/fx.py via fxSprites.ts), impact sparks, rounds in flight, tracers, muzzle flashes,
// movement / landing dust; fires and building dust come from fireFx.ts. Rendering only: reads
// the sim state and the battle clock, never the sim RNG.
// ============================================================================
import type { Camera, BattleState, Vec2, Explosion, Spark } from '@/shared/types';
import { VIEW_W, VIEW_H, FLASH_LIFE, TRACER_LIFE } from '@/shared/types';
import { clamp } from '@/shared/math';
import { hash2 } from '@/shared/rng';
import { worldToScreen } from '@/engine/camera';
import { WEAPONS } from '@/data/weapons';
import { drawFxAt, drawFxFrame, drawGlow, fxDuration, fxSeasonKey } from '@/render/fxSprites';
import { drawFires, drawStructureFx } from '@/render/fireFx';
import { tileAt } from '@/sim/map';
import type { Terrain } from '@/shared/types';

// ------------------------------------------------------------------- flashes
/** Muzzle flashes: a warm additive glow on the ground plus a small opaque flame tongue along the
 * bore (the opaque part keeps it legible on snow, where additive light alone disappears). Tank and
 * AT guns get a bigger tongue with muzzle-brake side jets and a puff of gun smoke. */
function drawFlashes(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  const z = cam.zoom;
  for (const f of state.flashes) {
    const frac = clamp(f.t / FLASH_LIFE, 0, 1);
    if (frac >= 1) continue;
    const big = f.kind === 'shell';
    const alpha = frac < 0.4 ? 1 : 1 - (frac - 0.4) / 0.6;
    const ux = Math.sin(f.facing), uy = -Math.cos(f.facing);
    const p = worldToScreen(cam, f.pos);
    const standoff = (big ? 13 : 7) * z;
    const sx = p.x + ux * standoff, sy = p.y + uy * standoff;
    if (big) {
      drawFxFrame(ctx, 'puff.light', Math.floor(f.pos.x * 7) % 6, sx + ux * 6 * z, sy + uy * 6 * z, 0.45 * z * (0.8 + frac * 0.8), (1 - frac) * 0.6);
    }
    drawGlow(ctx, sx, sy, (big ? 22 : 8) * z, alpha * (big ? 0.8 : 0.55), '255,190,90');
    if (frac > 0.5) continue; // the flame itself is over in an instant; the glow and smoke linger
    const len = (big ? 7 : 3.2) * z * (1 - frac), wid = (big ? 2.6 : 1.3) * z;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(f.facing);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#ffb040';
    ctx.beginPath(); ctx.ellipse(0, -len * 0.5, wid, len, 0, 0, Math.PI * 2); ctx.fill();
    if (big) {
      ctx.beginPath(); ctx.ellipse(-3 * z, -1 * z, 2.4 * z, 1.1 * z, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(3 * z, -1 * z, 2.4 * z, 1.1 * z, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#fff6d8';
    ctx.beginPath(); ctx.ellipse(0, -len * 0.35, wid * 0.55, len * 0.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

// ------------------------------------------------------------------- tracers
function drawTracers(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  const rockets = state.projectiles.filter((p) => p.kind === 'atrocket');
  for (const t of state.tracers) {
    if (t.kind === 'mortar') continue;
    // a rocket is drawn as itself (drawProjectiles), not as a shell streak
    if (t.kind === 'shell' && rockets.some((r) => r.from.x === t.from.x && r.from.y === t.from.y)) continue;
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
// Every explosion record the sim pushes starts a flipbook instance here (the sim drops its record
// after EXPLOSION_LIFE_*, the burst's smoke plays on). Pure function of the battle clock: paused
// bursts freeze, a new battle (clock running backwards / another state) clears the list.
interface Burst { key: string; x: number; y: number; t0: number; scale: number; glow: number; dur: number }
let bursts: Burst[] = [];
let burstOwner: BattleState | null = null;
let lastTime = 0;
const seenExplosions = new WeakSet<object>();

/** Which flipbook and how large (×native) a burst is drawn. Pure (tested). */
export function burstArt(e: Explosion): { key: string; scale: number; glow: number } | null {
  const w = e.weaponId ? WEAPONS[e.weaponId] : undefined;
  if (e.kind === 'smoke') return { key: 'smoke', scale: clamp(e.radiusM / 3, 0.7, 1.4), glow: 0 };
  if (e.kind === 'small' && e.radiusM <= 0) return { key: 'impact', scale: 1.5, glow: 0 };
  if (w?.cls === 'grenade') return { key: 'grenade', scale: e.radiusM >= 5 ? 1.6 : 1.25, glow: 1 };
  if (w?.cls === 'atrocket') return { key: 'grenade', scale: 1.1, glow: 0.9 };
  if (e.radiusM >= 8) return { key: 'he.big', scale: clamp(e.radiusM / 16, 0.6, 1.1), glow: 1 };
  if (e.radiusM < 3) return { key: 'grenade', scale: clamp(e.radiusM / 2.2, 0.6, 1.1), glow: 0.6 };
  return { key: 'he', scale: clamp(e.radiusM / 5, 0.8, 1.25), glow: 1 };
}

function syncBursts(state: BattleState): void {
  if (burstOwner !== state || state.time < lastTime - 0.01) { bursts = []; burstOwner = state; }
  lastTime = state.time;
  const winter = state.map.def.season === 'winter';
  for (const e of state.explosions) {
    if (seenExplosions.has(e)) continue;
    seenExplosions.add(e);
    const art = burstArt(e);
    if (!art) continue;
    const key = fxSeasonKey(art.key, winter);
    let t0 = state.time - e.t;
    // a burst on the target of a round still in flight goes off when the round gets there
    for (const p of state.projectiles) {
      if (p.preResolved && Math.abs(p.to.x - e.pos.x) < 0.05 && Math.abs(p.to.y - e.pos.y) < 0.05) t0 = Math.max(t0, p.t0 + p.flightS);
    }
    bursts.push({ key, x: e.pos.x, y: e.pos.y, t0, scale: art.scale, glow: art.glow, dur: fxDuration(key) || 2 });
  }
  if (bursts.length > 0) bursts = bursts.filter((b) => state.time - b.t0 < b.dur + 0.05);
  if (bursts.length > 160) bursts.splice(0, bursts.length - 160);
}

function drawExplosions(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  syncBursts(state);
  const z = cam.zoom;
  for (const b of bursts) {
    const age = state.time - b.t0;
    if (age < 0) continue;
    const p = worldToScreen(cam, b);
    const r = 130 * b.scale * z;
    if (p.x < -r || p.y < -r || p.x > VIEW_W + r || p.y > VIEW_H + r) continue;
    drawFxAt(ctx, b.key, age, p.x, p.y, z * b.scale);
    // the flash lights the ground around it for a moment
    if (b.glow > 0 && age < 0.3) {
      const k = 1 - age / 0.3;
      const big = b.key.startsWith('he.big') ? 2.2 : b.key.startsWith('he') ? 1 : 0.55;
      drawGlow(ctx, p.x, p.y, (24 + 26 * (1 - k)) * big * b.scale * z, 0.6 * k * k * b.glow);
      // the detonation itself: a hard white pop for the first couple of frames
      if (age < 0.08) drawGlow(ctx, p.x, p.y, (big < 1 ? 12 : 16) * b.scale * z, 1 - age / 0.08, '255,245,225');
    }
  }
}

// ------------------------------------------------------------------- sparks
const SPARK_S: Record<Spark['kind'], number> = { armor: 0.35, pen: 0.5, dust: 0.55, wood: 0.5, stone: 0.5, brick: 0.5, body: 0.35, backblast: 0.8 };
const CHIP: Partial<Record<Spark['kind'], string>> = { wood: '#7a5a34', stone: '#77736c', brick: '#8a4a36', body: '#6a1c14' };

/** Impact sparks and puffs (A2): hot streaks off armour, a flash through a pierced plate, dirt,
 * splinters and chips, the dust cone behind a rocket launcher. `t` is when the strike shows. */
function drawSparks(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  if (state.sparks.length === 0) return;
  const z = cam.zoom;
  const winter = state.map.def.season === 'winter';
  for (let i = 0; i < state.sparks.length; i++) {
    const s = state.sparks[i];
    const age = state.time - s.t;
    const life = SPARK_S[s.kind];
    if (age < 0 || age >= life) continue;
    const p = worldToScreen(cam, s.pos);
    if (p.x < -40 || p.y < -40 || p.x > VIEW_W + 40 || p.y > VIEW_H + 40) continue;
    const f = age / life;
    const seed = Math.floor(s.pos.x * 97 + s.pos.y * 13 + s.t * 50);
    if (s.kind === 'armor' || s.kind === 'pen') {
      const pen = s.kind === 'pen';
      if (pen) drawFxAt(ctx, 'puff.dark', 0, p.x, p.y - age * 12 * z, z * (0.35 + f * 0.5), 0.7 * (1 - f));
      drawGlow(ctx, p.x, p.y, (pen ? 26 : 14) * z, (pen ? 1 : 0.8) * (1 - f) ** 2, pen ? '255,150,60' : '255,230,170');
      // hot fragments flying off the plate
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1, z);
      const n = pen ? 9 : 6;
      for (let k = 0; k < n; k++) {
        const a = hash2(seed, k, 3) * Math.PI * 2;
        const v = (18 + hash2(seed, k, 5) * 30) * (pen ? 1.2 : 1);
        const d0 = v * age * z, d1 = v * Math.max(0, age - 0.04) * z;
        ctx.globalAlpha = (1 - f) * (0.6 + 0.4 * hash2(seed, k, 7));
        ctx.strokeStyle = k % 3 === 0 ? '#fff6d8' : '#ffc060';
        ctx.beginPath();
        ctx.moveTo(p.x + Math.cos(a) * d1, p.y + Math.sin(a) * d1);
        ctx.lineTo(p.x + Math.cos(a) * d0, p.y + Math.sin(a) * d0);
        ctx.stroke();
      }
      ctx.restore();
    } else if (s.kind === 'backblast') {
      // a cone of dust and propellant smoke behind the launcher, and a flash at the tube
      if (age < 0.12) drawGlow(ctx, p.x, p.y, 16 * z, 0.9 * (1 - age / 0.12));
      for (let k = 0; k < 4; k++) {
        const a = hash2(seed, k, 11) * Math.PI * 2;
        const d = (2 + k * 3) * f * z * 3;
        drawFxAt(ctx, 'puff.light', 0, p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, z * (0.35 + 0.35 * f + k * 0.05), 0.75 * (1 - f));
      }
    } else if (s.kind === 'dust') {
      drawFxAt(ctx, fxSeasonKey('impact', winter), age, p.x, p.y, z * 1.8);
    } else {
      // splinters / chips / blood mist: a small puff and a few specks thrown out
      if (s.kind !== 'body') drawFxAt(ctx, fxSeasonKey('impact', winter), age, p.x, p.y, z * 1.2);
      ctx.save();
      ctx.fillStyle = CHIP[s.kind] ?? '#6a6a64';
      for (let k = 0; k < 5; k++) {
        const a = hash2(seed, k, 13) * Math.PI * 2;
        const d = (3 + hash2(seed, k, 17) * 6) * f * z * (s.kind === 'body' ? 0.6 : 1);
        ctx.globalAlpha = 1 - f;
        const sz = Math.max(1, Math.round(z));
        ctx.fillRect(Math.round(p.x + Math.cos(a) * d), Math.round(p.y + Math.sin(a) * d - Math.sin(Math.PI * f) * 3 * z), sz, sz);
      }
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------- projectiles
/** Rounds in flight (A1). Shells and mortar bombs are carried by their tracer / burst; what is drawn
 * here is the slow, visible stuff: an AT rocket with its flame and smoke trail, and a grenade or
 * satchel tumbling along its lob with a ground shadow. */
function drawProjectiles(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  if (state.projectiles.length === 0) return;
  const z = cam.zoom;
  for (const pr of state.projectiles) {
    const age = state.time - pr.t0;
    if (age < 0 || age > pr.flightS) continue;
    const k = age / pr.flightS;
    const from = worldToScreen(cam, pr.from), to = worldToScreen(cam, pr.to);
    const x = from.x + (to.x - from.x) * k, y = from.y + (to.y - from.y) * k;
    if (pr.kind === 'atrocket') {
      const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      // smoke trail: a soft grey streak, each stretch fading and widening from when the rocket
      // passed it
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#d8d6d0';
      const segs = 12, trailLen = Math.min(len * k, 90 * z);
      for (let i = 0; i < segs; i++) {
        const d0 = len * k - trailLen * (i + 1) / segs, d1 = len * k - trailLen * i / segs;
        if (d1 <= 0) break;
        const pa = ((len * k - (d0 + d1) / 2) / len) * pr.flightS;
        const f = clamp(pa / 1.2, 0, 1);
        ctx.globalAlpha = 0.55 * (1 - f) ** 1.3;
        ctx.lineWidth = (1 + 4 * f) * z;
        ctx.beginPath();
        ctx.moveTo(from.x + ux * Math.max(0, d0), from.y + uy * Math.max(0, d0) - pa * 3 * z);
        ctx.lineTo(from.x + ux * d1, from.y + uy * d1 - pa * 3 * z * 0.9);
        ctx.stroke();
      }
      ctx.restore();
      drawGlow(ctx, x - ux * 3 * z, y - uy * 3 * z, 8 * z, 0.9);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#ffd070';
      ctx.lineWidth = 2 * z;
      ctx.beginPath(); ctx.moveTo(x - ux * 7 * z, y - uy * 7 * z); ctx.lineTo(x - ux * 2 * z, y - uy * 2 * z); ctx.stroke();
      ctx.strokeStyle = '#2a2a24';
      ctx.lineWidth = 2 * z;
      ctx.beginPath(); ctx.moveTo(x - ux * 2 * z, y - uy * 2 * z); ctx.lineTo(x + ux * 3 * z, y + uy * 3 * z); ctx.stroke();
      ctx.restore();
    } else if (pr.kind === 'grenade' || pr.kind === 'satchel') {
      // lob: seen from almost straight above the arc barely shifts it, so it is shown by the
      // shadow drifting away from the grenade and the grenade itself growing a little
      const h = Math.sin(Math.PI * k) * pr.arcM;
      const sh = h * 1.6 * z;
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#10120c';
      ctx.beginPath(); ctx.ellipse(x + sh * 0.7, y + sh * 0.7, 1.5 * z, 1 * z, 0, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.translate(x, y - h * 0.8 * z);
      ctx.rotate(age * 14);
      const s = (pr.kind === 'satchel' ? 1.6 : 1.2) * (1 + h * 0.1) * z;
      ctx.fillStyle = '#2c2c24';
      ctx.fillRect(-1.5 * s, -1 * s, 3 * s, 2 * s);
      ctx.fillStyle = '#6a6a58';
      ctx.fillRect(-1.5 * s, -1 * s, 1.5 * s, 1 * s);
      ctx.restore();
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
  drawStructureFx(ctx, cam, state);
  drawExplosions(ctx, cam, state);
  drawFires(ctx, cam, state);
  drawSparks(ctx, cam, state);
  drawProjectiles(ctx, cam, state);
  drawTracers(ctx, cam, state);
  drawFlashes(ctx, cam, state);

  ctx.restore();
}
