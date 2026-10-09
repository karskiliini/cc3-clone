// ============================================================================
// The WebGL side: one renderer on a hidden canvas at the view size x
// SUPERSAMPLE. Each frame it renders the shadow scene and copies it at
// SHADOW_ALPHA (one flat darkness however many hulls overlap), then the
// vehicles, box-downsampled into the 2D view.
// ============================================================================
import { Camera, PCFShadowMap, WebGLRenderer } from 'three';
import { TILE_M, TILE_PX } from '@/shared/types';
import type { VehicleScene } from './vehicleScene';
import { viewProjection, type ViewCam } from './projection';

/** Tuned against the sprites' baked ground shadow (tools/vehicle3dPreview). */
export const SHADOW_ALPHA = 0.42;
export const SUPERSAMPLE = 2;

function defaultFactory(canvas: HTMLCanvasElement): WebGLRenderer {
  return new WebGLRenderer({ canvas, antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
}

export class GlOutput {
  private lost = false;
  private readonly camera = new Camera();

  private constructor(private readonly r: WebGLRenderer, private readonly canvas: HTMLCanvasElement, private readonly w: number, private readonly h: number) {
    r.setPixelRatio(SUPERSAMPLE);
    r.setSize(w, h, false);
    r.setClearColor(0x000000, 0);
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    this.camera.matrixAutoUpdate = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; });
  }

  /** null when WebGL cannot be created: the vehicles stay sprites. */
  static create(w: number, h: number, factory: (canvas: HTMLCanvasElement) => WebGLRenderer = defaultFactory, canvasIn?: HTMLCanvasElement): GlOutput | null {
    try {
      const canvas = canvasIn ?? (typeof document !== 'undefined' ? document.createElement('canvas') : ({} as HTMLCanvasElement));
      return new GlOutput(factory(canvas), canvas, w, h);
    } catch (err) {
      console.warn('[vehicle3d] WebGL unavailable, vehicles stay sprites', err);
      return null;
    }
  }

  /** false after a lost context (the event, or the GL reporting it before the event is queued) or a
   * failed draw: the caller draws sprites. */
  get ready(): boolean {
    if (this.lost) return false;
    try { return !this.r.getContext().isContextLost(); } catch { return false; }
  }

  /** Renders the vehicle layer into ctx; false when it could not (lost context, renderer failure),
   * and then the caller must draw the frame's vehicles as sprites. Never throws. */
  draw(ctx: CanvasRenderingContext2D, vs: VehicleScene, cam: ViewCam, opts: { shadow?: boolean; vehicles?: boolean } = {}): boolean {
    if (!this.ready) return false;
    const smooth = ctx.imageSmoothingEnabled, quality = ctx.imageSmoothingQuality, alpha = ctx.globalAlpha;
    try {
      this.render(ctx, vs, cam, opts, alpha);
      return this.ready;
    } catch (err) {
      console.warn('[vehicle3d] draw failed, vehicles fall back to sprites', err);
      this.lost = true;
      return false;
    } finally {
      ctx.globalAlpha = alpha; ctx.imageSmoothingEnabled = smooth; ctx.imageSmoothingQuality = quality;
    }
  }

  private render(ctx: CanvasRenderingContext2D, vs: VehicleScene, cam: ViewCam, opts: { shadow?: boolean; vehicles?: boolean }, alpha: number): void {
    this.camera.projectionMatrix.fromArray(viewProjection(cam, this.w, this.h));
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    const ppm = (TILE_PX * cam.zoom) / TILE_M;
    vs.fitSun(cam.x * TILE_M + this.w / (2 * ppm), cam.y * TILE_M + this.h / (2 * ppm), Math.hypot(this.w, this.h) / (2 * ppm) + 6);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    if (opts.shadow !== false) {
      this.r.clear(); this.r.render(vs.shadowScene, this.camera);
      ctx.globalAlpha = alpha * SHADOW_ALPHA; ctx.drawImage(this.canvas, 0, 0, this.w, this.h);
    }
    if (opts.vehicles !== false) {
      this.r.clear(); this.r.render(vs.scene, this.camera);
      ctx.globalAlpha = alpha; ctx.drawImage(this.canvas, 0, 0, this.w, this.h);
    }
  }
}
