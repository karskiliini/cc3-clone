import type { CursorKind, InputState, Screen } from '@/shared/types';
import { PANEL_Y, TILE_PX, VIEW_H, VIEW_W } from '@/shared/types';
import { game } from '@/game';
import type { Battle } from '@/sim/battle';
import { centerCamera, clampCamera } from '@/engine/camera';
import { TerrainRenderer } from '@/render/terrainRender';
import { getFlagSprite } from '@/render/sprites';
import { HUD, PALETTE } from '@/render/palette';
import { drawHudBase, drawHudButton, hitRect, setHudFont } from '@/ui/hud/hudChrome';

const CLOSE_R = { x: 20, y: PANEL_Y + 50, w: 100, h: 20 };

export class OverviewScreen implements Screen {
  private battle: Battle;
  private returnTo: Screen;
  private thumb: HTMLCanvasElement;
  private scale: number;
  private offX: number;
  private offY: number;
  private hoverClose = false;

  constructor(battle: Battle, returnTo: Screen) {
    this.battle = battle;
    this.returnTo = returnTo;
    const map = battle.state.map;
    this.scale = Math.min(VIEW_W / map.width, VIEW_H / map.height);
    const dispW = Math.max(1, Math.round(map.width * this.scale));
    const dispH = Math.max(1, Math.round(map.height * this.scale));
    this.offX = Math.round((VIEW_W - dispW) / 2);
    this.offY = Math.round((VIEW_H - dispH) / 2);
    this.thumb = new TerrainRenderer(map).thumbnail(dispW, dispH);
  }

  update(_dt: number, input: InputState): void {
    this.hoverClose = hitRect(input.mouse, CLOSE_R);
    if (this.hoverClose || input.keysPressed.has('escape')) {
      for (const c of input.clicks) {
        if (c.button === 0 && hitRect({ x: c.x, y: c.y }, CLOSE_R)) {
          game.setScreen(this.returnTo);
          return;
        }
      }
      if (input.keysPressed.has('escape')) {
        game.setScreen(this.returnTo);
        return;
      }
    }
    for (const c of input.clicks) {
      if (c.button !== 0 || c.y >= VIEW_H) continue;
      const wx = (c.x - this.offX) / this.scale;
      const wy = (c.y - this.offY) / this.scale;
      centerCamera(game.cam, { x: wx, y: wy });
      clampCamera(game.cam, this.battle.state.map.width, this.battle.state.map.height);
      game.setScreen(this.returnTo);
      return;
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = PALETTE.black;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.drawImage(this.thumb, this.offX, this.offY);

    for (const vl of this.battle.state.map.victoryLocations) {
      const sx = this.offX + vl.x * this.scale;
      const sy = this.offY + vl.y * this.scale;
      ctx.drawImage(getFlagSprite(vl.owner), sx - 5, sy - 14);
    }

    const side = this.battle.playerSide();
    for (const s of this.battle.state.soldiers.values()) {
      if (s.side !== side || s.health === 'dead') continue;
      const sx = this.offX + s.pos.x * this.scale;
      const sy = this.offY + s.pos.y * this.scale;
      ctx.fillStyle = PALETTE.green;
      ctx.fillRect(sx - 1, sy - 1, 2, 2);
    }
    for (const id of this.battle.state.spotted[side]) {
      const s = this.battle.state.soldiers.get(id);
      if (!s) continue;
      const sx = this.offX + s.pos.x * this.scale;
      const sy = this.offY + s.pos.y * this.scale;
      ctx.fillStyle = PALETTE.red;
      ctx.fillRect(sx - 1, sy - 1, 2, 2);
    }

    const cam = game.cam;
    const vw = VIEW_W / (TILE_PX * cam.zoom);
    const vh = VIEW_H / (TILE_PX * cam.zoom);
    ctx.strokeStyle = PALETTE.white;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      this.offX + cam.x * this.scale + 0.5,
      this.offY + cam.y * this.scale + 0.5,
      vw * this.scale,
      vh * this.scale,
    );

    drawHudBase(ctx);
    setHudFont(ctx, 'small');
    ctx.fillStyle = HUD.text;
    ctx.fillText('Green = friendly, red = spotted enemy, white = current view. Click to recentre.', 140, PANEL_Y + 8);
    drawHudButton(ctx, CLOSE_R, 'Close', { hot: this.hoverClose, fontKind: 'map' });
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
