// 3D vehicles next to their sprites, with measured silhouette overlap (IoU) and brightness ratio
// per vehicle (IoU: minimum over 8 headings; brightness: summed over all 8): window.__vehicle3dMetrics(). BACKLOG 050 P1.
import { VEHICLE_DEFS } from '@/data/units';
import { drawVehicleSprite } from '@/render/unitRender';
import { requestBattleAtlases } from '@/render/spriteAtlas';
import { VehicleScene } from '@/render/vehicle3d/vehicleScene';
import { GlOutput } from '@/render/vehicle3d/glOutput';
import { loadVehicleModels, modelSource } from '@/render/vehicle3d/models';
import type { VehicleLook } from '@/render/vehicle3d/look';
import type { Season } from '@/shared/types';
import { TILE_PX } from '@/shared/types';

const q = new URLSearchParams(location.search);
const zoom = Number(q.get('zoom') ?? 1);
const season = (q.get('season') ?? 'summer') as Season;
const state = q.get('state') ?? 'ok';          // ok | ko | trackL | blown
const CELL = Math.ceil(140 * zoom), HEADINGS = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (i * Math.PI) / 4);
const ids = (q.get('only')?.split(',') ?? Object.keys(VEHICLE_DEFS));

function lookFor(defId: string, hullRad: number): VehicleLook {
  return { id: 1, defId, posTiles: { x: 0, y: 0 }, hullRad, turretRad: hullRad + 0.6, ko: state === 'ko' || state === 'blown',
    liveButLeft: false, turretBlown: state === 'blown', brokenTrack: state === 'trackL' ? 'L' : null, turretLanding: null, season, recoil: 0 };
}
/** a camera that puts world tile (0,0) at the cell centre */
function camAt(): { x: number; y: number; zoom: number } {
  const px = TILE_PX * zoom;
  return { x: -CELL / 2 / px, y: -CELL / 2 / px, zoom };
}
function cellCanvas(): CanvasRenderingContext2D {
  const c = document.createElement('canvas'); c.width = CELL; c.height = CELL;
  const ctx = c.getContext('2d', { willReadFrequently: true })!; ctx.imageSmoothingEnabled = false; return ctx;
}
function sprite(defId: string, h: number): CanvasRenderingContext2D {
  const ctx = cellCanvas(); const l = lookFor(defId, h);
  drawVehicleSprite(ctx, defId, l.ko ? 'knockedOut' : 'ok', CELL / 2, CELL / 2, h, l.turretRad, zoom, l.turretBlown, l.brokenTrack, undefined, season);
  return ctx;
}
const out3d = GlOutput.create(CELL, CELL)!;
function mesh(defId: string, h: number, shadow: boolean): CanvasRenderingContext2D {
  const ctx = cellCanvas(); const vs = new VehicleScene(modelSource);
  vs.begin(); vs.add(lookFor(defId, h)); vs.end();
  out3d.draw(ctx, vs, camAt(), { shadow }); return ctx;
}
const luma = (d: Uint8ClampedArray, i: number): number => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
function stats(a: CanvasRenderingContext2D, b: CanvasRenderingContext2D): { iou: number; la: number; lb: number } {
  const A = a.getImageData(0, 0, CELL, CELL).data, B = b.getImageData(0, 0, CELL, CELL).data;
  let inter = 0, uni = 0, la = 0, lb = 0;
  for (let i = 0; i < A.length; i += 4) {
    const ia = A[i + 3] > 128, ib = B[i + 3] > 128;     // > 50 %: the body, not the soft shadow
    if (ia && ib) { inter++; la += luma(A, i); lb += luma(B, i); }
    if (ia || ib) uni++;
  }
  return { iou: uni ? inter / uni : 0, la, lb };
}

async function main(): Promise<void> {
  await requestBattleAtlases(['german', 'soviet'], season, undefined, ids);
  loadVehicleModels(ids, season);
  for (const id of ids) sprite(id, 0);                  // asks for any lazily loaded (zoom-2) atlas
  await new Promise<void>((res) => { const t = setInterval(() => { if (ids.every((i) => modelSource.get(i))) { clearInterval(t); res(); } }, 100); });
  await new Promise((r) => setTimeout(r, 1500));
  const page = document.getElementById('c') as HTMLCanvasElement;
  page.width = CELL * 16; page.height = CELL * ids.length;
  const pctx = page.getContext('2d')!;
  pctx.fillStyle = '#7d7a5e'; pctx.fillRect(0, 0, page.width, page.height);   // steppe grass tone behind both
  const metrics: Record<string, { iou: number; lumaRatio: number }> = {};
  ids.forEach((id, row) => {
    let iou = 1, la = 0, lb = 0;
    HEADINGS.forEach((h, col) => {
      const s = sprite(id, h), m = mesh(id, h, true), mBody = mesh(id, h, false);
      pctx.drawImage(s.canvas, col * 2 * CELL, row * CELL);
      pctx.drawImage(m.canvas, (col * 2 + 1) * CELL, row * CELL);
      const st = stats(s, mBody);
      iou = Math.min(iou, st.iou); la += st.la; lb += st.lb;
    });
    pctx.fillStyle = '#fff'; pctx.font = '10px monospace'; pctx.fillText(id, 2, row * CELL + 10);
    metrics[id] = { iou: +iou.toFixed(3), lumaRatio: la ? +(lb / la).toFixed(3) : 0 };
  });
  (window as unknown as Record<string, unknown>).__vehicle3dMetrics = async () => metrics;
}
void main();
