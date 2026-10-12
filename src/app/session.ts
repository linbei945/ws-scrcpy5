/**
 * Browser side of the bridge: one WebSocket carrying the video / audio streams
 * (binary, multiplexed with a 1 byte channel tag) plus JSON events.
 */
import {
  CHANNEL,
  StreamParser,
  createBackOrScreenOn,
  createGetClipboard,
  createInjectKeycode,
  createInjectScrollEvent,
  createInjectText,
  createInjectTouchEvent,
  createSetClipboard,
  createSetDisplayPower,
  createSimple,
  createStartApp,
  ControlMessageType,
  KeyEventAction,
  MotionEventButton,
  type StreamEvent,
} from '../common/protocol';

export interface SessionCallbacks {
  onOpen(): void;
  onInit(info: {
    deviceName: string;
    serial: string;
    videoCodec?: string;
    audioCodec?: string;
    width: number;
    height: number;
    audio: boolean;
    control: boolean;
    serverVersion: string;
  }): void;
  onVideoEvent(event: StreamEvent): void;
  onAudioEvent(event: StreamEvent): void;
  onClipboard(text: string): void;
  onClipboardAck(sequence: number): void;
  onLog(message: string): void;
  onError(message: string): void;
  onClosed(reason?: string): void;
}

export interface StartOptions {
  serial: string;
  /**
   * `'mse'` asks the server to mux the video stream into fMP4 instead of
   * forwarding the raw scrcpy Annex-B bytes. The MSE player cannot read the raw
   * form at all, so this is not an optimisation — it is a different wire format.
   */
  container?: 'mse';
  audioCodec?: string;
  audio?: boolean;
  maxSize?: number;
  videoBitRate?: number;
  maxFps?: number;
  displayId?: number;
  stayAwake?: boolean;
  showTouches?: boolean;
  logLevel?: string;
  videoEncoder?: string;
}

export class MirroringSession {
  private ws: WebSocket | undefined;
  private clipboardSequence = 0n;
  /** Set by close(): a deliberate stop must not re-enter the onClosed path. */
  private stopped = false;
  /**
   * Both parsers expect the device name: the server emits the 64-byte name
   * field on every video path, raw or muxed, so the byte layout the browser
   * sees is identical either way.
   */
  private readonly videoParser = new StreamParser({ expectName: true });
  private readonly audioParser = new StreamParser({ expectName: false });

  constructor(private readonly callbacks: SessionCallbacks) {}

