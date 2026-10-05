// ============================================================================
// netIndicator.ts — the red "disconnected" symbol in the top-right corner of the battle view
// (multiplayer). It lights while the network is in trouble and for a moment after each incident
// (netHealth.ts), so the player reads the connection's state from how often it shows. The icon —
// a pulled plug and its socket with a spark between them, on a dark disc with a red rim — is
// public/hud/net_disconnected.png, rendered by tools/blender/hud.py; a word goes under it. Until
// the image has loaded, a plain red ring stands in.
// ============================================================================
import type { NetHealth } from '@/net/netHealth';
import { VIEW_W } from '@/shared/types';
import { setHudFont } from './hudChrome';

const SIZE = 36;                  // the icon (px), as rendered
const X = VIEW_W - 8 - SIZE;      // 8 px in from the view's top-right corner
const Y = 8;
const RED = '#ff2a1a';

let icon: HTMLImageElement | null = null;

function iconImage(): HTMLImageElement | null {
  if (!icon && typeof Image !== 'undefined') {
    icon = new Image();
    const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
    icon.src = `${env?.BASE_URL ?? '/'}hud/net_disconnected.png`;
  }
  return icon && icon.complete && icon.naturalWidth > 0 ? icon : null;
}

/** Draws the symbol when `health` reports trouble at `nowMs`. */
export function drawNetIndicator(ctx: CanvasRenderingContext2D, health: NetHealth, nowMs: number): void {
  const img = iconImage(); // start loading before it is first needed
  if (!health.troubled(nowMs)) return;
  ctx.save();
  // a slow pulse while it lasts, so it reads as a live warning rather than part of the HUD
  ctx.globalAlpha = 0.8 + 0.2 * Math.sin(nowMs / 160);
  if (img) {
    ctx.drawImage(img, X, Y, SIZE, SIZE);
  } else {
    ctx.strokeStyle = RED;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(X + SIZE / 2, Y + SIZE / 2, SIZE / 2 - 2, 0, Math.PI * 2);
    ctx.stroke();
  }
  // the word under it, right-aligned to the icon
  ctx.globalAlpha = 1;
  setHudFont(ctx, 'tiny');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  const text = health.label();
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillText(text, X + SIZE + 1, Y + SIZE + 4);
  ctx.fillStyle = RED;
  ctx.fillText(text, X + SIZE, Y + SIZE + 3);
  ctx.restore();
}
