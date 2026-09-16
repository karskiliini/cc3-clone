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
import { DepthOverlay, rasterizeDepth } from '@/render/depthOverlay';
import { getHeightField } from '@/sim/heightField';

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
// ?map=steppe_1943 renders only that map (faster art QA / headless capture).
const mapFilter = qs.get('map');
// ?depth=1 draws the Tab depth-map view over the 1:1 viewport and adds a whole-map depth thumbnail.
const depthView = qs.get('depth') === '1';
// ?flat=1 strips the map's ground relief before rendering — the A/B baseline for measuring what
// the real-elevation hillshading costs a chunk bake against the old fbm relief term.
const flatGround = qs.get('flat') === '1';
// ?bake=N times N cold chunk bakes (private bakeChunk, cache bypassed) and reports the mean in
// document.body.dataset.bakeMs / .bakeChunks, for the elevation performance budget.
const bakeRuns = qs.has('bake') ? Math.max(1, Number(qs.get('bake'))) : 0;

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

  if (flatGround) { map.ground = undefined; map.groundSteep = undefined; }
  const renderer = new TerrainRenderer(map);

  const block = el('div', 'map-block');

  if (bakeRuns > 0) {
    const bake = (renderer as unknown as { bakeChunk(cx: number, cy: number, zoom: number): unknown }).bakeChunk.bind(renderer);
    const CH = 16; // CHUNK_TILES in terrainRender.ts
    const cols = Math.max(1, Math.ceil(map.width / CH)), rows = Math.max(1, Math.ceil(map.height / CH));
    bake(0, 0, 1); // warm up (fonts, sprite atlases, JIT)
    const t0 = performance.now();
    for (let i = 0; i < bakeRuns; i++) bake((i * 7) % cols, (i * 5) % rows, 1);
    const ms = (performance.now() - t0) / bakeRuns;
    const prev = Number(document.body.dataset.bakeMs ?? 0), n = Number(document.body.dataset.bakeN ?? 0);
    document.body.dataset.bakeMs = (prev + ms).toFixed(3);
    document.body.dataset.bakeN = String(n + 1);
    block.dataset.bakeMs = ms.toFixed(2);
  }

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
  if (depthView) {
    const overlay = new DepthOverlay();
    const t0 = performance.now();
    overlay.update(map, cam);
    const ms = performance.now() - t0;
    overlay.draw(vctx, cam);
    overlay.drawLegend(vctx);
    block.dataset.depthMs = ms.toFixed(1);

    const field = getHeightField(map);
    const img = rasterizeDepth(field, { x0: 0, y0: 0, cols: map.width, rows: map.height, ppt: 4 });
    const full = el('canvas');
    full.width = img.w; full.height = img.h;
    full.getContext('2d')!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.w, img.h), 0, 0);
    const scaled = el('canvas');
    scaled.width = THUMB_W; scaled.height = THUMB_H;
    const sctx = scaled.getContext('2d')!;
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(full, 0, 0, THUMB_W, THUMB_H);
    const depthWrap = el('div', 'thumb-wrap');
    depthWrap.appendChild(scaled);
    const cap = el('div', 'caption');
    cap.textContent = `depth map (whole map) — viewport raster ${ms.toFixed(1)} ms`;
    depthWrap.appendChild(cap);
    row.appendChild(depthWrap);
  }
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
  for (const def of MAPS) if (!mapFilter || def.id === mapFilter) renderMap(root, def.id);
  document.body.dataset.ready = '1';
}

main();
