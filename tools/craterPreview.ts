// ============================================================================
// tools/craterPreview.ts — dev-only page: every earthwork type (fresh blast marks
// sized by weapon, old map craters and shell holes, grenade holes, foxholes in
// each parapet variant, a crenellated trench) rendered through the REAL terrain
// pipeline on a small synthetic map, per season, at zoom 1 and zoom 2.
//   ?bench=1   bakes a fixed chunk set on every real map and reports ms/chunk.
//   ?bench=earth  same, but only chunks containing crater/trench tiles (worst case).
// ============================================================================
import { MAPS } from '@/data/maps';
import { buildMap } from '@/sim/map';
import { MapPainter } from '@/sim/mapdsl';
import { TerrainRenderer } from '@/render/terrainRender';
import { createCamera } from '@/engine/camera';
import { VIEW_W, VIEW_H, TILE_PX } from '@/shared/types';
import type { CraterMark, MapDef, Season, Terrain } from '@/shared/types';

const qs = new URLSearchParams(location.search);

/** ?bench=1 : bakes a fixed set of chunks on every map at zoom 1 and 2 (3 passes, median). */
function bench(): void {
  const lines: string[] = [];
  for (const z of [1, 2]) {
    let total = 0, n = 0;
    for (const def of MAPS) {
      const map = buildMap(def);
      const r = new TerrainRenderer(map) as unknown as { bakeChunk(cx: number, cy: number, z: number): HTMLCanvasElement };
      const cw = Math.ceil(map.width / 16), ch = Math.ceil(map.height / 16);
      const earthOnly = qs.get('bench') === 'earth';
      const hasEarth = (cx: number, cy: number) => {
        for (let y = cy * 16; y < Math.min(map.height, cy * 16 + 16); y++) for (let x = cx * 16; x < Math.min(map.width, cx * 16 + 16); x++) {
          const t = map.tiles[y * map.width + x];
          if (t === 'crater' || t === 'trench') return true;
        }
        return false;
      };
      for (let cy = 0; cy < ch; cy += earthOnly ? 1 : 2) for (let cx = 0; cx < cw; cx += earthOnly ? 1 : 3) {
        if (earthOnly && !hasEarth(cx, cy)) continue;
        const t: number[] = [];
        for (let k = 0; k < 3; k++) { const t0 = performance.now(); r.bakeChunk(cx, cy, z); t.push(performance.now() - t0); }
        t.sort((a, b) => a - b);
        total += t[1]; n++;
      }
    }
    lines.push(`zoom ${z}: ${n} chunks, median-of-3 mean ${(total / n).toFixed(2)} ms/chunk`);
  }
  document.body.dataset.stats = lines.join(' | ');
  document.getElementById('root')!.textContent = lines.join('\n');
}


const W = 51, Hh = 22;

function paintSample(p: MapPainter, season: Season): void {
  p.fill(season === 'winter' ? 'snow' : 'grass');
  p.road([{ x: 0, y: 19 }, { x: 51, y: 18.5 }], 2, 'dirtroad');
  // old map craters: three shell-hole decor sizes, one isolated crater tile, one crater cluster
  p.addDecor('shellhole', 3, 10, 0);
  p.addDecor('shellhole', 6.5, 10, 1);
  p.addDecor('shellhole', 10, 10, 2);
  p.rect(15, 10, 1, 1, 'crater');
  p.patch(21.5, 10.5, 2.2, 'crater');
  // trench line + foxholes, all facing the attacker (south)
  p.line([{ x: 28, y: 3 }, { x: 37, y: 6 }, { x: 49, y: 3 }], 'trench');
  for (let v = 0; v < 6; v++) p.foxhole(28.5 + v * 3.8, 11.5, { x: 28.5 + v * 3.8, y: 40 }, v);
  p.rect(30, 14, 1, 1, 'scatteredtrees');
  p.foxhole(31.5, 14.5, { x: 25, y: 40 });
  p.foxhole(44.5, 14.5, { x: 60, y: 40 });
}

function sampleDef(season: Season): MapDef {
  const tiles: Terrain[] = new Array(W * Hh).fill('open');
  const p = new MapPainter(tiles, W, Hh, 4242);
  paintSample(p, season);
  return {
    id: `crater_preview_${season}`, name: `Earthworks ${season}`, description: '', width: W, height: Hh, season,
    paint(t, w, h) { const q = new MapPainter(t, w, h, 4242); paintSample(q, season); },
    victoryLocations: [],
    deployZones: { german: { x: 0, y: 20, w: W, h: 2 }, soviet: { x: 0, y: 0, w: W, h: 2 } },
    attacker: 'german', decor: p.decor, vectors: p.vectors,
  };
}

