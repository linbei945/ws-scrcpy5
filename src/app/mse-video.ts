/**
 * Hardware H.264 playback over Media Source Extensions.
 *
 * `VideoPlayer` (WebCodecs) is unavailable on `http://<lan-ip>`: `VideoDecoder`
 * is a secure-context API, so a phone opening the LAN address gets no decoder.
 * MSE is *not* gated that way — `new MediaSource()` and
 * `MediaSource.isTypeSupported('video/mp4; codecs="avc1.…"')` both work on a
 * plain-http origin (verified by `tools/httpcheck.ts` against a real browser).
 *
 * MSE only *delivers* media: the actual decode is done by the `<video>` element,
 * which normally means the GPU. So this path keeps hardware decoding on http,
 * unlike the WASM fallback — which is why it is preferred when available.
 *
 * The server muxes the scrcpy Annex-B stream into fMP4 (`common/fmp4.ts`) and
 * ships an init segment followed by one media segment per access unit; this
 * class appends them in order, honouring `SourceBuffer.updateend`.
 */
import { TIMESCALE } from '../common/fmp4';
import { BaseVideoPlayer } from './player';

/**
 * A `<video>` element plays media on its own schedule, so there is no per-frame
 * callback to count. `requestVideoFrameCallback` (Chrome 83+) reports decoded
 * frames and is the honest way to fill `stats.frames`.
 */
type VideoFrameCallback = (now: number, meta: { presentedFrames: number }) => void;

/**
 * TS 5.7+ types `Uint8Array` over `ArrayBufferLike`, but `BufferSource` requires
 * an `ArrayBuffer`. Copying through `new ArrayBuffer()` gives a value the
 * SourceBuffer API accepts without a cast at every call site.
 */
function toBufferSource(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(data.length);
  const view = new Uint8Array(buffer);
  view.set(data);
  return view;
}

export class MseVideoPlayer extends BaseVideoPlayer {
  private mediaSource: MediaSource | undefined;
  private objectUrl: string | undefined;
  private sourceBuffer: SourceBuffer | undefined;
  private readonly video: HTMLVideoElement;
  /** The surface every pointer event is bound to; see `resize()`. */
  private readonly canvas: HTMLCanvasElement;
  /** Appended segments when the SourceBuffer is still busy updating. */
  private readonly queue: Uint8Array<ArrayBuffer>[] = [];
  private initialized = false;
  private videoFrameHandle: number | undefined;
  private lastPresented = 0;

  constructor(target: HTMLCanvasElement, onError: (message: string) => void) {
    super(onError);
    this.canvas = target;
    this.video = MseVideoPlayer.createVideoElement(target);
  }

  /**
   * MSE exists on desktop *and* on plain-http phones; the codec check must be
   * done on the actual origin, because `isTypeSupported` is allowed to differ.
   *
   * Several candidate strings are tried rather than one: a browser is allowed
   * to answer `false` for a profile/level combination it does not declare even
   * when it decodes that stream perfectly well. `avc1.42E01E` (Baseline 3.0) is
   * what the spec's own examples use, but some mobile browsers only advertise
   * the level actually present in their hardware tables, so the profile we will
   * really send (read from the stream's `avcC`) is accepted where this probe is
   * not. Checking a list avoids falling back to software decode — which costs
   * the user real battery — merely because the probe picked the wrong rung.
   */
  private static readonly PROBE_CODECS = [
    'video/mp4; codecs="avc1.42E01E"', // Baseline, Level 3.0 (the usual probe)
    'video/mp4; codecs="avc1.42C01F"', // Baseline, Level 3.1
    'video/mp4; codecs="avc1.42C029"', // Baseline, Level 4.1
    'video/mp4; codecs="avc1.640028"', // High, Level 4.0
    'video/mp4; codecs="avc1"', // bare: no profile/level constraint at all
    'video/mp4', // last resort: MSE present, codec unspecified
  ];

  /**
   * Result of the (synchronous) capability probe, memoised: it runs once per
   * page load, and `decoderKind()` calls it on a hot path.
   */
  private static cachedSupport: boolean | undefined = undefined;

