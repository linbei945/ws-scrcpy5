/**
 * WS-scrcpy5 browser client.
 *
 * The browser receives the raw scrcpy 5.0.1 streams over a WebSocket and
 * decodes them with WebCodecs; all input is encoded into scrcpy control
 * messages and forwarded by the node server.
 */
import { MirroringSession, type StartOptions } from './session';
import { setupFiles, type FilesApi } from './files';
import {
  createVideoPlayer,
  decoderKind,
  webCodecsAvailable,
  DECODER_LABELS,
  type DecoderKind,
  type VideoDecoderLike,
} from './video';
import { SoftwareVideoPlayer } from './software-video';
import { MseVideoPlayer } from './mse-video';
import { buildInitSegment } from '../common/fmp4';
import { AudioPlayer } from './audio';
import { AndroidKeyCode, keyCodeFromEvent, metaStateFromEvent } from '../common/keys';
import {
  KeyEventAction,
  MotionEventAction,
  MotionEventButton,
  POINTER_ID,
  STREAM_DISABLED,
  STREAM_ERROR,
} from '../common/protocol';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const ui = {
  envWarning: el<HTMLDivElement>('envWarning'),
  deviceInput: el<HTMLInputElement>('deviceInput'),
  connectBtn: el<HTMLButtonElement>('connectBtn'),
  status: el<HTMLDivElement>('status'),
  historyList: el<HTMLUListElement>('historyList'),
  historyEmpty: el<HTMLParagraphElement>('historyEmpty'),
  pairAddress: el<HTMLInputElement>('pairAddress'),
  pairCode: el<HTMLInputElement>('pairCode'),
  pairBtn: el<HTMLButtonElement>('pairBtn'),
  decoderKind: el<HTMLSelectElement>('decoderKind'),
  maxSize: el<HTMLInputElement>('maxSize'),
  bitrate: el<HTMLInputElement>('bitrate'),
  maxFps: el<HTMLInputElement>('maxFps'),
  audioEnabled: el<HTMLInputElement>('audioEnabled'),
  stayAwake: el<HTMLInputElement>('stayAwake'),
  showTouches: el<HTMLInputElement>('showTouches'),
  keyboardEnabled: el<HTMLInputElement>('keyboardEnabled'),
  startBtn: el<HTMLButtonElement>('startBtn'),
  stopBtn: el<HTMLButtonElement>('stopBtn'),
  log: el<HTMLPreElement>('log'),
  canvas: el<HTMLCanvasElement>('screen'),
  placeholder: el<HTMLDivElement>('placeholder'),
  stage: el<HTMLDivElement>('stage'),
  toolbar: el<HTMLDivElement>('toolbar'),
};

let session: MirroringSession | undefined;
let deviceWidth = 0;
let deviceHeight = 0;
let audioCodecName: string | undefined;
/**
 * Assigned at the bottom of the file. Kept in a `let` (rather than a `const`
 * used from the helpers above) so that an early caller can never hit the
 * temporal dead zone of the module-level binding.
 */
let filesApi: FilesApi | undefined;

/**
 * The decoder is chosen by the user, defaulting to "auto".
 *
 * The client and the server have to agree on it, because it decides what the
 * server sends: an `mse` client can only read fMP4, and every other client
 * needs the raw scrcpy stream (see `buildOptions`). The selection therefore
 * lives in the "更多参数" panel rather than being decided silently, so a user
 * whose device only works one way can pin it.
 *
 * `?forceDecoder=mse` still works (it pre-selects the dropdown); a desktop
 * browser on `localhost` is a secure context, so it would otherwise always take
 * WebCodecs and the MSE path — the one plain-http phones actually use — would
 * never be exercised on a development machine.
 */
const forcedDecoder = new URLSearchParams(location.search).get('forceDecoder');
if (forcedDecoder) ui.decoderKind.value = forcedDecoder;

/**
 * Decoder capabilities of this browser — what it *can* do, as opposed to what
 * the user asked for. These never change during a page's life.
 */
const hasWebCodecs = webCodecsAvailable();
const hasMse = MseVideoPlayer.isSupported();
const hasSoftware = SoftwareVideoPlayer.isSupported();

/**
 * Turns the dropdown selection into a decoder that actually exists here.
 *
 * The dropdown only ever offers decoders this browser supports (unavailable
 * ones are disabled in `renderDecoderChoices`), but the check is repeated
 * because a stale selection can survive a reload — the `<select>` keeps its
 * value in the bfcache — and silently running a decoder the browser cannot
 * provide would show a black screen with no explanation.
 *
 * `auto` keeps the original best-first order:
 *   webcodecs (secure context, H.265/AV1) → mse (http, hardware) → software.
 */
function resolveDecoder(): DecoderKind {
  const choice = ui.decoderKind.value;
  if (choice === 'webcodecs' && hasWebCodecs) return 'webcodecs';
  if (choice === 'mse' && hasMse) return 'mse';
  if (choice === 'software' && hasSoftware) return 'software';
  return decoderKind();
}

/**
 * The decoder in use. Re-resolved whenever the selection changes, because both
 * the player and the server `container` option depend on it.
 */
let decoder: DecoderKind = resolveDecoder();

/**
 * Which decoder `player` was built for, so it is only rebuilt when it changes.
 */
let playerDecoder: DecoderKind = decoder;

/**
 * The active video player. Recreated when the user switches decoder: the three
 * implementations are not interchangeable at runtime (they render into
 * different surfaces and consume different containers), so switching means
 * building a new one. `close()` on the old player releases the MSE `<video>`
 * element it appended, which is what keeps repeated switches from stacking
 * hidden video tags in the DOM.
 */
