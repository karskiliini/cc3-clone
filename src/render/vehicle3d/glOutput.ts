// ============================================================================
// The WebGL side: one renderer on a hidden canvas at the view size x
// SUPERSAMPLE. Each frame it renders the shadow scene and copies it at
// SHADOW_ALPHA (one flat darkness however many hulls overlap), then the
// vehicles, box-downsampled into the 2D view.
// ============================================================================
import { Camera, WebGLRenderer } from 'three';
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
    this.camera.matrixAutoUpdate = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; });
  }

  /** null when WebGL cannot be created: the vehicles stay sprites. */
  static create(w: number, h: number, factory: (canvas: HTMLCanvasElement) => WebGLRenderer = defaultFactory): GlOutput | null {
    try {
      const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : ({} as HTMLCanvasElement);
      return new GlOutput(factory(canvas), canvas, w, h);
    } catch (err) {
      console.warn('[vehicle3d] WebGL unavailable, vehicles stay sprites', err);
      return null;
    }
  }

  get ready(): boolean { return !this.lost; }

  draw(ctx: CanvasRenderingContext2D, vs: VehicleScene, cam: ViewCam, opts: { shadow?: boolean; vehicles?: boolean } = {}): void {
    if (this.lost) return;
    this.camera.projectionMatrix.fromArray(viewProjection(cam, this.w, this.h));
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    const smooth = ctx.imageSmoothingEnabled, quality = ctx.imageSmoothingQuality, alpha = ctx.globalAlpha;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    if (opts.shadow !== false) {
      this.r.clear(); this.r.render(vs.shadowScene, this.camera);
      ctx.globalAlpha = alpha * SHADOW_ALPHA; ctx.drawImage(this.canvas, 0, 0, this.w, this.h);
    }
    if (opts.vehicles !== false) {
      this.r.clear(); this.r.render(vs.scene, this.camera);
      ctx.globalAlpha = alpha; ctx.drawImage(this.canvas, 0, 0, this.w, this.h);
    }
    ctx.globalAlpha = alpha; ctx.imageSmoothingEnabled = smooth; ctx.imageSmoothingQuality = quality;
  }
}