  static buildUrl(base: string, options: StartOptions): string {
    const params = new URLSearchParams();
    params.set('serial', options.serial);
    if (options.container) params.set('container', options.container);
    if (options.audioCodec) params.set('audioCodec', options.audioCodec);
    if (options.audio) params.set('audio', 'true');
    if (options.maxSize) params.set('maxSize', String(options.maxSize));
    if (options.videoBitRate) params.set('videoBitRate', String(options.videoBitRate));
    if (options.maxFps) params.set('maxFps', String(options.maxFps));
    if (options.displayId) params.set('displayId', String(options.displayId));
    if (options.stayAwake) params.set('stayAwake', 'true');
    if (options.showTouches) params.set('showTouches', 'true');
    if (options.logLevel) params.set('logLevel', options.logLevel);
    if (options.videoEncoder) params.set('videoEncoder', options.videoEncoder);
    const url = new URL(base, window.location.href);
    url.search = params.toString();
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  connect(url: string): void {
    this.stopped = false;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => this.callbacks.onOpen();
    // A manual close() must not fire onClosed: it would reset the UI of the
    // session that is already starting up in its place.
    this.ws.onclose = (e) => {
      if (this.stopped) return;
      this.callbacks.onClosed(e.reason || 'connection closed');
    };
    this.ws.onerror = () => this.callbacks.onError('websocket error');

    this.ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        this.handleJson(event.data);
        return;
      }
      const data = new Uint8Array(event.data as ArrayBuffer);
      if (data.length < 2) return;
      const channel = data[0];
      const payload = data.subarray(1);
      if (channel === CHANNEL.VIDEO) {
        for (const e of this.videoParser.push(payload)) this.callbacks.onVideoEvent(e);
      } else if (channel === CHANNEL.AUDIO) {
        for (const e of this.audioParser.push(payload)) this.callbacks.onAudioEvent(e);
      }
    };
  }

  private handleJson(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'init':
        this.callbacks.onInit(msg as never);
        break;
      case 'clipboard':
        this.callbacks.onClipboard(String(msg.text ?? ''));
        break;
      case 'clipboardAck':
        this.callbacks.onClipboardAck(Number(msg.sequence ?? 0));
        break;
      case 'log':
        this.callbacks.onLog(String(msg.message ?? ''));
        break;
      case 'error':
        this.callbacks.onError(String(msg.message ?? 'unknown error'));
        break;
      case 'closed':
        if (this.stopped) break;
        this.callbacks.onClosed(msg.reason ? String(msg.reason) : undefined);
        break;
      default:
        break;
    }
  }

  private sendRaw(data: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(data);
  }

  /* ---------------- control helpers ---------------- */

  key(action: number, keycode: number, repeat: number, metastate: number): void {
    this.sendRaw(createInjectKeycode(action, keycode, repeat, metastate));
  }

  keyDown(keycode: number, metastate = 0): void {
    this.key(KeyEventAction.DOWN, keycode, 0, metastate);
  }

  keyUp(keycode: number, metastate = 0): void {
    this.key(KeyEventAction.UP, keycode, 0, metastate);
  }

  tapKey(keycode: number, metastate = 0): void {
    this.keyDown(keycode, metastate);
    this.keyUp(keycode, metastate);
  }

  text(text: string): void {
    if (!text) return;
    this.sendRaw(createInjectText(text));
  }

  touch(params: Parameters<typeof createInjectTouchEvent>[0]): void {
    this.sendRaw(createInjectTouchEvent(params));
  }

  scroll(params: Parameters<typeof createInjectScrollEvent>[0]): void {
    this.sendRaw(createInjectScrollEvent(params));
  }

  back(): void {
    this.sendRaw(createBackOrScreenOn(KeyEventAction.DOWN));
    this.sendRaw(createBackOrScreenOn(KeyEventAction.UP));
  }

  setScreenPower(on: boolean): void {
    this.sendRaw(createSetDisplayPower(on));
  }

  expandNotificationPanel(): void {
    this.sendRaw(createSimple(ControlMessageType.EXPAND_NOTIFICATION_PANEL));
  }

  expandSettingsPanel(): void {
    this.sendRaw(createSimple(ControlMessageType.EXPAND_SETTINGS_PANEL));
  }

  collapsePanels(): void {
    this.sendRaw(createSimple(ControlMessageType.COLLAPSE_PANELS));
  }

  rotateDevice(): void {
    this.sendRaw(createSimple(ControlMessageType.ROTATE_DEVICE));
  }

  resetVideo(): void {
    this.sendRaw(createSimple(ControlMessageType.RESET_VIDEO));
  }

  startApp(name: string): void {
    this.sendRaw(createStartApp(name));
  }

  /** Push text to the device clipboard; paste=true also pastes it. */
  setClipboard(text: string, paste = false): void {
    this.clipboardSequence += 1n;
    this.sendRaw(createSetClipboard(this.clipboardSequence, text, paste));
  }

  getClipboard(copyKey = 0): void {
    this.sendRaw(createGetClipboard(copyKey));
  }

  mouseMove(x: number, y: number, w: number, h: number): void {
    this.touch({
      action: 2 /* MOVE */,
      pointerId: -1n,
      x,
      y,
      screenWidth: w,
      screenHeight: h,
      pressure: 1,
      actionButton: 0,
      buttons: MotionEventButton.PRIMARY,
    });
  }

  requestStop(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
    }
  }

  close(): void {
    this.stopped = true;
    this.requestStop();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = undefined;
    }
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}
