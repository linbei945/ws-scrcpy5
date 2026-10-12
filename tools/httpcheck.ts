/**
 * Headless check for the plain-http software-decoding path.
 *
 * This is the one behaviour that cannot be verified from Node alone: it needs a
 * real browser, because the whole point is what a browser does with a
 * non-secure origin. The script therefore drives Chrome (or Edge) over the
 * DevTools Protocol — no extra dependency, it is just HTTP + WebSocket — and
 * asserts that, on a plain `http://<lan-ip>` page (not localhost, which the
 * browser treats as secure and where the bug does not reproduce):
 *
 *   1. `VideoDecoder` is genuinely absent, proving the test really is on a
 *      path where the old code would have shown a black screen;
 *   2. the client selected the software decoder instead of giving up;
 *   3. `decoder.worker.js` is served and the page requests it.
 *
 * Run with: npm run httpcheck   (starts its own server)
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
const PORT = 18091;

/**
 * The page must be opened on a LAN address, not `127.0.0.1`: browsers treat
 * localhost as *potentially trustworthy*, so WebCodecs is available there and
 * the software path would never be exercised. A private IPv4 address is the
 * case the user actually hits from a phone.
 */
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

/**
 * Minimal CDP client: one WebSocket, incrementing ids, promise per call.
 * Node 22 ships a global WebSocket, so no dependency is needed.
 */
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

  /** Evaluates an expression and returns its JSON value. */
  async eval<T>(expression: string): Promise<T> {
    const result = await this.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? 'evaluate failed');
    }
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