let player: VideoDecoderLike = createVideoPlayer(ui.canvas, (message) => showError(message), decoder);

function ensurePlayer(): VideoDecoderLike {
  if (playerDecoder === decoder) return player;
  player.close();
  player = createVideoPlayer(ui.canvas, (message) => showError(message), decoder);
  playerDecoder = decoder;
  return player;
}

const audioPlayer = new AudioPlayer((message) => showError(message));

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * The log is prepended, newest first. Repeats of the exact same line are folded
 * into a `(×N)` counter instead of being stacked — a decoder that reports one
 * error per frame would otherwise push everything else out of the panel.
 */
let lastLogText = '';
let lastLogCount = 0;

function logLine(message: string): void {
  // No locale argument: the browser default is right for whoever is reading.
  const time = new Date().toLocaleTimeString(undefined, { hour12: false });
  if (message === lastLogText && ui.log.textContent) {
    lastLogCount++;
    const rest = (ui.log.textContent ?? '').split('\n');
    rest[0] = `[${time}] ${message} (×${lastLogCount})`;
    ui.log.textContent = rest.join('\n').slice(0, 8000);
    return;
  }
  lastLogText = message;
  lastLogCount = 1;
  ui.log.textContent = `[${time}] ${message}\n${ui.log.textContent ?? ''}`.slice(0, 8000);
}

/**
 * The status strip is a permanent readout (「已连接 <地址>」 / 「未连接」) that
 * lives right below the address box. It never fades: it is styled like the
 * other form controls so the sidebar looks uniform.
 */
function setStatus(text: string, kind: 'idle' | 'ok' | 'error' = 'idle'): void {
  ui.status.textContent = text;
  ui.status.className = `status ${kind === 'idle' ? '' : kind}`;
}

