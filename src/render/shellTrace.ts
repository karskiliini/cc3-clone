import type { Vec2 } from '@/shared/types';
import { TRACER_LIFE } from '@/shared/types';
import { clamp } from '@/shared/math';

/** Render timing only: damage and impact positions remain the ballistics simulation's. */
export function shellTraceSample(from: Vec2, to: Vec2, age: number, zoom: number) {
  const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy);
  if (age < 0 || age >= TRACER_LIFE || distance < 0.1) return null;
  const f = age / TRACER_LIFE, travel = clamp(f / 0.7, 0, 1);
  const head = Math.min(distance, Math.max(Math.min(6 * zoom, distance), distance * travel));
  return { x: from.x + dx / distance * head, y: from.y + dy / distance * head,
    angle: Math.atan2(dy, dx), body: Math.min(head, 9 * zoom), tail: Math.min(head, 36 * zoom),
    alpha: f < 0.7 ? 1 : (1 - f) / 0.3 };
}

/** Bright brass dart, hot base, soft tapered wake and a dark edge for snow/bright fields. */
export function drawShellTrace(ctx: CanvasRenderingContext2D, from: Vec2, to: Vec2, age: number, zoom: number, deflected = false): void {
  const s = shellTraceSample(from, to, age, zoom);
  if (!s) return;
  ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.angle); ctx.globalAlpha = s.alpha;
  const wake = ctx.createLinearGradient(-s.tail, 0, 0, 0);
  wake.addColorStop(0, 'rgba(224,190,132,0)'); wake.addColorStop(0.7, 'rgba(255,178,74,0.35)'); wake.addColorStop(1, 'rgba(255,241,183,0.9)');
  ctx.fillStyle = wake; ctx.beginPath(); ctx.moveTo(-s.tail, 0); ctx.lineTo(-s.body * 0.5, -2.3 * zoom); ctx.lineTo(0, 0); ctx.lineTo(-s.body * 0.5, 2.3 * zoom); ctx.closePath(); ctx.fill();
  const glow = ctx.createRadialGradient(-s.body * 0.6, 0, 0, -s.body * 0.6, 0, 6 * zoom);
  glow.addColorStop(0, 'rgba(255,219,126,0.65)'); glow.addColorStop(1, 'rgba(255,145,35,0)');
  ctx.fillStyle = glow; ctx.fillRect(-s.body - 6 * zoom, -6 * zoom, s.body + 12 * zoom, 12 * zoom);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-s.body * 0.3, -1.5 * zoom); ctx.lineTo(-s.body, -1.2 * zoom); ctx.lineTo(-s.body, 1.2 * zoom); ctx.lineTo(-s.body * 0.3, 1.5 * zoom); ctx.closePath();
  ctx.fillStyle = deflected ? '#e8b683' : '#fff5cb'; ctx.strokeStyle = '#533820'; ctx.lineWidth = Math.max(0.8, zoom * 0.65); ctx.stroke(); ctx.fill();
  ctx.strokeStyle = '#fffef3'; ctx.lineWidth = Math.max(0.6, zoom * 0.5); ctx.beginPath(); ctx.moveTo(-s.body * 0.8, -0.3 * zoom); ctx.lineTo(-s.body * 0.2, -0.3 * zoom); ctx.stroke();
  ctx.restore();
}
