// ============================================================================
// netIndicator.ts — the red "disconnected" symbol in the top-right corner of the battle view
// (multiplayer). It lights while the network is in trouble and for a moment after each incident
// (netHealth.ts), so the player reads the connection's state from how often it shows: a pulled
// plug, its two halves apart, on a dark disc, with a short word under it.
// ============================================================================
import type { NetHealth } from '@/net/netHealth';
import { VIEW_W } from '@/shared/types';
import { setHudFont } from './hudChrome';

const R = 18;                 // disc radius
const CX = VIEW_W - 8 - R;    // disc centre, 8 px in from the view's top-right corner
const CY = 8 + R;
const RED = '#ff2a1a';
const RED_DARK = '#5a0804';

/** Draws the symbol when `health` reports trouble at `nowMs`. */
export function drawNetIndicator(ctx: CanvasRenderingContext2D, health: NetHealth, nowMs: number): void {
  if (!health.troubled(nowMs)) return;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  ctx.beginPath();
  ctx.arc(CX, CY, R, 0, Math.PI * 2);
  ctx.fill();
  // the ring pulses, so it reads as a live warning rather than part of the HUD
  ctx.globalAlpha = 0.6 + 0.4 * Math.sin(nowMs / 160);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = RED;
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.fillStyle = RED;
  ctx.strokeStyle = RED;
  ctx.lineCap = 'round';
  // left: the plug, its two prongs pointing at the gap, and its cable out to the lower left
  ctx.fillRect(CX - 10, CY - 5, 6, 10);
  ctx.fillRect(CX - 4, CY - 4, 3, 2);
  ctx.fillRect(CX - 4, CY + 2, 3, 2);
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(CX - 10, CY);
  ctx.lineTo(CX - 15, CY + 7);
  ctx.stroke();
  // right: the socket with its two holes, and its cable out to the upper right
  ctx.fillRect(CX + 4, CY - 5, 6, 10);
  ctx.fillStyle = RED_DARK;
  ctx.fillRect(CX + 4, CY - 4, 2, 2);
  ctx.fillRect(CX + 4, CY + 2, 2, 2);
  ctx.beginPath();
  ctx.moveTo(CX + 10, CY);
  ctx.lineTo(CX + 15, CY - 7);
  ctx.stroke();
  // a spark in the gap
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(CX + 1, CY - 10);
  ctx.lineTo(CX - 1, CY - 7);
  ctx.moveTo(CX - 1, CY + 7);
  ctx.lineTo(CX + 1, CY + 10);
  ctx.stroke();

  // the word under it, right-aligned to the disc
  setHudFont(ctx, 'tiny');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  const text = health.label();
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillText(text, CX + R + 1, CY + R + 4);
  ctx.fillStyle = RED;
  ctx.fillText(text, CX + R, CY + R + 3);
  ctx.restore();
}
