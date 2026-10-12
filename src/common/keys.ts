/**
 * Mapping between browser keyboard events and Android key events.
 *
 * scrcpy injects *keycodes* (Android KeyEvent.KEYCODE_*), so a browser
 * KeyboardEvent has to be translated. `KeyboardEvent.code` (physical key) is
 * used, exactly like the native client does with SDL scancodes.
 */

export const AndroidKeyCode = {
  UNKNOWN: 0,
  HOME: 3,
  BACK: 4,
  CALL: 5,
  ENDCALL: 6,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  CLEAR: 28,
  COMMA: 55,
  PERIOD: 56,
  ALT_LEFT: 57,
  ALT_RIGHT: 58,
  SHIFT_LEFT: 59,
  SHIFT_RIGHT: 60,
  TAB: 61,
  SPACE: 62,
  SYM: 63,
  EXPLORER: 64,
  ENVELOPE: 65,
  ENTER: 66,
  DEL: 67, // backspace
  GRAVE: 68,
  MINUS: 69,
  EQUALS: 70,
  LEFT_BRACKET: 71,
  RIGHT_BRACKET: 72,
  BACKSLASH: 73,
  SEMICOLON: 74,
  APOSTROPHE: 75,
  SLASH: 76,
  AT: 77,
  NUM: 78,
  HEADSETHOOK: 79,
  FOCUS: 80,
  PLUS: 81,
  MENU: 82,
  NOTIFICATION: 83,
  SEARCH: 84,
  MEDIA_PLAY_PAUSE: 85,
  MEDIA_STOP: 86,
  MEDIA_NEXT: 87,
  MEDIA_PREVIOUS: 88,
  MEDIA_REWIND: 89,
  MEDIA_FAST_FORWARD: 90,
  MUTE: 91,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  CTRL_LEFT: 113,
  CTRL_RIGHT: 114,
  CAPS_LOCK: 115,
  SCROLL_LOCK: 116,
  META_LEFT: 117,
  META_RIGHT: 118,
  FUNCTION: 119,
  SYSRQ: 120,
  BREAK: 121,
  MOVE_HOME: 122,
  MOVE_END: 123,
  INSERT: 124,
  FORWARD: 125,
  MEDIA_PLAY: 126,
  MEDIA_PAUSE: 127,
  MEDIA_CLOSE: 128,
  MEDIA_EJECT: 129,
  MEDIA_RECORD: 130,
  NUM_LOCK: 143,
  NUMPAD_ADD: 157,
  NUMPAD_COMMA: 159,
  NUMPAD_DIVIDE: 154,
  NUMPAD_DOT: 158,
  NUMPAD_ENTER: 160,
  NUMPAD_EQUALS: 161,
  NUMPAD_LEFT_PAREN: 162,
  NUMPAD_MULTIPLY: 155,
  NUMPAD_RIGHT_PAREN: 163,
  NUMPAD_SUBTRACT: 156,
  VOLUME_MUTE: 164,
  INFO: 165,
  CHANNEL_UP: 166,
  CHANNEL_DOWN: 167,
  ZOOM_IN: 168,
  ZOOM_OUT: 169,
  TV: 170,
  GUIDE: 172,
  DVR: 173,
  BOOKMARK: 174,
  CAPTIONS: 175,
  SETTINGS: 176,
  TV_POWER: 177,
  TV_INPUT: 178,
  ASSIST: 219,
  BRIGHTNESS_DOWN: 220,
  BRIGHTNESS_UP: 221,
  MEDIA_AUDIO_TRACK: 222,
  SLEEP: 223,
  WAKEUP: 224,
  PAIRING: 225,
  MEDIA_TOP_MENU: 226,
  LAST_CHANNEL: 229,
  TV_DATA_SERVICE: 230,
  VOICE_ASSIST: 231,
  TV_RADIO_SERVICE: 232,
  TV_TELETEXT: 233,
  APP_SWITCH: 187,
} as const;

