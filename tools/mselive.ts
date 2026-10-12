/**
 * Live end-to-end MSE check against a **real device**.
 *
 * `httpcheck` proves the browser accepts this project's init segment; it cannot
 * prove the whole session plays, because that needs a device actually streaming
 * 1080p H.264 through the server's muxer. This tool starts a real mirroring
 * session in a real browser and reports what actually happened to the video
 * element — decoded frame count, `SourceBuffer` errors, `MediaSource` state —
 * so a "black screen on the phone" becomes a stack trace instead of a guess.
 *
 *   node tools/mselive.cjs                         (device auto-selected)
 *   WS_SERIAL=192.168.5.1:5555 node tools/mselive.cjs
 *   MSELIVE_MS=12000 node tools/mselive.cjs        (longer capture)
 *
 * The server must already be running (start.cmd / npm start).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const ROOT = resolve(process.cwd());
const SERVER_PORT = Number(process.env.PORT || 8080);
/**
 * Host the browser is pointed at. `MSELIVE_HOST` overrides it for environments
 * where the LAN address is not routable from the calling process (a sandboxed
 * shell, for instance) — `127.0.0.1` is enough to exercise the MSE path, since
 * the secure-context split that makes the LAN address matter only concerns
 * WebCodecs, which this tool does not use.
 */
const SERVER_HOST = process.env.MSELIVE_HOST || '';
const SERIAL = process.env.WS_SERIAL || '192.168.5.1:5555';
const CAPTURE_MS = Number(process.env.MSELIVE_MS || 9000);

function lanAddress(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) {
        return addr.address;
      }
    }
  }
  return undefined;
}

/**
 * A dev machine often has `HTTP_PROXY` set, and a proxy cannot reach the LAN
 * address this tool targets — Node's fetch would then report "unreachable" for
 * a server that is running perfectly. LAN traffic must bypass it.
 */
function directToLan(): void {
  const lan = lanAddress();
  if (!lan) return;
  const byp = [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost', lan]
    .filter(Boolean)
    .join(',');
  process.env.NO_PROXY = byp;
  process.env.no_proxy = byp;
}

function findBrowser(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p));
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** Minimal CDP client (Node 22 ships a global WebSocket, so no dependency). */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, (value: unknown) => void>();
  private readonly events: Array<(method: string, params: Record<string, unknown>) => void> = [];

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (msg.id === undefined) {
        if (msg.method) for (const fn of this.events) fn(msg.method, msg.params ?? {});
        return;
      }
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg.result);
      }
    });
  }

  onEvent(fn: (method: string, params: Record<string, unknown>) => void): void {
    this.events.push(fn);
  }

  static async attach(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('cdp connect failed')));
    });
    return new Cdp(ws);
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve) => {
      this.pending.set(id, resolve as (value: unknown) => void);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const result = await this.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string };
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluate failed');
    return result.result?.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | undefined>,
  timeoutMs = 20000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    await sleep(300);
  }
  console.log(`  ..  timed out waiting for ${label}`);
  return undefined;
}

/**
 * Installed before the page's own script runs, so every `SourceBuffer` gets
 * instrumented from the moment it is created. This is what turns a silent black
 * screen into a record: each append, each error, each `remove()`.
 */
const INSTRUMENT = `
(() => {
  const log = [];
  window.__mseTrace = log;
  const record = (kind, detail) => log.push({ t: Date.now(), kind, detail });
  const NativeMS = window.MediaSource;
  if (!NativeMS) { record('no-mediasource'); return; }

  const nativeAdd = NativeMS.prototype.addSourceBuffer;
  NativeMS.prototype.addSourceBuffer = function (mime) {
    const sb = nativeAdd.call(this, mime);
    record('addSourceBuffer', { mime, state: this.readyState });
    sb.__traced = true;
    const origAppend = sb.appendBuffer.bind(sb);
    sb.appendBuffer = function (data) {
      try {
        const r = origAppend(data);
        record('append', { bytes: data && data.byteLength, buffered: sb.buffered.length, updating: sb.updating });
        return r;
      } catch (e) {
        record('append-threw', { name: e && e.name, message: e && e.message });
        throw e;
      }
    };
    const origRemove = sb.remove.bind(sb);
    sb.remove = function (a, b) {
      record('remove', { start: a, end: b });
      return origRemove(a, b);
    };
    return sb;
  };

  const nativeRemove = NativeMS.prototype.removeSourceBuffer;
  NativeMS.prototype.removeSourceBuffer = function (sb) {
    record('removeSourceBuffer', { state: this.readyState });
    return nativeRemove.call(this, sb);
  };

  const nativeEnd = NativeMS.prototype.endOfStream;
  NativeMS.prototype.endOfStream = function (reason) {
    record('endOfStream', { reason, state: this.readyState });
    return nativeEnd.call(this, reason);
  };
})();
`;

