import type { Health, Season, Side } from '@/shared/types';
import { drawSoldier, freeAllAtlases, loadAtlas, soldierAtlasName, type Atlas } from '@/render/spriteAtlas';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const side = $<HTMLSelectElement>('side'), season = $<HTMLSelectElement>('season'), zoom = $<HTMLSelectElement>('zoom');
const canvas = $<HTMLCanvasElement>('scene'), ctx = canvas.getContext('2d')!;
const rows: { label: string; keys: string[]; health: Health; animated?: boolean }[] = [
  { label: 'Walking wounded', keys: ['standing.walk'], health: 'wounded', animated: true },
  { label: 'Wounded SMG', keys: ['standing.fire@smg'], health: 'wounded', animated: true },
  { label: 'Wounded MG prone', keys: ['prone.fire@lmg'], health: 'wounded', animated: true },
  { label: 'Crawling wounded', keys: ['prone.woundedCrawl'], health: 'wounded', animated: true },
  { label: 'Incapacitated', keys: ['prone.wounded'], health: 'incapacitated' },
  { label: 'Dragged casualty', keys: ['prone.dragged'], health: 'incapacitated' },
  { label: 'Dead', keys: ['corpse0'], health: 'dead' },
  { label: 'Dead, alternate pose', keys: ['corpse3'], health: 'dead' },
  { label: 'Blast casualty', keys: ['ragdoll.landed0'], health: 'dead' },
];
let atlas: Atlas | null = null, revision = 0;
async function reload() {
  const version = ++revision; atlas = null; freeAllAtlases();
  $('status').textContent = 'Loading…';
  const loaded = await loadAtlas(soldierAtlasName(side.value as Side, season.value as Season, Number(zoom.value) > 1 ? 2 : 1));
  if (version !== revision) return;
  atlas = loaded; $('status').textContent = loaded ? 'Ready' : 'Atlas unavailable';
}
for (const select of [side, season, zoom]) select.onchange = reload;
function draw(now: number) {
  const z = Number(zoom.value), rowHeight = z === 4 ? 125 : z === 2 ? 90 : 70;
  if (canvas.height !== rows.length * rowHeight) canvas.height = rows.length * rowHeight;
  ctx.imageSmoothingEnabled = false;
  rows.forEach((row, i) => {
    const y = i * rowHeight;
    ctx.fillStyle = season.value === 'winter' ? (i % 2 ? '#b7b9ad' : '#c6c8be') : i % 2 ? '#72784e' : '#82885d';
    ctx.fillRect(0, y, canvas.width, rowHeight);
    ctx.fillStyle = '#1b2117'; ctx.font = '13px monospace'; ctx.fillText(row.label, 10, y + 22);
    for (let d = 0; d < 8; d++) for (const changed of [false, true]) {
      drawSoldier(ctx, atlas, row.keys, d * Math.PI / 4,
        e => row.animated ? Math.floor(now / 1000 * e.fps) % e.frames : e.frames - 1,
        240 + d * 100, y + (changed ? rowHeight * 0.85 : rowHeight * 0.38), z, changed ? row.health : 'healthy');
    }
  });
  requestAnimationFrame(draw);
}
void reload(); requestAnimationFrame(draw);
