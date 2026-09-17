// ============================================================================
// ragdoll.ts — render-side playback of blast ragdolls (spec 2026-09-17 §4 / §5).
//
// The SIM decides everything that matters (casualty, knockback end point, stun) and records
// `soldier.blast`. This module only plays it back: while the flight lasts it picks a pre-rendered
// tumbling sequence `ragdoll.flight<N>` by hash, carries the body from the pre-blast position to
// the sim's position along an arc (ragdollSample), draws the detaching, shrinking ground shadow
// itself (flight sprites carry none), raises landing dust / snow spray once, then holds
// `ragdoll.landed<N>` for as long as the man is a corpse or a stunned survivor. At most
// RAGDOLL_MAX_ACTIVE bodies fly at once; extra ones skip straight to the landed pose. Without an
// atlas the code-drawn corpse sprite is tumbled instead. Nothing here feeds back into the sim.
// ============================================================================
import type { Camera, Season, Soldier } from '@/shared/types';
import { worldToScreen } from '@/engine/camera';
import {
  RAGDOLL_MAX_ACTIVE, metresToPx, ragdollHeading, ragdollSample, ragdollVariants, type RagdollSample,
} from '@/render/soldierAnim';
import { drawAtlasFrame, soldierAtlas } from '@/render/spriteAtlas';
import { getSoldierSprite, unitSpriteScale } from '@/render/sprites';
import { spawnLandingDust } from '@/render/effects';
import type { Facing8 } from '@/shared/types';

/** soldier id -> blast.time of the flight being played. */
const flying = new Map<number, number>();
/** `${id}|${blast.time}` of flights whose landing dust has been raised (or that were skipped). */
const settled = new Set<string>();
let lastTime = -1;

/** Call once per frame before drawing: forgets finished flights and resets on a new battle. */
export function ragdollBeginFrame(time: number): void {
  if (time < lastTime - 0.5) { flying.clear(); settled.clear(); }
  lastTime = time;
  if (settled.size > 600) settled.clear();
}

export function activeRagdolls(): number { return flying.size; }

export type RagdollPhase = 'none' | 'flight' | 'landed';

/** What to show for this soldier now. 'landed' persists for corpses and stunned survivors. */
export function ragdollPhase(s: Soldier, time: number): { phase: RagdollPhase; sample: RagdollSample | null } {
  const b = s.blast;
  if (!b) return { phase: 'none', sample: null };
  const key = `${s.id}|${b.time}`;
  const sample = ragdollSample(b, s.pos, time);
  if (!sample.landed && time >= b.time && !settled.has(key)) {
    if (flying.get(s.id) === b.time) return { phase: 'flight', sample };
    if (flying.size < RAGDOLL_MAX_ACTIVE) { flying.set(s.id, b.time); return { phase: 'flight', sample }; }
    settled.add(key); // over the cap: no flight, straight to the ground
  }
  if (flying.get(s.id) === b.time) {
    flying.delete(s.id);
    if (!settled.has(key)) { settled.add(key); spawnLandingDust(s.pos, time, b.force); }
  }
  const held = s.health === 'dead' || (s.stunnedUntil != null && time < s.stunnedUntil);
  return { phase: held ? 'landed' : 'none', sample };
}

/** Soft ground shadow that detaches from the body and shrinks / fades as it rises. */
function drawFlightShadow(ctx: CanvasRenderingContext2D, x: number, y: number, zoom: number, k: number, winter: boolean): void {
  ctx.save();
  ctx.globalAlpha = 0.42 * k;
  ctx.fillStyle = winter ? 'rgb(40,50,80)' : 'rgb(8,10,6)';
  ctx.beginPath();
  ctx.ellipse(x + 1.5 * zoom, y + 1.5 * zoom, 7 * zoom * (0.45 + 0.55 * k), 4 * zoom * (0.45 + 0.55 * k), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Draw the thrown body in flight. */
export function drawRagdollFlight(ctx: CanvasRenderingContext2D, cam: Camera, s: Soldier, sample: RagdollSample, season: Season): void {
  const b = s.blast!;
  const zoom = cam.zoom;
  const g = worldToScreen(cam, { x: sample.x, y: sample.y });
  const lift = metresToPx(sample.heightM, zoom) * 0.9;
  drawFlightShadow(ctx, g.x, g.y, zoom, sample.shadow, season === 'winter');
  const v = ragdollVariants(s.id, b.time);
  const heading = ragdollHeading(b, s.pos);
  const atlas = soldierAtlas(s.side, season, zoom);
  const key = `ragdoll.flight${v.flight}`;
  const entry = atlas?.meta.entries[key];
  if (atlas && entry) {
    const dirs = atlas.meta.dirs;
    const dir = Math.round((heading / (Math.PI * 2)) * dirs);
    if (drawAtlasFrame(ctx, atlas, key, dir, Math.min(entry.frames - 1, Math.floor(sample.t * entry.frames)), g.x, g.y - lift, zoom)) return;
  }
  // fallback: tumble the code-drawn sprawled figure
  const scale = unitSpriteScale(zoom);
  const sprite = getSoldierSprite(s.side, season, s.health === 'dead' ? 'dead' : 'woundedCrawl', 0, 0, 'enemy', scale);
  const spin = heading + sample.t * Math.PI * 2 * (0.75 + 0.5 * Math.min(1.5, b.force)) * (v.flight % 2 === 0 ? 1 : -1);
  const k = (zoom / scale) * (1 + sample.heightM * 0.06);
  ctx.save();
  ctx.translate(g.x, g.y - lift);
  ctx.rotate(spin);
  ctx.drawImage(sprite, (-sprite.width / 2) * k, (-sprite.height / 2) * k, sprite.width * k, sprite.height * k);
  ctx.restore();
}

/** Draw the pose he landed in (corpse or stunned survivor). False = caller draws its usual sprite. */
export function drawRagdollLanded(ctx: CanvasRenderingContext2D, cam: Camera, s: Soldier, season: Season): boolean {
  const b = s.blast;
  if (!b) return false;
  const v = ragdollVariants(s.id, b.time);
  const atlas = soldierAtlas(s.side, season, cam.zoom);
  const key = `ragdoll.landed${v.landed}`;
  if (!atlas || !atlas.meta.entries[key]) return false;
  const p = worldToScreen(cam, s.pos);
  const dirs = atlas.meta.dirs;
  const dir = Math.round((ragdollHeading(b, s.pos) / (Math.PI * 2)) * dirs) + v.landed * 3;
  return drawAtlasFrame(ctx, atlas, key, dir, 0, p.x, p.y, cam.zoom);
}

/** Facing for the code-drawn fallback of a landed body: thrown heading, varied per man. */
export function landedFacing8(s: Soldier): Facing8 {
  const b = s.blast!;
  const v = ragdollVariants(s.id, b.time);
  const f = Math.round(ragdollHeading(b, s.pos) / (Math.PI / 4)) + (v.landed % 3) - 1;
  return (((f % 8) + 8) % 8) as Facing8;
}