function showError(message: string): void {
  logLine(`错误: ${message}`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------------ */
/* capability check (secure context / WebCodecs / MSE / WASM)          */
/* ------------------------------------------------------------------ */

/**
 * Preferred decoding, best first — the order `auto` walks:
 *
 *   webcodecs  hardware, H.265/AV1, lowest latency — but secure-context only,
 *              so it is what the desktop and any `https://` visitor gets;
 *   mse        hardware as well, and *not* secure-context gated, so a phone on
 *              the plain-http LAN address still gets hardware decoding once the
 *              server muxes the stream to fMP4 (`decoderKind()` decides);
 *   software   WASM on the CPU, H.264 only — the safety net that makes plain
 *              http work even where MSE is missing.
 *
 * These are *derived* from `decoder` rather than fixed, because the user can
 * override the choice from the 更多参数 panel. `has*` above are the browser's
 * capabilities; these say what is actually running.
 */
const usingWebCodecs = (): boolean => decoder === 'webcodecs';
const usingMse = (): boolean => decoder === 'mse';
const usingSoftware = (): boolean => decoder === 'software';

/** The message the user sees when the page cannot render at all. */
const NO_DECODER_MESSAGE =
  '这个浏览器既不支持 WebCodecs / MSE 硬件解码，也不支持 WebAssembly 软件解码。请改用较新版本的 Chrome / Edge / 手机 Chrome 访问。';

function renderEnvWarning(): void {
  // Nothing to warn about: hardware decoding is in use (WebCodecs or MSE).
  if (usingWebCodecs() || usingMse()) {
    ui.envWarning.classList.add('hidden');
    return;
  }

  ui.envWarning.innerHTML = '';
  const title = document.createElement('strong');
  const body = document.createElement('span');

  /*
   * Software fallback active. Informational, not an error: the mirror works on
   * plain http with no certificate to install — and it is also what a user gets
   * when they pick it by hand from 解码方式.
   *
   * The wording therefore has to hold for both causes. On plain http the
   * browser simply has no other option; on https the user asked for it. Only
   * the first case is worth suggesting the https address for.
   */
  if (usingSoftware()) {
    const autoChose = ui.decoderKind.value === 'auto';
    title.textContent = '当前使用 WASM 软件解码';
    body.textContent =
      (autoChose
        ? '本页通过 http:// 打开，浏览器在此环境不提供 WebCodecs 硬件解码接口（MSE 也不可用），' +
          '已自动启用内置软件解码，无需安装证书即可观看。'
        : '已在「解码方式」里手动选择软件解码。') +
      '清晰度与帧率低于硬件解码，且更耗手机电量；若追求画质，' +
      '可改选 MSE 或 WebCodecs。';
    ui.envWarning.append(title, body);
    ui.envWarning.classList.remove('hidden');
    return;
  }

  // No decoder at all — the browser is genuinely too old.
  title.textContent = '当前浏览器无法解码画面';
  body.textContent = NO_DECODER_MESSAGE;
  ui.envWarning.append(title, body);
  ui.envWarning.classList.remove('hidden');
}

/**
 * Keeps the 更多参数 panel honest about what each choice will do.
 *
 * The one thing reflected here: **unavailable decoders are disabled, not
 * hidden.** A missing option looks like a bug; a greyed-out one with a reason
 * teaches the user what their browser can do. This matters most on plain http,
 * where WebCodecs exists but is withheld by the secure-context rule — the
 * single most confusing thing about the whole page.
 *
 * The video codec is always H.264 and is no longer selectable, so there is
 * nothing to reconcile between the two fields any more.
 */
function renderDecoderChoices(): void {
  const availability: Record<string, boolean> = {
    auto: hasWebCodecs || hasMse || hasSoftware,
    webcodecs: hasWebCodecs,
    mse: hasMse,
    software: hasSoftware,
  };
  /*
   * Labels come from `DECODER_LABELS` rather than being read back from the DOM.
   * Deriving them from `textContent` looks tempting but breaks on the second
   * run: stripping the "（不可用）" suffix would also eat the legitimate
   * "（跟随环境）" on the auto option. A shared table cannot drift, and it is the
   * same table `start()` logs from.
   *
   * `auto` is the one row with no decoder behind it — it is a mode, not a
   * decoder — so it is spelled out here.
   */
  const AUTO_LABEL = '自动（跟随环境）';
  const labels: Record<string, string> = {
    auto: AUTO_LABEL,
    webcodecs: DECODER_LABELS.webcodecs,
    mse: DECODER_LABELS.mse,
    software: DECODER_LABELS.software,
  };
  const unavailableReason: Record<string, string> = {
    webcodecs: '本浏览器不提供',
    mse: '本浏览器不支持',
    software: '本浏览器不支持',
  };

  for (const option of Array.from(ui.decoderKind.options)) {
    const label = labels[option.value] ?? option.textContent;
    const available = availability[option.value] ?? false;
    option.disabled = !available;
    /*
     * The only annotation a row ever carries is the reason it cannot be picked.
     * Any other suffix — "延迟最低", "（安全上下文）" — would restate what the
     * option name already says, and those claims go stale silently (the old
     * WebCodecs hint advertised H.265/AV1 for a while after they were removed).
     */
    option.textContent = available
      ? label
      : `${label}（${unavailableReason[option.value] ?? '不可用'}）`;
  }

  decoder = resolveDecoder();

  renderEnvWarning();
}

/* ------------------------------------------------------------------ */
/* devices                                                             */
/* ------------------------------------------------------------------ */

/** `192.168.5.1:5555`, `localhost:5555` … */
const NETWORK_ADDRESS = /^[A-Za-z0-9._-]+:\d{1,5}$/;

interface DeviceEntry {
  serial: string;
  state: string;
  model?: string;
}

function syncDeviceButtons(): void {
  const value = ui.deviceInput.value.trim();
  const busy = ui.connectBtn.disabled && ui.connectBtn.dataset.busy === '1';
  if (!busy) {
    // Any non-empty value is a valid target: a network address (adb connect)
    // or a plain USB serial already registered with adb.
    ui.connectBtn.disabled = value.length === 0;
  }
}

/**
 * The sidebar is a plain address box: nothing is enumerated when the page
 * loads and no background polling happens. This one-shot lookup is only used
 * to fill an empty box on an explicit 「开始」, so plug-and-play USB keeps
 * working without a device list.
 */
async function lookupDevices(): Promise<DeviceEntry[]> {
  try {
    const res = await fetch('/api/devices');
    const data = (await res.json()) as { devices?: DeviceEntry[]; error?: string };
    if (data.error) logLine(`设备列表错误: ${data.error}`);
    return data.devices ?? [];
  } catch (e) {
    logLine(`无法获取设备列表: ${(e as Error).message}`);
    return [];
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T & { error?: string }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T & { error?: string };
}

async function withDeviceButton<T>(button: HTMLButtonElement, fn: () => Promise<T>): Promise<void> {
  button.disabled = true;
  button.dataset.busy = '1';
  try {
    await fn();
  } finally {
    delete button.dataset.busy;
    ui.connectBtn.disabled = false;
    syncDeviceButtons();
  }
}

/** `adb connect` a network address. Returns true when the device is reachable. */
async function connectAddress(address: string): Promise<boolean> {
  setStatus(`正在 adb connect ${address} …`);
  logLine(`adb connect ${address}`);
  try {
    const data = await postJson<{ ok?: boolean; message?: string }>('/api/connect', { address });
    if (data.error) {
      setStatus(data.error, 'error');
      logLine(`错误: ${data.error}`);
      return false;
    }
    logLine(data.message ?? `已连接 ${address}`);
    setStatus(`已连接 ${address}`, 'ok');
    // The file manager may have been opened before the address was filled in.
    filesApi?.onSerialChange();
    return true;
  } catch (e) {
    const message = `adb connect 失败: ${(e as Error).message}`;
    setStatus(message, 'error');
    logLine(message);
    return false;
  }
}

async function connectDevice(): Promise<void> {
  const address = ui.deviceInput.value.trim();
  if (!NETWORK_ADDRESS.test(address)) {
    setStatus(`「${address}」不是有效的 IP:端口`, 'error');
    return;
  }
  await withDeviceButton(ui.connectBtn, async () => {
    ui.deviceInput.value = address;
    if (await connectAddress(address)) rememberDevice(address);
  });
}

/* ------------------------------------------------------------------ */
/* device history (localStorage)                                       */
/* ------------------------------------------------------------------ */

const HISTORY_KEY = 'ws-scrcpy5.history';
const HISTORY_MAX = 8;

function loadHistory(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  } catch {
    return [];
  }
}

let history = loadHistory();

function saveHistory(): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    /* private mode / quota — history is a convenience, never fatal */
  }
}

/** Most recent first, de-duplicated, capped. */
function rememberDevice(address: string): void {
  const value = address.trim();
  if (!value) return;
  history = [value, ...history.filter((item) => item !== value)].slice(0, HISTORY_MAX);
  saveHistory();
  renderHistory();
}

function forgetDevice(address: string): void {
  history = history.filter((item) => item !== address);
  saveHistory();
  renderHistory();
}

function renderHistory(): void {
  ui.historyList.innerHTML = '';
  ui.historyEmpty.classList.toggle('hidden', history.length > 0);
  for (const address of history) {
    const item = document.createElement('li');

    const label = document.createElement('span');
    label.className = 'history-addr';
    label.textContent = address;
    label.title = address;

    const connect = document.createElement('button');
    connect.textContent = '连接';
    connect.title = `连接 ${address}`;
    connect.dataset.address = address;
    connect.dataset.action = 'connect';

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '删除';
    remove.title = `从历史设备中删除 ${address}`;
    remove.dataset.address = address;
    remove.dataset.action = 'remove';

    item.append(label, connect, remove);
    ui.historyList.appendChild(item);
  }
}

