/**
 * End-to-end check for the "mirrors but cannot be controlled" fix.
 *
 * Drives a real browser over CDP against the LAN address (a non-secure origin,
 * so the page takes the MSE path), starts a session on a real device and then
 * asserts the two things that were broken:
 *
 *   1. `#screen` has the device resolution, not its markup size of 1x1 — that
 *      is the bug: every pointer event is bound to this canvas;
 *   2. a dispatched mouse click actually reaches the canvas listener.
 *
 * Run: npm run verify:control -- <origin> <serial>
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const ORIGIN = process.argv[2] || 'http://192.168.5.188:8080/';
const SERIAL = process.argv[3] || '192.168.5.20:5555';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

class Cdp {
  constructor(ws) {
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id === undefined) return;
      const done = this.pending.get(msg.id);
      if (done) {
        this.pending.delete(msg.id);
        done(msg.result);
      }
    });
    this.ws = ws;
  }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => this.pending.set(id, res));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r?.result?.value;
  }
}

const browserPath = findBrowser();
if (!browserPath) {
  console.log('  ..  no Chrome/Edge found, cannot verify');
  process.exit(0);
}

const profile = join(ROOT, 'node_modules/.cache/ws-scrcpy5/chrome-profile-verify');
mkdirSync(profile, { recursive: true });

console.log(`mse control verification\n  origin: ${ORIGIN}\n  device: ${SERIAL}`);

const browser = spawn(
  browserPath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

let stderr = '';
browser.stderr.on('data', (d) => (stderr += String(d)));
browser.stdout?.on('data', (d) => (stderr += String(d)));

let devtools;
for (let i = 0; i < 100 && !devtools; i++) {
  const m = /ws:\/\/[^\s]+/.exec(stderr);
  if (m) devtools = m[0];
  else await sleep(200);
}
if (!devtools) {
  console.log('FAIL  no devtools endpoint', stderr.slice(0, 200));
  browser.kill();
  process.exit(1);
}

const hostPort = new URL(devtools).host;
const target = await fetch(`http://${hostPort}/json/new?${encodeURIComponent(ORIGIN)}`, {
  method: 'PUT',
})
  .then((r) => r.json())
  .catch(() => undefined);

if (!target?.webSocketDebuggerUrl) {
  console.log('FAIL  could not open a page target');
  browser.kill();
  process.exit(1);
}

const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await sleep(2000);

try {
  const secure = await cdp.eval('window.isSecureContext');
  const hasWebCodecs = await cdp.eval('typeof window.VideoDecoder === "function"');
  check('origin is non-secure (so MSE is the path under test)', secure === false, { secure });
  check('WebCodecs is withheld here', hasWebCodecs === false, { hasWebCodecs });

  await cdp.eval(`
    (function () {
      var el = document.getElementById('deviceInput');
      el.value = ${JSON.stringify(SERIAL)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      window.__hits = 0;
      document.getElementById('screen').addEventListener('pointerdown', function () { window.__hits++; });
      return el.value;
    })()
  `);
  await sleep(400);
  const btnEnabled = await cdp.eval('!document.getElementById("connectBtn").disabled');
  check('connect button enabled after entering the serial', btnEnabled === true);

  await cdp.eval('document.getElementById("connectBtn").click()');
  await sleep(3000);

  await cdp.eval('document.getElementById("startBtn").click()');

  // The server pushes the jar, starts scrcpy-server and opens the tunnels.
  await sleep(12000);

  const state = await cdp.eval(`
    (function () {
      var c = document.getElementById('screen');
      var r = c.getBoundingClientRect();
      var v = document.querySelector('.mse-video');
      return {
        canvasW: c.width,
        canvasH: c.height,
        rectW: Math.round(r.width),
        rectH: Math.round(r.height),
        hasMseVideo: !!v,
        videoW: v ? v.videoWidth : 0,
        videoH: v ? v.videoHeight : 0,
        decoder: (function () { var s = document.getElementById('decoderKind'); return s ? s.value : ''; })(),
        status: (document.getElementById('status') || {}).textContent || '',
        log: ((document.getElementById('log') || {}).textContent || '').slice(-400)
      };
    })()
  `);

  console.log('  ..  ' + JSON.stringify(state));

  check('session really uses the MSE player', state.hasMseVideo === true, state.decoder);
  check('video is decoding', state.videoW > 0, { videoW: state.videoW, videoH: state.videoH });
  check(
    'canvas has the device resolution (the fix)',
    state.canvasW > 1 && state.canvasH > 1,
    { canvasW: state.canvasW, canvasH: state.canvasH },
  );
  check(
    'canvas rendered box is not 1x1 either',
    state.rectW > 1 && state.rectH > 1,
    { rectW: state.rectW, rectH: state.rectH },
  );

  const box = await cdp.eval(`
    (function () {
      var r = document.getElementById('screen').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()
  `);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  });
  await sleep(500);
  const hits = await cdp.eval('window.__hits');
  check('a click on the picture reaches the canvas listener', hits >= 1, { hits });
} finally {
  browser.kill();
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
