/**
 * scrcpy 5.0.1 wire protocol constants and control-message codec.
 *
 * Shared by the Node.js bridge (server) and the browser client (app), so both
 * sides always agree on the same binary layout.
 *
 * References (scrcpy v5.0.1):
 *   app/src/control_msg.h, app/src/control_msg.c
 *   app/src/device_msg.h
 *   server/src/main/java/com/genymobile/scrcpy/device/Streamer.java
 *   server/src/main/java/com/genymobile/scrcpy/video/VideoCodec.java
 *   server/src/main/java/com/genymobile/scrcpy/audio/AudioCodec.java
 */

export const SCRCPY_VERSION = '5.0.1';

/** Path of the server jar on the device. */
export const DEVICE_SERVER_PATH = '/data/local/tmp/scrcpy-server.jar';

/** Device name is sent as a 64 byte fixed-size NUL padded field. */
export const DEVICE_NAME_FIELD_LENGTH = 64;

/** Multiplexing tag used on the WebSocket between browser and node server. */
export const CHANNEL = {
  VIDEO: 1,
  AUDIO: 2,
} as const;

/* ------------------------------------------------------------------ */
/* Streams                                                             */
/* ------------------------------------------------------------------ */

/** First bit of the 64 bit "pts + flags" header: session (meta) packet. */
export const PACKET_FLAG_SESSION = 1n << 63n;
/** Second bit: the packet contains codec configuration (non media data). */
export const PACKET_FLAG_CONFIG = 1n << 62n;
/** Third bit: the packet is a key frame. */
export const PACKET_FLAG_KEY_FRAME = 1n << 61n;

/** Size of "ptsAndFlags" (8) + "packetSize" (4). */
export const PACKET_HEADER_SIZE = 12;

/** 4-byte ASCII codec ids written by the server before the first packet. */
export const VIDEO_CODEC_ID: Record<string, number> = {
  h264: 0x68323634,
  h265: 0x68323635,
  av1: 0x00617631,
  vp8: 0x00767038,
  vp9: 0x00767039,
};

export const AUDIO_CODEC_ID: Record<string, number> = {
  opus: 0x6f707573,
  aac: 0x00616163,
  flac: 0x666c6163,
  raw: 0x00726177,
};

const ID_TO_NAME: Record<number, string> = {};
for (const [name, id] of Object.entries(VIDEO_CODEC_ID)) ID_TO_NAME[id] = name;
for (const [name, id] of Object.entries(AUDIO_CODEC_ID)) ID_TO_NAME[id] = name;

/**
 * What the device writes *instead of* a codec id when a stream cannot start
 * (`Streamer.writeDisableStream`):
 *
 *   0  that stream is off (audio could not be captured) — video continues
 *   1  a configuration error occurred — scrcpy stops
 *
 * Neither is a codec, but both arrive where a codec id is expected, so they are
 * named here rather than being reported as `unknown(0x0)`.
 */
export const STREAM_DISABLED = 'disabled';
export const STREAM_ERROR = 'error';

export function codecIdToName(id: number): string | undefined {
  if (id === 0) return STREAM_DISABLED;
  if (id === 1) return STREAM_ERROR;
  return ID_TO_NAME[id];
}

/** WebCodecs codec strings per scrcpy codec name. */
export const VIDEO_CODEC_MIME: Record<string, string> = {
  h264: 'avc1.42E01E',
  h265: 'hvc1.1.6.L93.B0',
  av1: 'av01.0.04M.08',
  vp8: 'vp8',
  vp9: 'vp09.00.10.08',
};

export const AUDIO_CODEC_MIME: Record<string, string> = {
  opus: 'opus',
  aac: 'mp4a.40.2',
  flac: 'flac',
  raw: 'pcm-s16',
};

/* ------------------------------------------------------------------ */
/* Control messages (browser -> device)                               */
/* ------------------------------------------------------------------ */

export const ControlMessageType = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  UHID_CREATE: 12,
  UHID_INPUT: 13,
  UHID_DESTROY: 14,
  OPEN_HARD_KEYBOARD_SETTINGS: 15,
  START_APP: 16,
  RESET_VIDEO: 17,
  CAMERA_SET_TORCH: 18,
  CAMERA_ZOOM_IN: 19,
  CAMERA_ZOOM_OUT: 20,
  RESIZE_DISPLAY: 21,
  SCAN_FILE: 22,
} as const;

export type ControlMessageTypeValue =
  (typeof ControlMessageType)[keyof typeof ControlMessageType];

export const KeyEventAction = { DOWN: 0, UP: 1 } as const;

