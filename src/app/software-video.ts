/**
 * Software H.264 decoder — a drop-in sibling of {@link VideoPlayer}.
 *
 * `VideoPlayer` relies on WebCodecs (`VideoDecoder`), which the browser only
 * exposes in a *secure context*: `https://` or `http://localhost`. A phone
 * opening `http://<lan-ip>` therefore gets no picture at all, and no server
 * change can alter that. This class fills the gap by decoding H.264 in a
 * WebAssembly worker (TinyH264 / h264bsd, vendored from ws-scrcpy) and drawing
 * the YUV frames with a WebGL shader.
 *
 * The trade-offs, documented in the README:
 *  - H.264 only (h264bsd has no H.265/AV1 support);
 *  - CPU-bound, so it wants a smaller resolution and bitrate than WebCodecs.
 *
 * The public surface deliberately mirrors `VideoPlayer` so the caller can swap
 * decoders without touching the rendering pipeline.
 */
import type Canvas from '../../vendor/tinyh264/Canvas';
import YUVCanvas from '../../vendor/tinyh264/YUVCanvas';
import YUVWebGLCanvas from '../../vendor/tinyh264/YUVWebGLCanvas';
import { BaseVideoPlayer } from './player';

/** Emitted by the vendored worker (see vendor/tinyh264/H264NALDecoder.worker.ts). */
interface WorkerMessage {
  type: 'pictureReady' | 'decoderReady' | 'decoderError';
  width?: number;
  height?: number;
  data?: ArrayBuffer;
  renderStateId?: number;
  message?: string;
}

interface DecodedFrame {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export class SoftwareVideoPlayer extends BaseVideoPlayer {
  private worker: Worker | undefined;
  private canvas: Canvas | undefined;
  private decoderReady = false;
  private readonly queue: DecodedFrame[] = [];
  private animationFrameId: number | undefined;
  /** SPS/PPS that must survive the gap before the worker reports ready. */
  private config: Uint8Array | undefined;
  /** The most recent frame seen before the worker was ready. */
  private pending: Uint8Array | undefined;
  /** Bumped per stream so a stale worker result can never paint a new session. */
  private renderStateId = 1;

  constructor(
    private readonly target: HTMLCanvasElement,
    onError: (message: string) => void,
  ) {
    super(onError);
  }

  /** h264bsd decodes H.264 only. */
  static isSupported(): boolean {
    return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
  }

  static supportsCodec(codec: string): boolean {
    return codec === 'h264';
  }

  private ensureWorker(): boolean {
    if (this.unavailable) return false;
    if (!this.worker) {
      try {
        this.worker = new Worker('./decoder.worker.js');
      } catch (e) {
        this.fail(`无法启动软件解码线程: ${(e as Error).message}`);
        return false;
      }
      this.worker.addEventListener('message', this.onWorkerMessage);
      this.worker.addEventListener('error', (event) => {
        this.fail(`软件解码线程错误: ${event.message}`);
      });
    }
    return true;
  }

  private onWorkerMessage = (event: MessageEvent<WorkerMessage>): void => {
    const message = event.data;
    if (message.type === 'decoderReady') {
      this.decoderReady = true;
      this.flushPending();
      return;
    }
    if (message.type === 'decoderError') {
      // A malformed packet must not kill the socket: report and keep going,
      // the next key frame brings the stream back in sync.
      this.onError(`软件解码错误: ${message.message ?? 'unknown'}`);
      return;
    }
    if (message.type !== 'pictureReady' || !message.data) return;
    const width = message.width ?? 0;
    const height = message.height ?? 0;
    if (width <= 0 || height <= 0) return;

    if (!this.canvas) {
      this.canvas = SoftwareVideoPlayer.createCanvas(this.target);
      if (!this.canvas) {
        this.fail('软件解码渲染器初始化失败（WebGL 与 2D 均不可用）');
        return;
      }
    }
    // Keep the queue short: a slow phone must drop frames, not lag behind.
    while (this.queue.length >= 4) {
      this.queue.shift();
      this.stats.dropped++;
    }
    this.queue.push({ width, height, pixels: new Uint8Array(message.data) });
    if (this.animationFrameId === undefined) {
      this.animationFrameId = requestAnimationFrame(this.draw);
    }
  };

