import type { DecorItem, DecorKind, MapVectorFeature, Terrain, Vec2 } from '@/shared/types';
import { hash2 } from '@/shared/rng';

const NON_DECOR_TILES = new Set<Terrain>(['water', 'buildingWood', 'buildingStone', 'floor']);

/** Deterministic terrain painter DSL used by map definitions. */
export class MapPainter {
  tiles: Terrain[];
  w: number;
  h: number;
  seed: number;
  /** Visual dressing collected while painting; filtered against final tiles at the end. */
  decor: DecorItem[] = [];
  /** Vector source geometry for road()/river()/line() calls, so the renderer can paint smooth
   * curves instead of the stepped tile rasterization (tiles remain the sim ground truth). */
  vectors: MapVectorFeature[] = [];

  constructor(tiles: Terrain[], w: number, h: number, seed = 0) {
    this.tiles = tiles;
    this.w = w;
    this.h = h;
    this.seed = seed;
  }

  private set(x: number, y: number, t: Terrain): void {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return;
    this.tiles[yi * this.w + xi] = t;
  }

  private get(x: number, y: number): Terrain | null {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    return this.tiles[y * this.w + x];
  }

  fill(t: Terrain): void {
    for (let i = 0; i < this.tiles.length; i++) this.tiles[i] = t;
  }