async function main(): Promise<void> {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.log('  ..  no Chrome/Edge found, skipping');
    process.exit(0);
  }
  const lan = lanAddress();
  if (!lan) {
    console.log('  ..  no LAN address available, skipping');
    process.exit(0);
  }

  // Confirm the server is actually up before launching anything.
  directToLan();
  const origin = `http://${SERVER_HOST || lan}:${SERVER_PORT}/`;
  const up = await fetch(`${origin}api/version`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!up) {
    console.log(`  ..  server not reachable at ${origin} — start it first`);
    process.exit(1);
  }
  console.log(`  ..  server  : ${origin}`);
  console.log(`  ..  serial  : ${SERIAL}`);

  const userDataDir = join(ROOT, 'node_modules/.cache/ws-scrcpy5/chrome-profile-mselive');
  const browser = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-proxy-server',
      // Autoplay must work headlessly, or the frame counter never ticks and a
      // working stream would look identical to a dead one.
      '--autoplay-policy=no-user-gesture-required',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let stderr = '';
  browser.stderr.on('data', (d) => (stderr += String(d)));

  try {
    const devtoolsUrl = await waitFor('devtools endpoint', async () => {
      const match = /ws:\/\/[^\s]+/.exec(stderr);
      return match ? match[0] : undefined;
    }, 20000);
    if (!devtoolsUrl) {
      check('browser exposes a devtools endpoint', false, stderr.slice(0, 200));
      return;
    }

    const hostPort = new URL(devtoolsUrl).host;
    const target = await fetch(`http://${hostPort}/json/new?${encodeURIComponent('about:blank')}`, {
      method: 'PUT',
    })
      .then((r) => r.json() as Promise<CdpTarget>)
      .catch(() => undefined);
    if (!target?.webSocketDebuggerUrl) {
      check('opened a page target', false);
      return;
    }
    check('opened a page target', true);

    const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const consoleErrors: string[] = [];
    cdp.onEvent((method, params) => {
      if (method !== 'Runtime.consoleAPICalled') return;
      const type = String(params.type ?? '');
      if (type !== 'error' && type !== 'warning') return;
      const args = (params.args as Array<{ value?: unknown; description?: string }>) ?? [];
      const text = args.map((a) => String(a.value ?? a.description ?? '')).join(' ');
      if (text) consoleErrors.push(text);
    });

    // Instrument before any page script runs, then navigate to the app.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
    await cdp.send('Page.navigate', {
      // `forceDecoder=mse` matters: on localhost the browser is in a secure
      // context and would pick WebCodecs, so without this the MSE path — the
      // one real phones take — would never be exercised here.
      url: `${origin}?serial=${encodeURIComponent(SERIAL)}&autostart=1&forceDecoder=mse`,
    });

    const ready = await waitFor(
      'app boot',
      async () => ((await cdp.eval<boolean>('Boolean(window.__wsScrcpy5)')) ? true : undefined),
      15000,
    );
    check('the app booted', ready === true);

    const kind = await cdp.eval<string | null>('window.__wsScrcpy5?.decoderKind?.() ?? null');
    console.log(`  ..  decoder : ${kind}`);
    check('the page selected the MSE decoder', kind === 'mse', kind);

    // Let the session run: connect, handshake, stream, decode.
    await sleep(CAPTURE_MS);

    const result = await cdp.eval<{
      connected: boolean;
      frames: number;
      dropped: number;
      status: string;
      trace: Array<{ kind: string; detail: Record<string, unknown> }>;
      video: {
        readyState: number;
        currentTime: number;
        paused: boolean;
        buffered: number;
        error: string | null;
      } | null;
    }>(`
      (() => {
        const v = document.querySelector('video.mse-video');
        return {
          connected: window.__wsScrcpy5?.connected?.() ?? false,
          frames: window.__wsScrcpy5?.frames?.() ?? -1,
          dropped: window.__wsScrcpy5?.dropped?.() ?? -1,
          status: window.__wsScrcpy5?.status?.() ?? '',
          trace: window.__mseTrace ?? [],
          video: v ? {
            readyState: v.readyState,
            currentTime: v.currentTime,
            paused: v.paused,
            buffered: v.buffered.length,
            error: v.error ? (v.error.message || String(v.error.code)) : null,
          } : null,
        };
      })()
    `);

    console.log('\n--- trace ---');
    const counts = new Map<string, number>();
    for (const entry of result.trace) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    for (const [kindName, n] of counts) console.log(`  ${kindName.padEnd(20)} x${n}`);
    const problems = result.trace.filter((e) =>
      ['append-threw', 'removeSourceBuffer', 'endOfStream', 'no-mediasource'].includes(e.kind),
    );
    if (problems.length) {
      console.log('  -- suspicious events --');
      for (const p of problems.slice(0, 12)) console.log(`  ${p.kind}: ${JSON.stringify(p.detail)}`);
    }

    console.log('\n--- video element ---');
    console.log(`  ${JSON.stringify(result.video)}`);

    console.log('\n--- result ---');
    console.log(`connected     : ${result.connected}`);
    console.log(`frames        : ${result.frames} (dropped: ${result.dropped})`);
    console.log(`status        : ${result.status}`);
    if (consoleErrors.length) {
      console.log(`console       : ${consoleErrors.slice(0, 6).join(' | ')}`);
    }

    check('the page is connected to a device', result.connected === true);
    check('the video element reached HAVE_CURRENT_DATA', (result.video?.readyState ?? 0) >= 2, result.video);
    check('the video element is playing, not paused', result.video?.paused === false, result.video);
    check('frames were actually decoded', result.frames > 5, result.frames);
    check('no MSE append error was raised', !problems.some((p) => p.kind === 'append-threw'));
    check('the SourceBuffer was never yanked out from under the player', !problems.some((p) => p.kind === 'removeSourceBuffer'));

    const css = await cdp.eval<string>(`
      (() => {
        const v = document.querySelector('video.mse-video');
        if (!v) return 'no-video';
        const r = v.getBoundingClientRect();
        const s = getComputedStyle(v);
        return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), display: s.display, visibility: s.visibility, opacity: s.opacity });
      })()
    `);
    console.log(`  video css     : ${css}`);

    cdp.close();
  } finally {
    browser.kill();
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