/** History 「连接」: fill the box, then adb connect (or start directly for USB). */
async function connectFromHistory(address: string): Promise<void> {
  ui.deviceInput.value = address;
  syncDeviceButtons();
  if (NETWORK_ADDRESS.test(address)) {
    await connectAddress(address);
    rememberDevice(address);
    return;
  }
  // A USB serial needs no adb connect — go straight to mirroring.
  logLine(`USB 设备 ${address}，直接开始投屏`);
  await start();
}

ui.historyList.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest('button');
  if (!button) return;
  const address = button.dataset.address;
  if (!address) return;
  if (button.dataset.action === 'remove') forgetDevice(address);
  else void connectFromHistory(address);
});

async function pairDevice(): Promise<void> {
  const address = ui.pairAddress.value.trim();
  const code = ui.pairCode.value.trim();
  if (!NETWORK_ADDRESS.test(address) || !code) {
    setStatus('请填写配对用的 IP:端口 和配对码', 'error');
    return;
  }
  logLine(`adb pair ${address}`);
  await withDeviceButton(ui.pairBtn, async () => {
    try {
      const data = await postJson<{ ok?: boolean; message?: string }>('/api/pair', { address, code });
      if (data.error) {
        setStatus(data.error, 'error');
        logLine(`错误: ${data.error}`);
        return;
      }
      logLine(data.message ?? `配对成功: ${address}`);
      setStatus(`配对成功，可用「连接」填入调试端口`, 'ok');
      ui.pairCode.value = '';
    } catch (e) {
      const message = `adb pair 失败: ${(e as Error).message}`;
      setStatus(message, 'error');
      logLine(message);
    }
  });
}

/* ------------------------------------------------------------------ */
/* session lifecycle                                                   */
/* ------------------------------------------------------------------ */

/**
 * Software decoding runs on the phone's CPU, so the defaults that suit a
 * hardware decoder would melt it. When the fallback is active and the user has
 * not expressed a preference, clamp to values the WASM decoder can keep up
 * with (mirroring ws-scrcpy's TinyH264 profile: small, 24 fps, low bitrate).
 *
 * MSE and WebCodecs both decode in hardware, so neither needs clamping.
 */
const SOFT_MAX_SIZE = 720;
const SOFT_MAX_FPS = 24;
const SOFT_BITRATE = 2_000_000;

function buildOptions(): StartOptions {
  const maxSize = Number(ui.maxSize.value);
  const bitrate = Number(ui.bitrate.value);
  const maxFps = Number(ui.maxFps.value);

  /*
   * The server must know which container the client can read: `mse` makes it
   * mux fMP4, anything else forwards the raw scrcpy stream.
   *
   * The video codec is not sent: it is always H.264 now. MSE and the WASM
   * decoder can read nothing else, so a second choice only created ways to get
   * a black screen.
   */
  const container = usingMse() ? ('mse' as const) : undefined;

  const soft = usingSoftware();
  const resolvedMaxSize = maxSize > 0 ? maxSize : soft ? SOFT_MAX_SIZE : undefined;
  const resolvedMaxFps = maxFps > 0 ? maxFps : soft ? SOFT_MAX_FPS : undefined;
  const resolvedBitrate = bitrate > 0 ? bitrate * 1_000_000 : soft ? SOFT_BITRATE : undefined;

  return {
    serial: ui.deviceInput.value.trim(),
    container,
    audioCodec: 'opus',
    audio: ui.audioEnabled.checked,
    maxSize: resolvedMaxSize,
    videoBitRate: resolvedBitrate,
    maxFps: resolvedMaxFps,
    stayAwake: ui.stayAwake.checked,
    showTouches: ui.showTouches.checked,
  };
}

/**
 * Resolves what to mirror. The box is authoritative: whatever the user typed
 * wins. Only when it is empty do we ask adb once — and only accept the result
 * if exactly one device is online, which keeps USB plug-and-play working
 * without ever building a device list.
 */
async function resolveSerial(): Promise<string | undefined> {
  const typed = ui.deviceInput.value.trim();
  if (typed) return typed;

  setStatus('设备地址为空，正在查找唯一在线设备…');
  const devices = await lookupDevices();
  const online = devices.filter((d) => d.state === 'device');
  if (online.length === 1) {
    ui.deviceInput.value = online[0].serial;
    syncDeviceButtons();
    logLine(`自动使用唯一在线设备 ${online[0].serial}`);
    return online[0].serial;
  }
  setStatus(
    online.length === 0
      ? '未检测到在线设备：请在手机开启无线调试并填写 IP:端口'
      : `检测到 ${online.length} 个设备，请在设备地址里明确填写其中一个`,
    'error',
  );
  return undefined;
}

/**
 * On a phone the sidebar stacks on top of the stage (max-width: 900px), so the
 * picture starts below the fold. Once the first init arrives, bring the mirror
 * into view instead of leaving the user staring at the log.
 */