export const MotionEventAction = {
  DOWN: 0,
  UP: 1,
  MOVE: 2,
  CANCEL: 3,
  OUTSIDE: 4,
  POINTER_DOWN: 5,
  POINTER_UP: 6,
  HOVER_MOVE: 7,
  SCROLL: 8,
  HOVER_ENTER: 9,
  HOVER_EXIT: 10,
  BTN_PRESS: 11,
  BTN_RELEASE: 12,
} as const;

/** Android MotionEvent buttons. */
export const MotionEventButton = {
  PRIMARY: 1 << 0,
  SECONDARY: 1 << 1,
  TERTIARY: 1 << 2,
  BACK: 1 << 3,
  FORWARD: 1 << 4,
} as const;

/** Well known pointer ids (see control_msg.h). */
export const POINTER_ID = {
  MOUSE: -1n,
  GENERIC_FINGER: -2n,
  VIRTUAL_FINGER: -3n,
} as const;

export const MAX_CLIPBOARD_TEXT_LENGTH = (1 << 18) - 14;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

function asU16(value: number): number {
  return value & 0xffff;
}

/** float in [0,1] -> unsigned 16-bit fixed point (scrcpy sc_float_to_u16fp). */
export function floatToU16Fp(f: number): number {
  const clamped = Math.min(1, Math.max(0, f));
  return Math.min(0xffff, Math.round(clamped * 0x10000));
}

/** float in [-1,1] -> signed 16-bit fixed point (scrcpy sc_float_to_i16fp). */
export function floatToI16Fp(f: number): number {
  const clamped = Math.min(1, Math.max(-1, f));
  const i = Math.round(clamped * 0x8000);
  return Math.max(-0x8000, Math.min(0x7fff, i));
}

function writePosition(view: DataView, offset: number, x: number, y: number, w: number, h: number): void {
  view.setInt32(offset, x | 0, false);
  view.setInt32(offset + 4, y | 0, false);
  view.setUint16(offset + 8, asU16(w), false);
  view.setUint16(offset + 10, asU16(h), false);
}

/**
 * KEYCODE injection (14 bytes):
 *   type | action | keycode(u32) | repeat(u32) | metastate(u32)
 */
export function createInjectKeycode(
  action: number,
  keycode: number,
  repeat: number,
  metastate: number,
): Uint8Array {
  const buf = new Uint8Array(14);
  const view = new DataView(buf.buffer);
  view.setUint8(0, ControlMessageType.INJECT_KEYCODE);
  view.setUint8(1, action);
  view.setUint32(2, keycode >>> 0, false);
  view.setUint32(6, repeat >>> 0, false);
  view.setUint32(10, metastate >>> 0, false);
  return buf;
}

/** Text injection (UTF-8, no key events). */
export function createInjectText(text: string): Uint8Array {
  const raw = textEncoder.encode(text.slice(0, 300));
  const buf = new Uint8Array(1 + 4 + raw.length);
  const view = new DataView(buf.buffer);
  view.setUint8(0, ControlMessageType.INJECT_TEXT);
  view.setUint32(1, raw.length, false);
  buf.set(raw, 5);
  return buf;
}

/**
 * TOUCH injection (32 bytes):
 *   type | action | pointerId(u64) | x(i32) | y(i32) | screenW(u16) |
 *   screenH(u16) | pressure(u16fp) | actionButton(u32) | buttons(u32)
 */
export function createInjectTouchEvent(params: {
  action: number;
  pointerId: bigint | number;
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
  pressure: number;
  actionButton?: number;
  buttons?: number;
}): Uint8Array {
  const buf = new Uint8Array(32);
  const view = new DataView(buf.buffer);
  view.setUint8(0, ControlMessageType.INJECT_TOUCH_EVENT);
  view.setUint8(1, params.action);
  view.setBigUint64(2, BigInt(params.pointerId), false);
  writePosition(view, 10, params.x, params.y, params.screenWidth, params.screenHeight);
  view.setUint16(22, floatToU16Fp(params.pressure), false);
  view.setUint32(24, (params.actionButton ?? 0) >>> 0, false);
  view.setUint32(28, (params.buttons ?? 0) >>> 0, false);
  return buf;
}

/**
 * SCROLL injection (21 bytes):
 *   type | x(i32) | y(i32) | screenW(u16) | screenH(u16) |
 *   hscroll(i16fp) | vscroll(i16fp) | buttons(u32)
 *
 * hscroll/vscroll are normalized by /16 then clamped to [-1, 1], exactly like
 * the native client does.
 */
