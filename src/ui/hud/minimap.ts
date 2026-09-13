// ============================================================================
// minimap.ts — the 168x118 inset at the bottom-left corner of the map
// viewport (x 0..168, y 512..630): whole-map thumbnail, VLs as crosses
// (German) / stars (Russian), friendly units as blue dots, spotted enemies as red dots, the
// current viewport as a yellow rectangle. Click to recentre the camera.
// ============================================================================
import type { Rect, InputState, BattleState, Side, Camera, Vec2 } from '@/shared/types';
import { TILE_PX, VIEW_W, VIEW_H } from '@/shared/types';
import { HUD } from '@/render/palette';
import { TerrainRenderer } from '@/render/terrainRender';
import { centerCamera, clampCamera } from '@/engine/camera';
import { hitRect } from './hudChrome';

const MM_W = 168;
const MM_H = 118;
const MM_X = 0;
const MM_Y = 512;
const THUMB_W = 164;
const THUMB_H = 114;

const FRIENDLY_DOT = '#4a7fd0';

/** 5-point star (Russian VL marker), outer radius `r`, light fill with a dark 1px rim. */
function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, inner: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = '#f0f0ec';
  ctx.fill();
  ctx.strokeStyle = '#0c0c0a';
  ctx.lineWidth = 1;
  ctx.stroke();
}

export class Minimap {
  rect: Rect = { x: MM_X, y: MM_Y, w: MM_W, h: MM_H };
  private thumb: HTMLCanvasElement | null = null;
  private thumbForMap: unknown = null;
  private scaleX = 1;
  private scaleY = 1;
  /** true from the frame the button goes down inside the minimap until it's
   * released, so dragging pans continuously (not just on the initial click). */
  private dragging = false;

  private ensureThumb(terrain: TerrainRenderer, mapWidth: number, mapHeight: number): void {
    if (this.thumbForMap !== terrain) {
      this.thumb = terrain.thumbnail(THUMB_W, THUMB_H);
      this.thumbForMap = terrain;
      this.scaleX = THUMB_W / mapWidth;
      this.scaleY = THUMB_H / mapHeight;
    }
  }

  private originX(): number {
    return MM_X + Math.round((MM_W - THUMB_W) / 2);
  }
  private originY(): number {
    return MM_Y + Math.round((MM_H - THUMB_H) / 2);
  }

  /** Returns true if the click/drag consumed input this frame (camera
   * recentred). Panning continues every frame the button stays held, even
   * once the pointer drags outside the minimap's own rect. */
  update(input: InputState, cam: Camera, mapWidth: number, mapHeight: number): boolean {
    for (const c of input.clicks) {
      if (c.button === 0 && hitRect({ x: c.x, y: c.y }, this.rect)) this.dragging = true;
    }
    if (this.dragging) {
      if (!input.buttons.left) {
        this.dragging = false;
      } else {
        const wx = (input.mouse.x - this.originX()) / this.scaleX;
        const wy = (input.mouse.y - this.originY()) / this.scaleY;
        centerCamera(cam, { x: wx, y: wy });
        clampCamera(cam, mapWidth, mapHeight);
        return true;
      }
    }
    return false;
  }

  draw(ctx: CanvasRenderingContext2D, terrain: TerrainRenderer, state: BattleState, cam: Camera, playerSide: Side): void {
    this.ensureThumb(terrain, state.map.width, state.map.height);
    const ox = this.originX();
    const oy = this.originY();

    ctx.fillStyle = HUD.black;
    ctx.fillRect(MM_X, MM_Y, MM_W, MM_H);
    if (this.thumb) ctx.drawImage(this.thumb, ox, oy);

    // Manual: crosses = German VLs, stars = Russian VLs; unowned VLs stay a thin neutral cross.
    for (const vl of state.map.victoryLocations) {
      const x = Math.round(ox + vl.x * this.scaleX);
      const y = Math.round(oy + vl.y * this.scaleY);
      if (vl.owner === 'soviet') {
        drawStar(ctx, x + 0.5, y + 0.5, 4, 1.7);
      } else {
        ctx.fillStyle = vl.owner === 'german' ? '#0c0c0a' : '#4a4a46';
        const t = vl.owner === 'german' ? 2 : 1;
        ctx.fillRect(x - 4, y - Math.floor(t / 2), 9, t);
        ctx.fillRect(x - Math.floor(t / 2), y - 4, t, 9);
      }
    }

    const dot = (wx: number, wy: number, color: string) => {
      const x = Math.round(ox + wx * this.scaleX);
      const y = Math.round(oy + wy * this.scaleY);
      ctx.fillStyle = '#101018';
      ctx.fillRect(x - 2, y - 2, 5, 5);
      ctx.fillStyle = color;
      ctx.fillRect(x - 1, y - 1, 3, 3);
    };
    for (const s of state.soldiers.values()) {
      if (s.side !== playerSide || s.health === 'dead') continue;
      dot(s.pos.x, s.pos.y, FRIENDLY_DOT);
    }
    for (const v of state.vehicles.values()) {
      if (v.side !== playerSide) continue;
      dot(v.pos.x, v.pos.y, FRIENDLY_DOT);
    }
    for (const id of state.spotted[playerSide]) {
      const s = state.soldiers.get(id);
      if (s) dot(s.pos.x, s.pos.y, HUD.red);
    }
    for (const id of state.spottedVehicles[playerSide]) {
      const v = state.vehicles.get(id);
      if (v) dot(v.pos.x, v.pos.y, HUD.red);
    }

    const px = TILE_PX * cam.zoom;
    ctx.strokeStyle = '#e0c04a';
    ctx.lineWidth = 1;
    const vx = ox + cam.x * this.scaleX;
    const vy = oy + cam.y * this.scaleY;
    const vwPx = (VIEW_W / px) * this.scaleX;
    const vhPx = (VIEW_H / px) * this.scaleY;
    ctx.strokeRect(Math.round(vx) + 0.5, Math.round(vy) + 0.5, Math.round(vwPx), Math.round(vhPx));

    // light 2px bevelled frame (ref_cc3_1482), not the dark maroon HUD frame
    ctx.fillStyle = '#c8c8c0';
    ctx.fillRect(MM_X, MM_Y, MM_W, 2);
    ctx.fillRect(MM_X, MM_Y, 2, MM_H);
    ctx.fillStyle = '#6a6a64';
    ctx.fillRect(MM_X, MM_Y + MM_H - 2, MM_W, 2);
    ctx.fillRect(MM_X + MM_W - 2, MM_Y, 2, MM_H);
  }
}