async function main(): Promise<void> {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.log('  ..  no Chrome/Edge found, skipping browser check');
    console.log('\nall checks passed');
    process.exit(0);
  }

  const lan = lanAddress();
  if (!lan) {
    console.log('  ..  no LAN address available, skipping browser check');
    console.log('\nall checks passed');
    process.exit(0);
  }
  const origin = `http://${lan}:${PORT}/`;
  console.log(`  ..  page origin: ${origin}`);

  // ------------------------------------------------------------------ server
  const server = spawn(process.execPath, [join(ROOT, 'dist/server/index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });

  try {
    const up = await waitFor('http server', async () => {
      const res = await fetch(`http://${lan}:${PORT}/api/version`);
      return res.ok ? true : undefined;
    }, 15000);
    check('server is up on plain http', up === true);
    if (!up) return;

    // --------------------------------------------------------------- browser
    const userDataDir = join(ROOT, 'node_modules/.cache/ws-scrcpy5/chrome-profile');
    const browser = spawn(
      browserPath,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        // The LAN interface must be reached directly; a system proxy would
        // turn this into a different origin and change the security verdict.
        '--no-proxy-server',
        '--remote-debugging-port=0',
        `--user-data-dir=${userDataDir}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let stderr = '';
    browser.stderr.on('data', (d) => (stderr += String(d)));

    // Chrome prints `DevTools listening on ws://...`; that URL fronts the
    // browser-level endpoint used to open a page target.
    const devtoolsUrl = await waitFor('devtools endpoint', async () => {
      const match = /ws:\/\/[^\s]+/.exec(stderr);
      return match ? match[0] : undefined;
    }, 20000);

    if (!devtoolsUrl) {
      check('browser exposes a devtools endpoint', false, stderr.slice(0, 200));
      browser.kill();
      return;
    }

    const hostPort = new URL(devtoolsUrl).host;
    const target = await fetch(`http://${hostPort}/json/new?${encodeURIComponent(origin)}`, {
      method: 'PUT',
    })
      .then((r) => r.json() as Promise<CdpTarget>)
      .catch(() => undefined);

    if (!target?.webSocketDebuggerUrl) {
      check('opened a page target', false);
      browser.kill();
      return;
    }
    check('opened a page target', true);

    const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');

    // Give scripts a moment to parse and run on load.
    await sleep(1500);

    // 1. Prove the origin really is one where WebCodecs is withheld.
    const hasDecoder = await cdp.eval<boolean>('typeof window.VideoDecoder === "function"');
    check('http origin withholds VideoDecoder (the original bug)', hasDecoder === false);

    const isSecure = await cdp.eval<boolean>('window.isSecureContext');
    check('http origin is reported as non-secure', isSecure === false);

    /*
     * MediaSource is *not* specified as secure-context-only, but it has been
     * claimed otherwise. Record the truth rather than assume it: whether MSE
     * can be used over plain http decides if the hardware-decoding path
     * (`mse`) is selectable here at all.
     */
    const mseKind = await cdp.eval<string>('typeof MediaSource');
    const mseConstruct = await cdp.eval<string>(`
      (() => {
        if (typeof MediaSource !== 'function') return 'absent';
        try { const ms = new MediaSource(); return ms.readyState || 'ok'; }
        catch (e) { return 'throw:' + (e && e.name); }
      })()
    `);
    const mseAvc = await cdp.eval<boolean>(
      'typeof MediaSource === "function" && MediaSource.isTypeSupported(\'video/mp4; codecs="avc1.42E01E"\')',
    );
    console.log(
      `  ..  MediaSource: typeof=${mseKind} construct=${mseConstruct} avc1=${mseAvc} (http origin)`,
    );
    check('MSE is constructible over plain http', mseConstruct === 'closed' || mseConstruct === 'open');
    check('MSE accepts H.264 baseline fMP4 over plain http', mseAvc === true);

    // 2. The client must have chosen the *hardware* path: MSE is available on
    //    this origin and decodes on the GPU, so it beats the WASM fallback.
    const picked = await waitFor('decoder selection', async () => {
      const v = await cdp.eval<string | null>(
        'window.__wsScrcpy5 ? window.__wsScrcpy5.decoderKind() : null',
      );
      return v ?? undefined;
    }, 10000);
    check('client selected the MSE (hardware) decoder over plain http', picked === 'mse', picked);

    /*
     * The 解码方式 dropdown. This origin is exactly the interesting case: a
     * *non-secure* page where WebCodecs is withheld but MSE and the WASM
     * decoder both work, so the availability rules can be observed directly.
     *
     * `selectDecoder` drives the real `renderDecoderChoices()` through the same
     * code path the UI uses; it deliberately does not fire the `change` handler,
     * which would try to restart a session.
     */
    const decodedOptions = await cdp.eval<string[]>(
      `Array.from(document.getElementById('decoderKind').options).map(o => o.value)`,
    );
    check(
      'the decoder dropdown offers auto / webcodecs / mse / software',
      JSON.stringify(decodedOptions) === JSON.stringify(['auto', 'webcodecs', 'mse', 'software']),
      decodedOptions,
    );

    /*
     * Label wording. The three decoder rows must read `<标识> <中文说明>` — the
     * shape that was once broken by a `软件解码（WASM）` sitting next to
     * `WebCodecs 硬件解码`. A dropdown is a column, so one row that flips the
     * order looks like a typo and makes the parts hard to compare.
     *
     * An unavailable decoder gets a reason appended (`（本浏览器不提供）`), which
     * on this origin applies to WebCodecs — so the suffix is stripped before
     * the shape is judged, or the rule would only hold on a secure page.
     *
     * The shape is asserted rather than the exact strings so a deliberate
     * rename (say, to a new decoder name) passes while an order flip fails.
     */
    const decoderLabels = await cdp.eval<string[]>(
      `Array.from(document.getElementById('decoderKind').options).map(o => o.textContent)`,
    );
    const stripReason = (label: string) =>
      label.replace(/（(?:本浏览器不提供|本浏览器不支持|不可用)）$/, '');
    const decoderRows = decoderLabels.filter((l) => !l.includes('自动')).map(stripReason);
    check(
      'decoder labels put the identifier first and the Chinese description last',
      decoderRows.length === 3 &&
        decoderRows.every(
          (label) => /^[A-Za-z][\w.]*\s+\S*\p{Script=Han}$/u.test(label),
        ),
      decoderRows,
    );
    check(
      'no decoder label wraps its identifier in parentheses at the end',
      decoderRows.every((label) => !/（[A-Za-z][\w.]*）\s*$/.test(label)),
      decoderRows,
    );

    const avail = await cdp.eval<Record<string, boolean>>(
      'window.__wsScrcpy5.decoderAvailability()',
    );
    check('WebCodecs is reported unavailable on a non-secure origin', avail.webcodecs === false, avail);
    check('MSE is reported available on this origin', avail.mse === true, avail);
    check('the WASM decoder is reported available', avail.software === true, avail);

    /*
     * The video codec is no longer a choice: it was removed from the UI and the
     * wire protocol, because MSE and the WASM decoder are H.264-only and a
     * second dropdown only created ways to end up with a black screen. The
     * absence is asserted rather than assumed — a leftover control would still
     * send `videoCodec=`, which the server now ignores, so nothing else would
     * notice it had been left behind.
     */
    check(
      'the 视频编码 control is gone from the UI',
      (await cdp.eval<boolean>("document.getElementById('videoCodec') === null")) === true,
    );
    /*
     * The panel carries no explanatory line either. Anything under the dropdown
     * restated the option name ("延迟最低", "（安全上下文）") and drifted — the
     * WebCodecs line still advertised H.265/AV1 after they were removed. The
     * option name is the whole description.
     */
    check(
      'the panel shows no extra decoder description',
      (await cdp.eval<boolean>("document.getElementById('decoderHint') === null")) === true,
    );

    /*
     * Rows must stay bare: the only annotation allowed is the reason a row is
     * unpickable. Guards against a suffix creeping back in.
     */
    const bareRows = await cdp.eval<string[]>(
      `Array.from(document.getElementById('decoderKind').options).map(o => o.textContent)`,
    );
    check(
      'rows carry no annotation beyond an unavailability reason',
      bareRows.every((l) => !/延迟|安全上下文|画质|H\.26|AV1/.test(l)),
      bareRows,
    );

    /** Resolves a decoder through the real UI path and reads the outcome. */
    const probeDecoder = async (value: string) => {
      await cdp.eval(`window.__wsScrcpy5.selectDecoder(${JSON.stringify(value)})`);
      return cdp.eval<{ kind: string; choice: string }>(`
        (() => ({
          kind: window.__wsScrcpy5.decoderKind(),
          choice: window.__wsScrcpy5.decoderChoice(),
        }))()
      `);
    };

    /*
     * A decoder this browser cannot provide must not be honoured — silently
     * running it would be a black screen with no explanation. Falling back to
     * the auto order is the honest behaviour.
     */
    const webcodecsPick = await probeDecoder('webcodecs');
    check(
      'picking WebCodecs on a non-secure origin falls back instead of failing',
      webcodecsPick.kind !== 'webcodecs' && webcodecsPick.kind !== 'none',
      webcodecsPick,
    );

    const msePick = await probeDecoder('mse');
    check('picking MSE selects the MSE decoder', msePick.kind === 'mse', msePick);

    const softPick = await probeDecoder('software');
    check('picking WASM 软件解码 selects the WASM decoder', softPick.kind === 'software', softPick);

    // `auto` must return to the best available decoder for this origin.
    const autoPick = await probeDecoder('auto');
    check('auto resolves back to MSE on this origin', autoPick.kind === 'mse', autoPick);
    check('auto reports the dropdown value as auto', autoPick.choice === 'auto', autoPick);

    /*
     * The machine-checkable part of "hardware decoding works on http": the
     * server's own fMP4 output must be accepted by the browser's MSE stack.
     *
     * The init segment is produced by the *server* muxer and inlined here as
     * base64, so this exercises the real `buildInitSegment` output rather than a
     * hand-written fixture. If MSE rejects it, `sourceopen` never fires and the
     * failure is unambiguous.
     */
    const initBase64 = await cdp.eval<string | null>('window.__wsScrcpy5?.mseInitSegment?.() ?? null');
    if (initBase64) {
      const playback = await cdp.eval<string>(`
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), 8000);
          (async () => {
            try {
              const bin = atob(${JSON.stringify(initBase64)});
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              const ms = new MediaSource();
              const video = document.createElement('video');
              video.muted = true;
              video.src = URL.createObjectURL(ms);
              ms.addEventListener('sourceopen', () => {
                try {
                  const mime = 'video/mp4; codecs="' + (window.__wsScrcpy5.mseCodecString() || 'avc1.42E01E') + '"';
                  if (!MediaSource.isTypeSupported(mime)) { clearTimeout(timer); resolve('mime-unsupported:' + mime); return; }
                  const sb = ms.addSourceBuffer(mime);
                  sb.addEventListener('updateend', () => { clearTimeout(timer); resolve('appended'); });
                  sb.appendBuffer(bytes);
                } catch (e) { clearTimeout(timer); resolve('append-threw:' + e.message); }
              });
              ms.addEventListener('error', () => { clearTimeout(timer); resolve('source-error'); });
            } catch (e) { clearTimeout(timer); resolve('setup-threw:' + e.message); }
          })();
        })
      `);
      check('the server-muxed init segment is accepted by MSE', playback === 'appended', playback);

      /*
       * The codec string is derived from the init segment's `avcC` box. An
       * off-by-one there reads `configurationVersion` (0x01) as the profile and
       * asks MSE for `avc1.01…` — a profile that does not exist, which every MSE
       * implementation rejects, leaving a black screen with only a log line to
       * show for it. Assert the shape, not just that *some* string came back.
       */
      const codecString = await cdp.eval<string | null>(
        'window.__wsScrcpy5?.mseCodecString?.() ?? null',
      );
      check('a codec string is derived from the init segment', typeof codecString === 'string', codecString);
      check(
        'the codec string names a real profile, not the 0x01 version byte',
        /^avc1\.[0-9A-F]{6}$/.test(codecString ?? '') && !(codecString ?? '').startsWith('avc1.01'),
        codecString,
      );
      const derivedAccepted = await cdp.eval<boolean>(
        'window.__wsScrcpy5?.mseCodecAccepted?.() ?? false',
      );
      check('the browser accepts the derived codec string', derivedAccepted === true, { codecString, derivedAccepted });

      /*
       * MIUI's browser ships a stubbed `MediaSource.isTypeSupported` that returns
       * `false` for *everything* — including bare `'video/mp4'` — while
       * `addSourceBuffer` works perfectly. Trusting that answer dropped the phone
       * to WASM software decode (the "无法触发 MSE" report). The probe must look
       * past it, so this simulates the stub and demands a positive verdict.
       *
       * Real-browser evidence, `XiaoMi/MiuiBrowser/20.28.1020918` on Android 16:
       *   isTypeSupported('video/mp4')             -> false
       *   canPlayType('…"avc1.42E01E"')            -> "probably"
       *   sourceopen + addSourceBuffer(avc1…)      -> both succeed
       */
      const survivesStub = await cdp.eval<boolean>(
        'window.__wsScrcpy5?.mseSupportedWithStubbedIsTypeSupported?.() ?? false',
      );
      check(
        'MSE is still detected when isTypeSupported is a stub that denies everything (MIUI)',
        survivesStub === true,
        survivesStub,
      );
    } else {
      check('a server-muxed init segment is exposed for verification', false);
    }

    /*
     * The worker is created lazily, on the first session start — loading it on
     * page load would waste ~180 KB of WASM for visitors who never start a
     * mirror. So the assertion here is the opposite one: nothing was fetched
     * yet, and the bundle is nonetheless served correctly for when it is.
     */
    const workerRequestedEarly = await cdp.eval<boolean>(
      'performance.getEntriesByType("resource").some(r => r.name.includes("decoder.worker.js"))',
    );
    check('worker is not fetched before a session starts (lazy)', workerRequestedEarly === false);

    const workerStatus = await fetch(`http://${lan}:${PORT}/decoder.worker.js`);
    check('decoder.worker.js is served', workerStatus.ok);
    check(
      'decoder.worker.js has a script mime type',
      (workerStatus.headers.get('content-type') ?? '').includes('javascript'),
      workerStatus.headers.get('content-type'),
    );

    /*
     * With MSE available there is nothing to warn about: the picture is
     * hardware-decoded on plain http, so the banner must stay hidden. (The
     * software fallback's own note is asserted further down, via the decoder
     * kind, which is what actually selects it.)
     */
    const noBlockingWarning = await cdp.eval<boolean>(
      '!document.getElementById("envWarning").textContent.includes("无法解码")',
    );
    check('no "cannot decode" warning is shown', noBlockingWarning === true);

    const bannerHidden = await cdp.eval<boolean>(
      'document.getElementById("envWarning").classList.contains("hidden")',
    );
    check('no environment warning is shown when hardware decoding is available', bannerHidden === true);

    /*
     * Even though MSE wins on this origin, the WASM fallback must still build
     * and boot: it is what covers a browser without MSE. Constructing the
     * worker runs the real bundle through the browser's parser and compiles the
     * inlined WASM, so a bad build (external .wasm request, syntax error, CSP
     * rejection) fails here rather than on a family member's phone.
     */
    const workerOutcome = await cdp.eval<string>(`
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 15000);
        try {
          const worker = new Worker('./decoder.worker.js');
          worker.addEventListener('message', (e) => {
            if (e.data && e.data.type === 'decoderReady') {
              clearTimeout(timer);
              worker.terminate();
              resolve('ready');
            }
          });
          worker.addEventListener('error', (e) => {
            clearTimeout(timer);
            resolve('error: ' + (e.message || 'unknown'));
          });
        } catch (err) {
          clearTimeout(timer);
          resolve('throw: ' + err.message);
        }
      })
    `);
    check('wasm decoder boots in the browser over plain http', workerOutcome === 'ready', workerOutcome);

    /*
     * Second page, on `localhost`. The section above covers the non-secure
     * origin, where WebCodecs is withheld — the hard case. This covers the one
     * the 解码方式 dropdown was added for: a secure page (https / localhost)
     * where all three decoders exist and the user picks by hand. Without it, a
     * regression that broke the *unlocked* codec field or the secure-context
     * auto choice would ship unnoticed, because the LAN page cannot see either.
     */
    const securePage = await fetch(`http://${hostPort}/json/new?${encodeURIComponent(`http://localhost:${PORT}/`)}`, {
      method: 'PUT',
    })
      .then((r) => r.json() as Promise<CdpTarget>)
      .catch(() => undefined);

    if (securePage?.webSocketDebuggerUrl) {
      const sec = await Cdp.attach(securePage.webSocketDebuggerUrl);
      await sec.send('Runtime.enable');
      await sec.send('Page.enable');
      await sleep(1500);

      check('the localhost page is a secure context', (await sec.eval<boolean>('window.isSecureContext')) === true);

      const secureAvail = await sec.eval<Record<string, boolean>>(
        'window.__wsScrcpy5?.decoderAvailability?.() ?? {}',
      );
      check('WebCodecs is available on a secure origin', secureAvail.webcodecs === true, secureAvail);

      const secureAuto = await sec.eval<string>('window.__wsScrcpy5?.decoderKind?.() ?? "none"');
      check('auto picks WebCodecs on a secure origin', secureAuto === 'webcodecs', secureAuto);

      const secureOptions = await sec.eval<boolean>(
        `Array.from(document.getElementById('decoderKind').options).every(o => !o.disabled)`,
      );
      check('no decoder option is disabled on a secure origin', secureOptions === true);

      // The codec control is gone here too — on https it used to be the one
      // place H.265/AV1 was reachable, so this is where a leftover would hide.
      check(
        'the codec control is gone on a secure origin too',
        (await sec.eval<boolean>("document.getElementById('videoCodec') === null")) === true,
      );

      sec.close();
    } else {
      check('opened a second page on localhost', false);
    }

    cdp.close();
    browser.kill();
  } finally {
    server.kill();
  }
}

void main()
  .catch((e) => {
    failures++;
    console.log(`FAIL  unexpected error -> ${(e as Error).message}`);
  })
  .then(() => {
    console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
  });
