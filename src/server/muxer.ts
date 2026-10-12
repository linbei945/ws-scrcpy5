/**
 * Server-side fMP4 muxing for the MSE playback path.
 *
 * The WebCodecs path receives the raw scrcpy 5.0.1 Annex-B stream and repairs it
 * client-side. MSE cannot: a `<video>` element will not accept Annex-B at all,
 * it needs fragmented MP4. Rather than ship a JavaScript muxer to every phone
 * (and pay for it twice, in battery and startup time), the split is explicit:
 *
 *   container=mse    -> the server muxes into fMP4 and the client uses MSE
 *   anything else    -> the raw stream is forwarded byte-for-byte, as before
 *
 * The one hard requirement of the fMP4 form is that every media segment begins
 * on an IDR frame, and that no media segment precedes the init segment.
 */
import { splitAnnexB, nalUnitType, NAL_TYPE } from '../common/annexb';
import {
  annexBToAvcc,
  buildInitSegment,
  buildMediaSegment,
  TIMESCALE,
  type AvcProfile,
} from '../common/fmp4';

/**
 * Fallback duration when the stream gives no usable timestamps. 30 fps is a
 * reasonable mean for a mirroring stream and affects only pacing, never
 * decodability.
 */
const DEFAULT_FRAME_DURATION_US = 33_333;

/** `DEFAULT_FRAME_DURATION_US` expressed in the 90 kHz mp4 timescale. */
const DEFAULT_FRAME_DURATION_TICKS = Math.round((DEFAULT_FRAME_DURATION_US * TIMESCALE) / 1_000_000);

/**
 * Upper bound for one sample's duration: ten frames' worth (~333 ms). Anything
 * longer is an encoder stall, and turning it into a sample duration would
 * freeze the picture for that long (see `durationFor`).
 */
const MAX_FRAME_DURATION_TICKS = DEFAULT_FRAME_DURATION_TICKS * 10;

/** Raised for a codec this muxer cannot wrap. */
export class MuxError extends Error {}

export class Fmp4Muxer {
  private sps: Uint8Array | undefined;
  private pps: Uint8Array | undefined;
  private width = 0;
  private height = 0;
  private profile: AvcProfile | undefined;
  private init: Uint8Array | undefined;
  /** The last init segment handed to the caller, compared by identity. */
  private emitted: Uint8Array | undefined;
  /** Something the init segment depends on changed, so it must be rebuilt. */
  private initDirty = false;
  private sequenceNumber = 1;
  /**
   * Where the next media segment must start, in timescale units.
   *
   * This — not the frame's own pts — is what `tfdt` gets. Every segment then
   * begins exactly where the previous one ended, so the timeline MSE sees is
   * gapless by construction. See `durationFor()` for why the raw pts cannot be
   * used directly.
   */
  private nextTime = 0;
  /** Raw pts of the previous frame, in microseconds. */
  private lastPtsMicros: number | undefined = undefined;
  /** Frame counter for the WS_SCRCPY_MUX_DEBUG trace. */
  private debugFrames = 0;
  /** Set once the codec is known to be unsupported, so it is reported once. */
  private failed = false;

  /** True once the init segment is available. */
  get ready(): boolean {
    return Boolean(this.init);
  }

  get codecString(): string {
    if (!this.profile) return 'avc1.42E01E';
    const hex = (b: number) => b.toString(16).padStart(2, '0').toUpperCase();
    return `avc1.${hex(this.profile.profileIdc)}${hex(this.profile.profileCompat)}${hex(this.profile.levelIdc)}`;
  }

  setCodec(codec: string): void {
    if (codec !== 'h264') {
      this.failed = true;
      throw new MuxError(`MSE 封装仅支持 H.264，收到的是 ${codec}`);
    }
    this.failed = false;
  }

  setGeometry(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    /*
     * The sample entry bakes in the display size, so a resize rebuilds the init
     * segment — and the client must be given the new one. Rebuild right away so
     * the muxer stays usable even before the encoder's fresh config packet
     * arrives; `setConfig` is what hands the result out.
     */
    this.initDirty = true;
    this.ensureInit();
  }

