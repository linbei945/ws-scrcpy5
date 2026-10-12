/**
 * A single-channel (LUMINANCE) WebGL texture, used to upload the Y/U/V planes
 * for the shader. Taken from h264-live-player (see the original project's
 * LICENSE) and trimmed to just what the YUV renderer needs: the unused
 * `Program`-based `bind()` helper was dropped along with its dependencies.
 */
export default class Texture {
  public readonly texture: WebGLTexture | null;
  public readonly format: GLenum;

  static create(gl: WebGLRenderingContext, format: number): Texture {
    return new Texture(gl, format);
  }

  constructor(
    readonly gl: WebGLRenderingContext,
    format?: GLenum,
  ) {
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    this.format = format ? format : gl.LUMINANCE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  public fill(textureData: Uint8Array, w: number, h: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // texImage2D re-allocates, which is measurably faster than texSubImage2D
    // for this workload and is what the upstream implementation settled on.
    gl.texImage2D(gl.TEXTURE_2D, 0, this.format, w, h, 0, this.format, gl.UNSIGNED_BYTE, textureData);
  }

  public image2dBuffer(buffer: Uint8Array, width: number, height: number): void {
    this.fill(buffer, width, height);
  }
}