  rect(x: number, y: number, w: number, h: number, t: Terrain): void {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.floor(x + w), y1 = Math.floor(y + h);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) this.set(xx, yy, t);
    }
  }

  /** Blobby irregular disc: radius modulated by hash noise over angle, +-25%. */
  patch(cx: number, cy: number, r: number, t: Terrain): void {
    const steps = Math.max(16, Math.round(r * 6));
    const x0 = Math.floor(cx - r * 1.3), x1 = Math.ceil(cx + r * 1.3);
    const y0 = Math.floor(cy - r * 1.3), y1 = Math.ceil(cy + r * 1.3);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const dx = xx + 0.5 - cx, dy = yy + 0.5 - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > r * 1.3) continue;
        const angle = Math.atan2(dy, dx);
        const angleBucket = Math.round(((angle + Math.PI) / (2 * Math.PI)) * steps);
        const noise = hash2(angleBucket, Math.round(r * 100), this.seed);
        const localR = r * (0.75 + noise * 0.5); // +-25%
        if (dist <= localR) this.set(xx, yy, t);
      }
    }
  }

  /** A `patch()`-style organic blob, but each candidate cell is only painted when its CURRENT
   * terrain is in `restrict` (or unconditionally when `restrict` is null) — used by `noiseFill`
   * so blobs read as round/hand-painted rather than a jagged per-tile dilate mask. */
  private patchRestricted(cx: number, cy: number, r: number, t: Terrain, restrict: Set<Terrain> | null, seedOffset: number): void {
    const steps = Math.max(16, Math.round(r * 6));
    const x0 = Math.floor(cx - r * 1.3), x1 = Math.ceil(cx + r * 1.3);
    const y0 = Math.floor(cy - r * 1.3), y1 = Math.ceil(cy + r * 1.3);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
        if (restrict && !restrict.has(this.tiles[yy * this.w + xx])) continue;
        const dx = xx + 0.5 - cx, dy = yy + 0.5 - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > r * 1.3) continue;
        const angle = Math.atan2(dy, dx);
        const angleBucket = Math.round(((angle + Math.PI) / (2 * Math.PI)) * steps);
        const noise = hash2(angleBucket, Math.round(r * 100) + seedOffset, this.seed);
        const localR = r * (0.75 + noise * 0.5); // +-25%
        if (dist <= localR) this.tiles[yy * this.w + xx] = t;
      }
    }
  }

  /** Scatters a handful of round, organically-edged blobs of `t` over the map (optionally
   * restricted to cells currently painted `onlyOver`) — few and large, never a tile-aligned
   * jagged silhouette. Blob count/size is derived from `density` so callers keep the same
   * "fraction of map area" mental model as before. */
  noiseFill(t: Terrain, density: number, onlyOver?: Terrain[]): void {
    if (density <= 0) return;
    const restrict = onlyOver ? new Set(onlyOver) : null;
    const avgBlobArea = Math.PI * 3.5 * 3.5; // radius ~3.5 tiles on average
    const targetArea = this.w * this.h * density;
    const count = Math.max(1, Math.round(targetArea / avgBlobArea));
    const callSeed = 90000 + t.length * 977 + Math.round(density * 100000);
    for (let i = 0; i < count; i++) {
      const cx = hash2(i, 3, this.seed + callSeed) * this.w;
      const cy = hash2(i, 7, this.seed + callSeed + 1) * this.h;
      const r = 2 + hash2(i, 13, this.seed + callSeed + 2) * 3; // 2..5 tiles
      this.patchRestricted(cx, cy, r, t, restrict, callSeed + i * 31);
    }
  }

  private distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  private rasterizeLine(points: Vec2[], width: number, t: Terrain): void {
    if (points.length < 2) {
      if (points.length === 1) this.patch(points[0].x, points[0].y, width / 2, t);
      return;
    }
    const half = width / 2;
    for (let s = 0; s < points.length - 1; s++) {
      const a = points[s], b = points[s + 1];
      const x0 = Math.floor(Math.min(a.x, b.x) - half - 1);
      const x1 = Math.ceil(Math.max(a.x, b.x) + half + 1);
      const y0 = Math.floor(Math.min(a.y, b.y) - half - 1);
      const y1 = Math.ceil(Math.max(a.y, b.y) + half + 1);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const d = this.distToSegment(xx + 0.5, yy + 0.5, a.x, a.y, b.x, b.y);
          if (d <= half) this.set(xx, yy, t);
        }
      }
    }
  }

  road(points: Vec2[], width: number, t: 'dirtroad' | 'pavedroad'): void {
    this.rasterizeLine(points, width, t);
    this.vectors.push({ kind: 'road', terrain: t, points: points.slice(), width });
  }

  river(points: Vec2[], width: number): void {
    this.rasterizeLine(points, width, 'water');
    this.vectors.push({ kind: 'river', terrain: 'water', points: points.slice(), width });
  }

  line(points: Vec2[], t: Terrain): void {
    this.rasterizeLine(points, 1, t);
    this.vectors.push({ kind: 'line', terrain: t, points: points.slice(), width: 1 });
  }

  bridge(x: number, y: number, w: number, h: number): void {
    this.rect(x, y, w, h, 'bridge');
  }

  building(x: number, y: number, w: number, h: number, kind: 'wood' | 'stone'): void {
    const wallT: Terrain = kind === 'wood' ? 'buildingWood' : 'buildingStone';
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.floor(x + w), y1 = Math.floor(y + h);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const onWall = xx === x0 || xx === x1 - 1 || yy === y0 || yy === y1 - 1;
        this.set(xx, yy, onWall ? wallT : 'floor');
      }
    }
  }

  /** Irregular ellipse of 'woods' with a 1-tile 'scatteredtrees' fringe ring. */
  woods(cx: number, cy: number, rx: number, ry: number): void {
    const r = Math.max(rx, ry);
    const steps = Math.max(16, Math.round(r * 6));
    const woodsMask = new Set<string>();
    const x0 = Math.floor(cx - rx * 1.3 - 1), x1 = Math.ceil(cx + rx * 1.3 + 1);
    const y0 = Math.floor(cy - ry * 1.3 - 1), y1 = Math.ceil(cy + ry * 1.3 + 1);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const dx = (xx + 0.5 - cx) / rx, dy = (yy + 0.5 - cy) / ry;
        const dist = Math.hypot(dx, dy);
        if (dist > 1.3) continue;
        const angle = Math.atan2(dy, dx);
        const angleBucket = Math.round(((angle + Math.PI) / (2 * Math.PI)) * steps);
        const noise = hash2(angleBucket, Math.round((rx + ry) * 100), this.seed + 303);
        const localR = 0.75 + noise * 0.5;
        if (dist <= localR) {
          this.set(xx, yy, 'woods');
          woodsMask.add(`${xx},${yy}`);
        }
      }
    }
    // fringe: 1-tile ring of scatteredtrees around the woods blob
    for (const key of woodsMask) {
      const [xs, ys] = key.split(',').map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = xs + dx, ny = ys + dy;
        if (woodsMask.has(`${nx},${ny}`)) continue;
        if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
        const cur = this.get(nx, ny);
        if (cur !== 'woods') this.set(nx, ny, 'scatteredtrees');
      }
    }
  }

  /** Records a decor item; filtered out at map-build time if it lands on water/building tiles. */
  addDecor(kind: DecorKind, x: number, y: number, variant?: number): void {
    this.decor.push({ kind, x, y, variant });
  }

  /** Scatters `count` decor items of `kind` uniformly inside a rect, deterministically, skipping
   * tiles that are water/building at paint time (a final water/building filter also runs at build). */
  scatterDecor(kind: DecorKind, x: number, y: number, w: number, h: number, count: number, seedOffset = 0): void {
    for (let i = 0; i < count; i++) {
      const nx = hash2(i, 11, this.seed + seedOffset);
      const ny = hash2(i, 37, this.seed + seedOffset + 1);
      const px = x + nx * w;
      const py = y + ny * h;
      const t = this.get(Math.floor(px), Math.floor(py));
      if (t !== null && NON_DECOR_TILES.has(t)) continue;
      this.addDecor(kind, px, py, Math.floor(hash2(i, 71, this.seed + seedOffset) * 4));
    }
  }

  /** Irregular elliptical parcel (field), same blobby-edge technique as `patch` but with independent
   * x/y radii and a seed offset so adjacent parcels don't share the same noise pattern. */
  field(cx: number, cy: number, rx: number, ry: number, t: Terrain, seedOffset = 0): void {
    const r = Math.max(rx, ry);
    const steps = Math.max(16, Math.round(r * 6));
    const x0 = Math.floor(cx - rx * 1.3 - 1), x1 = Math.ceil(cx + rx * 1.3 + 1);
    const y0 = Math.floor(cy - ry * 1.3 - 1), y1 = Math.ceil(cy + ry * 1.3 + 1);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const dx = (xx + 0.5 - cx) / rx, dy = (yy + 0.5 - cy) / ry;
        const dist = Math.hypot(dx, dy);
        if (dist > 1.3) continue;
        const angle = Math.atan2(dy, dx);
        const angleBucket = Math.round(((angle + Math.PI) / (2 * Math.PI)) * steps);
        const noise = hash2(angleBucket, Math.round((rx + ry) * 100), this.seed + seedOffset + 7001);
        const localR = 0.7 + noise * 0.6;
        if (dist <= localR) this.set(xx, yy, t);
      }
    }
  }

  /** A ragged single-tile tree line along a polyline: marches 1 tile at a time, leaving
   * occasional natural gaps rather than a solid wall. */
  treeLine(points: Vec2[], seedOffset = 0, gapProb = 0.15): void {
    let n = 0;
    for (let s = 0; s < points.length - 1; s++) {
      const a = points[s], b = points[s + 1];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.round(dist));
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
        const noise = hash2(n++, 13, this.seed + seedOffset + 8001);
        if (noise < gapProb) continue;
        this.set(Math.round(px), Math.round(py), 'scatteredtrees');
      }
    }
  }

  /** A regular grid of scattered trees (orchard), leaving the ground terrain between rows intact. */
  orchard(x: number, y: number, w: number, h: number, spacing = 2): void {
    for (let yy = y; yy < y + h; yy += spacing) {
      for (let xx = x; xx < x + w; xx += spacing) {
        this.set(Math.round(xx), Math.round(yy), 'scatteredtrees');
      }
    }
  }

  /** Poles (or any decor kind) marching along a polyline every `spacing` tiles - telegraph poles,
   * fence posts, etc. */
  decorLine(points: Vec2[], kind: DecorKind, spacing = 6): void {
    let carry = 0;
    for (let s = 0; s < points.length - 1; s++) {
      const a = points[s], b = points[s + 1];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      let d = carry;
      while (d < dist) {
        const t = dist === 0 ? 0 : d / dist;
        this.addDecor(kind, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
        d += spacing;
      }
      carry = d - dist;
    }
  }

  /** A small farmstead: house, barn, shed around a yard, a fence ring with a gap, a track stub,
   * a well/haystacks/cart/woodpile, a small orchard and a vegetable patch. Footprint ~24x22 tiles
   * centred on (cx, cy). */
  farmstead(cx: number, cy: number, seedOffset = 0): void {
    const jitter = (n: number) => Math.round((hash2(n, 5, this.seed + seedOffset) - 0.5) * 2);
    this.building(cx - 6 + jitter(1), cy - 8, 6, 4, 'wood'); // house
    this.building(cx + 2, cy - 3 + jitter(2), 7, 5, 'wood'); // barn
    this.building(cx - 7, cy + 1, 4, 3, 'wood'); // shed
    // fence ring around the yard, with a gap facing south for the track
    this.line([
      { x: cx - 9, y: cy - 10 }, { x: cx + 10, y: cy - 10 }, { x: cx + 10, y: cy + 8 },
      { x: cx + 1, y: cy + 8 },
    ], 'fence');
    this.line([{ x: cx - 2, y: cy + 8 }, { x: cx - 9, y: cy + 8 }, { x: cx - 9, y: cy - 10 }], 'fence');
    this.addDecor('well', cx - 1, cy - 1);
    this.addDecor('haystack', cx + 3, cy + 5);
    this.addDecor('haystack', cx + 5, cy + 6);
    this.addDecor('cart', cx - 3, cy + 4);
    this.addDecor('woodpile', cx - 6, cy + 4);
    this.orchard(cx - 22, cy - 12, 12, 12, 2);
    // centred well clear of the barn (at cx+2..cx+9) — field() paints out to ~1.3x its radius,
    // so a field placed any closer clips into the barn's footprint and corrupts its building
    // tiles (previously invisible since the roof was one undifferentiated fillRect; the
    // footprint-aware roof/courtyard rendering exposes any such overlap directly).
    this.field(cx + 20, cy + 6, 4, 4, 'crops', seedOffset + 21);
  }

  /** A city block: a ring of buildings around an interior courtyard, with a 2-wide paved gateway
   * through one wall connecting the street to the courtyard. */
  block(x: number, y: number, w: number, h: number, kind: 'wood' | 'stone', courtyard: Terrain = 'pavedroad'): void {
    this.building(x, y, w, h, kind);
    const ring = 3;
    const cw = w - 2 * ring, ch = h - 2 * ring;
    if (cw > 2 && ch > 2) this.rect(x + ring, y + ring, cw, ch, courtyard);
    const gx = Math.floor(x + w / 2) - 1;
    this.rect(gx, y + h - ring - 1, 2, ring + 1, 'pavedroad');
  }

  /** A bombed-out building footprint: a rubble mound with 2-4 standing wall SEGMENTS (short
   * contiguous runs, not scattered single-tile dots) surviving along the original perimeter, as
   * if part of each wall collapsed and part is still standing. */
  ruin(x: number, y: number, w: number, h: number, seedOffset = 0): void {
    this.rect(x, y, w, h, 'rubble');
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.floor(x + w), y1 = Math.floor(y + h);
    // the four perimeter edges as (start, end, isHoriz) runs in edge-local coordinates
    const edges: { x0: number; y0: number; len: number; horiz: boolean }[] = [
      { x0, y0, len: x1 - x0, horiz: true },       // north
      { x0, y0: y1 - 1, len: x1 - x0, horiz: true }, // south
      { x0, y0, len: y1 - y0, horiz: false },       // west
      { x0: x1 - 1, y0, len: y1 - y0, horiz: false }, // east
    ];
    const nSegments = 2 + Math.floor(hash2(x0, y0, this.seed + seedOffset + 9010) * 3); // 2..4
    for (let s = 0; s < nSegments; s++) {
      const edge = edges[Math.floor(hash2(x0 + s, y0 + s, this.seed + seedOffset + 9011) * edges.length)];
      const segLen = Math.min(edge.len, 2 + Math.floor(hash2(s, x0, this.seed + seedOffset + 9012) * 3)); // 2..4 tiles
      const maxStart = Math.max(0, edge.len - segLen);
      const start = Math.floor(hash2(s, y0, this.seed + seedOffset + 9013) * (maxStart + 1));
      for (let i = 0; i < segLen; i++) {
        const xx = edge.horiz ? edge.x0 + start + i : edge.x0;
        const yy = edge.horiz ? edge.y0 : edge.y0 + start + i;
        this.set(xx, yy, 'stonewall');
      }
    }
  }
}