function revealStageIfStacked(): void {
  if (!window.matchMedia('(max-width: 900px)').matches) return;
  try {
    ui.stage.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch {
    /* older engines: ignore */
  }
}

async function start(): Promise<void> {
  /*
   * Re-read the dropdown before doing anything else. The selection can change
   * between runs, and it has to be settled first because it decides both the
   * player and the `container` the server is asked for.
   */
  renderDecoderChoices();

  // Only a browser too old for *all three* decoders has to be turned away.
  if (decoder === 'none') {
    renderEnvWarning();
    setStatus('无法解码：浏览器版本过旧', 'error');
    logLine('该浏览器不支持 WebCodecs / MSE / WebAssembly，无法解码画面');
    return;
  }
  const serial = await resolveSerial();
  if (!serial) return;
  if (NETWORK_ADDRESS.test(serial)) {
    // adb connect runs again server side, right before the jar is pushed.
    logLine(`${serial} 是网络设备，将先执行 adb connect`);
  }
  /*
   * Only tear down when something is actually running. `stop()` logs
   * "已停止投屏", so calling it unconditionally made every fresh connect
   * announce a stop that never happened — which reads like a failure right
   * before the connection opens.
   */
  if (session) await stop();

  // Swap the player before any frame can arrive: the three decoders are not
  // interchangeable, so a changed selection means a new one.
  ensurePlayer();
  // Log the decoder name and nothing else — the same string the dropdown shows,
  // so the log confirms which row is running without restating caveats the user
  // can already read in the panel (`DECODER_LABELS` is the one source). The
  // `none` case returned above, so there is always a name to log.
  logLine(DECODER_LABELS[decoder]);

  const options = buildOptions();
  player.reset();
  audioPlayer.stop();
  audioCodecName = undefined;

  const s = new MirroringSession({
    onOpen: () => {
      setStatus(`已连接 ${options.serial}`, 'ok');
      logLine(`连接 ${options.serial}`);
    },
    onInit: (init) => {
      deviceWidth = init.width;
      deviceHeight = init.height;
      player.resize(init.width, init.height);
      if (init.videoCodec) player.setCodec(init.videoCodec);
      // The status strip only shows 已连接/未连接 + address; the device name,
      // resolution and scrcpy version live in the log instead.
      setStatus(`已连接 ${options.serial}`, 'ok');
      logLine(
        `设备 ${init.deviceName} (${init.serial}) ${init.width}x${init.height} · scrcpy ${init.serverVersion}`,
      );
      rememberDevice(options.serial);
      // The device is real and reachable now — refresh the file listing if it
      // was opened while the address box was still empty.
      filesApi?.onSerialChange();
      ui.placeholder.classList.add('hidden');
      ui.canvas.classList.remove('hidden');
      // The MSE player renders into an overlaid <video>, so it has to be told
      // separately; the canvas-based players treat this as a no-op.
      player.setVisible(true);
      revealStageIfStacked();
      if (init.audio && init.audioCodec) audioCodecName = init.audioCodec;
    },
    onVideoEvent: (event) => {
      switch (event.kind) {
        case 'meta':
          logLine(`device name: ${event.deviceName}`);
          break;
        case 'codec':
          /*
           * `disabled` / `error` are not codecs: the device writes them
           * instead of a codec id when a stream cannot start at all
           * (`Streamer.writeDisableStream`). Saying so beats logging
           * "unknown(0x0)" and leaving the user guessing why there is no
           * picture or no sound.
           */
          if (event.codec === STREAM_DISABLED) {
            logLine('该流在设备侧被禁用（例如 Android 11 以下不支持音频采集）');
          } else if (event.codec === STREAM_ERROR) {
            logLine('设备侧配置错误，scrcpy-server 已停止');
            setStatus('设备侧配置错误', 'error');
          } else {
            logLine(`video codec: ${event.codec}`);
          }
          player.setCodec(event.codec);
          break;
        case 'session':
          deviceWidth = event.width;
          deviceHeight = event.height;
          player.resize(event.width, event.height);
          break;
        case 'packet':
          if (event.packet.config) {
            player.setConfig(event.packet.data);
          } else {
            player.pushFrame(event.packet.pts, event.packet.keyFrame, event.packet.data);
          }
          break;
      }
    },
    onAudioEvent: (event) => {
      if (event.kind === 'codec') {
        if (event.codec === STREAM_DISABLED) {
          logLine('音频不可用：设备未开启音频采集（Android 11 以下不支持）');
        } else if (event.codec === STREAM_ERROR) {
          logLine('音频设备侧配置错误');
        } else {
          audioCodecName = event.codec;
          logLine(`audio codec: ${event.codec}`);
        }
      } else if (event.kind === 'packet') {
        if (event.packet.config) {
          void audioPlayer.start(audioCodecName ?? 'opus', 48000, 2, event.packet.data);
        } else if (audioPlayer.isPlaying) {
          audioPlayer.push(event.packet.pts, event.packet.data);
        }
      }
    },
    onClipboard: (text) => {
      logLine(`设备剪贴板: ${text.slice(0, 60)}`);
      navigator.clipboard?.writeText(text).catch(() => undefined);
    },
    onClipboardAck: (sequence) => logLine(`剪贴板已同步 (seq ${sequence})`),
    onLog: (message) => logLine(message),
    onError: (message) => {
      setStatus(message, 'error');
      logLine(message);
    },
    onClosed: (reason) => {
      logLine(`断开: ${reason ?? 'closed'}`);
      // Drop the handle only if it is still THIS session: the close callback is
      // async, and a quick reconnect may already have installed a new one.
      if (session === s) session = undefined;
      resetUi();
      setStatus('未连接');
    },
  });

  session = s;
  ui.startBtn.disabled = true;
  ui.stopBtn.disabled = false;
  s.connect(MirroringSession.buildUrl('/ws', options));
}

/**
 * Ends *this* viewer's session and nothing else.
 *
 * This used to also issue `adb disconnect`, which is why 停止 on one phone killed
 * the picture on every other phone watching the same device. The adb transport
 * is shared, so only the server may drop it — and it does that once the last
 * session for the device is gone (see `src/server/registry.ts`).
 */
async function stop(): Promise<void> {
  if (session) {
    session.close();
    session = undefined;
  }
  audioPlayer.stop();
  resetUi();
  logLine('已停止投屏');
  setStatus('未连接');
}

function resetUi(): void {
  ui.startBtn.disabled = false;
  ui.stopBtn.disabled = true;
  // Hide the canvas *and* wipe it: the decoded last frame would otherwise stay
  // on screen behind the placeholder.
  ui.canvas.classList.add('hidden');
  player.setVisible(false);
  player.clear();
  deviceWidth = 0;
  deviceHeight = 0;
  ui.placeholder.classList.remove('hidden');
  activePointers.clear();
  fingerCounter = 0n;
}

/* ------------------------------------------------------------------ */
/* pointer / touch input                                               */
/* ------------------------------------------------------------------ */

const activePointers = new Map<number, bigint>();
let fingerCounter = 0n;

function toDeviceCoords(clientX: number, clientY: number): { x: number; y: number } {
  const rect = ui.canvas.getBoundingClientRect();
  const w = deviceWidth || ui.canvas.width;
  const h = deviceHeight || ui.canvas.height;
  const x = Math.round(((clientX - rect.left) / Math.max(1, rect.width)) * w);
  const y = Math.round(((clientY - rect.top) / Math.max(1, rect.height)) * h);
  return { x: clamp(x, 0, w), y: clamp(y, 0, h) };
}

function domButtonToAndroid(button: number): number {
  if (button === 1) return MotionEventButton.TERTIARY;
  if (button === 2) return MotionEventButton.SECONDARY;
  return MotionEventButton.PRIMARY;
}

function androidButtonsFromButtons(buttons: number): number {
  let mask = 0;
  if (buttons & 1) mask |= MotionEventButton.PRIMARY;
  if (buttons & 2) mask |= MotionEventButton.SECONDARY;
  if (buttons & 4) mask |= MotionEventButton.TERTIARY;
  return mask;
}

ui.canvas.addEventListener('pointerdown', (e) => {
  if (!session) return;
  e.preventDefault();
  ui.canvas.setPointerCapture(e.pointerId);
  const isMouse = e.pointerType === 'mouse';
  const pointerId = isMouse ? POINTER_ID.MOUSE : fingerCounter++;
  activePointers.set(e.pointerId, pointerId);
  const { x, y } = toDeviceCoords(e.clientX, e.clientY);
  const action = activePointers.size === 1 ? MotionEventAction.DOWN : MotionEventAction.POINTER_DOWN;
  const button = isMouse ? domButtonToAndroid(e.button) : MotionEventButton.PRIMARY;
  session.touch({
    action,
    pointerId,
    x,
    y,
    screenWidth: deviceWidth,
    screenHeight: deviceHeight,
    pressure: isMouse ? 1 : e.pressure || 1,
    actionButton: isMouse ? button : 0,
    buttons: isMouse ? androidButtonsFromButtons(e.buttons) : MotionEventButton.PRIMARY,
  });
});

ui.canvas.addEventListener('pointermove', (e) => {
  if (!session) return;
  const pointerId = activePointers.get(e.pointerId);
  if (pointerId === undefined) return;
  const { x, y } = toDeviceCoords(e.clientX, e.clientY);
  const isMouse = e.pointerType === 'mouse';
  session.touch({
    action: MotionEventAction.MOVE,
    pointerId,
    x,
    y,
    screenWidth: deviceWidth,
    screenHeight: deviceHeight,
    pressure: isMouse ? 1 : e.pressure || 1,
    actionButton: 0,
    buttons: isMouse ? androidButtonsFromButtons(e.buttons) : MotionEventButton.PRIMARY,
  });
});

function endPointer(e: PointerEvent): void {
  if (!session) return;
  const pointerId = activePointers.get(e.pointerId);
  if (pointerId === undefined) return;
  activePointers.delete(e.pointerId);
  const { x, y } = toDeviceCoords(e.clientX, e.clientY);
  const isMouse = e.pointerType === 'mouse';
  const action = activePointers.size === 0 ? MotionEventAction.UP : MotionEventAction.POINTER_UP;
  session.touch({
    action,
    pointerId,
    x,
    y,
    screenWidth: deviceWidth,
    screenHeight: deviceHeight,
    pressure: 0,
    actionButton: isMouse ? domButtonToAndroid(e.button) : 0,
    buttons: 0,
  });
}

ui.canvas.addEventListener('pointerup', endPointer);
ui.canvas.addEventListener('pointercancel', endPointer);
ui.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

ui.canvas.addEventListener(
  'wheel',
  (e) => {
    if (!session) return;
    e.preventDefault();
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) {
      dx *= 33;
      dy *= 33;
    } else if (e.deltaMode === 2) {
      dx *= 400;
      dy *= 400;
    }
    const { x, y } = toDeviceCoords(e.clientX, e.clientY);
    session.scroll({
      x,
      y,
      screenWidth: deviceWidth,
      screenHeight: deviceHeight,
      hscroll: dx / 100,
      vscroll: -dy / 100,
      buttons: 0,
    });
  },
  { passive: false },
);