export function createInjectScrollEvent(params: {
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
  hscroll: number;
  vscroll: number;
  buttons?: number;
}): Uint8Array {
  const buf = new Uint8Array(21);
  const view = new DataView(buf.buffer);
  view.setUint8(0, ControlMessageType.INJECT_SCROLL_EVENT);
  writePosition(view, 1, params.x, params.y, params.screenWidth, params.screenHeight);
  const h = Math.min(1, Math.max(-1, params.hscroll / 16));
  const v = Math.min(1, Math.max(-1, params.vscroll / 16));
  view.setInt16(13, floatToI16Fp(h), false);
  view.setInt16(15, floatToI16Fp(v), false);
  view.setUint32(17, (params.buttons ?? 0) >>> 0, false);
  return buf;
}

/** BACK or turn screen on (2 bytes). */
export function createBackOrScreenOn(action: number): Uint8Array {
  return new Uint8Array([ControlMessageType.BACK_OR_SCREEN_ON, action]);
}

/** Ask the device for its clipboard (2 bytes). copyKey: 0 none, 1 copy, 2 cut. */
export function createGetClipboard(copyKey = 0): Uint8Array {
  return new Uint8Array([ControlMessageType.GET_CLIPBOARD, copyKey]);
}

/** Push the clipboard to the device, optionally pasting it immediately. */
export function createSetClipboard(sequence: bigint | number, text: string, paste = false): Uint8Array {
  let raw = textEncoder.encode(text);
  if (raw.length > MAX_CLIPBOARD_TEXT_LENGTH) {
    raw = raw.slice(0, MAX_CLIPBOARD_TEXT_LENGTH);
  }
  const buf = new Uint8Array(10 + 4 + raw.length);
  const view = new DataView(buf.buffer);
  view.setUint8(0, ControlMessageType.SET_CLIPBOARD);
  view.setBigUint64(1, BigInt(sequence), false);
  view.setUint8(9, paste ? 1 : 0);
  view.setUint32(10, raw.length, false);
  buf.set(raw, 14);
  return buf;
}

export function createSetDisplayPower(on: boolean): Uint8Array {
  return new Uint8Array([ControlMessageType.SET_DISPLAY_POWER, on ? 1 : 0]);
}

/** Start an app by package name (or "activity" form). */
export function createStartApp(name: string): Uint8Array {
  const raw = textEncoder.encode(name.slice(0, 255));
  const buf = new Uint8Array(1 + 1 + raw.length);
  buf[0] = ControlMessageType.START_APP;
  buf[1] = raw.length;
  buf.set(raw, 2);
  return buf;
}

export function createResizeDisplay(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(5);
  const view = new DataView(buf.buffer);
  view.setUint8(0, ControlMessageType.RESIZE_DISPLAY);
  view.setUint16(1, asU16(width), false);
  view.setUint16(3, asU16(height), false);
  return buf;
}

/** Messages without any payload. */
export function createSimple(type: ControlMessageTypeValue): Uint8Array {
  return new Uint8Array([type]);
}

/* ------------------------------------------------------------------ */
/* Device messages (device -> browser)                                */
/* ------------------------------------------------------------------ */

export const DeviceMessageType = {
  CLIPBOARD: 0,
  ACK_CLIPBOARD: 1,
  UHID_OUTPUT: 2,
} as const;

export type DeviceMsg =
  | { type: typeof DeviceMessageType.CLIPBOARD; text: string }
  | { type: typeof DeviceMessageType.ACK_CLIPBOARD; sequence: number }
  | { type: typeof DeviceMessageType.UHID_OUTPUT; id: number; data: Uint8Array };

/**
 * Incremental parser for the control socket: the device writes a stream of
 * device messages, one after the other, without any framing.
 */
export class DeviceMessageParser {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): DeviceMsg[] {
    this.buffer = concat(this.buffer, chunk);
    const messages: DeviceMsg[] = [];
    for (;;) {
      const msg = this.tryParse();
      if (!msg) break;
      messages.push(msg.msg);
      this.buffer = this.buffer.subarray(msg.consumed);
    }
    return messages;
  }

  private tryParse(): { msg: DeviceMsg; consumed: number } | undefined {
    const buf = this.buffer;
    if (buf.length < 1) return undefined;
    const type = buf[0];
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    switch (type) {
      case DeviceMessageType.CLIPBOARD: {
        if (buf.length < 5) return undefined;
        const len = view.getUint32(1, false);
        if (buf.length < 5 + len) return undefined;
        const text = textDecoder.decode(buf.subarray(5, 5 + len));
        return { msg: { type, text }, consumed: 5 + len };
      }
      case DeviceMessageType.ACK_CLIPBOARD: {
        if (buf.length < 9) return undefined;
        const sequence = Number(view.getBigUint64(1, false));
        return { msg: { type, sequence }, consumed: 9 };
      }
      case DeviceMessageType.UHID_OUTPUT: {
        if (buf.length < 5) return undefined;
        const id = view.getUint16(1, false);
        const size = view.getUint16(3, false);
        if (buf.length < 5 + size) return undefined;
        return {
          msg: { type, id, data: buf.slice(5, 5 + size) },
          consumed: 5 + size,
        };
      }
      default:
        // Unknown message: nothing can be recovered, drop everything.
        this.buffer = new Uint8Array(0);
        return undefined;
    }
  }
}

