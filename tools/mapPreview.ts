// ============================================================================
// tools/mapPreview.ts — dev-only Vite page. Renders every map in MAPS both
// fully zoomed out (thumbnail) and at a 1:1 viewport so a human can eyeball
// the painted terrain look. Not part of the shipped game.
// ============================================================================
import { MAPS } from '@/data/maps';
import { buildMap } from '@/sim/map';
import { TerrainRenderer } from '@/render/terrainRender';
import { createCamera, centerCamera, clampCamera } from '@/engine/camera';
import { VIEW_W, VIEW_H } from '@/shared/types';

const THUMB_W = 480;
const THUMB_H = 360;

// Optional camera override for art QA passes: ?cx=100&cy=60 centres every map's 1:1 viewport on
// that tile instead of the map midpoint, so a specific woods/hedge/farmstead cluster can be
// screenshotted directly instead of whatever happens to sit at the exact centre of each map.
const qs = new URLSearchParams(location.search);
const cxOverride = qs.has('cx') ? Number(qs.get('cx')) : null;
const cyOverride = qs.has('cy') ? Number(qs.get('cy')) : null;
// ?zoom=2 (or 0.5) bakes+renders the 1:1 viewport at that zoom instead of 1, so a chunk's
// true-output-resolution bake can be eyeballed directly against the zoom-1 version (e.g. field
// edges/ruts staying smooth rather than blockily upscaled).
const ZOOM_QS = qs.has('zoom') ? Number(qs.get('zoom')) : 1;
const previewZoom = [0.5, 1, 2].includes(ZOOM_QS) ? ZOOM_QS : 1;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function renderMap(root: HTMLElement, mapId: string): void {
  let map;
  try {
    const def = MAPS.find((m) => m.id === mapId);
    if (!def) throw new Error(`map def not found: ${mapId}`);
    map = buildMap(def);
  } catch (err) {
    const block = el('div', 'map-block');
    block.textContent = `Failed to build map "${mapId}": ${(err as Error).message}`;
    root.appendChild(block);
    return;
  }

  const renderer = new TerrainRenderer(map);

  const block = el('div', 'map-block');
  const title = el('div', 'map-title');
  title.textContent = `${map.def.name} `;
  const meta = el('small');
  meta.textContent = `(${map.def.id} — ${map.width}x${map.height} tiles, ${map.def.season}, attacker: ${map.def.attacker})`;
  title.appendChild(meta);
  block.appendChild(title);

  const row = el('div', 'row');

  // Fully zoomed-out thumbnail.
  const thumbWrap = el('div', 'thumb-wrap');
  const thumbCanvas = renderer.thumbnail(THUMB_W, THUMB_H);
  thumbWrap.appendChild(thumbCanvas);
  const thumbCaption = el('div', 'caption');
  thumbCaption.textContent = `thumbnail ${THUMB_W}x${THUMB_H}`;
  thumbWrap.appendChild(thumbCaption);
  row.appendChild(thumbWrap);

  // 1:1 viewport centred on the map, at zoom 1.
  const viewWrap = el('div', 'viewport-wrap');
  const viewCanvas = el('canvas');
  viewCanvas.width = VIEW_W;
  viewCanvas.height = VIEW_H;
  const vctx = viewCanvas.getContext('2d')!;
  vctx.imageSmoothingEnabled = false;
  const cam = createCamera();
  cam.zoom = previewZoom;
  const centerX = cxOverride !== null && !Number.isNaN(cxOverride) ? cxOverride : map.width / 2;
  const centerY = cyOverride !== null && !Number.isNaN(cyOverride) ? cyOverride : map.height / 2;
  centerCamera(cam, { x: centerX, y: centerY });
  clampCamera(cam, map.width, map.height);
  vctx.fillStyle = '#000';
  vctx.fillRect(0, 0, VIEW_W, VIEW_H);
  // The renderer only bakes a couple of chunks per draw() call (to keep real gameplay
  // scrolling smooth); repeatedly redraw here so this static preview shows fully-baked,
  // full-detail chunks rather than the low-res scrolling fallback.
  for (let i = 0; i < 40; i++) renderer.draw(vctx, cam);
  viewWrap.appendChild(viewCanvas);
  const viewCaption = el('div', 'caption');
  viewCaption.textContent = cxOverride !== null || cyOverride !== null
    ? `1:1 viewport ${VIEW_W}x${VIEW_H} @ zoom ${previewZoom}, centred on (${centerX}, ${centerY})`
    : `1:1 viewport ${VIEW_W}x${VIEW_H} @ zoom ${previewZoom}, centred on map`;
  viewWrap.appendChild(viewCaption);
  row.appendChild(viewWrap);

  block.appendChild(row);
  root.appendChild(block);
}

function main(): void {
  const root = document.getElementById('root');
  if (!root) return;
  if (!MAPS.length) {
    root.textContent = 'No maps found in @/data/maps.';
    return;
  }
  for (const def of MAPS) renderMap(root, def.id);
}

main();