/* ------------------------------------------------------------------ */
/* keyboard input                                                      */
/* ------------------------------------------------------------------ */

function isTypingTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || node.isContentEditable;
}

window.addEventListener('keydown', (e) => {
  if (!session) return;
  if (!ui.keyboardEnabled.checked) return;
  if (isTypingTarget(e.target)) return;
  e.preventDefault();
  const keycode = keyCodeFromEvent(e);
  if (keycode === AndroidKeyCode.UNKNOWN) return;
  const meta = metaStateFromEvent(e);
  // Use text injection for printable characters (supports non-ASCII layouts
  // through the text box below) and keycodes for everything else.
  const printable = e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && e.code !== 'Space';
  if (printable) {
    session.text(e.key);
    return;
  }
  session.key(KeyEventAction.DOWN, keycode, e.repeat ? 1 : 0, meta);
});

window.addEventListener('keyup', (e) => {
  if (!session) return;
  if (!ui.keyboardEnabled.checked) return;
  if (isTypingTarget(e.target)) return;
  e.preventDefault();
  const keycode = keyCodeFromEvent(e);
  if (keycode === AndroidKeyCode.UNKNOWN) return;
  const printable = e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && e.code !== 'Space';
  if (printable) return;
  session.key(KeyEventAction.UP, keycode, 0, metaStateFromEvent(e));
});