  /**
   * Does this browser actually have working MSE?
   *
   * The obvious test — `MediaSource.isTypeSupported('video/mp4; codecs="…"')` —
   * is *not* trustworthy. MIUI's browser (and other Android WebViews) ship a
   * stubbed implementation that answers `false` for **every** input, including
   * the bare `'video/mp4'` that no real implementation rejects. Measured on
   * `XiaoMi/MiuiBrowser/20.28.1020918`, Android 16:
   *
   *     MediaSource.isTypeSupported('video/mp4')             -> false
   *     MediaSource.isTypeSupported('video/mp4; codecs="…"')  -> false
   *     video.canPlayType('video/mp4; codecs="avc1.42E01E"')  -> "probably"
   *     new MediaSource() -> sourceopen -> addSourceBuffer()  -> all succeed
   *
   * So a `false` there proves nothing; the browser plays that exact stream
   * fine. Believing it drops the phone to WASM software decode, which is the
   * battery cost this whole path exists to avoid. The probe therefore:
   *
   *   1. rejects only when the API is genuinely absent;
   *   2. trusts a positive `isTypeSupported` answer immediately;
   *   3. treats an all-`false` sweep over a list containing bare `'video/mp4'`
   *      as a *stubbed* implementation, not a missing one, and falls through to
   *      the two independent signals below;
   *   4. accepts `HTMLMediaElement.canPlayType()` saying "maybe"/"probably" —
   *      it consults the platform's media stack rather than MSE's table;
   *   5. accepts a bare `SourceBuffer` constructor, since a browser that cannot
   *      append fMP4 at all does not expose one.
   *
   * `MseVideoPlayer.startStream()` still guards the real thing: it attaches a
   * `MediaSource` and reports an error if `sourceopen` never arrives, so a
   * browser that passes this probe but cannot stream still fails loudly rather
   * than silently showing black.
   */
  static isSupported(): boolean {
    if (MseVideoPlayer.cachedSupport !== undefined) return MseVideoPlayer.cachedSupport;
    MseVideoPlayer.cachedSupport = MseVideoPlayer.probeSupport();
    return MseVideoPlayer.cachedSupport;
  }

  /**
   * Drops the memoised verdict. Only the test suite needs this, so it can run
   * `isSupported()` again under a simulated `MediaSource` (see
   * `mseSupportedWithStubbedIsTypeSupported` in `main.ts`) without reloading
   * the page.
   */
  static resetSupportCache(): void {
    MseVideoPlayer.cachedSupport = undefined;
  }

  private static probeSupport(): boolean {
    const w = window as unknown as {
      MediaSource?: typeof MediaSource;
      SourceBuffer?: unknown;
    };
    const source = w.MediaSource;
    if (!source) return false;

    // (2) A positive answer is authoritative. Only an all-false sweep over the
    //     list needs interpreting.
    if (typeof source.isTypeSupported === 'function') {
      const answers = MseVideoPlayer.PROBE_CODECS.map((mime) => {
        try {
          return source.isTypeSupported(mime);
        } catch {
          return false;
        }
      });
      if (answers.some(Boolean)) return true;
    }

    // (3) `isTypeSupported` said no to everything — including bare
    //     `'video/mp4'`, which is the signature of a stubbed implementation
    //     rather than a browser without H.264. Fall through to independent
    //     evidence instead of giving up.
    const canPlay = document.createElement('video');
    const verdict = typeof canPlay.canPlayType === 'function'
      ? canPlay.canPlayType('video/mp4; codecs="avc1.42E01E"') ||
        canPlay.canPlayType('video/mp4')
      : '';
    // (4) "maybe" also counts: the browser is unsure of the exact profile/level
    //     but will attempt playback, and the init segment we build is plain
    //     Baseline/High H.264 that every Android decoder handles.
    if (verdict === 'maybe' || verdict === 'probably') return true;

    // (5) Last resort: the MSE interfaces exist and look usable.
    return typeof w.SourceBuffer === 'function';
  }

  static supportsCodec(codec: string): boolean {
    return codec === 'h264' && MseVideoPlayer.isSupported();
  }

  private static createVideoElement(canvas: HTMLCanvasElement): HTMLVideoElement {
    const video = document.createElement('video');
    video.className = 'mse-video';
    video.playsInline = true;
    video.muted = true; // audio has its own WebCodecs path; muted also bypasses autoplay blocking
    video.setAttribute('playsinline', '');
    video.autoplay = true;
    video.preload = 'auto';
    /*
     * The canvas normally owns the mirrored area's size. Mirror whatever CSS box
     * the canvas has so swapping the decoder does not move the layout, and keep
     * the two in the same place in the DOM.
     */
    video.style.position = 'absolute';
    video.style.inset = '0';
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'contain';
    video.style.background = '#000';
    canvas.parentElement?.appendChild(video);
    return video;
  }

