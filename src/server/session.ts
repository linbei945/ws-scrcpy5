/**
 * One mirroring session: deploy + run the official scrcpy-server 5.0.1 on a
 * device, open an adb tunnel and expose the three sockets (video / audio /
 * control) to the Node.js side.
 *
 * Unlike the original WS-scrcpy, no patched server is required: the official
 * `scrcpy-server-v5.0.1` jar is pushed to the device and started with
 * `tunnel_forward=true`, then the node process connects to it over
 * `adb forward`.
 */
import net from 'node:net';
import { randomInt } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as adb from './adb';
import * as registry from './registry';
import { Fmp4Muxer } from './muxer';
import {
  DEVICE_NAME_FIELD_LENGTH,
  DEVICE_SERVER_PATH,
  PACKET_HEADER_SIZE,
  SCRCPY_VERSION,
  CHANNEL,
  DeviceMessageParser,
  StreamParser,
  codecIdToName,
  concat,
  encodeCodecEvent,
  encodeDeviceName,
  encodeConfigPacket,
  encodeMediaPacket,
  encodeSessionMeta,
  type DeviceMsg,
  type StreamEvent,
} from '../common/protocol';

export interface SessionOptions {
  serial: string;
  /**
   * `'mse'` wraps the video stream in fragmented MP4 before it leaves the
   * server, because a `<video>` element (the MSE path) cannot read Annex-B. The
   * default keeps the raw scrcpy stream, which is what WebCodecs and the WASM
   * decoder both expect.
   */
  container?: 'mse';
  /** opus | aac | flac | raw */
  audioCodec?: string;
  audio?: boolean;
  control?: boolean;
  video?: boolean;
  maxSize?: number;
  videoBitRate?: number;
  audioBitRate?: number;
  maxFps?: number;
  displayId?: number;
  crop?: string;
  videoEncoder?: string;
  audioEncoder?: string;
  stayAwake?: boolean;
  showTouches?: boolean;
  logLevel?: string;
  /**
   * Spawn the bundled CleanUp helper on the device (scrcpy default: true).
   *
   * CleanUp deletes `/data/local/tmp/scrcpy-server.jar` as soon as it starts,
   * about 80 ms after the server. On some devices (observed on redroid/Android
   * 12) the ART runtime still needs to open the jar by path afterwards, so the
   * server dies a few hundred milliseconds later with a native
   * `ClassNotFoundException` abort and no Java-side error. Defaults to false.
   */
  cleanup?: boolean;
  /** Force pushing the jar again even if a copy already exists on the device. */
  forcePush?: boolean;
}

export interface SessionInit {
  deviceName: string;
  serial: string;
  videoCodec?: string;
  audioCodec?: string;
  width: number;
  height: number;
  audio: boolean;
  control: boolean;
  serverVersion: string;
}

export interface SessionHandlers {
  onInit(init: SessionInit): void;
  /** `data` is either the raw scrcpy stream or fMP4, depending on `container`. */
  onMedia(channel: number, data: Uint8Array): void;
  onDeviceMessage(msg: DeviceMsg): void;
  onLog(message: string): void;
  onClosed(reason?: string): void;
}

/** dist/server/index.js -> project root */
const PROJECT_ROOT = resolve(typeof __dirname === 'string' ? __dirname : process.cwd(), '..', '..');

/**
 * Where the jar lives depends on which root we are running from:
 *   <root>/server       - the standalone `pc/` folder (copied to another disk,
 *                         where the folder *is* the root and has no `pc/` in it)
 *   <root>/pc/server    - inside the repository, next to src/ and public/
 *   <root>/vendor       - the layout used before the pc/ split
 * Order matters: check the most specific layout first, and always fall back to
 * the cwd so `node dist/server/index.js` works from anywhere.
 */