/**
 * Re-encodes stream events back into scrcpy 5.0.1 wire form.
 *
 * Only the fMP4 (`container=mse`) path needs this: instead of forwarding the
 * device's bytes verbatim, the server rebuilds the stream around the muxed
 * segments. Keeping the encoders here — next to the parser that reads them —
 * means the two can never drift apart.
 */
function packetHeader(ptsAndFlags: bigint, size: number): Uint8Array {
  const header = new Uint8Array(PACKET_HEADER_SIZE);
  const view = new DataView(header.buffer);
  view.setBigUint64(0, ptsAndFlags, false);
  view.setUint32(8, size, false);
  return header;
}

/** The 4-byte codec id, as the device writes it before the first packet. */
export function encodeCodecEvent(codec: string): Uint8Array {
  const id = VIDEO_CODEC_ID[codec] ?? AUDIO_CODEC_ID[codec] ?? 0;
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, id, false);
  return out;
}

/**
 * The 64-byte device name that precedes the codec id in the raw stream.
 *
 * The fMP4 path rebuilds the stream packet by packet, so it has to re-emit
 * this too: the browser's video parser is a plain `StreamParser`, and a
 * missing name field would shift every following read by exactly this many
 * bytes — turning the codec id into garbage and hiding the init segment.
 */
export function encodeDeviceName(name: string): Uint8Array {
  const out = new Uint8Array(DEVICE_NAME_FIELD_LENGTH);
  out.set(new TextEncoder().encode(name).subarray(0, DEVICE_NAME_FIELD_LENGTH - 1));
  return out;
}

/** A config packet: the client routes it to `setConfig()` (init segment). */
export function encodeConfigPacket(data: Uint8Array): Uint8Array {
  const header = packetHeader(PACKET_FLAG_CONFIG, data.length);
  const out = new Uint8Array(header.length + data.length);
  out.set(header, 0);
  out.set(data, header.length);
  return out;
}

/** A media packet: the client routes it to `pushFrame()` (fMP4 fragment). */
export function encodeMediaPacket(data: Uint8Array, pts = 0, keyFrame = false): Uint8Array {
  let flags = 0n;
  if (keyFrame) flags |= PACKET_FLAG_KEY_FRAME;
  const header = packetHeader(BigInt(pts) | flags, data.length);
  const out = new Uint8Array(header.length + data.length);
  out.set(header, 0);
  out.set(data, header.length);
  return out;
}

/**
 * The 12-byte session packet the device writes before every (re)start of the
 * video encoder — at the beginning of the stream, on rotation, and on a display
 * or encoder reset (`Streamer.writeSessionMeta`, called from
 * `SurfaceEncoder.streamCapture`).
 *
 * The raw path forwards it because it forwards everything. The fMP4 path parses
 * the stream and rebuilds it packet by packet, so it has to re-emit this too:
 * `width`/`height` are what the browser maps touch coordinates onto, and in
 * that mode nothing else carries the new geometry — dropping it leaves the input
 * pointing at the old orientation after a rotation.
 */
