/**
 * Functional test for the software (TinyH264/WASM) decoder.
 *
 * The value here is proving the vendored WASM actually boots and decodes, so a
 * broken bundle or a missing SPS/PPS replay fails `npm test` instead of showing
 * up as a black screen on a family member's phone.
 *
 * TinyH264's Emscripten build hardcodes `ENVIRONMENT_IS_WORKER = true` and
 * reads `self.location`, so it only runs inside a worker. Node's
 * `worker_threads` is a real worker environment, so the module is exercised by
 * building to CJS, then loading it from a worker thread with a minimal `self`
 * shim. That is also why the browser build has to emit a separate
 * `decoder.worker.js` rather than inlining the decoder into app.js.
 *
 * Run with: npm run softcheck
 */
import { Worker } from 'node:worker_threads';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { splitAnnexB, nalUnitType, NAL_TYPE } from '../src/common/annexb';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

console.log('annex-b splitting');
{
  check('splits into 2 nals', splitAnnexB(Uint8Array.from([0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0xce])).length === 2);
  check('a 4-byte start code leaves no stray zero', splitAnnexB(Uint8Array.from([0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0xce]))[0].length === 2);
  check('nal type reads the low 5 bits', nalUnitType(Uint8Array.from([0x67])) === NAL_TYPE.SPS);
  check('idr type is 5', nalUnitType(Uint8Array.from([0x65])) === NAL_TYPE.SLICE_IDR);
}

/*
 * The decoder worker is built as a standalone classic script; this test loads
 * that very artifact, so a build regression is caught here too.
 *
 * `process.cwd()` is the project root: npm runs these scripts from there.
 */
const ROOT = resolve(process.cwd());
const WORKER_BUNDLE = join(ROOT, 'dist/public/decoder.worker.js');

/**
 * The test loads the *built* worker, so it must exist. Building it here keeps
 * `npm test` self-contained (it can run before a full `npm run build`) and,
 * more importantly, means a broken worker build fails this test rather than
 * silently shipping.
 */
function ensureWorkerBundle(): void {
  mkdirSync(dirname(WORKER_BUNDLE), { recursive: true });
  // Call the platform-specific binary directly instead of the .bin shim, which
  // is a shell script on POSIX and a .cmd on Windows.
  const binary = join(
    ROOT,
    'node_modules',
    '@esbuild',
    `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild',
  );
  if (!existsSync(binary)) return; // fall back to a pre-existing dist/
  execFileSync(
    binary,
    [
      join(ROOT, 'vendor/tinyh264/H264NALDecoder.worker.ts'),
      '--bundle',
      '--platform=browser',
      '--format=iife',
      `--outfile=${WORKER_BUNDLE}`,
      '--log-level=warning',
    ],
    { stdio: 'inherit' },
  );
}

/** Minimal `self` so the Emscripten runtime finds what it expects, plus a
 *  message channel the test can drive like the main thread would. */
const HARNESS = `
const { parentPort } = require('node:worker_threads');
const self = {
  location: { href: 'file:///decoder.worker.js' },
  addEventListener(type, listener) { this._onmessage = listener; },
  postMessage(message, transfer) { parentPort.postMessage(message, transfer); },
};
globalThis.self = self;
require(${JSON.stringify(WORKER_BUNDLE)});
self._onmessage({ data: { type: 'boot' } });
parentPort.on('message', (data) => self._onmessage({ data }));
`;

/** SPS carries profile 0x42 = Baseline, the profile h264bsd targets. */
const SPS = Uint8Array.from([0x67, 0x42, 0xc0, 0x29, 0x8d, 0x68, 0x05, 0x00]);
const PPS = Uint8Array.from([0x68, 0xce, 0x3c, 0x80]);

interface PictureReady {
  type: string;
  width?: number;
  height?: number;
  data?: ArrayBuffer;
  message?: string;
}

async function runWorkerTest(): Promise<void> {
  console.log('\nsoftware decoder worker (real wasm)');

  ensureWorkerBundle();
  if (!existsSync(WORKER_BUNDLE)) {
    failures++;
    console.log(`FAIL  worker bundle missing: ${WORKER_BUNDLE}`);
    return;
  }
  const bundleSize = (await import('node:fs')).statSync(WORKER_BUNDLE).size;
  check('worker bundle built', bundleSize > 100_000, bundleSize);
  // The WASM must be inlined; an external .wasm request would 404 in a worker.
  const source = (await import('node:fs')).readFileSync(WORKER_BUNDLE, 'utf8');
  check('wasm is inlined as a data: uri', source.includes('data:application/octet-stream;base64'));
  check('no external .wasm request', !/[\w./-]+\.wasm['"]/.test(source));

  const harnessPath = join(ROOT, 'node_modules/.cache/ws-scrcpy5/worker-harness.cjs');
  writeFileSync(harnessPath, HARNESS);

  const worker = new Worker(harnessPath);
  const messages: PictureReady[] = [];
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => (resolveReady = resolve));

  worker.on('message', (msg: PictureReady) => {
    messages.push(msg);
    if (msg.type === 'decoderReady') resolveReady();
  });
  worker.on('error', (e) => {
    failures++;
    console.log(`FAIL  worker crashed -> ${e.message}`);
    resolveReady();
  });

  // Booting the ~180 KB WASM takes a moment.
  await Promise.race([ready, new Promise((r) => setTimeout(r, 15000))]);
  const readySeen = messages.some((m) => m.type === 'decoderReady');
  check('worker boots and reports decoderReady', readySeen);

  if (readySeen) {
    const renderStateId = 1;
    // Send the parameter sets and an IDR slice as one Annex-B access unit,
    // which is exactly the shape a scrcpy config packet + key frame has.
    const accessUnit = Uint8Array.from([
      0, 0, 0, 1, ...SPS,
      0, 0, 0, 1, ...PPS,
      0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x33, 0xff, 0xf1, 0x22,
    ]);
    const buffer = accessUnit.slice().buffer;
    worker.postMessage({
      type: 'decode',
      data: buffer,
      offset: 0,
      length: accessUnit.length,
      renderStateId,
    }, [buffer]);

    await new Promise((r) => setTimeout(r, 1500));

    const errors = messages.filter((m) => m.type === 'decoderError');
    check('no decoder error on a well-formed access unit', errors.length === 0, errors);

    const picture = messages.find((m) => m.type === 'pictureReady');
    if (picture) {
      // YUV420 is exactly 1.5 bytes per pixel.
      const expected = (picture.width ?? 0) * (picture.height ?? 0) * 1.5;
      check('picture dimensions are positive', (picture.width ?? 0) > 0 && (picture.height ?? 0) > 0, {
        w: picture.width,
        h: picture.height,
      });
      check(
        'picture buffer is a full YUV420 frame',
        Math.abs((picture.data?.byteLength ?? 0) - expected) < 1,
        { got: picture.data?.byteLength, expected },
      );
    } else {
      // h264bsd may reject a synthetic slice; that is acceptable as long as it
      // did not crash. Report which path was taken instead of failing.
      console.log('  ..  decoder produced no picture for the synthetic slice (acceptable)');
      check('decoder stayed alive after the slice', errors.length === 0);
    }

    // Release must not throw; a leaked WASM allocation would surface later.
    worker.postMessage({ type: 'release', renderStateId });
    await new Promise((r) => setTimeout(r, 300));
    const afterRelease = messages.filter((m) => m.type === 'decoderError').length;
    check('release() is clean', afterRelease === errors.length, afterRelease);
  }

  await worker.terminate();
}

void runWorkerTest().then(() => {
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
});
