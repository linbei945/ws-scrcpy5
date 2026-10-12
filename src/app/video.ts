/**
 * Video decoding with the browser WebCodecs API.
 *
 * Android's MediaCodec may emit H.264 either in Annex-B (start-code prefixed)
 * or in AVCC (length prefixed) form depending on the device/encoder, so the
 * stream is normalized to AVCC before being handed to VideoDecoder.
 */
import { VIDEO_CODEC_MIME } from '../common/protocol';
import { splitAnnexB, nalUnitType, NAL_TYPE } from '../common/annexb';
import { annexBToAvcc, buildAvcC } from '../common/fmp4';
import { SoftwareVideoPlayer } from './software-video';
import { MseVideoPlayer } from './mse-video';
import { BaseVideoPlayer, type VideoDecoderLike, type VideoPlayerStats } from './player';

// Re-exported for callers that historically imported them from here (the test
// suite does). The implementations live in `player.ts` / `common/annexb`.
export { splitAnnexB };
export type { VideoDecoderLike, VideoPlayerStats };

export const MISSING_WEBCODECS =
  '浏览器未提供 WebCodecs 视频解码接口（该接口只在安全上下文可用：HTTPS 或 localhost）';

/**
 * WebCodecs lives behind a *secure context*. `http://localhost` qualifies,
 * `http://192.168.5.1` does not.
 */
export function webCodecsAvailable(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return typeof w.VideoDecoder === 'function' && typeof w.EncodedVideoChunk === 'function';
}

/**
 * Which decoder the page will use. This is what the server has to agree on,
 * because it decides whether the stream is forwarded raw or muxed to fMP4.
 *
 *   webcodecs  secure context           raw scrcpy stream, hardware decode
 *   mse        plain http, MSE present  server-muxed fMP4, hardware decode
 *   software   neither                  raw scrcpy stream, WASM software decode
 *   none       browser too old          nothing can render
 */
export type DecoderKind = 'webcodecs' | 'mse' | 'software' | 'none';

/**
 * The user-facing names of the decoders — **the single source of truth.**
 *
 * These strings are used twice: as the 解码方式 dropdown rows and as the line
 * logged when a session starts. They have to be identical, because the log is
 * how the user confirms which row they are actually running; keeping two copies
 * is how they drift apart.
 *
 * Kept to the name alone. Earlier versions appended claims like 「（安全上下文），
 * 支持 H.264 / H.265 / AV1，延迟最低」 — which went stale the moment H.265/AV1
 * were removed, and told the user nothing the dropdown had not already said.
 *
 * Naming convention: identifier first, Chinese description last, so the rows
 * line up in the dropdown column (`httpcheck` asserts this shape).
 */
export const DECODER_LABELS: Record<DecoderKind, string> = {
  webcodecs: 'WebCodecs 硬件解码',
  mse: 'MSE 硬件解码',
  software: 'WASM 软件解码',
  none: '无可用解码方式',
};

/**
 * Chooses the decoder for this page, best first:
 *
 *   1. **WebCodecs** — hardware, accepts H.265/AV1, lowest latency. Secure
 *      context only, so it is what the desktop and any `https://` visitor get.
 *   2. **MSE** — hardware as well (the `<video>` element decodes, normally on
 *      the GPU) and — unlike WebCodecs — *not* restricted to a secure context.
 *      A phone on `http://<lan-ip>` therefore keeps hardware decoding once the
 *      server wraps the stream in fMP4.
 *   3. **WASM software** — the safety net for a browser without MSE: CPU-bound,
 *      H.264 only, but always available.
 */
export function decoderKind(): DecoderKind {
  if (webCodecsAvailable()) return 'webcodecs';
  if (MseVideoPlayer.isSupported()) return 'mse';
  if (SoftwareVideoPlayer.isSupported()) return 'software';
  return 'none';
}

export function createVideoPlayer(
  canvas: HTMLCanvasElement,
  onError: (message: string) => void,
  kind: DecoderKind,
): VideoDecoderLike {
  if (kind === 'webcodecs') return new VideoPlayer(canvas, onError);
  if (kind === 'mse') return new MseVideoPlayer(canvas, onError);
  return new SoftwareVideoPlayer(canvas, onError);
}

