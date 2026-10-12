/**
 * Proves control actually reaches the phone, not just the browser.
 *
 * `verify-control.mjs` shows a click reaching the canvas listener. This goes one
 * step further and looks at the device itself: it opens Settings (a static list,
 * so the picture does not change on its own), takes a screenshot, clicks the
 * middle of the picture *through the web page*, and checks that the device
 * screen really changed.
 *
 * A control screenshot pair is taken first: if the picture moves with no click at
 * all, "changed after the click" would prove nothing.
 *
 * Run: node tools/verify-device-control.mjs <origin> <serial>
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const ORIGIN = process.argv[2] || 'http://192.168.5.188:8080/';
const SERIAL = process.argv[3] || '192.168.5.20:5555';
const ADB = join(ROOT, 'adb', 'adb.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
};

function adb(args) {
  try {
    return execFileSync(ADB, ['-s', SERIAL, ...args], { timeout: 20000 }).toString('utf8');
  } catch (e) {
    return `ERROR: ${String(e.message).split('\n')[0]}`;
  }
}

function screenshot() {
  return execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], {
    timeout: 20000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/*
 * PNG size is a cheap proxy for "the picture changed". A static screen still
 * drifts by a few bytes — the clock in the status bar — while opening a new page
 * moves it by thousands, so compare the *proportion* rather than exact equality.
 */
const drift = (a, b) => Math.abs(a.length - b.length) / Math.max(1, a.length);
const changed = (a, b) => drift(a, b) > 0.02;
const steady = (a, b) => drift(a, b) < 0.01;

console.log(`device control verification\n  origin: ${ORIGIN}\n  device: ${SERIAL}`);

console.log(`  ..  ${adb(['connect', SERIAL]).trim()}`);
await sleep(1000);

// Settings is a static list: nothing animates, so the screen only changes when
// the device actually received the tap.
// Force-stop first, otherwise the intent is delivered to whatever Settings
// sub-page is already open and the screen is not where this test assumes.
adb(['shell', 'am', 'force-stop', 'com.android.settings']);
await sleep(1200);
adb(['shell', 'am', 'start', '-a', 'android.settings.SETTINGS']);
await sleep(4000);

const baseline = screenshot();
await sleep(2500);
const baseline2 = screenshot();
console.log(`  ..  baseline ${baseline.length}B, control ${baseline2.length}B`);
check('the Settings screen is static on its own (control pair)', steady(baseline, baseline2), {
  baseline: baseline.length,
  control: baseline2.length,
});

/* ---------------- browser side ---------------- */

function findBrowser() {
  return [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean).find((p) => existsSync(p));
}

class Cdp {
  constructor(ws) {
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id === undefined) return;
      const done = this.pending.get(m.id);
      if (done) {
        this.pending.delete(m.id);
        done(m.result);
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
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r?.result?.value;
  }
}

const browserPath = findBrowser();
if (!browserPath) {
  console.log('  ..  no Chrome/Edge, skipping');
  process.exit(0);
}

const profile = join(ROOT, 'node_modules/.cache/ws-scrcpy5/chrome-profile-effect');
mkdirSync(profile, { recursive: true });
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--no-proxy-server', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderr = '';
browser.stderr.on('data', (d) => (stderr += String(d)));
let devtools;
for (let i = 0; i < 100 && !devtools; i++) {
  const m = /ws:\/\/[^\s]+/.exec(stderr);
  if (m) devtools = m[0];
  else await sleep(200);
}
if (!devtools) {
  console.log('FAIL  no devtools endpoint');
  browser.kill();
  process.exit(1);
}
const hostPort = new URL(devtools).host;
const target = await fetch(`http://${hostPort}/json/new?${encodeURIComponent(ORIGIN)}`, { method: 'PUT' })
  .then((r) => r.json()).catch(() => undefined);
if (!target?.webSocketDebuggerUrl) {
  console.log('FAIL  no page target');
  browser.kill();
  process.exit(1);
}

const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await sleep(2000);

try {
  await cdp.eval(`
    (function () {
      var el = document.getElementById('deviceInput');
      el.value = ${JSON.stringify(SERIAL)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(400);
  await cdp.eval('document.getElementById("connectBtn").click()');
  await sleep(3000);
  await cdp.eval('document.getElementById("startBtn").click()');
  await sleep(12000);

  const status = await cdp.eval('(document.getElementById("status")||{}).textContent||""');
  check('session is connected', /已连接/.test(status), status);

  /*
   * BACK rather than a tap: navigating back is always a large, unambiguous
   * change from any page, whereas tapping whatever sits in the middle of the
   * picture may legitimately land on nothing.
   *
   * `BrowserBack` maps to Android KEYCODE_BACK (see src/common/keys.ts).
   */
  const sendKey = (type) =>
    cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'BrowserBack',
      code: 'BrowserBack',
      windowsVirtualKeyCode: 166,
      nativeVirtualKeyCode: 166,
    });
  await sendKey('keyDown');
  await sleep(150);
  await sendKey('keyUp');
  await sleep(2500);

  const after = screenshot();
  console.log(`  ..  after BACK ${after.length}B`);
  check(
    'BACK through the browser changed the device screen (control really reaches the phone)',
    changed(baseline, after),
    { baseline: baseline.length, after: after.length, drift: `${(drift(baseline, after) * 100).toFixed(1)}%` },
  );
} finally {
  browser.kill();
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