/** Android metastate bits (android/input.h). */
export const AndroidMetaState = {
  NONE: 0,
  SHIFT_ON: 0x01,
  ALT_ON: 0x02,
  SYM_ON: 0x04,
  FUNCTION_ON: 0x08,
  ALT_LEFT_ON: 0x10,
  ALT_RIGHT_ON: 0x20,
  SHIFT_LEFT_ON: 0x40,
  SHIFT_RIGHT_ON: 0x80,
  CAPS_LOCK_ON: 0x100,
  NUM_LOCK_ON: 0x400,
  SCROLL_LOCK_ON: 0x800,
  CTRL_ON: 0x1000,
  CTRL_LEFT_ON: 0x2000,
  CTRL_RIGHT_ON: 0x4000,
  META_ON: 0x10000,
  META_LEFT_ON: 0x20000,
  META_RIGHT_ON: 0x40000,
} as const;

/** KeyboardEvent.code -> Android keycode. */
const CODE_TO_KEYCODE: Record<string, number> = {
  // letters: KeyA = 29 ... KeyZ = 54
  ...letters(),
  // digits: Digit0 = 7 ... Digit9 = 16
  ...digits(),
  ...numpad(),
  ...functionKeys(),

  Escape: AndroidKeyCode.ESCAPE,
  Enter: AndroidKeyCode.ENTER,
  NumpadEnter: AndroidKeyCode.NUMPAD_ENTER,
  Tab: AndroidKeyCode.TAB,
  Space: AndroidKeyCode.SPACE,
  Backspace: AndroidKeyCode.DEL,
  Delete: AndroidKeyCode.FORWARD_DEL,
  Insert: AndroidKeyCode.INSERT,
  Home: AndroidKeyCode.MOVE_HOME,
  End: AndroidKeyCode.MOVE_END,
  PageUp: AndroidKeyCode.PAGE_UP,
  PageDown: AndroidKeyCode.PAGE_DOWN,

  ArrowUp: AndroidKeyCode.DPAD_UP,
  ArrowDown: AndroidKeyCode.DPAD_DOWN,
  ArrowLeft: AndroidKeyCode.DPAD_LEFT,
  ArrowRight: AndroidKeyCode.DPAD_RIGHT,

  ShiftLeft: AndroidKeyCode.SHIFT_LEFT,
  ShiftRight: AndroidKeyCode.SHIFT_RIGHT,
  ControlLeft: AndroidKeyCode.CTRL_LEFT,
  ControlRight: AndroidKeyCode.CTRL_RIGHT,
  AltLeft: AndroidKeyCode.ALT_LEFT,
  AltRight: AndroidKeyCode.ALT_RIGHT,
  MetaLeft: AndroidKeyCode.META_LEFT,
  MetaRight: AndroidKeyCode.META_RIGHT,
  CapsLock: AndroidKeyCode.CAPS_LOCK,
  ScrollLock: AndroidKeyCode.SCROLL_LOCK,
  NumLock: AndroidKeyCode.NUM_LOCK,
  PrintScreen: AndroidKeyCode.SYSRQ,
  Pause: AndroidKeyCode.BREAK,
  ContextMenu: AndroidKeyCode.MENU,

  Minus: AndroidKeyCode.MINUS,
  Equal: AndroidKeyCode.EQUALS,
  BracketLeft: AndroidKeyCode.LEFT_BRACKET,
  BracketRight: AndroidKeyCode.RIGHT_BRACKET,
  Backslash: AndroidKeyCode.BACKSLASH,
  Semicolon: AndroidKeyCode.SEMICOLON,
  Quote: AndroidKeyCode.APOSTROPHE,
  Slash: AndroidKeyCode.SLASH,
  Comma: AndroidKeyCode.COMMA,
  Period: AndroidKeyCode.PERIOD,
  Backquote: AndroidKeyCode.GRAVE,
  IntlBackslash: AndroidKeyCode.BACKSLASH,
  IntlRo: AndroidKeyCode.UNKNOWN,

  MediaPlayPause: AndroidKeyCode.MEDIA_PLAY_PAUSE,
  MediaStop: AndroidKeyCode.MEDIA_STOP,
  MediaTrackNext: AndroidKeyCode.MEDIA_NEXT,
  MediaTrackPrevious: AndroidKeyCode.MEDIA_PREVIOUS,
  AudioVolumeUp: AndroidKeyCode.VOLUME_UP,
  AudioVolumeDown: AndroidKeyCode.VOLUME_DOWN,
  AudioVolumeMute: AndroidKeyCode.VOLUME_MUTE,
  BrowserHome: AndroidKeyCode.HOME,
  BrowserSearch: AndroidKeyCode.SEARCH,
  BrowserBack: AndroidKeyCode.BACK,
  Power: AndroidKeyCode.POWER,
  Sleep: AndroidKeyCode.SLEEP,
  WakeUp: AndroidKeyCode.WAKEUP,
  LaunchApp1: AndroidKeyCode.EXPLORER,
  LaunchApp2: AndroidKeyCode.ENVELOPE,
  Select: AndroidKeyCode.DPAD_CENTER,
};

