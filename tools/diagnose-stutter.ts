/**
 * Diagnoses periodic mirroring stutter by driving a real headless Chrome
 * against the *deployed* server and sampling playback metrics.
 *
 * The point is measurement, not guessing: for the MSE path we record the
 * buffered gap (`buffered.end - currentTime`), every seek the page performs,
 * every `waiting`/`stalled` event and the frame-advance timeline. Those four
 * signals separate the two candidate causes:
 *
 *   gap crossing the 2 s threshold  -> the page seeks, which visually *jumps*
 *   waiting / frame-advance stalls  -> the buffer ran dry, playback hiccups
 *
 * Usage (against the running deployment, device pre-connected by adb):
 *
 *   esbuild tools/diagnose-stutter.ts --bundle --platform=node --format=cjs \
 *     --outfile=node_modules/.cache/ws-scrcpy5/diagnose.cjs
 *   node node_modules/.cache/ws-scrcpy5/diagnose.cjs [device] [decoder] [seconds]
 *
 *   device   adb address, default 192.168.1.86:5555
 *   decoder  mse | webcodecs — forced via ?forceDecoder, so both runs use the
 *            same origin and the same network path; only the decoder differs
 *   seconds  sampling window, default 40
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Plain `http`, never `fetch`: Node's fetch honours HTTP_PROXY, and this
 * machine's proxy refuses LAN addresses — which makes a reachable server look
 * dead. (Same reason the test tools set NO_PROXY.)
 */
