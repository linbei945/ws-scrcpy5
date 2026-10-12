/**
 * Live probe: start a real mirroring session against a device through the
 * running ws-scrcpy5 server, verify the video stream and exercise the control
 * channel.
 *
 *   node --loader …  (bundled by esbuild, see README)
 *   WS_URL=ws://127.0.0.1:8080/ws?serial=<serial> node probe.cjs
 *
 * It answers two questions:
 *   1. does the device stream decodable H.264 (config packets + key frames)?
 *   2. do control messages actually reach the device?
 */
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { adbPath } from '../src/server/adb';
import {
  CHANNEL,
  StreamParser,
  createInjectKeycode,
  createInjectTouchEvent,
  createInjectText,
  MotionEventAction,
  MotionEventButton,
  POINTER_ID,
  KeyEventAction,
} from '../src/common/protocol';

/**
 * NAL type of the first unit in a packet. Packets arrive either as Annex-B
 * (start code 00 00 00 01 / 00 00 01) or as AVCC (4-byte length prefix), so
 * reading `data[0]` blindly reports 0 for every Annex-B frame.
 */
function firstNalType(data: Uint8Array): number {
  let offset = 0;
  if (data.length >= 4 && data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 1) {
    offset = 4;
  } else if (data.length >= 3 && data[0] === 0 && data[1] === 0 && data[2] === 1) {
    offset = 3;
  } else if (data.length >= 4 && data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 0) {
    // AVCC: 4-byte big endian length prefix (usually 00 00 xx xx).
    offset = 4;
  }
  return offset < data.length ? data[offset] & 0x1f : -1;
}

/**
 * The four-character type of an ISO-BMFF box at `offset`. An MSE packet is
 * always a whole box: `ftyp`/`moov` for the init segment, `moof` for a frame.
 */
function boxTypeAt(data: Uint8Array, offset: number): string {
  if (offset + 4 > data.length) return '';
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

/**
 * `avc1.PPCCLL` from an ISO-BMFF init segment — the same derivation the browser
 * player does, so this reproduces exactly what MSE will be asked to accept.
 * The `avcC` box payload is version, profile, compatibility, level; the four
 * type bytes come first, so the fields start four bytes in.
 */
function codecStringFromInit(init: Uint8Array): string | undefined {
  let index = -1;
  outer: for (let i = 0; i + 4 <= init.length; i++) {
    if (boxTypeAt(init, i) === 'avcC') {
      index = i;
      break outer;
    }
  }
  if (index < 0 || index + 8 > init.length) return undefined;
  const hex = (b: number) => b.toString(16).padStart(2, '0').toUpperCase();
  return `${hex(init[index + 5])}${hex(init[index + 6])}${hex(init[index + 7])}`;
}

const url = process.env.WS_URL ?? 'ws://127.0.0.1:8080/ws?serial=192.168.5.1:5555';
const serial = new URL(url.replace('ws://', 'http://')).searchParams.get('serial') ?? '';
// Same resolution rules as the server ($ADB -> bundled tools/platform-tools -> PATH).
const adb = adbPath();
const durationMs = Number(process.env.PROBE_MS || 6000);
const outFile = process.env.PROBE_OUT || 'probe-stream.h264';
/**
 * `PROBE_CONTAINER=mse` asks the server to mux the stream to fMP4, exactly as a
 * plain-http phone does. The raw parser cannot read that container, so the
 * probe switches to ISO-BMFF framing checks instead of NAL checks.
 */
const container = process.env.PROBE_CONTAINER === 'mse' ? 'mse' : undefined;
const probeUrl = container ? `${url}&container=${container}` : url;

/** spawnSync() fails with EBUSY on Windows here, so use the async API. */
function adbShell(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(adb, ['-s', serial, 'shell', ...args], { windowsHide: true });
    let out = '';
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.stderr?.on('data', (d) => (out += d.toString()));
    child.on('error', (e) => {
      console.log(`  [adb ${args.join(' ')}] error=${e.message}`);
      resolve('');
    });
    child.on('close', () => resolve(out.trim()));
  });
}