/** Hardware decoding through WebCodecs (`VideoDecoder`). */
export class VideoPlayer extends BaseVideoPlayer {
  private readonly ctx: CanvasRenderingContext2D;
  private decoder: VideoDecoder | undefined;
  private description: Uint8Array | undefined;
  private awaitingKeyFrame = true;
  private lastTimestamp = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    onError: (message: string) => void,
  ) {
    super(onError);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
  }

  reset(): void {
    this.unavailable = false;
    this.awaitingKeyFrame = true;
    this.description = undefined;
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        /* ignore */
      }
    }
    this.decoder = undefined;
  }

  resize(width: number, height: number): void {
    if (width > 0 && height > 0 && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /** No-op: this player draws into the canvas, which `main.ts` already toggles. */
  setVisible(_visible: boolean): void {
    /* the canvas is the visible surface */
  }

  /**
   * Drop the last rendered frame and shrink the canvas back to its initial
   * 1x1 size, so a stopped session looks the same as a freshly loaded page.
   */
  clear(): void {
    this.reset();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.stats.frames = 0;
    this.stats.dropped = 0;
    this.lastTimestamp = 0;
  }

  /** Codec configuration packet (SPS/PPS/...). */
  setConfig(data: Uint8Array): void {
    const description = this.buildDescription(data);
    // reset() clears this.description, so it must be assigned afterwards.
    this.reset();
    this.description = description;
    this.awaitingKeyFrame = true;
    this.configure();
  }

  pushFrame(pts: number, keyFrame: boolean, data: Uint8Array): void {
    if (this.unavailable) return;
    if (!this.decoder || this.decoder.state !== 'configured') {
      this.configure();
    }
    if (!this.decoder || this.decoder.state !== 'configured') {
      this.stats.dropped++;
      return;
    }
    // WebCodecs requires a key frame as the first chunk after configure().
    if (this.awaitingKeyFrame && !keyFrame) {
      this.stats.dropped++;
      return;
    }
    this.awaitingKeyFrame = false;
    const timestamp = Number.isFinite(pts) && pts > 0 ? pts : this.lastTimestamp + 1;
    this.lastTimestamp = timestamp;
    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: keyFrame ? 'key' : 'delta',
          timestamp,
          data: this.normalize(data),
        }),
      );
    } catch (e) {
      this.onError(`decode failed: ${(e as Error).message}`);
    }
  }

  private configure(): void {
    if (this.unavailable) return;
    if (this.decoder) return;
    if (!('VideoDecoder' in window)) {
      this.fail(MISSING_WEBCODECS);
      return;
    }
    const mime = VIDEO_CODEC_MIME[this.codecName];
    if (!mime) {
      this.fail(`不支持的视频编码: ${this.codecName}`);
      return;
    }
    const codec =
      this.codecName === 'h264' && this.description ? this.avcCodecString(this.description) : mime;
    this.decoder = new VideoDecoder({
      output: (frame) => this.render(frame),
      error: (e) => this.onError(`VideoDecoder error: ${e.message}`),
    });
    try {
      this.decoder.configure({
        codec,
        description: this.description,
        optimizeForLatency: true,
        hardwareAcceleration: 'no-preference',
      });
    } catch (e) {
      this.decoder = undefined;
      this.fail(`VideoDecoder.configure failed (${codec}): ${(e as Error).message}`);
    }
  }

  private render(frame: VideoFrame): void {
    try {
      this.resize(frame.displayWidth, frame.displayHeight);
      this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
      this.stats.frames++;
    } catch (e) {
      this.onError(`render failed: ${(e as Error).message}`);
    } finally {
      frame.close();
    }
  }

  /** Annex-B -> AVCC conversion (returns the input unchanged when already AVCC). */
  private normalize(data: Uint8Array): Uint8Array {
    if (this.codecName !== 'h264') return data;
    return annexBToAvcc(data, splitAnnexB);
  }

  private buildDescription(data: Uint8Array): Uint8Array {
    if (this.codecName !== 'h264') return data;
    const nals = splitAnnexB(data);
    if (nals.length === 0) return data; // already an avcC buffer
    const sps = nals.find((n) => nalUnitType(n) === NAL_TYPE.SPS);
    const pps = nals.find((n) => nalUnitType(n) === NAL_TYPE.PPS);
    if (!sps || !pps) return data;
    return buildAvcC(sps, pps);
  }

  /** avc1.PPCCLL from an avcC description. */
  private avcCodecString(description: Uint8Array): string {
    if (description.length < 4) return VIDEO_CODEC_MIME.h264;
    const hex = (b: number) => b.toString(16).padStart(2, '0').toUpperCase();
    return `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;
  }

  close(): void {
    this.reset();
  }
}
