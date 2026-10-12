/**
 * GPU-accelerated YUV renderer, based on the tinyh264 demo:
 * https://github.com/udevbe/tinyh264/tree/master/demo
 *
 * This is the preferred path for software decoding on a phone: the YUV->RGB
 * conversion runs in the fragment shader instead of a per-pixel JS loop, which
 * is what makes TinyH264 usable at all on mobile CPUs.
 *
 * TinyH264Decoder reports the *display* dimensions and hands back a tightly
 * packed YUV420 frame (`w*h*1.5` bytes: Y, then U, then V), so the planes can
 * be sliced directly with no stride guessing.
 */
import YUVSurfaceShader from './YUVSurfaceShader';
import Texture from '../h264-live-player/Texture';
import Canvas from './Canvas';

export default class YUVWebGLCanvas extends Canvas {
  private readonly yTexture: Texture;
  private readonly uTexture: Texture;
  private readonly vTexture: Texture;
  private readonly yuvSurfaceShader: YUVSurfaceShader;

  constructor(canvas: HTMLCanvasElement) {
    super(canvas);
    // `webgl` is the standard name; `experimental-webgl` is a legacy alias
    // that some modern engines refuse to hand out.
    const gl = (canvas.getContext('webgl', { preserveDrawingBuffer: true }) ??
      canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true })) as WebGLRenderingContext | null;
    if (!gl) {
      throw new Error('Unable to initialize WebGL. Your browser may not support it.');
    }
    this.yuvSurfaceShader = YUVSurfaceShader.create(gl);
    this.yTexture = Texture.create(gl, gl.LUMINANCE);
    this.uTexture = Texture.create(gl, gl.LUMINANCE);
    this.vTexture = Texture.create(gl, gl.LUMINANCE);
  }

  decode(buffer: Uint8Array, width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;

    const lumaSize = width * height;
    const chromaSize = lumaSize >> 2;
    const chromaWidth = width >> 1;
    const chromaHeight = height >> 1;

    const yBuffer = buffer.subarray(0, lumaSize);
    const uBuffer = buffer.subarray(lumaSize, lumaSize + chromaSize);
    const vBuffer = buffer.subarray(lumaSize + chromaSize, lumaSize + chromaSize * 2);

    this.yTexture.image2dBuffer(yBuffer, width, height);
    this.uTexture.image2dBuffer(uBuffer, chromaWidth, chromaHeight);
    this.vTexture.image2dBuffer(vBuffer, chromaWidth, chromaHeight);

    this.yuvSurfaceShader.setTexture(this.yTexture, this.uTexture, this.vTexture);
    this.yuvSurfaceShader.updateShaderData({ w: width, h: height }, { maxXTexCoord: 1, maxYTexCoord: 1 });
    this.yuvSurfaceShader.draw();
  }
}