export function encodeSessionMeta(width: number, height: number, clientResize = false): Uint8Array {
  const out = new Uint8Array(PACKET_HEADER_SIZE);
  const view = new DataView(out.buffer);
  // Exactly Streamer.writeSessionMeta(): the SESSION flag's high word, plus bit
  // 0 when the resize was requested by the client.
  let flags = Number(PACKET_FLAG_SESSION >> 32n) >>> 0;
  if (clientResize) flags |= 1;
  view.setUint32(0, flags >>> 0, false);
  view.setUint32(4, width >>> 0, false);
  view.setUint32(8, height >>> 0, false);
  return out;
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/* ------------------------------------------------------------------ */
/* Media stream parsing (used by the browser)                         */
/* ------------------------------------------------------------------ */

export interface StreamPacket {
  /** Presentation timestamp (0 for config packets). */
  pts: number;
  /** true for codec configuration (SPS/PPS, ...) packets. */
  config: boolean;
  keyFrame: boolean;
  data: Uint8Array;
}

export interface SessionMeta {
  width: number;
  height: number;
  clientResize: boolean;
}

export type StreamEvent =
  | { kind: 'meta'; deviceName: string }
  | { kind: 'codec'; codec: string }
  | { kind: 'session'; width: number; height: number; clientResize: boolean }
  | { kind: 'packet'; packet: StreamPacket };

/**
 * Parses a media stream (video or audio) as produced by scrcpy 5.0.1:
 *
 *   [device name: 64 bytes]        (only on the first socket)
 *   [codec id: 4 bytes]
 *   [session meta: 12 bytes]       (video only, may be repeated on resize)
 *   [header: 12 bytes][payload]    (repeated)
 */
export class StreamParser {
  /** Remaining bytes of the payload of the packet being read. */
  private pendingPacket: { pts: number; config: boolean; keyFrame: boolean; size: number } | undefined;
  private buffer: Uint8Array = new Uint8Array(0);
  private state: 'name' | 'codec' | 'packets' = 'name';

  /** @param expectName true for the first socket (the device name is sent there) */
  constructor(opts: { expectName: boolean }) {
    if (!opts.expectName) this.state = 'codec';
  }

  push(chunk: Uint8Array): StreamEvent[] {
    this.buffer = concat(this.buffer, chunk);
    const events: StreamEvent[] = [];
    for (;;) {
      const event = this.next();
      if (!event) break;
      events.push(event);
    }
    return events;
  }

  private next(): StreamEvent | undefined {
    const buf = this.buffer;
    if (this.pendingPacket) {
      if (buf.length < this.pendingPacket.size) return undefined;
      const payload = buf.slice(0, this.pendingPacket.size);
      this.buffer = buf.subarray(this.pendingPacket.size);
      const { pts, config, keyFrame } = this.pendingPacket;
      this.pendingPacket = undefined;
      return { kind: 'packet', packet: { pts, config, keyFrame, data: payload } };
    }

    if (this.state === 'name') {
      if (buf.length < DEVICE_NAME_FIELD_LENGTH) return undefined;
      const raw = buf.subarray(0, DEVICE_NAME_FIELD_LENGTH);
      const end = raw.indexOf(0);
      const deviceName = textDecoder.decode(end === -1 ? raw : raw.subarray(0, end));
      this.buffer = buf.subarray(DEVICE_NAME_FIELD_LENGTH);
      this.state = 'codec';
      return { kind: 'meta', deviceName };
    }

    if (this.state === 'codec') {
      if (buf.length < 4) return undefined;
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const id = view.getUint32(0, false);
      this.buffer = buf.subarray(4);
      this.state = 'packets';
      return { kind: 'codec', codec: codecIdToName(id) ?? `unknown(0x${id.toString(16)})` };
    }

    if (buf.length < PACKET_HEADER_SIZE) return undefined;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const ptsAndFlags = view.getBigUint64(0, false);
    const size = view.getUint32(8, false);

    if ((ptsAndFlags & PACKET_FLAG_SESSION) !== 0n) {
      // Session meta: the 12 bytes are flags | width | height, no payload.
      const width = view.getUint32(4, false);
      const height = view.getUint32(8, false);
      const clientResize = (view.getUint32(0, false) & 1) !== 0;
      this.buffer = buf.subarray(PACKET_HEADER_SIZE);
      return { kind: 'session', width, height, clientResize };
    }

    const config = (ptsAndFlags & PACKET_FLAG_CONFIG) !== 0n;
    const keyFrame = (ptsAndFlags & PACKET_FLAG_KEY_FRAME) !== 0n;
    const pts = Number(ptsAndFlags & ~(PACKET_FLAG_CONFIG | PACKET_FLAG_KEY_FRAME));
    this.buffer = buf.subarray(PACKET_HEADER_SIZE);
    this.pendingPacket = { pts, config, keyFrame, size };
    return this.next();
  }
}

/**
 * `ws` throws a RangeError when a close reason exceeds 123 bytes, which kills
 * the whole server process. Truncate on a UTF-8 boundary instead of by code
 * unit, because CJK error messages are 3 bytes per character.
 */
export function closeReason(text: string, maxBytes = 120): string {
  if (typeof TextEncoder === 'undefined') return text.slice(0, 40);
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Never cut in the middle of a multi-byte sequence (continuation byte 0b10xx).
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}
