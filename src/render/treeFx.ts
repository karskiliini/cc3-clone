import type { BattleState, Camera } from '@/shared/types';
import { TILE_M, TILE_PX, VIEW_H, VIEW_W } from '@/shared/types';
import { worldToScreen } from '@/engine/camera';
import { hash2 } from '@/shared/rng';
import { getTreeSprite, TREE_VARIANTS } from './sprites';

/** World-anchored trunks and brash, with a brief hinge fall and settling dust. Draw below units. */
export function drawFallenTrees(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  const m = TILE_PX * cam.zoom / TILE_M;
  const winter = state.map.def.season === 'winter';
  for (const [i, tree] of state.map.fallenTrees ?? []) {
    const pos = { x: i % state.map.width + 0.5, y: Math.floor(i / state.map.width) + 0.5 };
    const p = worldToScreen(cam, pos);
    if (p.x < -100 || p.y < -100 || p.x > VIEW_W + 100 || p.y > VIEW_H + 100) continue;
    const age = Math.max(0, state.time - tree.fellAt), phase = Math.min(1, age / 1.1);
    const lean = Math.sin(phase * Math.PI / 2), length = (2.5 + hash2(i, 1, 82) * 1.2) * m;
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(tree.facing + (hash2(i, 0, 85) - 0.5) * 0.45);
    // The moving crown spreads down into a resting fan of leafy branches.
    ctx.strokeStyle = '#292d1d'; ctx.globalAlpha = 0.25; ctx.lineWidth = 0.45 * m;
    ctx.beginPath(); ctx.moveTo(0.2 * m, 0); ctx.lineTo(0.2 * m, -length * lean); ctx.stroke();
    ctx.globalAlpha = 1; ctx.lineCap = 'round';
    ctx.strokeStyle = '#463a29'; ctx.lineWidth = 0.22 * m;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -length * lean); ctx.stroke();
    ctx.strokeStyle = '#ae9970'; ctx.lineWidth = 0.06 * m;
    ctx.beginPath(); ctx.moveTo(-0.04 * m, 0); ctx.lineTo(-0.04 * m, -length * lean); ctx.stroke();
    for (let b = 0; b < 9; b++) {
      const h = hash2(i, b, 83), side = b % 2 ? -1 : 1;
      const y = -(0.25 + b * 0.07) * length * lean;
      ctx.strokeStyle = '#65533a'; ctx.lineWidth = 0.065 * m;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(side * (0.3 + h * 0.6) * m, y - 0.35 * m); ctx.stroke();
    }
    const crown = getTreeSprite(i % TREE_VARIANTS, state.map.def.season, cam.zoom, winter ? 'bare' : 'lobed');
    ctx.globalAlpha = 0.92;
    ctx.drawImage(crown, -m * 1.05, -length * lean - m * 0.45, m * 2.1, m * 1.3 + length * lean * 0.65);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#b9a17a'; ctx.beginPath(); ctx.ellipse(0, 0, 0.15 * m, 0.1 * m, 0, 0, Math.PI * 2); ctx.fill();
    if (age < 1.8) {
      ctx.globalAlpha = (1 - age / 1.8) * 0.25; ctx.fillStyle = '#b3a47e';
      for (let d = 0; d < 5; d++) { ctx.beginPath(); ctx.ellipse((hash2(i, d, 84) - 0.5) * m * 2, -length * lean * d / 5, m * (0.2 + age * 0.3), m * 0.3, 0, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();
  }
}