/* ------------------------------------------------------------------ */
/* toolbar                                                             */
/* ------------------------------------------------------------------ */

ui.toolbar.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest('button');
  if (!button) return;
  const cmd = button.dataset.cmd;
  if (!cmd) return;
  if (cmd === 'screenshot') {
    // The canvas is reset to 1x1 when a session ends; guard against saving
    // an empty PNG.
    if (!session || ui.canvas.width <= 1 || ui.canvas.height <= 1) {
      setStatus('未连接设备，无法截图', 'error');
      return;
    }
    // MSE paints into a <video>, leaving the canvas blank, so the player
    // supplies the still itself when it has one.
    const href = player.snapshot?.() ?? ui.canvas.toDataURL('image/png');
    if (!href) {
      setStatus('画面尚未就绪，无法截图', 'error');
      return;
    }
    const link = document.createElement('a');
    link.download = `scrcpy-${Date.now()}.png`;
    link.href = href;
    link.click();
    return;
  }
  if (cmd === 'fullscreen') {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void ui.stage.requestFullscreen().catch(() => undefined);
    return;
  }
  if (!session) return;
  switch (cmd) {
    case 'back':
      session.back();
      break;
    case 'home':
      session.tapKey(AndroidKeyCode.HOME);
      break;
    case 'app-switch':
      session.tapKey(AndroidKeyCode.APP_SWITCH);
      break;
    case 'power':
      session.tapKey(AndroidKeyCode.POWER);
      break;
    case 'screen-off':
      session.setScreenPower(false);
      break;
    case 'screen-on':
      session.setScreenPower(true);
      break;
    case 'volume-up':
      session.tapKey(AndroidKeyCode.VOLUME_UP);
      break;
    case 'volume-down':
      session.tapKey(AndroidKeyCode.VOLUME_DOWN);
      break;
    case 'notifications':
      session.expandNotificationPanel();
      break;
    case 'collapse':
      session.collapsePanels();
      break;
    case 'rotate':
      session.rotateDevice();
      break;
    default:
      break;
  }
});

/*
 * The dedicated 文本输入 / 读取剪贴板 / 推送剪贴板 block was removed: typing goes
 * straight into the mirrored screen, and the device → browser clipboard sync
 * still runs automatically in onClipboard.
 */

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

ui.startBtn.addEventListener('click', () => void start());
ui.stopBtn.addEventListener('click', () => void stop());
ui.connectBtn.addEventListener('click', () => void connectDevice());
ui.pairBtn.addEventListener('click', () => void pairDevice());
ui.deviceInput.addEventListener('input', () => syncDeviceButtons());

/*
 * Switching decoder mid-session has to reconnect: the server picks the stream
 * format (raw vs fMP4) when the session starts, so the already-running one is
 * sending something the new decoder may not understand. Restarting is what the
 * user means by changing the setting, and doing it here keeps the "开始" button
 * from silently disagreeing with the dropdown.
 */
ui.decoderKind.addEventListener('change', () => {
  renderDecoderChoices();
  if (session) {
    logLine(`解码方式已改为「${ui.decoderKind.selectedOptions[0]?.textContent ?? decoder}」，正在重连`);
    void (async () => {
      await stop();
      await start();
    })();
  }
});
ui.deviceInput.addEventListener('keydown', (e) => {
  // Enter in the address box = the 「连接」 button for network targets.
  if (e.key === 'Enter' && NETWORK_ADDRESS.test(ui.deviceInput.value.trim())) {
    e.preventDefault();
    void connectDevice();
  }
});
ui.pairCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void pairDevice();
});

window.addEventListener('beforeunload', () => {
  session?.close();
});

/**
 * Deep links: `/?serial=192.168.5.1:5555&autostart=1` pre-fills the address
 * box and (optionally) starts mirroring right away. Handy for kiosks and for
 * automated smoke tests. Nothing else runs on load — the panel never scans for
 * devices by itself.
 */
const params = new URLSearchParams(location.search);
const presetSerial = params.get('serial');
if (presetSerial) ui.deviceInput.value = presetSerial;
syncDeviceButtons();
renderHistory();
setStatus('未连接');
renderDecoderChoices();

/*
 * Device file manager: browse, upload, extract. It reads the address box live,
 * so it works whether or not a mirroring session is running — copying a file
 * off a phone that is only being watched is a normal use.
 */
filesApi = setupFiles({ serial: () => ui.deviceInput.value, log: logLine });

/** A new address means the listing on screen belongs to another device. */
ui.deviceInput.addEventListener('change', () => filesApi?.onSerialChange());

/**
 * A representative Baseline SPS/PPS pair, used only by the MSE verification
 * hook below. It is the shape a real scrcpy config packet has (Annex-B, 4-byte
 * start codes, profile 0x42).
 */