  private draw = (): void => {
    this.animationFrameId = undefined;
    const frame = this.queue.shift();
    if (frame && this.canvas) {
      try {
        this.canvas.decode(frame.pixels, frame.width, frame.height);
        this.stats.frames++;
      } catch (e) {
        this.fail(`软件解码渲染失败: ${(e as Error).message}`);
      }
    }
    if (this.queue.length > 0) {
      this.animationFrameId = requestAnimationFrame(this.draw);
    }
  };

  /**
   * Picks the WebGL renderer when available (the GPU does the YUV->RGB math,
   * which matters a lot on a phone) and falls back to a 2D canvas otherwise.
   */
  private static createCanvas(target: HTMLCanvasElement): Canvas | undefined {
    if (SoftwareVideoPlayer.hasWebGL()) {
      try {
        return new YUVWebGLCanvas(target);
      } catch {
        /* fall through to the 2D path */
      }
    }
    try {
      return new YUVCanvas(target);
    } catch {
      return undefined;
    }
  }

  private static hasWebGL(): boolean {
    try {
      const probe = document.createElement('canvas');
      return !!(probe.getContext('webgl') ?? probe.getContext('experimental-webgl'));
    } catch {
      return false;
    }
  }

  reset(): void {
    this.queue.length = 0;
    this.config = undefined;
    this.pending = undefined;
    if (this.animationFrameId !== undefined) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }
    if (this.worker) {
      // Drop the decoder for this stream, then move on to a fresh id. The WASM
      // runtime itself stays alive, so `decoderReady` remains true and the new
      // stream can start pushing frames immediately.
      this.worker.postMessage({ type: 'release', renderStateId: this.renderStateId });
      this.renderStateId++;
    }
    this.canvas = undefined;
  }

  /** Kept for interface parity; the real size comes with each decoded frame. */
  resize(_width: number, _height: number): void {
    /* no-op: dimensions travel with each picture */
  }

  /** No-op: this player draws into the canvas, which `main.ts` already toggles. */
  setVisible(_visible: boolean): void {
    /* the canvas is the visible surface */
  }

  clear(): void {
    this.reset();
    this.target.width = 1;
    this.target.height = 1;
    this.stats.frames = 0;
    this.stats.dropped = 0;
  }

  /** SPS/PPS packet: forwarded like any access unit, the worker sorts it out. */
  setConfig(data: Uint8Array): void {
    // Remembered separately: the worker may not have finished booting yet, and
    // losing the parameter sets would leave every following frame undecodable.
    this.config = data.slice();
    this.pushFrame(0, false, data);
  }

  pushFrame(_pts: number, _keyFrame: boolean, data: Uint8Array): void {
    if (this.unavailable) {
      this.stats.dropped++;
      return;
    }
    if (!this.ensureWorker() || !this.worker) return;
    // Not ready yet: hold the config packet so it can be replayed on 'ready'
    // (frames are expendable, parameter sets are not).
    if (!this.decoderReady) {
      this.pending = data.slice();
      return;
    }
    this.send(data);
  }

  private send(data: Uint8Array): void {
    if (!this.worker) return;
    // Copy: the source is a view into the WebSocket frame, and transferring it
    // would detach the caller's buffer.
    const copy = data.slice();
    this.worker.postMessage(
      {
        type: 'decode',
        data: copy.buffer,
        offset: 0,
        length: copy.byteLength,
        renderStateId: this.renderStateId,
      },
      [copy.buffer],
    );
  }

  /** Replays what arrived before the worker finished booting. */
  private flushPending(): void {
    if (this.config) {
      this.send(this.config);
      this.config = undefined;
    }
    if (this.pending) {
      this.send(this.pending);
      this.pending = undefined;
    }
  }

  close(): void {
    this.reset();
    if (this.worker) {
      this.worker.removeEventListener('message', this.onWorkerMessage);
      this.worker.terminate();
      this.worker = undefined;
    }
  }
}
