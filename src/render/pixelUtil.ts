// ============================================================================
// pixelUtil.ts — small helpers shared by pixelfont.ts and sprites.ts for
// building procedural pixel art on offscreen canvases.
// ============================================================================

/** Create a fresh offscreen canvas of the given size (transparent). */
export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Get a 2D context with image smoothing disabled (crisp pixel art). */
export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/**
 * Paint "pixel art" described as an array of equal-length strings onto a
 * canvas at (ox, oy). Each character maps to a color via `colorMap`; a
 * character absent from the map (typically '.') is treated as transparent
 * and skipped. Returns the canvas for chaining.
 */
export function putPixelArt(
  canvas: HTMLCanvasElement,
  art: readonly string[],
  colorMap: Record<string, string>,
  ox = 0,
  oy = 0,
): HTMLCanvasElement {
  const ctx = ctx2d(canvas);
  for (let y = 0; y < art.length; y++) {
    const row = art[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const color = colorMap[ch];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(ox + x, oy + y, 1, 1);
    }
  }
  return canvas;
}

/** Draw a single pixel-art string array onto a brand-new canvas sized to fit it. */
export function canvasFromArt(art: readonly string[], colorMap: Record<string, string>): HTMLCanvasElement {
  const w = art.length ? art[0].length : 0;
  const h = art.length;
  const c = createCanvas(w, h);
  putPixelArt(c, art, colorMap);
  return c;
}

/**
 * Rotate a square-ish sprite by an arbitrary angle (radians, clockwise,
 * 0 = no rotation) around its centre using nearest-neighbour sampling.
 * Output canvas is the same size as the input.
 */
export function rotateSprite(src: HTMLCanvasElement, radians: number): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const srcCtx = ctx2d(src);
  const srcData = srcCtx.getImageData(0, 0, w, h);
  const out = createCanvas(w, h);
  const outCtx = ctx2d(out);
  const outData = outCtx.createImageData(w, h);
  const cx = w / 2 - 0.5;
  const cy = h / 2 - 0.5;
  const cos = Math.cos(-radians);
  const sin = Math.sin(-radians);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Rotate destination pixel back into source space (inverse rotation).
      const dx = x - cx;
      const dy = y - cy;
      const sx = Math.round(cx + dx * cos - dy * sin);
      const sy = Math.round(cy + dx * sin + dy * cos);
      const di = (y * w + x) * 4;
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) {
        outData.data[di + 3] = 0;
        continue;
      }
      const si = (sy * w + sx) * 4;
      outData.data[di] = srcData.data[si];
      outData.data[di + 1] = srcData.data[si + 1];
      outData.data[di + 2] = srcData.data[si + 2];
      outData.data[di + 3] = srcData.data[si + 3];
    }
  }
  outCtx.putImageData(outData, 0, 0);
  return out;
}

/** Exact 90°-step rotation (clockwise `steps` times), no resampling artifacts. */
export function rotate90(src: HTMLCanvasElement, steps: number): HTMLCanvasElement {
  const n = ((steps % 4) + 4) % 4;
  if (n === 0) {
    const out = createCanvas(src.width, src.height);
    ctx2d(out).drawImage(src, 0, 0);
    return out;
  }
  const w = src.width;
  const h = src.height;
  const outW = n === 2 ? w : h;
  const outH = n === 2 ? h : w;
  const out = createCanvas(outW, outH);
  const octx = ctx2d(out);
  octx.translate(outW / 2, outH / 2);
  octx.rotate((n * Math.PI) / 2);
  octx.drawImage(src, -w / 2, -h / 2);
  return out;
}

/** Flip horizontally (mirror left/right). */
export function flipH(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = createCanvas(src.width, src.height);
  const octx = ctx2d(out);
  octx.translate(src.width, 0);
  octx.scale(-1, 1);
  octx.drawImage(src, 0, 0);
  return out;
}

/** Flip vertically (mirror top/bottom). */
export function flipV(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = createCanvas(src.width, src.height);
  const octx = ctx2d(out);
  octx.translate(0, src.height);
  octx.scale(1, -1);
  octx.drawImage(src, 0, 0);
  return out;
}

/** Tint every opaque pixel to a solid color while keeping the alpha shape (for monochrome icons/cursors). */
export function recolor(src: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const out = createCanvas(src.width, src.height);
  const octx = ctx2d(out);
  octx.drawImage(src, 0, 0);
  octx.globalCompositeOperation = 'source-in';
  octx.fillStyle = color;
  octx.fillRect(0, 0, src.width, src.height);
  octx.globalCompositeOperation = 'source-over';
  return out;
}

/** Darken/desaturate a sprite in place-copy (for knocked-out / dead variants). */
export function darken(src: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const w = src.width, h = src.height;
  const octx = ctx2d(src);
  const data = octx.getImageData(0, 0, w, h);
  const out = createCanvas(w, h);
  const outCtx = ctx2d(out);
  const outData = outCtx.createImageData(w, h);
  for (let i = 0; i < data.data.length; i += 4) {
    const a = data.data[i + 3];
    if (a === 0) continue;
    const r = data.data[i], g = data.data[i + 1], b = data.data[i + 2];
    const gray = (r + g + b) / 3;
    outData.data[i] = r * factor + gray * (1 - factor) * 0.6;
    outData.data[i + 1] = g * factor + gray * (1 - factor) * 0.6;
    outData.data[i + 2] = b * factor + gray * (1 - factor) * 0.6;
    outData.data[i + 3] = a;
  }
  outCtx.putImageData(outData, 0, 0);
  return out;
}