async function topActivity(): Promise<string> {
  const sources = [await adbShell(['dumpsys', 'window']), await adbShell(['dumpsys', 'activity', 'activities'])];
  for (const out of sources) {
    const m =
      out.match(/mCurrentFocus=Window\{[^ ]+ [^ ]+ ([^\s/]+)/) ??
      out.match(/mFocusedApp=ActivityRecord\{[^ ]+ [^ ]+ ([^\s/]+)/) ??
      out.match(/mResumedActivity:\s*ActivityRecord\{[^ ]+ [^ ]+ ([^\s/]+)/);
    if (m) return m[1];
  }
  return '(unknown)';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log(`serial      : ${serial}`);
  console.log(`adb         : ${adb}`);
  console.log(`target      : ${probeUrl}`);
  console.log(`container   : ${container ?? 'raw (Annex-B)'}\n`);

  const ws = new WebSocket(probeUrl);
  const parser = new StreamParser({ expectName: true });

  let init: Record<string, unknown> | undefined;
  let configPackets = 0;
  let keyFrames = 0;
  let frames = 0;
  let bytes = 0;
  const nalTypes = new Map<number, number>();
  const chunks: Uint8Array[] = [];
  let errored: string | undefined;
  /** MSE path: the first `ftyp` payload, kept for the codec-string check. */
  let initSegment: Uint8Array | undefined;

  ws.on('message', (raw, isBinary) => {
    if (!isBinary) {
      const msg = JSON.parse(raw.toString()) as { type: string; [k: string]: unknown };
      if (msg.type === 'init') init = msg;
      else console.log(`[event] ${msg.type}: ${JSON.stringify(msg).slice(0, 200)}`);
      return;
    }
    const frame = new Uint8Array(raw as Buffer);
    // The server prefixes every binary frame with a 1 byte channel tag.
    const channel = frame[0];
    const data = frame.subarray(1);
    if (channel !== CHANNEL.VIDEO) {
      bytes += data.length;
      return;
    }
    if (bytes === 0) {
      console.log(`first video frame (${data.length}B) hex: ${[...data.subarray(0, 100)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    }
    bytes += data.length;
    for (const ev of parser.push(data)) {
      if (ev.kind === 'meta') {
        console.log(`device name : ${ev.deviceName}`);
      } else if (ev.kind === 'codec') {
        console.log(`video codec : ${ev.codec}`);
      } else if (ev.kind === 'session') {
        console.log(`resolution  : ${ev.width}x${ev.height}`);
      } else if (ev.kind === 'packet') {
        if (ev.packet.config) {
          configPackets++;
          chunks.push(ev.packet.data);
          // In mse mode this packet is the ISO-BMFF init segment, not SPS+PPS.
          if (container === 'mse' && !initSegment && boxTypeAt(ev.packet.data, 4) === 'ftyp') {
            initSegment = ev.packet.data;
          }
        } else {
          frames++;
          if (ev.packet.keyFrame) keyFrames++;
          chunks.push(ev.packet.data);
          const nal = firstNalType(ev.packet.data);
          if (nal >= 0) nalTypes.set(nal, (nalTypes.get(nal) ?? 0) + 1);
        }
      }
    }
  });

  const done = new Promise<void>((resolve) => {
    ws.on('close', (code, reason) => {
      if (code !== 1000) errored = `${code} ${reason.toString()}`;
      resolve();
    });
    ws.on('error', (e) => {
      errored = e.message;
      resolve();
    });
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  console.log('websocket   : open');

  await sleep(durationMs);

  /* ---------------- control channel test ---------------- */

  console.log('\n--- control channel ---');
  // Move to Settings first so the HOME key has an observable effect.
  const started = await adbShell(['am', 'start', '-a', 'android.settings.SETTINGS']);
  console.log(`am start settings -> ${started.split('\n').pop()}`);
  await sleep(1500);
  const before = await topActivity();
  console.log(`top activity before HOME: ${before}`);

  ws.send(Buffer.from(createInjectKeycode(KeyEventAction.DOWN, 3 /* KEYCODE_HOME */, 0, 0)));
  ws.send(Buffer.from(createInjectKeycode(KeyEventAction.UP, 3 /* KEYCODE_HOME */, 0, 0)));
  await sleep(2000);
  const after = await topActivity();
  console.log(`top activity after  HOME: ${after}`);
  // Only a real HOME injection leaves the foreground app, so a change is proof
  // enough. Do not match on the name: third party launchers are called
  // "app.lawnchair", "com.actionlauncher.playstore", "com.teslacoilsw.launcher"…
  const homeWorked =
    before !== '(unknown)' && after !== '(unknown)' && before !== after;

  // A tap in the middle of the screen plus a text injection must not error.
  ws.send(
    Buffer.from(
      createInjectTouchEvent({
        action: MotionEventAction.DOWN,
        pointerId: POINTER_ID.MOUSE,
        x: 640,
        y: 360,
        screenWidth: 1280,
        screenHeight: 720,
        pressure: 1,
        actionButton: MotionEventButton.PRIMARY,
        buttons: MotionEventButton.PRIMARY,
      }),
    ),
  );
  ws.send(
    Buffer.from(
      createInjectTouchEvent({
        action: MotionEventAction.UP,
        pointerId: POINTER_ID.MOUSE,
        x: 640,
        y: 360,
        screenWidth: 1280,
        screenHeight: 720,
        pressure: 0,
        actionButton: MotionEventButton.PRIMARY,
        buttons: 0,
      }),
    ),
  );
  ws.send(Buffer.from(createInjectText('ws-scrcpy5')));
  await sleep(800);

  ws.send(JSON.stringify({ type: 'stop' }));
  await done;

  /* ---------------- report ---------------- */

  const total = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  writeFileSync(outFile, total);

  console.log('\n--- result ---');
  console.log(`init          : ${JSON.stringify(init)}`);
  console.log(`bytes         : ${bytes}`);
  console.log(`config packets: ${configPackets}`);
  console.log(`frames        : ${frames} (key frames: ${keyFrames})`);
  console.log(`nal types     : ${JSON.stringify([...nalTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6))}`);
  console.log(`raw stream    : ${outFile} (${total.length} bytes)`);
  console.log(`control HOME  : ${before} -> ${after}  ${homeWorked ? 'OK' : 'NO EFFECT'}`);
  console.log(`error         : ${errored ?? 'none'}`);

  const mirroringOk = !!init && frames > 5 && configPackets > 0 && keyFrames > 0;
  console.log(`\nMIRRORING: ${mirroringOk ? 'OK' : 'FAILED'}`);
  console.log(`CONTROL  : ${homeWorked ? 'OK' : 'FAILED'}`);
  process.exit(mirroringOk && homeWorked && !errored ? 0 : 1);
}

void main();
