import Canvas from './Canvas';

/**
 * Pure-2D fallback for the YUV renderer, used when WebGL is unavailable.
 *
 * Based on the tinyh264 demo (see LICENSE), with two changes over the original:
 *  - a single `cIndex` is computed for U and V (they have the same dimensions
 *    and the original duplicated the expression into `uIndex`/`vIndex`);
 *  - integer fixed-point conversion replaces the float math, which is both
 *    faster and avoids relying on the clamped-array rounding.
 *
 * WebGL is strongly preferred on phones: this path burns CPU on the UI thread
 * on top of the software decode itself.
 */
export default class YUVCanvas extends Canvas {
  private readonly canvasCtx: CanvasRenderingContext2D;
  private canvasBuffer: ImageData | null = null;

  constructor(canvas: HTMLCanvasElement) {
    super(canvas);
    this.canvasCtx = canvas.getContext('2d') as CanvasRenderingContext2D;
  }

  public decode(buffer: Uint8Array, width: number, height: number): void {
    if (!buffer) return;
    if (!this.canvasBuffer || this.canvasBuffer.width !== width || this.canvasBuffer.height !== height) {
      this.canvasBuffer = this.canvasCtx.createImageData(width, height);
    }
    this.canvas.width = width;
    this.canvas.height = height;

    const lumaSize = width * height;
    const chromaSize = lumaSize >> 2;
    const halfW = width >> 1;
    const uOffset = lumaSize;
    const vOffset = lumaSize + chromaSize;
    const out = this.canvasBuffer.data;

    for (let y = 0; y < height; y++) {
      const chromaRow = (y >> 1) * halfW;
      const rowBase = y * width;
      for (let x = 0; x < width; x++) {
        const cIndex = chromaRow + (x >> 1);
        const c = buffer[rowBase + x] - 16;
        const U = buffer[uOffset + cIndex] - 128;
        const V = buffer[vOffset + cIndex] - 128;

        // Fixed-point BT.601 limited-range conversion.
        let r = (298 * c + 409 * V + 128) >> 8;
        let g = (298 * c - 100 * U - 208 * V + 128) >> 8;
        let b = (298 * c + 516 * U + 128) >> 8;
        if (r < 0) r = 0;
        else if (r > 255) r = 255;
        if (g < 0) g = 0;
        else if (g > 255) g = 255;
        if (b < 0) b = 0;
        else if (b > 255) b = 255;

        const rgbIndex = (rowBase + x) * 4;
        out[rgbIndex] = r;
        out[rgbIndex + 1] = g;
        out[rgbIndex + 2] = b;
        out[rgbIndex + 3] = 0xff;
      }
    }

    this.canvasCtx.putImageData(this.canvasBuffer, 0, 0);
  }
}