  /**
   * The `<video>` paints the picture, but the canvas still owns the geometry of
   * the mirrored area: every pointer event is bound to it, and the device
   * coordinate mapping in `main.ts` reads its bounding box.
   *
   * Leaving it at its initial 1x1 was a bug, not an optimisation: it collapsed
   * to a single pixel in the middle of the stage, so no click, drag or wheel
   * ever reached a listener — browsing worked, controlling did not. The fMP4
   * init segment carries the size for the *video*; the canvas has to be told
   * separately.
   */
  resize(width: number, height: number): void {
    if (width > 0 && height > 0 && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /**
   * Shows or hides the playback surface. `main.ts` hides the canvas when a
   * session ends; the video must follow it, or the last frame stays on screen.
   */
  setVisible(visible: boolean): void {
    this.video.style.display = visible ? '' : 'none';
  }

  /**
   * The canvas is blank on this path — the picture lives in the `<video>` — so
   * the screenshot is taken from there instead of from `ui.canvas`.
   */
  snapshot(): string | null {
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!w || !h) return null;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    try {
      ctx.drawImage(this.video, 0, 0, w, h);
      return off.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  reset(): void {
    this.queue.length = 0;
    this.initialized = false;
    this.unavailable = false;
    if (this.sourceBuffer && this.mediaSource?.readyState === 'open') {
      try {
        if (this.sourceBuffer.updating) this.sourceBuffer.abort();
        this.mediaSource.removeSourceBuffer(this.sourceBuffer);
      } catch {
        /* the element may already be torn down */
      }
    }
    this.sourceBuffer = undefined;
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = undefined;
    }
    this.mediaSource = undefined;
    this.video.removeAttribute('src');
    this.video.load();
    this.stopFrameCounter();
  }

  clear(): void {
    this.reset();
    this.stats.frames = 0;
    this.stats.dropped = 0;
  }

  /**
   * The SPS/PPS packet. Everything in front of it (an fMP4 init segment built
   * by the server) is what MSE actually needs, so this is where the decoder is
   * created — before any media segment can arrive.
   */
  setConfig(data: Uint8Array): void {
    if (this.unavailable) return;
    // scrcpy's config packet is Annex-B SPS+PPS; the server turns it into an
    // fMP4 init segment and sends *that*, so what arrives here is already
    // `ftyp`-prefixed. Guard anyway, so an unmuxed packet cannot be appended.
    if (!MseVideoPlayer.looksLikeInitSegment(data)) return;
    this.startStream(data);
  }

  pushFrame(_pts: number, _keyFrame: boolean, data: Uint8Array): void {
    if (this.unavailable) {
      this.stats.dropped++;
      return;
    }
    if (!this.initialized || !this.mediaSource) {
      // A media segment before the init segment cannot be decoded.
      this.stats.dropped++;
      return;
    }
    this.append(data);
  }

  private static looksLikeInitSegment(data: Uint8Array): boolean {
    // A box type at offset 4: `ftyp` for the init segment, `moof` for media.
    return (
      data.length >= 8 &&
      data[4] === 0x66 /* f */ &&
      data[5] === 0x74 /* t */ &&
      data[6] === 0x79 /* y */ &&
      data[7] === 0x70 /* p */
    );
  }

  /**
   * The MIME the SourceBuffer will be created with.
   *
   * The exact string names the stream's own profile/level. Some browsers accept
   * an `avc1` with no profile/level and reject the qualified form (or vice
   * versa), so the exact one is preferred but a bare `avc1` is an acceptable
   * stand-in: it constrains nothing the decoder cannot discover from the init
   * segment it is about to be handed.
   *
   * `isTypeSupported` is advisory here, not decisive — MIUI's browser answers
   * `false` to every candidate while `addSourceBuffer` accepts them happily
   * (see `probeSupport`). A browser that rejects the stream at append time says
   * so through `video.error`, which is a far better diagnostic than refusing to
   * try. So a candidate is chosen whenever nothing objects *and* one always is
   * chosen, so a stubbed table cannot turn into a hard failure.
   */
  private static mimeFor(init: Uint8Array): string | undefined {
    const exact = `video/mp4; codecs="avc1.${MseVideoPlayer.codecString(init)}"`;
    const bare = 'video/mp4; codecs="avc1"';
    const untyped = 'video/mp4';
    const candidates = [exact, bare, untyped];
    const accepts = (mime: string): boolean => {
      try {
        return MediaSource.isTypeSupported(mime);
      } catch {
        return false;
      }
    };
    return candidates.find(accepts) ?? exact;
  }

  private startStream(init: Uint8Array): void {
    this.reset();
    if (typeof MediaSource !== 'function') {
      this.fail('浏览器不支持 Media Source Extensions（MSE）');
      return;
    }
    const mime = MseVideoPlayer.mimeFor(init);
    if (!mime) {
      this.fail(`浏览器不支持该视频编码: avc1.${MseVideoPlayer.codecString(init)}`);
      return;
    }

    const source = new MediaSource();
    this.mediaSource = source;
    this.objectUrl = URL.createObjectURL(source);
    this.video.src = this.objectUrl;

    source.addEventListener(
      'sourceopen',
      () => {
        if (this.mediaSource !== source) return;
        try {
          const buffer = source.addSourceBuffer(mime);
          // "segments" = let the browser decide how far ahead to buffer; the
          // default is fine and keeps memory bounded on a phone.
          buffer.mode = 'segments';
          buffer.addEventListener('updateend', this.onUpdateEnd);
          this.sourceBuffer = buffer;
          this.initialized = true;
          buffer.appendBuffer(toBufferSource(init));
          // Autoplay is best-effort: the element is muted, which is what the
          // autoplay policy actually keys on, so this normally succeeds.
          void this.video.play().catch(() => undefined);
          this.startFrameCounter();
        } catch (e) {
          this.fail(`MSE 初始化失败: ${(e as Error).message}`);
        }
      },
      { once: true },
    );
    source.addEventListener('error', () => this.fail('MediaSource 出错'));
  }

  /** `avc1.PPCCLL` from the `avcC` embedded in the init segment. */
  private static codecString(init: Uint8Array): string {
    /*
     * The `avcC` box payload is:
     *   +0 configurationVersion (always 0x01)
     *   +1 profile_idc          +2 profile_compatibility  +3 level_idc
     * `indexOfAscii` points at the box *type*, so the four-character name
     * occupies +0..+3 and the fields start at +4. Reading from +4 would pick up
     * configurationVersion and emit `avc1.0142C0`, which MSE rejects outright
     * (the codec string would name a profile that does not exist) — the video
     * element then never gets a decoder and the screen stays black.
     */
    const index = MseVideoPlayer.indexOfAscii(init, 'avcC');
    if (index < 0 || index + 8 > init.length) return '42E01E';
    const hex = (b: number) => b.toString(16).padStart(2, '0').toUpperCase();
    return `${hex(init[index + 5])}${hex(init[index + 6])}${hex(init[index + 7])}`;
  }

  private static indexOfAscii(haystack: Uint8Array, needle: string): number {
    outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle.charCodeAt(j)) continue outer;
      }
      return i;
    }
    return -1;
  }

  private append(segment: Uint8Array): void {
    // Copy: the caller hands us a view into the WebSocket frame buffer, and the
    // SourceBuffer must not retain it.
    this.queue.push(toBufferSource(segment));
    this.pump();
  }

  private pump(): void {
    const buffer = this.sourceBuffer;
    if (!buffer || buffer.updating || this.queue.length === 0) return;
    const next = this.queue[0];
    try {
      buffer.appendBuffer(next);
      this.queue.shift();
    } catch (e) {
      /*
       * QuotaExceededError means the browser's buffer is full. Drop the oldest
       * queued segment and try again rather than dying: a stalled phone should
       * lose a frame, not the whole session.
       */
      if ((e as DOMException).name === 'QuotaExceededError') {
        this.queue.shift();
        this.stats.dropped++;
        if (this.sourceBuffer) {
          try {
            const start = this.sourceBuffer.buffered.length
              ? this.sourceBuffer.buffered.start(0)
              : 0;
            this.sourceBuffer.remove(start, this.video.currentTime);
          } catch {
            /* ignore */
          }
        }
        return;
      }
      this.fail(`MSE appendBuffer 失败: ${(e as Error).message}`);
    }
  }

  private onUpdateEnd = (): void => {
    /*
     * Nudge the playhead to the live edge of a buffer that is being appended
     * faster than it drains, or the picture falls further behind with every
     * segment. The threshold has to leave normal playback alone: a modest gap
     * simply means the element is a little behind the newest data, which is
     * exactly what buffering is for. Only a genuinely stuck element — more than
     * a couple of seconds back — is worth a seek, and even then it should land
     * near the edge rather than on it, so the seek does not immediately run out
     * of data again.
     */
    if (this.initialized && this.video.buffered.length) {
      const end = this.video.buffered.end(this.video.buffered.length - 1);
      if (end - this.video.currentTime > 2) this.video.currentTime = end - 0.5;
      if (this.video.paused) void this.video.play().catch(() => undefined);
    }
    this.pump();
  };

  private startFrameCounter(): void {
    const video = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: VideoFrameCallback) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    if (typeof video.requestVideoFrameCallback !== 'function') return;
    const tick: VideoFrameCallback = (_now, meta) => {
      // `presentedFrames` is monotonic; the delta is this frame's contribution.
      if (meta.presentedFrames > this.lastPresented) {
        this.stats.frames += meta.presentedFrames - this.lastPresented;
        this.lastPresented = meta.presentedFrames;
      }
      if (video.isConnected) this.videoFrameHandle = video.requestVideoFrameCallback(tick);
    };
    this.videoFrameHandle = video.requestVideoFrameCallback(tick);
  }

  private stopFrameCounter(): void {
    const video = this.video as HTMLVideoElement & {
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    if (this.videoFrameHandle !== undefined && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(this.videoFrameHandle);
    }
    this.videoFrameHandle = undefined;
    this.lastPresented = 0;
  }

  close(): void {
    this.reset();
    this.video.remove();
  }
}

/** Re-exported for tests that assert the timescale contract. */
export { TIMESCALE };
