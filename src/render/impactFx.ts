import type { BattleState, Camera, Vehicle } from '@/shared/types';
import { TILE_M, TILE_PX, VIEW_W, VIEW_H } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { worldToScreen } from '@/engine/camera';
import { localToWorldXZ } from './vehicle3d/projection';

/** Drawn only for already-visible vehicles, so armor scars never reveal hidden enemies. */
export function drawVehicleScars(ctx: CanvasRenderingContext2D, cam: Camera, v: Vehicle, broken: 'L' | 'R' | 'both' | null): void {
  const def = VEHICLE_DEFS[v.defId]; if (!def) return;
  const p = worldToScreen(cam, v.pos), m = TILE_PX * cam.zoom / TILE_M;
  ctx.save();
  // Exposed links and slack metal ribbons alongside a thrown track, on either or both sides.
  if (broken) for (const side of [-1, 1]) {
    if (broken !== 'both' && broken !== (side < 0 ? 'L' : 'R')) continue;
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(v.hullFacing);
    const x = side * def.widthM * 0.49 * m, len = def.lengthM * m * 0.8;
    ctx.lineJoin = 'round'; ctx.strokeStyle = '#17191a'; ctx.lineWidth = m * 0.22;
    ctx.beginPath(); ctx.moveTo(x, -len * 0.4); ctx.bezierCurveTo(x + side * m, -len * 0.2, x + side * m * 0.65, len * 0.2, x + side * m * 0.25, len * 0.55); ctx.stroke();
    for (let i = 0; i < 13; i++) {
      const f = i / 12, y = -len * 0.4 + len * 0.95 * f, sx = x + side * m * (0.2 + Math.sin(f * Math.PI) * 0.55);
      ctx.fillStyle = i % 2 ? '#555653' : '#77766b'; ctx.fillRect(sx - m * 0.15, y, m * 0.3, m * 0.07);
    }
    ctx.restore();
  }
  for (const mark of v.strikeMarks ?? []) {
    if (mark.part === 'turret' && v.turretBlown) continue;
    const [x, y] = localToWorldXZ(mark.x, mark.y, mark.part === 'turret' ? v.turretFacing : v.hullFacing);
    const r = Math.max(0.6 * cam.zoom, mark.sizeM * m);
    ctx.fillStyle = '#292924'; ctx.beginPath(); ctx.ellipse(p.x + x * m, p.y + y * m, r * 1.5, r, -0.4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#b1aaa0'; ctx.lineWidth = Math.max(0.4, cam.zoom * 0.5);
    ctx.beginPath(); ctx.moveTo(p.x + x * m - r, p.y + y * m + r * 0.3); ctx.lineTo(p.x + x * m + r, p.y + y * m - r * 0.3); ctx.stroke();
    if (mark.penetrated) { ctx.fillStyle = '#090b0b'; ctx.beginPath(); ctx.arc(p.x + x * m, p.y + y * m, r * 0.55, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

export function drawFragmentScars(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  const m = TILE_PX * cam.zoom / TILE_M;
  ctx.save();
  for (const scar of state.map.fragmentMarks ?? []) {
    const p = worldToScreen(cam, scar.pos);
    if (p.x < -10 || p.y < -10 || p.x > VIEW_W + 10 || p.y > VIEW_H + 10) continue;
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(scar.angle);
    ctx.strokeStyle = scar.material === 'wood' ? '#d6b783' : scar.material === 'brick' ? '#b09b88' : '#464438';
    ctx.lineWidth = Math.max(0.5, cam.zoom * 0.6); ctx.beginPath(); ctx.moveTo(-m * 0.12, -m * 0.04); ctx.lineTo(m * 0.18, m * 0.03); ctx.stroke();
    if (scar.glass) {
      ctx.strokeStyle = '#b7dae0'; ctx.beginPath();
      for (let i = 0; i < 5; i++) { const a = i * 2.1; ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * m * 0.22, Math.sin(a) * m * 0.22); }
      ctx.stroke();
    }
    ctx.restore();
  }
  for (const f of state.map.fragmentFlights ?? []) {
    const t = (state.time - f.at) / 0.18; if (t < 0 || t >= 1) continue;
    const a = worldToScreen(cam, f.from), b = worldToScreen(cam, f.to), tail = Math.max(0, t - 0.14);
    ctx.globalAlpha = (1 - t) * 0.7; ctx.strokeStyle = '#d8c69a'; ctx.lineWidth = Math.max(0.5, cam.zoom * 0.7);
    ctx.beginPath(); ctx.moveTo(a.x + (b.x - a.x) * tail, a.y + (b.y - a.y) * tail); ctx.lineTo(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t); ctx.stroke();
  }
  ctx.restore();
}