const MSE_TEST_SPS = Uint8Array.from([
  0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xc0, 0x29, 0x8d, 0x68, 0x05, 0x00,
]);
const MSE_TEST_PPS = Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80]);

/** The init segment the test hooks below hand to the MSE stack. */
function MSE_TEST_INIT(): Uint8Array {
  return buildInitSegment({
    sps: MSE_TEST_SPS.subarray(4),
    pps: MSE_TEST_PPS.subarray(4),
    width: 720,
    height: 1280,
  });
}

/**
 * `PPCCLL` exactly as `MseVideoPlayer` reads it: from the `avcC` box payload,
 * skipping the box's own four-character type. Kept in sync with the player
 * deliberately — if the offsets there drift, this probe reports the wrong
 * string and `httpcheck` notices.
 */
function mseInitCodecString(): string {
  const init = MSE_TEST_INIT();
  let index = -1;
  outer: for (let i = 0; i + 4 <= init.length; i++) {
    for (const [j, ch] of [...'avcC'].entries()) {
      if (init[i + j] !== ch.charCodeAt(0)) continue outer;
    }
    index = i;
    break;
  }
  if (index < 0) return '42E01E';
  const hex = (b: number) => b.toString(16).padStart(2, '0').toUpperCase();
  return `${hex(init[index + 5])}${hex(init[index + 6])}${hex(init[index + 7])}`;
}

function bytesToBinary(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/**
 * Read-only debug hook for the headless test scripts (`tools/uicheck.mjs`,
 * `tools/uie2e.mjs`, `tools/mobilecheck.mjs`, `tools/httpcheck.ts`). The sidebar
 * deliberately has no frame-counter block any more, so the scripts read the
 * decoder stats from here. `log()` is the one writing entry: the phone-layout
 * check needs to fill the log through the real code path to prove the panel is
 * capped.
 */
(window as unknown as { __wsScrcpy5?: unknown }).__wsScrcpy5 = {
  frames: () => player.stats.frames,
  dropped: () => player.stats.dropped,
  connected: () => Boolean(session),
  status: () => ui.status.textContent,
  history: () => history.slice(),
  log: (message: string) => logLine(message),
  secureContext: () => window.isSecureContext,
  /** Capability: does this browser expose the WebCodecs video interfaces? */
  webCodecs: () => hasWebCodecs,
  /** True when the WebAssembly fallback is the active decoder. */
  software: () => usingSoftware(),
  /** True when the MSE (hardware, fMP4) path is the active decoder. */
  mse: () => usingMse(),
  /** 'webcodecs' | 'mse' | 'software' | 'none' — which decoder the page picked. */
  decoderKind: () => decoder,
  /** The raw dropdown value, including 'auto'. */
  decoderChoice: () => ui.decoderKind.value,
  /** Which decoder options this browser can actually offer. */
  decoderAvailability: () => ({
    webcodecs: hasWebCodecs,
    mse: hasMse,
    software: hasSoftware,
    auto: hasWebCodecs || hasMse || hasSoftware,
  }),
  /** Test-only: select a decoder the way the UI does (fires no change handler). */
  selectDecoder: (value: string) => {
    ui.decoderKind.value = value;
    renderDecoderChoices();
  },
  envWarning: () => !ui.envWarning.classList.contains('hidden'),
  /**
   * Test-only: builds a base64 init segment with the very same muxer the server
   * uses, so `tools/httpcheck.ts` can hand a *real* fMP4 header to the browser's
   * MSE stack and prove it accepts what this project produces over plain http.
   */
  mseInitSegment: () => btoa(bytesToBinary(MSE_TEST_INIT())),
  /**
   * The exact `avc1.PPCCLL` this page would hand to `addSourceBuffer`, derived
   * from the same init segment. A wrong value here means MSE refuses the codec
   * and the screen stays black, so the probe asserts the browser accepts it.
   */
  mseCodecString: () => `avc1.${mseInitCodecString()}`,
  /** Whether the browser's MSE stack accepts the codec string above. */
  mseCodecAccepted: () => {
    if (typeof MediaSource !== 'function') return false;
    try {
      return MediaSource.isTypeSupported(`video/mp4; codecs="${`avc1.${mseInitCodecString()}`}"`);
    } catch {
      return false;
    }
  },
  /**
   * Test-only: what `MseVideoPlayer.isSupported()` answers when the browser's
   * `MediaSource.isTypeSupported` is a *lying stub* — the MIUI case, where it
   * replies `false` to every input including bare `'video/mp4'` while
   * `addSourceBuffer` works fine. The stub is installed on a throwaway object
   * and the memoised verdict is cleared, so the real decision logic runs
   * unmodified. A `true` here is what keeps MIUI phones on hardware MSE instead
   * of dropping them to the WASM fallback.
   */
  mseSupportedWithStubbedIsTypeSupported: () => {
    const real = (window as unknown as { MediaSource?: typeof MediaSource }).MediaSource;
    if (typeof real !== 'function') return false;
    const stub = function (this: unknown, ...args: unknown[]) {
      return new (real as unknown as new (...a: unknown[]) => MediaSource)(...args);
    } as unknown as typeof MediaSource;
    Object.setPrototypeOf(stub, real);
    stub.isTypeSupported = () => false; // the MIUI lie
    (window as unknown as { MediaSource?: typeof MediaSource }).MediaSource = stub;
    MseVideoPlayer.resetSupportCache();
    try {
      return MseVideoPlayer.isSupported();
    } finally {
      (window as unknown as { MediaSource?: typeof MediaSource }).MediaSource = real;
      MseVideoPlayer.resetSupportCache();
    }
  },
};

if (params.get('autostart') === '1') {
  void start();
}