function httpGet(url: string, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += String(c)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const ROOT = join('C:', 'Users', 'PC', 'WorkBuddy', 'ws-scrcpy5');

const DEVICE = process.argv[2] ?? '192.168.1.86:5555';
const DECODER = process.argv[3] === 'webcodecs' ? 'webcodecs' : 'mse';
const SECONDS = Number(process.argv[4] ?? 40);
/**
 * The origin under test. Point it at the LAN address to reproduce the real
 * deployment (non-secure -> MSE), or at localhost to A/B WebCodecs.
 */
const ORIGIN = process.env.DIAG_ORIGIN ?? 'http://localhost:8080';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function findBrowser(): string | undefined {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  return candidates.find((p) => existsSync(p));
}

interface CdpTarget {
  webSocketDebuggerUrl?: string;
}

/** Minimal CDP client over the Node builtin WebSocket (same as httpcheck). */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, (value: unknown) => void>();

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
      if (msg.id === undefined) return;
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg.result);
      }
    });
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
      exceptionDetails?: { text: string };
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.text}`);
    }
    return result.result?.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

interface Sample {
  at: number;
  t: number;
  end: number;
  gap: number;
  rs: number;
  paused: boolean;
  tf: number;
  df: number;
  /** The app's own decoded-frame counter (comparable across decoders). */
  af: number;
}

function pctl(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined && value !== null && value !== false) return value;
    await sleep(300);
  }
  console.log(`  ..  超时：${label}`);
  return undefined;
}

async function main(): Promise<void> {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.log('未找到 Chrome/Edge，无法诊断');
    process.exit(1);
  }

  // The deployment under test is the running container, not a spawned server.
  const up = await httpGet(`${ORIGIN}/api/version`)
    .then((r) => r.status === 200)
    .catch(() => false);
  if (!up) {
    console.log(`服务器不可达：${ORIGIN}（容器没在跑？）`);
    process.exit(1);
  }
  console.log(`目标: ${ORIGIN}  设备: ${DEVICE}  强制解码: ${DECODER}  采样: ${SECONDS}s`);

  const pageUrl = `${ORIGIN}?forceDecoder=${DECODER}`;
  /*
   * Headless mode is a confound for MSE: a `<video>` element may not advance
   * its playhead without a real presentation surface, which looks exactly like
   * a frozen stream. DIAG_HEADFUL=1 runs a normal window to rule that out.
   */
  const headful = process.env.DIAG_HEADFUL === '1';
  const browser: ChildProcess = spawn(
    browserPath,
    [
      ...(headful ? [] : ['--headless=new']),
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-proxy-server',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--remote-debugging-port=0',
      `--user-data-dir=${join(tmpdir(), 'ws-scrcpy5-diag-' + DECODER)}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let stderr = '';
  browser.stderr?.on('data', (d) => (stderr += String(d)));

  try {
    const devtoolsUrl = await waitFor('devtools endpoint', async () => {
      const match = /ws:\/\/[^\s]+/.exec(stderr);
      return match ? match[0] : undefined;
    }, 20000);
    if (!devtoolsUrl) throw new Error('浏览器未开放调试端口');

    const hostPort = new URL(devtoolsUrl).host;
    // about:blank first: the hook must be installed before the app loads.
    const target = JSON.parse(
      (await httpGet(`http://${hostPort}/json/new?${encodeURIComponent('about:blank')}`, 'PUT')).body,
    ) as CdpTarget;
    if (!target.webSocketDebuggerUrl) throw new Error('打不开页面');

    const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    /*
     * Instrument MediaSource/SourceBuffer *before* any page script runs, so
     * the real objects the app creates can be watched. This is what separates
     * "data never arrives" from "appends are stuck / rejected": both look like
     * a frozen picture from the outside.
     */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (() => {
          const Orig = window.MediaSource;
          if (typeof Orig !== 'function') return;
          const hook = { created: 0, appends: 0, appendErrors: [], msErrors: [], updates: 0 };
          window.__msHook = hook;
          function Patched() {
            const ms = new Orig();
            hook.created++;
            hook.ms = ms;
            ms.addEventListener('error', () => hook.msErrors.push('MediaSource error, state=' + ms.readyState));
            const origAdd = ms.addSourceBuffer.bind(ms);
            ms.addSourceBuffer = (mime) => {
              const sb = origAdd(mime);
              hook.sb = sb;
              hook.mime = mime;
              const origAppend = sb.appendBuffer.bind(sb);
              sb.appendBuffer = (b) => {
                hook.appends++;
                try { return origAppend(b); }
                catch (e) { hook.appendErrors.push((e && e.name) + ': ' + (e && e.message)); throw e; }
              };
              return sb;
            };
            return ms;
          }
          Patched.isTypeSupported = Orig.isTypeSupported;
          Patched.prototype = Orig.prototype;
          window.MediaSource = Patched;
        })();
      `,
    });
    await cdp.send('Page.navigate', { url: pageUrl });
    await sleep(3500);

    const picked = await cdp.eval<string>('window.__wsScrcpy5.decoderKind()');
    console.log(`页面解码器: ${picked}（下拉值 ${(await cdp.eval<string>('window.__wsScrcpy5.decoderChoice()'))}）`);

    // Fill the address box (input event so the button enables), then connect.
    await cdp.eval(
      `(() => { const i = document.getElementById('deviceInput'); i.value = ${JSON.stringify(DEVICE)};
        i.dispatchEvent(new Event('input', { bubbles: true })); return i.value; })()`,
    );
    await cdp.eval(`document.getElementById('connectBtn').click()`);

    /*
     * `connected()` is *not* an adb state — it reports an active mirroring
     * session (`Boolean(session)`). adb connect finishing is visible only on
     * the server, so poll `/api/devices` for the serial; only then start.
     */
    const adbUp = await waitFor(
      'adb 连接',
      async () => {
        const res = await httpGet(`${ORIGIN}/api/devices`).catch(() => undefined);
        if (!res) return undefined;
        try {
          const list = (JSON.parse(res.body) as { devices?: { serial?: string }[] }).devices ?? [];
          return list.some((d) => d.serial === DEVICE) ? true : undefined;
        } catch {
          return undefined;
        }
      },
      30000,
    );
    if (!adbUp) throw new Error('adb 没连上设备（设备离线 / 未授权？）');
    console.log('adb 已连接，开始投屏…');

    await cdp.eval(`document.getElementById('startBtn').click()`);
    const streaming = await waitFor(
      '投屏会话建立',
      async () => ((await cdp.eval<boolean>('window.__wsScrcpy5.connected()')) ? true : undefined),
      30000,
    );
    if (!streaming) throw new Error('投屏会话没建立');

    if (DECODER === 'mse') {
      await waitFor(
        'MSE 视频出流',
        async () =>
          (await cdp.eval<boolean>(
            `(() => { const v = document.querySelector('video.mse-video');
              return v && v.readyState >= 2 && v.currentTime > 0.5 ? true : undefined; })()`,
          )) ?? undefined,
        30000,
      );
      const instrumented = await cdp.eval<string>(`
        (() => {
          const v = document.querySelector('video.mse-video');
          if (!v) return 'no-video';
          const d = { waits: 0, stalled: 0, seeks: 0, seekLog: [] };
          window.__diag = d;
          v.addEventListener('waiting', () => d.waits++);
          v.addEventListener('stalled', () => d.stalled++);
          v.addEventListener('seeking', () => { d.seeks++; d.seekLog.push([+(performance.now()/1000).toFixed(1), +v.currentTime.toFixed(2)]); });
          window.__sample = () => {
            const b = v.buffered;
            const end = b.length ? b.end(b.length - 1) : 0;
            const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : { totalVideoFrames: -1, droppedVideoFrames: -1 };
            // af is the app's own frame counter — the same number the
            // WebCodecs run reports, so the two paths compare like for like.
            const af = window.__wsScrcpy5 ? window.__wsScrcpy5.frames() : -1;
            return { t: v.currentTime, end, gap: end - v.currentTime, rs: v.readyState, paused: v.paused, tf: q.totalVideoFrames, df: q.droppedVideoFrames, af };
          };
          return 'ok';
        })()
      `);
      if (instrumented !== 'ok') throw new Error('找不到 MSE video 元素');
    } else {
      await waitFor(
        'WebCodecs 出帧',
        async () => ((await cdp.eval<number>('window.__wsScrcpy5.frames()')) > 20 ? true : undefined),
        30000,
      );
    }

    console.log(`开始采样 ${SECONDS}s…\n`);
    const samples: Sample[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < SECONDS * 1000) {
      const at = (Date.now() - t0) / 1000;
      try {
        if (DECODER === 'mse') {
          const s = await cdp.eval<Sample | null>('window.__sample ? window.__sample() : null');
          if (s) samples.push({ at, ...s });
        } else {
          const s = await cdp.eval<{ f: number; d: number }>(
            '(() => { const a = window.__wsScrcpy5; return { f: a.frames(), d: a.dropped() }; })()',
          );
          samples.push({ at, t: s.f, end: 0, gap: 0, rs: 0, paused: false, tf: s.f, df: s.d, af: s.f });
        }
      } catch {
        /* a transient evaluate failure must not end the run */
      }
      await sleep(200);
    }

    // ------------------------------------------------------------- analysis
    console.log('—— 结果 ——');
    if (DECODER === 'mse') {
      const gaps = samples.map((s) => s.gap).filter((g) => Number.isFinite(g));
      let episodes = 0;
      const episodeTimes: number[] = [];
      let prev = false;
      for (const s of samples) {
        const cur = s.gap > 2;
        if (cur && !prev) {
          episodes++;
          episodeTimes.push(+s.at.toFixed(1));
        }
        prev = cur;
      }
      const intervals: number[] = [];
      for (let i = 1; i < episodeTimes.length; i++) intervals.push(+(episodeTimes[i] - episodeTimes[i - 1]).toFixed(1));

      let jumps = 0;
      const jumpLog: string[] = [];
      for (let i = 1; i < samples.length; i++) {
        const d = samples[i].t - samples[i - 1].t;
        if (d > 0.6) {
          jumps++;
          jumpLog.push(`t=${samples[i].at.toFixed(1)}s  ${samples[i - 1].t.toFixed(2)} → ${samples[i].t.toFixed(2)}（+${d.toFixed(2)}s）`);
        }
      }

      // Stall detection uses `af` (the app's decoded-frame count) so MSE and
      // WebCodecs are measured with the same yardstick: `totalVideoFrames` is
      // only meaningful for an MSE <video>, and headless Chrome may not
      // present frames at all without a real surface.
      let stalls = 0;
      let stallRun = 0;
      let longestStall = 0;
      let lastAf = samples[0]?.af ?? 0;
      for (const s of samples) {
        if (s.af === lastAf && s.af >= 0) {
          stallRun += 0.2;
          if (stallRun >= 1) stalls++;
          longestStall = Math.max(longestStall, stallRun);
        } else {
          stallRun = 0;
        }
        lastAf = s.af;
      }

      const fps = samples.length > 1 ? (samples[samples.length - 1].af - samples[0].af) / SECONDS : 0;
      const diag = await cdp.eval<{ waits: number; stalled: number; seeks: number; seekLog: [number, number][] } | undefined>(
        'window.__diag',
      );

      console.log(`  缓冲 gap:  平均 ${(gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1)).toFixed(2)}s   中位 ${pctl(gaps, 50).toFixed(2)}s   p95 ${pctl(gaps, 95).toFixed(2)}s   最大 ${Math.max(...gaps).toFixed(2)}s`);
      console.log(`  gap>2s（会触发 seek 跳帧）: ${episodes} 次${episodeTimes.length ? `，时刻 ${episodeTimes.join(', ')}s` : ''}`);
      if (intervals.length) console.log(`  触发间隔: ${intervals.join(', ')}s`);
      console.log(`  currentTime 跳变(>0.6s): ${jumps} 次${jumpLog.length ? '\n    ' + jumpLog.join('\n    ') : ''}`);
      /*
       * Playhead stalls. `currentTime` is the most trustworthy signal for an
       * MSE <video>: frame counters depend on presentation callbacks that a
       * headless browser may not fire, but the playhead always advances when
       * the element is actually playing.
       */
      let ctStalls = 0;
      let ctRun = 0;
      let ctLongest = 0;
      let lastT = samples[0]?.t ?? 0;
      for (const s of samples) {
        if (s.t - lastT < 0.05) {
          ctRun += 0.2;
          if (ctRun >= 1) ctStalls++;
          ctLongest = Math.max(ctLongest, ctRun);
        } else {
          ctRun = 0;
        }
        lastT = s.t;
      }
      console.log(`  播放头停顿(≥1s 不前进): ${ctStalls} 次，最长 ${ctLongest.toFixed(1)}s`);
      const hook = await cdp.eval<{
        created: number;
        appends: number;
        appendErrors: string[];
        msErrors: string[];
        mime?: string;
        msState?: string;
        sbUpdating?: boolean;
        sbRanges?: number;
        sbEnd?: number;
      } | null>(`
        (() => {
          const h = window.__msHook;
          if (!h) return null;
          const sb = h.sb;
          return {
            created: h.created, appends: h.appends, appendErrors: h.appendErrors.slice(0, 5),
            msErrors: h.msErrors.slice(0, 5), mime: h.mime,
            msState: h.ms ? h.ms.readyState : undefined,
            sbUpdating: sb ? sb.updating : undefined,
            sbRanges: sb ? sb.buffered.length : undefined,
            sbEnd: sb && sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : undefined,
          };
        })()
      `).catch(() => null);
      if (hook) {
        console.log(`  MediaSource: 创建 ${hook.created} 个  readyState=${hook.msState}  mime=${hook.mime ?? '-'}`);
        console.log(`  appendBuffer 调用: ${hook.appends} 次   SourceBuffer.updating=${hook.sbUpdating}   缓冲区间数=${hook.sbRanges}  缓冲末端=${hook.sbEnd?.toFixed?.(2) ?? '-'}s`);
        if (hook.appendErrors.length) console.log(`  ⚠ append 抛错: ${hook.appendErrors.join(' | ')}`);
        if (hook.msErrors.length) console.log(`  ⚠ MediaSource 错误: ${hook.msErrors.join(' | ')}`);
      }

      console.log(`  waiting(缓冲耗尽): ${diag?.waits ?? '?'} 次   stalled: ${diag?.stalled ?? '?'} 次   seeking: ${diag?.seeks ?? '?'} 次`);
      console.log(`  帧推进停顿(≥1s 无新帧): ${stalls} 次，最长 ${longestStall.toFixed(1)}s`);
      console.log(`  平均帧率: ${fps.toFixed(1)} fps   采样点: ${samples.length}`);
    } else {
      let stalls = 0;
      let stallRun = 0;
      let longestStall = 0;
      let lastAf = samples[0]?.af ?? 0;
      for (const s of samples) {
        if (s.af === lastAf && s.af >= 0) {
          stallRun += 0.2;
          if (stallRun >= 1) stalls++;
          longestStall = Math.max(longestStall, stallRun);
        } else {
          stallRun = 0;
        }
        lastAf = s.af;
      }
      const fps = samples.length > 1 ? (samples[samples.length - 1].af - samples[0].af) / SECONDS : 0;
      console.log(`  帧推进停顿(≥1s 无新帧): ${stalls} 次，最长 ${longestStall.toFixed(1)}s`);
      console.log(`  平均帧率: ${fps.toFixed(1)} fps   掉帧(应用统计): ${samples[samples.length - 1]?.df ?? '?'}`);
    }

    cdp.close();
  } finally {
    browser.kill();
  }
}

main().catch((e) => {
  console.error('诊断失败:', (e as Error).message);
  process.exit(1);
});
