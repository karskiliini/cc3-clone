// ============================================================================
// menuArt.ts — the CC3-style "propaganda poster" behind every menu screen:
// public/menu/poster.png (800x600, the MENU_W x MENU_H area) with the pointing
// soldier for the main menu, poster_plain.png (the same burning town without
// him) behind the working screens' panels. Both are rendered by
// tools/blender/menu.py. Until an image has loaded (or if it is missing) a
// plain maroon gradient with the same fire glow stands in.
// ============================================================================
import { MENU_W, MENU_H } from '@/shared/types';

export type PosterVariant = 'hero' | 'plain';

const FILES: Record<PosterVariant, string> = { hero: 'menu/poster.png', plain: 'menu/poster_plain.png' };
const images: Partial<Record<PosterVariant, HTMLImageElement>> = {};
let fallback: HTMLCanvasElement | null = null;

function posterImage(variant: PosterVariant): HTMLImageElement | null {
  let img = images[variant];
  if (!img && typeof Image !== 'undefined') {
    img = images[variant] = new Image();
    const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
    img.src = `${env?.BASE_URL ?? '/'}${FILES[variant]}`;
  }
  return img && img.complete && img.naturalWidth > 0 ? img : null;
}

function fallbackCanvas(): HTMLCanvasElement {
  if (fallback) return fallback;
  const c = document.createElement('canvas');
  c.width = MENU_W;
  c.height = MENU_H;
  const ctx = c.getContext('2d')!;
  const bg = ctx.createLinearGradient(0, 0, 0, MENU_H);
  bg.addColorStop(0, '#1a0605');
  bg.addColorStop(0.55, '#4a1009');
  bg.addColorStop(1, '#140404');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, MENU_W, MENU_H);
  const glow = ctx.createRadialGradient(MENU_W * 0.55, MENU_H * 0.48, 4, MENU_W * 0.55, MENU_H * 0.48, MENU_W * 0.4);
  glow.addColorStop(0, 'rgba(250,200,120,0.85)');
  glow.addColorStop(0.4, 'rgba(210,90,30,0.5)');
  glow.addColorStop(1, 'rgba(210,90,30,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, MENU_W, MENU_H);
  fallback = c;
  return c;
}

/** Draws the poster filling the 800x600 menu area (context already translated to MENU-local). */
export function drawPosterBackground(ctx: CanvasRenderingContext2D, variant: PosterVariant): void {
  ctx.drawImage(posterImage(variant) ?? fallbackCanvas(), 0, 0, MENU_W, MENU_H);
}