/** Fresh blast marks from this battle, sized by weapon (see combat.ts craterForWeapon). */
const FRESH: CraterMark[] = [
  { x: 3, y: 3.5, sizeM: 1, kind: 'grenade' },
  { x: 4.3, y: 4.4, sizeM: 1, kind: 'grenade' },
  { x: 8, y: 3.5, sizeM: 2.5, kind: 'shell' },
  { x: 13, y: 3.5, sizeM: 3.2, kind: 'shell' },
  { x: 18.5, y: 3.5, sizeM: 3.8, kind: 'shell' },
  { x: 24.5, y: 4, sizeM: 5, kind: 'shell' },
  { x: 4, y: 15, sizeM: 1.2, kind: 'grenade' },
  { x: 10, y: 15, sizeM: 2.5, kind: 'shell' },
  { x: 12.2, y: 16.2, sizeM: 2.5, kind: 'shell' },
  { x: 32, y: 18.7, sizeM: 1, kind: 'grenade' },
  { x: 40, y: 18.5, sizeM: 3.2, kind: 'shell' },
  { x: 47, y: 18.9, sizeM: 3.8, kind: 'shell' },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function view(renderer: TerrainRenderer, zoom: number, camX: number, camY: number, wPx: number, hPx: number): HTMLCanvasElement {
  const full = document.createElement('canvas');
  full.width = VIEW_W; full.height = VIEW_H;
  const ctx = full.getContext('2d')!;
  const cam = createCamera();
  cam.zoom = zoom; cam.x = camX; cam.y = camY;
  for (let i = 0; i < 30; i++) renderer.draw(ctx, cam);
  const out = document.createElement('canvas');
  out.width = wPx; out.height = hPx;
  out.getContext('2d')!.drawImage(full, 0, 0);
  return out;
}

function gallery(): void {
  const root = document.getElementById('root')!;
  const legend = el('div', 'Left, top row: FRESH marks from this battle — grenade x2 (1 m), mortar 2.5 m, tank HE 3.2 m, AT/tank HE 3.8 m, large 5 m. ' +
    'Middle row: OLD map craters — shell-hole decor x3, isolated crater tile, crater cluster. Bottom: fresh grenade + mortar pair. ' +
    'Right: crenellated trench (top), foxholes variants 0-5 (1/2-man x spoil/sandbag/log), foxholes by trees; road with fresh marks.', 'cap');
  legend.style.margin = '0 16px';
  root.appendChild(legend);
  for (const season of ['summer', 'autumn', 'winter'] as Season[]) {
    const map = buildMap(sampleDef(season));
    map.craterMarks = FRESH.map((m) => ({ ...m }));
    const r = new TerrainRenderer(map);
    root.appendChild(el('h2', `${season}`));
    const row1 = el('div', undefined, 'row');
    const c1 = view(r, 1, 0, 0, W * TILE_PX, Hh * TILE_PX);
    const w1 = el('div'); w1.appendChild(c1); w1.appendChild(el('div', `${season} zoom 1 (1:1)`, 'cap'));
    row1.appendChild(w1);
    root.appendChild(row1);
    const row2 = el('div', undefined, 'row');
    for (const [cx, cy, label] of [[0, 0, 'fresh craters'], [0, 7, 'old craters / grenade'], [26, 0, 'trench + foxholes'], [26, 8, 'foxholes / road']] as [number, number, string][]) {
      const c = view(r, 2, cx, cy, 512 * 2, 300 * 2 > VIEW_H ? VIEW_H : 600);
      const wrap = el('div'); wrap.appendChild(c); wrap.appendChild(el('div', `${season} zoom 2 — ${label}`, 'cap'));
      c.dataset.label = `${season}_z2_${label.replace(/[^a-z]+/g, '_')}`;
      row2.appendChild(wrap);
    }
    c1.dataset.label = `${season}_z1`;
    root.appendChild(row2);
  }
}

setTimeout(() => {
  console.log = () => {};
  if (qs.has('bench')) bench(); else gallery();
  document.body.dataset.ready = '1';
}, 50);