  /**
   * Feeds the scrcpy config packet (SPS+PPS in Annex-B).
   *
   * Returns the init segment **only when it differs from the one last handed
   * out** — the first time, and whenever the SPS/PPS or the geometry changed.
   * `undefined` covers "not ready yet" and "nothing new" alike: both mean the
   * same to the caller, which must not re-send an init the client already has.
   *
   * Why "only when changed" matters in both directions:
   *
   *   - Re-emitting the same init on every config packet would tear playback
   *     down for no reason. The client answers an init segment by discarding
   *     its `MediaSource` and building a fresh one (`MseVideoPlayer.setConfig`
   *     -> `startStream` -> `reset`), and a config packet arrives again on
   *     every encoder restart.
   *   - Never re-emitting it — the original one-shot latch — left the client
   *     decoding the *old* resolution after a rotation for the rest of the
   *     session, because the size lives in the init segment and nowhere else.
   */
  setConfig(data: Uint8Array): Uint8Array | undefined {
    for (const nal of splitAnnexB(data)) {
      const type = nalUnitType(nal);
      if (type === NAL_TYPE.SPS) {
        if (!sameBytes(this.sps, nal)) {
          this.sps = nal.slice();
          this.initDirty = true;
        }
      } else if (type === NAL_TYPE.PPS) {
        if (!sameBytes(this.pps, nal)) {
          this.pps = nal.slice();
          this.initDirty = true;
        }
      }
    }
    if (!this.sps || !this.pps) return undefined;
    this.ensureInit();
    const init = this.init;
    if (!init || init === this.emitted) return undefined;
    this.emitted = init;

    /*
     * A fresh init segment means the client builds a fresh MediaSource, whose
     * timeline starts at zero. Restart ours at the same place: continuing the
     * old cursor would make the first segment after a rotation land seconds
     * past the end of the brand-new (empty) buffer, and the element would sit
     * there waiting for data that is not there yet.
     */
    this.nextTime = 0;
    this.lastPtsMicros = undefined;
    return init;
  }

  private ensureInit(): void {
    if (this.init && !this.initDirty) return;
    if (!this.sps || !this.pps || !this.width || !this.height) return;
    this.init = buildInitSegment({
      sps: this.sps,
      pps: this.pps,
      width: this.width,
      height: this.height,
    });
    this.profile = {
      profileIdc: this.sps[1],
      profileCompat: this.sps[2],
      levelIdc: this.sps[3],
    };
    this.initDirty = false;
  }

  /**
   * Converts one media packet (an access unit) into an fMP4 media segment.
   * Returns `undefined` until the init segment exists, because a media segment
   * before `moov` is undecodable and would poison the SourceBuffer.
   */
  pushFrame(pts: number, keyFrame: boolean, data: Uint8Array): Uint8Array | undefined {
    if (this.failed || !this.init) return undefined;

    const avcc = annexBToAvcc(data, splitAnnexB);
    if (avcc.length === 0) return undefined;

    const duration = this.durationFor(pts);
    /*
     * Start this sample exactly where the previous one ended. Using the frame's
     * own pts here is what broke playback: `tfdt` would jump by the real
     * interval while `trun` carried the *previous* interval as this sample's
     * duration, so every change in frame spacing left an unfillable hole — or
     * an overlap — in the timeline. A `<video>` that reaches a hole stops and
     * waits for data that never comes, which is a frozen picture with no error
     * anywhere (the append succeeds, MediaSource stays open).
     */
    const decodeTime = this.nextTime;
    this.nextTime += duration;

    /*
     * Diagnostic only, off unless WS_SCRCPY_MUX_DEBUG=1: MSE plays strictly by
     * timestamp while WebCodecs renders whatever arrives, so a bad timeline
     * shows up as a frozen MSE picture and nothing else.
     */
    if (process.env.WS_SCRCPY_MUX_DEBUG === '1' && this.debugFrames < 40) {
      this.debugFrames++;
      console.log(`[mux-debug] #${this.debugFrames} pts=${pts} decodeTime=${decodeTime} dur=${duration} next=${this.nextTime} key=${keyFrame}`);
    }

    return buildMediaSegment({
      data: avcc,
      decodeTime,
      duration,
      keyFrame,
      sequenceNumber: this.sequenceNumber++,
    });
  }

  /**
   * Sample duration in timescale units, from the gap to the previous frame.
   *
   * A packet that does not advance the timestamp — or steps backwards after a
   * decoder restart — falls back to a nominal frame duration: a zero-length
   * sample makes MSE stall.
   *
   * The gap is also capped. A stalled encoder would otherwise hand out a
   * multi-second "duration", and because the timeline is now built by adding
   * durations up, that single sample would freeze the picture for just as long.
   * Capping keeps one hiccup a hiccup instead of a hang.
   */
  private durationFor(pts: number): number {
    const previous = this.lastPtsMicros;
    this.lastPtsMicros = pts;
    if (previous === undefined) return DEFAULT_FRAME_DURATION_TICKS;
    const deltaMicros = pts - previous;
    if (deltaMicros <= 0) return DEFAULT_FRAME_DURATION_TICKS;
    return Math.min(microsToTimescale(deltaMicros), MAX_FRAME_DURATION_TICKS);
  }
}

/**
 * Microseconds (scrcpy's unit) -> the mp4 timescale. Kept in one place to avoid
 * the classic off-by-1000 that makes a clip play 1000x too fast.
 */
export function microsToTimescale(micros: number): number {
  if (!Number.isFinite(micros) || micros < 0) return 0;
  return Math.round((micros * TIMESCALE) / 1_000_000);
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
