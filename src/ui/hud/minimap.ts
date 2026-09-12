// ============================================================================
// minimap.ts — the 168x118 inset at the bottom-left corner of the map
// viewport (x 0..168, y 512..630): whole-map thumbnail, VLs as small '+'
// stars, friendly units as blue dots, spotted enemies as red dots, the
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

export class Minimap {
  rect: Rect = { x: MM_X, y: MM_Y, w: MM_W, h: MM_H };
  private thumb: HTMLCanvasElement | null = null;
  private thumbForMap: unknown = null;
  private scaleX = 1;
  private scaleY = 1;

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

  /** Returns true if the click was consumed (camera recentred). */
  update(input: InputState, cam: Camera, mapWidth: number, mapHeight: number): boolean {
    for (const c of input.clicks) {
      if (c.button !== 0) continue;
      if (!hitRect({ x: c.x, y: c.y }, this.rect)) continue;
      const wx = (c.x - this.originX()) / this.scaleX;
      const wy = (c.y - this.originY()) / this.scaleY;
      centerCamera(cam, { x: wx, y: wy });
      clampCamera(cam, mapWidth, mapHeight);
      return true;
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

    for (const vl of state.map.victoryLocations) {
      const x = ox + vl.x * this.scaleX;
      const y = oy + vl.y * this.scaleY;
      ctx.strokeStyle = '#0c0c0a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y);
      ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3);
      ctx.stroke();
    }

    for (const s of state.soldiers.values()) {
      if (s.side !== playerSide || s.health === 'dead') continue;
      const x = ox + s.pos.x * this.scaleX;
      const y = oy + s.pos.y * this.scaleY;
      ctx.fillStyle = '#4a7fd0';
      ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2);
    }
    for (const v of state.vehicles.values()) {
      if (v.side !== playerSide) continue;
      const x = ox + v.pos.x * this.scaleX;
      const y = oy + v.pos.y * this.scaleY;
      ctx.fillStyle = '#4a7fd0';
      ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2);
    }
    for (const id of state.spotted[playerSide]) {
      const s = state.soldiers.get(id);
      if (!s) continue;
      const x = ox + s.pos.x * this.scaleX;
      const y = oy + s.pos.y * this.scaleY;
      ctx.fillStyle = HUD.red;
      ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2);
    }
    for (const id of state.spottedVehicles[playerSide]) {
      const v = state.vehicles.get(id);
      if (!v) continue;
      const x = ox + v.pos.x * this.scaleX;
      const y = oy + v.pos.y * this.scaleY;
      ctx.fillStyle = HUD.red;
      ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2);
    }

    const px = TILE_PX * cam.zoom;
    ctx.strokeStyle = '#e0c04a';
    ctx.lineWidth = 1;
    const vx = ox + cam.x * this.scaleX;
    const vy = oy + cam.y * this.scaleY;
    const vwPx = (VIEW_W / px) * this.scaleX;
    const vhPx = (VIEW_H / px) * this.scaleY;
    ctx.strokeRect(Math.round(vx) + 0.5, Math.round(vy) + 0.5, Math.round(vwPx), Math.round(vhPx));

    ctx.strokeStyle = HUD.frame;
    ctx.lineWidth = 2;
    ctx.strokeRect(MM_X + 1, MM_Y + 1, MM_W - 2, MM_H - 2);
  }
}