function letters(): Record<string, number> {
  const map: Record<string, number> = {};
  for (let i = 0; i < 26; i++) {
    map[`Key${String.fromCharCode(65 + i)}`] = 29 + i;
  }
  return map;
}

function digits(): Record<string, number> {
  const map: Record<string, number> = {};
  for (let i = 0; i <= 9; i++) {
    map[`Digit${i}`] = 7 + i;
    map[`Numpad${i}`] = 144 + i;
  }
  return map;
}

function numpad(): Record<string, number> {
  return {
    NumpadDivide: AndroidKeyCode.NUMPAD_DIVIDE,
    NumpadMultiply: AndroidKeyCode.NUMPAD_MULTIPLY,
    NumpadSubtract: AndroidKeyCode.NUMPAD_SUBTRACT,
    NumpadAdd: AndroidKeyCode.NUMPAD_ADD,
    NumpadDecimal: AndroidKeyCode.NUMPAD_DOT,
    NumpadComma: AndroidKeyCode.NUMPAD_COMMA,
    NumpadEqual: AndroidKeyCode.NUMPAD_EQUALS,
    NumpadParenLeft: AndroidKeyCode.NUMPAD_LEFT_PAREN,
    NumpadParenRight: AndroidKeyCode.NUMPAD_RIGHT_PAREN,
  };
}

function functionKeys(): Record<string, number> {
  const map: Record<string, number> = {};
  for (let i = 1; i <= 12; i++) {
    map[`F${i}`] = 130 + i; // F1 = 131
  }
  return map;
}

/** Fallback for layouts where `code` is not available: use `key`. */
const KEY_FALLBACK: Record<string, number> = {
  Backspace: AndroidKeyCode.DEL,
  Delete: AndroidKeyCode.FORWARD_DEL,
  Enter: AndroidKeyCode.ENTER,
  Escape: AndroidKeyCode.ESCAPE,
  Tab: AndroidKeyCode.TAB,
  ' ': AndroidKeyCode.SPACE,
  ArrowUp: AndroidKeyCode.DPAD_UP,
  ArrowDown: AndroidKeyCode.DPAD_DOWN,
  ArrowLeft: AndroidKeyCode.DPAD_LEFT,
  ArrowRight: AndroidKeyCode.DPAD_RIGHT,
};

export function keyCodeFromEvent(e: KeyboardEvent): number {
  const fromCode = CODE_TO_KEYCODE[e.code];
  if (fromCode !== undefined) return fromCode;
  const fromKey = KEY_FALLBACK[e.key];
  if (fromKey !== undefined) return fromKey;
  if (e.key && e.key.length === 1) {
    const upper = e.key.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') return 29 + (upper.charCodeAt(0) - 65);
    if (e.key >= '0' && e.key <= '9') return 7 + (e.key.charCodeAt(0) - 48);
  }
  return AndroidKeyCode.UNKNOWN;
}

export function metaStateFromEvent(e: KeyboardEvent): number {
  let meta = 0;
  if (e.shiftKey) meta |= AndroidMetaState.SHIFT_ON | AndroidMetaState.SHIFT_LEFT_ON;
  if (e.altKey) meta |= AndroidMetaState.ALT_ON | AndroidMetaState.ALT_LEFT_ON;
  if (e.ctrlKey) meta |= AndroidMetaState.CTRL_ON | AndroidMetaState.CTRL_LEFT_ON;
  if (e.metaKey) meta |= AndroidMetaState.META_ON | AndroidMetaState.META_LEFT_ON;
  return meta;
}