export function defaultServerJar(): string {
  if (process.env.SCRCPY_SERVER_PATH) return process.env.SCRCPY_SERVER_PATH;
  const name = `scrcpy-server-v${SCRCPY_VERSION}`;
  const candidates = [
    join(PROJECT_ROOT, 'server', name),
    join(PROJECT_ROOT, 'pc', 'server', name),
    join(PROJECT_ROOT, 'vendor', name),
    join(process.cwd(), 'server', name),
    join(process.cwd(), 'pc', 'server', name),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pause between two tunnel connections, overridable via
 * $WS_SCRCPY_SOCKET_GAP_MS. Establishing them back to back kills the server on
 * some devices (observed on redroid).
 */
const SOCKET_GAP_MS = Number(process.env.WS_SCRCPY_SOCKET_GAP_MS ?? 150) || 0;

/**
 * Time given to the device process to bind its abstract socket before the first
 * connection attempt, overridable via $WS_SCRCPY_BOOT_MS. Connecting too early
 * makes adbd fail the forward and, on some devices, take the server with it.
 */
const SERVER_BOOT_MS = Number(process.env.WS_SCRCPY_BOOT_MS ?? 400) || 0;

export class ScrcpySession {
  private readonly video: boolean;
  private readonly audio: boolean;
  private readonly control: boolean;
  private readonly cleanup: boolean;
  /**
   * Set for `container=mse`: the video stream is parsed here (SPS/PPS, key
   * frames, timestamps) and re-emitted as fMP4 instead of being forwarded raw.
   * Created lazily, because only the MSE path pays for it.
   */
  private muxer: Fmp4Muxer | undefined;
  /** Reuses the client-side parser to split the device stream into packets. */
  private readonly videoPackets = new StreamParser({ expectName: true });

  private scid = 0;
  private socketName = '';
  private port = 0;
  private shell: adb.ShellProcess | undefined;

  private videoSocket?: net.Socket;
  private audioSocket?: net.Socket;
  private controlSocket?: net.Socket;
  private readonly deviceMessageParser = new DeviceMessageParser();

  private stopped = false;
  private started = false;
  private restore: Array<{ table: adb.SettingsTable; key: string; value: string }> = [];
  /** Bytes of the first socket kept back until the header has been parsed. */
  private headerBuffer: Uint8Array = new Uint8Array(0);
  private headerParsed = false;
  private init: SessionInit | undefined;

  constructor(
    private readonly options: SessionOptions,
    private readonly handlers: SessionHandlers,
  ) {
    this.video = options.video !== false;
    this.audio = !!options.audio;
    this.control = options.control !== false;
    this.cleanup = options.cleanup === true;
    // Created up front so a codec the muxer rejects fails the session with a
    // clear message, rather than silently degrading to an unreadable stream.
    if (options.container === 'mse' && this.video) this.muxer = new Fmp4Muxer();
    if (!this.video && !this.audio) {
      throw new Error('At least one of video/audio must be enabled');
    }
  }

  async start(): Promise<void> {
    const jar = defaultServerJar();
    if (!existsSync(jar)) {
      throw new Error(
        `scrcpy-server not found at ${jar}. Run "npm run fetch-server" (or set $SCRCPY_SERVER_PATH).`,
      );
    }
    const size = statSync(jar).size;
    if (size < 1024) throw new Error(`scrcpy-server at ${jar} looks truncated (${size} bytes)`);

    this.scid = randomInt(0, 0x7fffffff);
    this.socketName = `scrcpy_${this.scid.toString(16).padStart(8, '0')}`;

    const serial = this.options.serial;

    // Wireless devices must be reachable before adb push/shell are used.
    if (adb.isNetworkAddress(serial)) {
      this.handlers.onLog(`connecting to ${serial} over adb tcp/ip`);
      try {
        await adb.ensureConnected(serial);
      } catch (e) {
        throw new Error(
          `${(e as Error).message}（请先在手机上开启「无线调试」，或用 adb tcpip 5555 打开端口）`,
        );
      }
    }

    await this.snapshotSettings();

    this.handlers.onLog(`pushing scrcpy-server v${SCRCPY_VERSION} to ${serial}`);
    // Serialised per device: two viewers pressing 开始 at the same time would
    // otherwise write the same jar concurrently.
    await registry.withDeviceLock(serial, () => adb.push(serial, jar, DEVICE_SERVER_PATH));

    this.port = await adb.forward(serial, this.socketName);
    this.handlers.onLog(`adb forward tcp:${this.port} localabstract:${this.socketName}`);

    const args = this.buildServerArgs();
    this.handlers.onLog(`starting server: ${args.join(' ')}`);
    this.shell = adb.shell(serial, args);
    this.shell.onExit((code) => {
      if (!this.stopped) {
        this.handlers.onClosed(`scrcpy-server exited (code ${code})`);
        this.stopped = true;
      }
    });
    this.shell.child.stdout?.on('data', (d) => this.log(String(d).trim()));
    this.shell.child.stderr?.on('data', (d) => this.log(String(d).trim()));

    if (SERVER_BOOT_MS > 0) await sleep(SERVER_BOOT_MS);
    await this.connectSockets();
    this.started = true;
  }

  /**
   * `cleanup=false` means the device will not restore these settings by itself,
   * so remember their current values and put them back when the session ends.
   *
   * These settings are device-global: the first session on a device captures
   * them and the last one restores them (see `restoreSettings`). A second
   * session must not capture them again — it would snapshot the already modified
   * value and write that back permanently.
   */
  private async snapshotSettings(): Promise<void> {
    const serial = this.options.serial;
    const existing = registry.settingsBackup(serial);
    if (existing) {
      this.restore = existing;
      return;
    }
    const remember = async (table: adb.SettingsTable, key: string): Promise<void> => {
      try {
        const value = await adb.getSetting(serial, table, key);
        this.restore.push({ table, key, value });
      } catch (e) {
        this.handlers.onLog(`could not read ${table}:${key}: ${(e as Error).message}`);
      }
    };
    if (this.options.showTouches) await remember('system', 'show_touches');
    if (this.options.stayAwake) await remember('global', 'stay_on_while_plugged_in');
    registry.setSettingsBackup(serial, this.restore);
  }

  private async restoreSettings(): Promise<void> {
    const serial = this.options.serial;
    // Somebody else is still mirroring this device: leave the settings alone,
    // the last session to leave puts them back.
    if (!registry.isLastViewer(serial)) {
      this.restore = [];
      return;
    }
    const backup = registry.takeSettingsBackup(serial) ?? this.restore;
    for (const item of backup) {
      try {
        if (item.value === 'null' || item.value === '') {
          await adb.deleteSetting(serial, item.table, item.key);
        } else {
          await adb.putSetting(serial, item.table, item.key, item.value);
        }
      } catch (e) {
        this.handlers.onLog(`could not restore ${item.table}:${item.key}: ${(e as Error).message}`);
      }
    }
    this.restore = [];
  }

  private log(message: string): void {
    if (!message) return;
    for (const line of message.split(/\r?\n/)) {
      if (line.trim()) this.handlers.onLog(line.trim());
    }
  }

  private buildServerArgs(): string[] {
    const o = this.options;
    const args: string[] = [
      `CLASSPATH=${DEVICE_SERVER_PATH}`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      SCRCPY_VERSION,
      `scid=${this.scid.toString(16).padStart(8, '0')}`,
      `log_level=${o.logLevel || 'info'}`,
      'tunnel_forward=true',
      /*
       * Pinned rather than left to the jar's default. Every decoder this client
       * ships is H.264-only in practice — MSE and the WASM decoder can read
       * nothing else at all — and stating it here means a future scrcpy release
       * that changes its default cannot silently produce a stream the browser
       * renders as a black screen.
       */
      'video_codec=h264',
    ];
    if (!this.video) args.push('video=false');
    if (this.audio) {
      if (o.audioCodec && o.audioCodec !== 'opus') args.push(`audio_codec=${o.audioCodec}`);
      if (o.audioBitRate) args.push(`audio_bit_rate=${o.audioBitRate}`);
      if (o.audioEncoder) args.push(`audio_encoder=${o.audioEncoder}`);
    } else {
      args.push('audio=false');
    }
    if (o.videoBitRate) args.push(`video_bit_rate=${o.videoBitRate}`);
    if (o.maxSize) args.push(`max_size=${o.maxSize}`);
    if (o.maxFps) args.push(`max_fps=${o.maxFps}`);
    if (o.displayId) args.push(`display_id=${o.displayId}`);
    if (o.crop) args.push(`crop=${o.crop}`);
    if (o.videoEncoder) args.push(`video_encoder=${o.videoEncoder}`);
    if (o.stayAwake) args.push('stay_awake=true');
    if (o.showTouches) args.push('show_touches=true');
    if (!this.control) args.push('control=false');
    // scrcpy enables this by default; see the note on SessionOptions.cleanup.
    if (this.cleanup === false) args.push('cleanup=false');
    // keep the defaults: clipboard_autosync=true, cleanup=true, power_on=true,
    // send_dummy_byte=true, send_device_meta=true, send_stream_meta=true,
    // send_frame_meta=true
    return args;
  }

  private async connectSockets(): Promise<void> {
    const order: Array<'video' | 'audio' | 'control'> = [];
    if (this.video) order.push('video');
    if (this.audio) order.push('audio');
    if (this.control) order.push('control');

    /*
     * The first socket cannot be connected the way the others are.
     *
     * `adb forward` accepts the TCP connection before it has resolved the
     * device-side abstract socket, so `connect` fires even when the server has
     * not bound yet — and adb then drops the connection right away. Taking such
     * a socket at face value yields a session that reports "started" and falls
     * over with "device disconnected" a moment later, and whether it happens
     * depends only on how long the ART runtime needed to boot the server. That
     * was the intermittent black screen.
     *
     * scrcpy's own client avoids exactly this by waiting for the server's dummy
     * byte (`connect_and_read_byte`), so do the same: the first socket counts as
     * connected only once the server has actually written to it.
     */
    const head = await this.connectOne(true);
    this.assignSocket(order[0], head.socket);
    // Some devices (observed on redroid) kill the server when the tunnels are
    // established back to back with no gap at all; a short pause makes it
    // reliable and costs nothing.
    if (order.length > 1) await sleep(SOCKET_GAP_MS);

    for (let i = 1; i < order.length; i++) {
      const next = await this.connectOne();
      if (this.stopped) {
        next.socket.destroy();
        throw new Error('session stopped while connecting');
      }
      this.assignSocket(order[i], next.socket);
      if (i !== order.length - 1) await sleep(SOCKET_GAP_MS);
    }

    const first: net.Socket | undefined = this.videoSocket ?? this.audioSocket ?? this.controlSocket;
    if (!first) throw new Error('no socket connected');

    // The first socket carries the dummy byte + device name + codec id,
    // followed by the media stream.
    first.on('data', (chunk: Buffer) => this.onFirstSocketData(new Uint8Array(chunk)));
    // Whatever arrived while waiting for the greeting is part of the stream
    // too, and must be handed over before anything else is read.
    if (head.hello && head.hello.length > 0) {
      this.onFirstSocketData(new Uint8Array(head.hello));
    }

    if (this.audioSocket) {
      this.audioSocket.on('data', (chunk: Buffer) =>
        this.handlers.onMedia(CHANNEL.AUDIO, new Uint8Array(chunk)),
      );
    }
    if (this.controlSocket) {
      this.controlSocket.on('data', (chunk: Buffer) => this.onControlData(new Uint8Array(chunk)));
    }
    for (const socket of [this.videoSocket, this.audioSocket, this.controlSocket]) {
      socket?.on('error', (e) => this.log(`socket error: ${e.message}`));
      socket?.on('close', () => this.handleSocketClosed());
      socket?.setNoDelay(true);
    }
  }

  private handleSocketClosed(): void {
    if (this.stopped) return;
    // Any closed socket means the mirroring is over.
    this.handlers.onClosed('device disconnected');
    void this.stop();
  }

  private assignSocket(kind: 'video' | 'audio' | 'control', socket: net.Socket): void {
    if (kind === 'video') this.videoSocket = socket;
    else if (kind === 'audio') this.audioSocket = socket;
    else this.controlSocket = socket;
  }

  /**
   * Connects one tunnel socket, retrying until the server is reachable.
   *
   * With `expectHello` the connection only counts once the server has written
   * its first byte; see the comment in `connectSockets()` for why that is the
   * only reliable signal that the server is really there.
   */
  private async connectOne(expectHello = false): Promise<{ socket: net.Socket; hello?: Buffer }> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (this.stopped) throw new Error('session stopped');
      const socket = await new Promise<net.Socket>((resolveSocket, rejectSocket) => {
        const s = net.connect({ host: '127.0.0.1', port: this.port });
        const timer = setTimeout(() => {
          s.destroy();
          rejectSocket(new Error('connection timeout'));
        }, 2000);
        s.once('connect', () => {
          clearTimeout(timer);
          resolveSocket(s);
        });
        s.once('error', (e) => {
          clearTimeout(timer);
          rejectSocket(e);
        });
      }).catch((e: Error) => {
        lastError = e;
        return undefined;
      });
      if (!socket) {
        await sleep(100);
        continue;
      }
      if (!expectHello) return { socket };
      const hello = await this.readHello(socket);
      if (hello) return { socket, hello };
      // adb accepted us and dropped us: the server is not listening yet.
      socket.destroy();
      await sleep(100);
    }
    throw new Error(`could not connect to the device tunnel: ${lastError?.message ?? 'unknown error'}`);
  }

  /**
   * Waits for the server's greeting — scrcpy's dummy byte (`send_dummy_byte`,
   * on by default, which is what `connect_and_read_byte` reads upstream).
   *
   * Resolves with `undefined` when the socket closes or nothing arrives; both
   * mean "not ready, try again". The bytes are handed back rather than
   * consumed: they are the head of the stream (dummy byte, device name, codec
   * id) and still have to be parsed by `onFirstSocketData`.
   */
  private readHello(socket: net.Socket): Promise<Buffer | undefined> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = (value: Buffer | undefined): void => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('close', onClose);
        socket.off('error', onError);
        resolve(value);
      };
      const onData = (chunk: Buffer): void => done(chunk);
      const onClose = (): void => done(undefined);
      const onError = (): void => done(undefined);
      timer = setTimeout(() => done(undefined), 2000);
      socket.on('data', onData);
      socket.on('close', onClose);
      socket.on('error', onError);
    });
  }

  private onFirstSocketData(chunk: Uint8Array): void {
    if (this.headerParsed) {
      if (this.video) this.onVideoData(chunk);
      else this.handlers.onMedia(CHANNEL.AUDIO, chunk);
      return;
    }
    this.headerBuffer = concat(this.headerBuffer, chunk);
    // dummy byte + device name + codec id + (video session meta)
    const needed = 1 + DEVICE_NAME_FIELD_LENGTH + 4 + (this.video ? PACKET_HEADER_SIZE : 0);
    if (this.headerBuffer.length < needed) return;

    const view = new DataView(this.headerBuffer.buffer, this.headerBuffer.byteOffset, this.headerBuffer.byteLength);
    const nameBytes = this.headerBuffer.subarray(1, 1 + DEVICE_NAME_FIELD_LENGTH);
    const zero = nameBytes.indexOf(0);
    const deviceName = Buffer.from(zero === -1 ? nameBytes : nameBytes.subarray(0, zero)).toString('utf8');
    const codecId = view.getUint32(1 + DEVICE_NAME_FIELD_LENGTH, false);
    const codecName = codecIdToName(codecId);
    let width = 0;
    let height = 0;
    if (this.video) {
      const offset = 1 + DEVICE_NAME_FIELD_LENGTH + 4;
      // Session meta packets start with the PACKET_FLAG_SESSION bit (0x80).
      if ((this.headerBuffer[offset] & 0x80) !== 0) {
        width = view.getUint32(offset + 4, false);
        height = view.getUint32(offset + 8, false);
      }
    }

    this.init = {
      deviceName,
      serial: this.options.serial,
      videoCodec: this.video ? codecName : undefined,
      audioCodec: this.audio ? (this.video ? undefined : codecName) : undefined,
      width,
      height,
      audio: this.audio,
      control: this.control,
      serverVersion: SCRCPY_VERSION,
    };
    this.headerParsed = true;

    /*
     * Forward everything that follows the dummy byte, so the browser sees the
     * complete stream (device name included) and can parse it on its own. In
     * `mse` mode the header is still forwarded verbatim — the fMP4 substitution
     * happens per *packet*, so the client keeps using the same StreamParser.
     */
    const media = this.headerBuffer.subarray(1);
    this.headerBuffer = new Uint8Array(0);
    this.handlers.onInit(this.init);
    if (this.muxer && width > 0 && height > 0) this.muxer.setGeometry(width, height);
    if (this.video) this.onVideoData(media);
    else this.handlers.onMedia(CHANNEL.AUDIO, media);
  }

  /**
   * Video bytes from the device. In the default mode they are forwarded
   * untouched; in `mse` mode they are parsed and re-emitted as fMP4.
   */
  private onVideoData(chunk: Uint8Array): void {
    if (!this.muxer) {
      this.handlers.onMedia(CHANNEL.VIDEO, chunk);
      return;
    }
    for (const event of this.videoPackets.push(chunk)) {
      this.muxEvent(event);
    }
  }

  /** Re-encodes one parsed video packet as fMP4 and forwards it. */
  private muxEvent(event: StreamEvent): void {
    const muxer = this.muxer;
    if (!muxer) return;
    try {
      if (event.kind === 'codec') {
        muxer.setCodec(event.codec);
        this.handlers.onMedia(CHANNEL.VIDEO, encodeCodecEvent(event.codec));
        return;
      }
      if (event.kind === 'meta') {
        // The browser's video parser is the same one the raw path feeds, so it
        // still consumes the 64-byte name field first. Re-emit it, or every
        // later read is shifted by 64 bytes.
        this.handlers.onMedia(CHANNEL.VIDEO, encodeDeviceName(event.deviceName));
        return;
      }
      if (event.kind === 'session') {
        muxer.setGeometry(event.width, event.height);
        /*
         * Forward it. The raw path forwards it simply by forwarding everything;
         * this path rebuilds the stream, so it has to be re-emitted. Without it
         * the browser keeps the size from `SessionInit` and maps every touch
         * onto the orientation the screen had when mirroring started.
         */
        this.handlers.onMedia(
          CHANNEL.VIDEO,
          encodeSessionMeta(event.width, event.height, event.clientResize),
        );
        return;
      }
      const packet = event.packet;
      if (packet.config) {
        /*
         * `setConfig` returns a segment only when it differs from the one the
         * client already has, so this fires once at the start and again on
         * every real change (rotation, encoder restart with new SPS/PPS).
         * A one-shot latch here was the bug: after a rotation the rebuilt init
         * segment was dropped, and the client went on showing — and accepting
         * input for — the old resolution.
         */
        const init = muxer.setConfig(packet.data);
        if (init) {
          // The init segment replaces the codec-config packet; the client
          // treats it as `setConfig`, which is exactly where MSE wants it.
          this.handlers.onMedia(CHANNEL.VIDEO, encodeConfigPacket(init));
        }
        return;
      }
      const segment = muxer.pushFrame(packet.pts, packet.keyFrame, packet.data);
      // The packet flags still describe the *source* frame (key frame / pts), so
      // the client can keep its usual stats and drop logic.
      if (segment) this.handlers.onMedia(CHANNEL.VIDEO, encodeMediaPacket(segment, packet.pts, packet.keyFrame));
    } catch (e) {
      // A codec the muxer cannot wrap is a client/server mismatch, not a
      // transient condition: report it once and stop pretending to mux.
      this.muxer = undefined;
      this.handlers.onLog(`MSE 封装不可用: ${(e as Error).message}`);
    }
  }

  private onControlData(chunk: Uint8Array): void {
    for (const msg of this.deviceMessageParser.push(chunk)) {
      this.handlers.onDeviceMessage(msg);
    }
  }

  /** Send an already encoded scrcpy control message to the device. */
  sendControl(data: Uint8Array): void {
    if (!this.controlSocket) {
      this.handlers.onLog('control is disabled for this session');
      return;
    }
    if (this.controlSocket.destroyed) return;
    this.controlSocket.write(Buffer.from(data));
  }

  get isRunning(): boolean {
    return this.started && !this.stopped;
  }

  async stop(reason?: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    // Closing the sockets makes the server terminate by itself.
    for (const socket of [this.controlSocket, this.videoSocket, this.audioSocket]) {
      if (socket && !socket.destroyed) {
        try {
          socket.end();
        } catch {
          /* ignore */
        }
        setTimeout(() => socket.destroy(), 500).unref?.();
      }
    }

    if (this.shell) {
      const shell = this.shell;
      setTimeout(() => shell.kill(), 1000).unref?.();
    }
    if (this.port) {
      await adb.removeForward(this.options.serial, this.port);
    }
    await this.restoreSettings();
    this.handlers.onClosed(reason);
  }
}
