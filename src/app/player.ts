/**
 * Shared scaffolding for the three video decoders.
 *
 * All three (`WebCodecs`, `MSE`, `TinyH264`) present the same tiny surface to
 * `main.ts` — stats, a codec name, a reset — and all three need the same
 * "report the first failure, then stay quiet" behaviour: a decoder that fails
 * per frame would otherwise flood the log panel with the same line.
 *
 * Keeping that here means each player file only contains what makes it
 * different, which is the part worth reading.
 */

export interface VideoPlayerStats {
  frames: number;
  dropped: number;
}

export interface VideoDecoderLike {
  readonly stats: VideoPlayerStats;
  readonly codec: string;
  setCodec(codec: string): void;
  reset(): void;
  resize(width: number, height: number): void;
  clear(): void;
  setConfig(data: Uint8Array): void;
  pushFrame(pts: number, keyFrame: boolean, data: Uint8Array): void;
  /** Shows or hides the playback surface (only MSE has a separate one). */
  setVisible(visible: boolean): void;
  /**
   * A still of the current picture, for the screenshot button. Optional: a
   * player that paints into the canvas needs nothing here, `main.ts` reads the
   * canvas directly when the method is absent.
   */
  snapshot?(): string | null;
  close(): void;
}

export abstract class BaseVideoPlayer implements VideoDecoderLike {
  readonly stats: VideoPlayerStats = { frames: 0, dropped: 0 };
  protected codecName = 'h264';
  /** Set once this decoder is known to be unusable, so errors are logged once. */
  protected unavailable = false;

  constructor(protected readonly onError: (message: string) => void) {}

  get codec(): string {
    return this.codecName;
  }

  setCodec(codec: string): void {
    if (codec === this.codecName) return;
    this.codecName = codec;
    this.reset();
  }

  /** Marks the player dead and reports why — exactly once. */
  protected fail(message: string): void {
    if (this.unavailable) return;
    this.unavailable = true;
    this.onError(message);
  }

  abstract reset(): void;
  abstract resize(width: number, height: number): void;
  abstract clear(): void;
  abstract setConfig(data: Uint8Array): void;
  abstract pushFrame(pts: number, keyFrame: boolean, data: Uint8Array): void;
  abstract setVisible(visible: boolean): void;
  abstract close(): void;
}
