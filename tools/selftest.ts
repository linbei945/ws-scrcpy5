/**
 * Self test for the scrcpy 5.0.1 protocol codec used by WS-scrcpy5.
 *
 * Run with: npm test
 */
import {
  CHANNEL,
  StreamParser,
  DeviceMessageParser,
  DeviceMessageType,
  createInjectKeycode,
  createInjectScrollEvent,
  createInjectText,
  createInjectTouchEvent,
  createSetClipboard,
  encodeCodecEvent,
  encodeConfigPacket,
  encodeDeviceName,
  encodeMediaPacket,
  encodeSessionMeta,
  codecIdToName,
  concat,
  DEVICE_NAME_FIELD_LENGTH,
  PACKET_HEADER_SIZE,
  closeReason,
} from '../src/common/protocol';
import { ScrcpySession } from '../src/server/session';
import * as adb from '../src/server/adb';
import * as registry from '../src/server/registry';
import * as upload from '../src/server/upload';
import * as fs from '../src/server/fs';
import * as util from '../src/server/util';
import { splitAnnexB, DECODER_LABELS } from '../src/app/video';

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

/** Folds the protocol's two-arg `concat` over any number of chunks. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  return parts.reduce((acc, part) => concat(acc, part), new Uint8Array(0));
}

console.log('control messages');
{
  const keycode = createInjectKeycode(0 /* DOWN */, 4 /* BACK */, 0, 0);
  check('inject keycode layout', keycode.length === 14 && hex(keycode) === '00 00 00 00 00 04 00 00 00 00 00 00 00 00', hex(keycode));

  const text = createInjectText('A');
  check('inject text layout', text.length === 6 && hex(text) === '01 00 00 00 01 41', hex(text));

  const touch = createInjectTouchEvent({
    action: 0,
    pointerId: -1n,
    x: 100,
    y: 200,
    screenWidth: 1080,
    screenHeight: 2400,
    pressure: 1,
    actionButton: 1,
    buttons: 1,
  });
  check('inject touch size', touch.length === 32, touch.length);
  check('inject touch type/action', touch[0] === 2 && touch[1] === 0);
  check('inject touch pointer id', hex(touch.subarray(2, 10)) === 'ff ff ff ff ff ff ff ff');
  check('inject touch position', hex(touch.subarray(10, 22)) === '00 00 00 64 00 00 00 c8 04 38 09 60');
  check('inject touch pressure fp', hex(touch.subarray(22, 24)) === 'ff ff');
  check('inject touch buttons', hex(touch.subarray(24, 32)) === '00 00 00 01 00 00 00 01');

  const scroll = createInjectScrollEvent({
    x: 10,
    y: 20,
    screenWidth: 1080,
    screenHeight: 2400,
    hscroll: 0,
    vscroll: -1,
    buttons: 0,
  });
  check('inject scroll size', scroll.length === 21, scroll.length);
  check('inject scroll vscroll fp', hex(scroll.subarray(15, 17)) === 'f8 00', hex(scroll));

  const clipboard = createSetClipboard(1n, 'hi', true);
  check(
    'set clipboard layout',
    clipboard.length === 16 && hex(clipboard) === '09 00 00 00 00 00 00 00 01 01 00 00 00 02 68 69',
    hex(clipboard),
  );
}

console.log('stream parser');
{
  const parser = new StreamParser({ expectName: true });
  const name = new Uint8Array(DEVICE_NAME_FIELD_LENGTH);
  const encoder = new TextEncoder();
  name.set(encoder.encode('Pixel'), 0);

  const meta = new Uint8Array(12);
  const metaView = new DataView(meta.buffer);
  metaView.setUint32(0, 0x80000000, false);
  metaView.setUint32(4, 1080, false);
  metaView.setUint32(8, 2400, false);

  const header = new Uint8Array(12);
  const headerView = new DataView(header.buffer);
  headerView.setBigUint64(0, (1n << 62n) | (1n << 61n), false); // config + keyframe
  headerView.setUint32(8, 3, false);
  const payload = new Uint8Array([1, 2, 3]);

  const stream = new Uint8Array(name.length + 4 + meta.length + header.length + payload.length);
  let offset = 0;
  stream.set(name, offset);
  offset += name.length;
  new DataView(stream.buffer).setUint32(offset, 0x68323634, false); // h264
  offset += 4;
  stream.set(meta, offset);
  offset += meta.length;
  stream.set(header, offset);
  offset += header.length;
  stream.set(payload, offset);

  const events = parser.push(stream);
  check('parsed 4 events', events.length === 4, events.map((e) => e.kind));
  check('device name', events[0].kind === 'meta' && events[0].deviceName === 'Pixel', events[0]);
  check('codec is h264', events[1].kind === 'codec' && events[1].codec === 'h264', events[1]);
  check(
    'session meta',
    events[2].kind === 'session' && events[2].width === 1080 && events[2].height === 2400,
    events[2],
  );
  check(
    'packet',
    events[3].kind === 'packet' &&
      events[3].packet.config &&
      events[3].packet.keyFrame &&
      events[3].packet.data.length === 3,
    events[3],
  );

  // A packet split across two chunks must still be parsed.
  const split = new StreamParser({ expectName: false });
  const withoutName = stream.subarray(name.length);
  const first = split.push(withoutName.subarray(0, 10)); // codec id + partial header
  check('partial chunk yields codec only', first.length === 1 && first[0].kind === 'codec', first);
  const rest = split.push(withoutName.subarray(10));
  check('remaining chunk completes the packet', rest.length === 2, rest.map((e) => e.kind));
}

console.log('device messages');
{
  const parser = new DeviceMessageParser();
  const msg = new Uint8Array(5 + 2);
  msg[0] = DeviceMessageType.CLIPBOARD;
  new DataView(msg.buffer).setUint32(1, 2, false);
  msg[5] = 0x68;
  msg[6] = 0x69;
  const parsed = parser.push(msg);
  check('clipboard message', parsed.length === 1 && parsed[0].type === 0 && parsed[0].text === 'hi', parsed);

  const splitParser = new DeviceMessageParser();
  check('partial clipboard', splitParser.push(msg.subarray(0, 3)).length === 0);
  check('rest of clipboard', splitParser.push(msg.subarray(3)).length === 1);
}

console.log('session header sniffing');
{
  const name = new Uint8Array(DEVICE_NAME_FIELD_LENGTH);
  name.set(new TextEncoder().encode('MockPhone'), 0);
  const meta = new Uint8Array(12);
  const metaView = new DataView(meta.buffer);
  metaView.setUint32(0, 0x80000000, false);
  metaView.setUint32(4, 720, false);
  metaView.setUint32(8, 1280, false);

  const codec = new Uint8Array(4);
  new DataView(codec.buffer).setUint32(0, 0x68323634, false);

  const tail = new Uint8Array([0xaa, 0xbb]);
  const chunk = new Uint8Array(1 + name.length + codec.length + meta.length + tail.length);
  chunk[0] = 0; // dummy byte written by the server
  let offset = 1;
  chunk.set(name, offset);
  offset += name.length;
  chunk.set(codec, offset);
  offset += codec.length;
  chunk.set(meta, offset);
  offset += meta.length;
  chunk.set(tail, offset);

  let init: unknown;
  let media: { channel: number; data: Uint8Array } | undefined;
  const session = new ScrcpySession(
    { serial: 'test' },
    {
      onInit: (info) => (init = info),
      onMedia: (channel, data) => (media = { channel, data }),
      onDeviceMessage: () => undefined,
      onLog: () => undefined,
      onClosed: () => undefined,
    },
  );
  (session as unknown as { onFirstSocketData(data: Uint8Array): void }).onFirstSocketData(chunk);

  const info = init as { deviceName: string; width: number; height: number } | undefined;
  check('init emitted', !!info);
  check('init device name', info?.deviceName === 'MockPhone', info);
  check('init size', info?.width === 720 && info?.height === 1280, info);
  check('media channel is video', media?.channel === CHANNEL.VIDEO, media?.channel);
  check('dummy byte stripped', media?.data.length === chunk.length - 1, media?.data.length);
  check('media starts with device name', media?.data[0] === 0x4d /* 'M' of MockPhone */, media?.data[0]);
}

console.log('\ndecoder labels');
{
  /*
   * The names are shown in two places — the 解码方式 dropdown and the log line
   * a session start writes — so they live in one table. This pins the rule the
   * user asked for: a hint is the name and nothing more. The old log lines
   * appended "（安全上下文）", "延迟最低" and, worst of all, "支持 H.264 / H.265 /
   * AV1" — which stayed on screen for a while after H.265/AV1 were removed.
   */
  const entries = Object.entries(DECODER_LABELS) as Array<[string, string]>;
  check('every decoder kind has a label', entries.length === 4, entries.map(([k]) => k));
  check(
    'labels are the identifier followed by the Chinese description',
    entries
      .filter(([kind]) => kind !== 'none')
      .every(([, label]) => /^[A-Za-z][\w.]*\s+\S*\p{Script=Han}$/u.test(label)),
    entries,
  );
  check(
    'no label carries a stale capability claim',
    entries.every(([, label]) => !/延迟|安全上下文|画质|H\.26|AV1|证书|http/.test(label)),
    entries.filter(([, label]) => /延迟|安全上下文|画质|H\.26|AV1|证书|http/.test(label)),
  );
  check(
    'the three decoder names are spelled as the UI shows them',
    DECODER_LABELS.webcodecs === 'WebCodecs 硬件解码' &&
      DECODER_LABELS.mse === 'MSE 硬件解码' &&
      DECODER_LABELS.software === 'WASM 软件解码',
    DECODER_LABELS,
  );
}

console.log('\nscrcpy server arguments');
{
  /*
   * The video codec is pinned, not negotiated. MSE and the WASM decoder cannot
   * read H.265/AV1 at all, and the codec dropdown is gone from the UI and the
   * wire protocol — so the only correct arg list is one that always says h264.
   *
   * `buildServerArgs` is private; reaching it through a cast matches how the
   * frame-parser tests above already work, and keeps the assertion on the real
   * method rather than a copy of its logic.
   */
  const argsFor = (options: Record<string, unknown>): string[] => {
    const s = new ScrcpySession({ serial: 'test', ...options }, {
      onInit: () => undefined,
      onMedia: () => undefined,
      onDeviceMessage: () => undefined,
      onLog: () => undefined,
      onClosed: () => undefined,
    });
    return (s as unknown as { buildServerArgs(): string[] }).buildServerArgs();
  };

  check('h264 is pinned in the scrcpy arguments', argsFor({}).includes('video_codec=h264'));
  check(
    'no other video codec can reach the jar',
    argsFor({}).every((a) => !/^video_codec=(?!h264)/.test(a)),
    argsFor({}).filter((a) => a.startsWith('video_codec=')),
  );
  // A legacy client that still sends `videoCodec=` must not be able to change
  // it. SessionOptions no longer has the field, so this documents that the
  // query parameter is genuinely ignored rather than merely unset.
  check(
    'a stray videoCodec option is ignored',
    argsFor({ videoCodec: 'h265' }).every((a) => !/^video_codec=(?!h264)/.test(a)),
    argsFor({ videoCodec: 'h265' }).filter((a) => a.startsWith('video_codec=')),
  );
  // The MSE path needs a tunnel like any other session; this guards against a
  // future edit that returns early and drops the base args entirely.
  check('the base arguments survive', argsFor({}).some((a) => a.startsWith('CLASSPATH=')));
}

console.log('\nannex-b splitting');
{
  const nalType = (n: Uint8Array) => n[0] & 0x1f;
  // Real config packet captured from a device: 4-byte codes, SPS then PPS.
  const config = Uint8Array.from([
    0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xc0, 0x29, 0x8d, 0x68, 0x05, 0x00,
    0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80,
  ]);
  const nals = splitAnnexB(config);
  check('config splits into 2 nals', nals.length === 2, nals.length);
  check('first nal is SPS (7)', nals[0] !== undefined && nalType(nals[0]) === 7, nals[0]?.[0]);
  check('second nal is PPS (8)', nals[1] !== undefined && nalType(nals[1]) === 8, nals[1]?.[0]);
  check('sps keeps its nal header byte', nals[0]?.[0] === 0x67, nals[0]?.[0]);

  const idr = Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00, 0x33, 0xff]);
  const idrNals = splitAnnexB(idr);
  check('4-byte code -> IDR nal', idrNals.length === 1 && nalType(idrNals[0]) === 5, idrNals[0]?.[0]);

  const three = Uint8Array.from([0x00, 0x00, 0x01, 0x65, 0x88, 0x84]);
  const threeNals = splitAnnexB(three);
  check('3-byte code -> IDR nal', threeNals.length === 1 && nalType(threeNals[0]) === 5, threeNals[0]?.[0]);

  const avcc = Uint8Array.from([0x00, 0x00, 0x00, 0x20, 0x65, 0x88]);
  check('avcc buffer is not annex-b', splitAnnexB(avcc).length === 0);

  const two = Uint8Array.from([
    0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x00, 0x00, 0x01, 0x68, 0xce,
  ]);
  const twoNals = splitAnnexB(two);
  check('no leftover start code bytes', twoNals.length === 2 && twoNals[0].length === 2 && twoNals[1].length === 2, twoNals.map((n) => n.length));
}

console.log('\nwebsocket close reason safety');
{
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  check('ascii passed through', closeReason('stopped') === 'stopped');
  // Regression: ws throws RangeError above 123 bytes and killed the server,
  // because slice(0, 100) counts code units and CJK chars are 3 bytes each.
  const long = 'adb executable not found. Install Android platform-tools and/or set $ADB.（请先在手机上开启「无线调试」，或用 adb tcpip 5555 打开端口）';
  const trimmed = closeReason(long);
  check('cjk error under the 123 byte limit', bytes(trimmed) <= 123, bytes(trimmed));
  check('cjk error still readable', trimmed.length > 60, trimmed.length);
  check('no replacement characters', !trimmed.includes('\ufffd'), trimmed);
  check('pure cjk truncated cleanly', !closeReason('测'.repeat(100)).includes('\ufffd'));
  check('cut exactly at a multibyte boundary', bytes(closeReason('测'.repeat(41))) <= 120);
}

console.log('\nadb wireless address detection');
{
  check('ipv4:port', adb.isNetworkAddress('192.168.5.1:5555'));
  check('hostname:port', adb.isNetworkAddress('localhost:5555'));
  check('mdns:port', adb.isNetworkAddress('pixel-7.local:37000'));
  check('usb serial is not a network address', !adb.isNetworkAddress('R58M12ABCDE'));
  check('emulator is not a network address', !adb.isNetworkAddress('emulator-5554'));
  check('port is required', !adb.isNetworkAddress('192.168.5.1'));
  check('port must be numeric', !adb.isNetworkAddress('192.168.5.1:http'));
  check('surrounding spaces are tolerated', adb.isNetworkAddress(' 10.0.0.2:5555 '));
}

console.log('\nadb path resolution');
{
  /*
   * The startup banner prints the adb it resolved and then `existsSync()`s it.
   * A bare `adb` — the normal case on Linux and inside the Docker image — is
   * not a path, so a working install was reported as "未找到".
   */
  const dir = mkdtempSync(join(tmpdir(), 'ws-scrcpy5-adb-'));
  const fake = join(dir, process.platform === 'win32' ? 'adb.exe' : 'adb');
  writeFileSync(fake, '');
  const savedPath = process.env.PATH;
  process.env.PATH = [dir, savedPath ?? ''].filter(Boolean).join(delimiter);
  try {
    const found = adb.resolveOnPath('adb');
    check('bare adb resolves to a real path', typeof found === 'string' && found !== 'adb', found);
    check('resolved adb exists on disk', typeof found === 'string' && existsSync(found!), found);
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
  check('a path is passed through untouched', adb.resolveOnPath('/usr/bin/adb') === '/usr/bin/adb');
  check('a missing command resolves to nothing', adb.resolveOnPath('ws-scrcpy5-no-such-binary') === undefined);
}

/*
 * Session registry: several viewers can mirror one device, and one of them
 * leaving must never disturb the others. Ref-counted release of the shared adb
 * transport is what makes that true.
 */
console.log('\nsession registry (multi-viewer)');
{
  const serial = '192.168.5.99:5555';
  const a = {};
  const b = {};

  check('first viewer', registry.acquire(serial, a) === 1, registry.activeCount(serial));
  check('second viewer on the same device', registry.acquire(serial, b) === 2, registry.activeCount(serial));
  check('two viewers is not "last one"', registry.isLastViewer(serial) === false);
  check('A leaves: B is still there', registry.release(serial, a) === 1, registry.activeCount(serial));
  check('the remaining viewer is the last one', registry.isLastViewer(serial) === true);
  check('B leaves too', registry.release(serial, b) === 0, registry.activeCount(serial));
  check('releasing an unknown token is harmless', registry.release(serial, {}) === 0);

  // Device-global settings: captured by the first session, restored by the last.
  const backup = [{ table: 'system', key: 'show_touches', value: '0' }] as const;
  registry.setSettingsBackup(serial, backup.map((x) => ({ ...x })));
  check('settings backup is shared', registry.settingsBackup(serial)?.length === 1);
  check('taking it hands it over once', registry.takeSettingsBackup(serial)?.length === 1);
  check('and it is gone afterwards', registry.settingsBackup(serial) === undefined);
}

console.log('\nfile push / APK install');
{
  // Filename hardening: a hostile `name` must never escape the upload dir.
  check('剥离目录穿越', upload.safeFileName('../../etc/passwd') === 'passwd');
  check('Windows 反斜杠同样被当作分隔符', upload.safeFileName('a/b\\c.apk') === 'c.apk');
  check('空名字有兜底', upload.safeFileName('') === 'upload.bin');
  check('纯点号名字有兜底', upload.safeFileName('..') === 'upload.bin');
  check('保留中文与空格', upload.safeFileName('我的 应用 v2.apk') === '我的 应用 v2.apk');
  check('冒号与竖线被替换', upload.safeFileName('ab:cd|ef.apk') === 'ab_cd_ef.apk', upload.safeFileName('ab:cd|ef.apk'));
  // Windows `path.basename()` would eat a leading `x:` as a drive letter; the
  // hand-rolled split must keep it identical on every platform.
  check('不依赖平台的盘符语义', upload.safeFileName('C:evil.apk') === 'C_evil.apk', upload.safeFileName('C:evil.apk'));

  const long = `${'x'.repeat(200)}.apk`;
  const trimmed = upload.safeFileName(long);
  check('超长名字被截断且保留扩展名', trimmed.length === 120 && trimmed.endsWith('.apk'), trimmed.length);

  const throws = (fn: () => unknown): boolean => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  check('空 serial 被拒绝', throws(() => upload.validateSerial('')));
  check('带 shell 元字符的 serial 被拒绝', throws(() => upload.validateSerial('x; rm -rf /')));
  check('正常网络地址通过', upload.validateSerial('192.168.5.1:5555') === '192.168.5.1:5555');
  check('USB serial 通过', upload.validateSerial('emulator-5554') === 'emulator-5554');

  check('.apk 自动走安装', upload.resolveKind('a.apk', 'auto') === 'apk');
  check('其它文件走推送', upload.resolveKind('a.txt', 'auto') === 'file');
  check('mode=file 强制推送', upload.resolveKind('a.apk', 'file') === 'file');
  check('mode=install 强制安装', upload.resolveKind('a.txt', 'install') === 'apk');
  check('拆分包识别', upload.isBundle('x.apks') && !upload.isBundle('x.apk'));

  const output = 'Performing Streamed Install\nadb: failed to install a.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]';
  check(
    '提取 INSTALL_FAILED 原因',
    upload.parseInstallFailure(output) === 'INSTALL_FAILED_UPDATE_INCOMPATIBLE',
    upload.parseInstallFailure(output),
  );
  check('无原因时退回原始输出', upload.parseInstallFailure('').length > 0);
  check('字节数可读', util.formatBytes(2048) === '2.0 KB', util.formatBytes(2048));
  // 4 位数的 GB 档：提取大文件时日志里会用到，别让它溢出成 NaN。
  check('GB 档位', util.formatBytes(3 * 1024 ** 3) === '3.00 GB', util.formatBytes(3 * 1024 ** 3));

  /*
   * Upload cap: **unlimited by default**. A game package is routinely 1–2 GB,
   * so a 512 MB ceiling rejected exactly the files people push. `0` means "no
   * limit" (same convention as the download side), and "off" moved to its own
   * switch — otherwise "unlimited" and "disabled" would be the same number.
   */
  const savedMax = process.env.WS_SCRCPY_UPLOAD_MAX_MB;
  const savedOff = process.env.WS_SCRCPY_UPLOAD;
  delete process.env.WS_SCRCPY_UPLOAD_MAX_MB;
  delete process.env.WS_SCRCPY_UPLOAD;
  check('默认不限制上传大小', upload.maxUploadBytes() === 0 && upload.uploadEnabled() === true, {
    max: upload.maxUploadBytes(),
  });
  process.env.WS_SCRCPY_UPLOAD_MAX_MB = '0';
  check('MAX_MB=0 也是不限制', upload.maxUploadBytes() === 0 && upload.uploadEnabled() === true);
  process.env.WS_SCRCPY_UPLOAD_MAX_MB = '2';
  check('MAX_MB 可设置上限', upload.maxUploadBytes() === 2 * 1024 * 1024);
  delete process.env.WS_SCRCPY_UPLOAD_MAX_MB;
  process.env.WS_SCRCPY_UPLOAD = 'off';
  check('WS_SCRCPY_UPLOAD=off 关闭推送', upload.uploadEnabled() === false);
  check('关闭后浏览与提取不受影响（开关与上限互不影响）', upload.maxUploadBytes() === 0);
  if (savedMax === undefined) delete process.env.WS_SCRCPY_UPLOAD_MAX_MB;
  else process.env.WS_SCRCPY_UPLOAD_MAX_MB = savedMax;
  if (savedOff === undefined) delete process.env.WS_SCRCPY_UPLOAD;
  else process.env.WS_SCRCPY_UPLOAD = savedOff;
  check('默认上限恢复', upload.uploadEnabled() === true);
}

/*
 * Removing the cap is not enough on its own: `adb push` used to give a 2 GB
 * package a fixed 5-minute budget, so it was aborted part-way through and the
 * user got a timeout instead of an installed game. The budget has to grow with
 * the file.
 */
console.log('\ntransfer timeout scales with the file');
{
  const twoGb = 2 * 1024 ** 3;
  check('小文件仍给一个宽松的底线', adb.transferTimeout(1024) >= 120_000, adb.transferTimeout(1024));
  // 2 GB at the 2 MB/s floor is ~17 min of transfer, plus the 2 min base.
  check('2GB 的包不再挤在 5 分钟里', adb.transferTimeout(twoGb) > 15 * 60_000, adb.transferTimeout(twoGb));
  check('超时随大小单调增长', adb.transferTimeout(twoGb) > adb.transferTimeout(1024 ** 3));
  check('缺失/非法大小不会算出 NaN', Number.isFinite(adb.transferTimeout(NaN)) && adb.transferTimeout(-1) >= 120_000);
}

/*
 * `receiveUpload(limit)` must only enforce a cap when there is one: with the
 * default (0) a multi-GB file has to stream through untouched.
 */
async function uploadStreamChecks(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ws5-upload-'));
  const feed = async (limit: number, bytes: number): Promise<number | string> => {
    const dest = join(dir, `f-${limit}-${bytes}.bin`);
    const req = new PassThrough() as unknown as IncomingMessage;
    const done = upload.receiveUpload(req, dest, limit);
    // Bigger than the high-water mark, so both the drain/resume path and the
    // cap have to work.
    for (let i = 0; i < bytes; i += 64) req.write(Buffer.alloc(Math.min(64, bytes - i), 7));
    req.end();
    try {
      return await done;
    } catch (e) {
      return (e as upload.UploadError).message;
    }
  };

  check('不限大小时 3000 字节原样落地', (await feed(0, 3000)) === 3000, await feed(0, 3000));
  const capped = await feed(1000, 3000);
  check('设了上限就仍然拦截', typeof capped === 'string' && capped.includes('超过上限'), capped);
  check('正好等于上限不算超', (await feed(1000, 1000)) === 1000);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ndevice file manager');
{
  /* Paths: the only escape route out of the panel is a `..`, so it is capped. */
  check('绝对路径保持不变', fs.normalizeRemote('/sdcard/Download') === '/sdcard/Download');
  check('去掉尾部斜杠', fs.normalizeRemote('/sdcard/') === '/sdcard');
  check('相对路径相对 base 解析', fs.normalizeRemote('Download', '/sdcard') === '/sdcard/Download');
  check(
    '.. 不能越过根目录',
    fs.normalizeRemote('/../../etc/passwd') === '/etc/passwd',
    fs.normalizeRemote('/../../etc/passwd'),
  );
  check('深层 .. 正常回退', fs.normalizeRemote('/a/b/../c') === '/a/c');
  check('多级 .. 正常回退', fs.normalizeRemote('/a/b/c/../../d') === '/a/d');
  check('反斜杠也当分隔符', fs.normalizeRemote('a\\b') === '/a/b');
  check('上级目录', fs.remoteDirname('/sdcard/Download') === '/sdcard');
  check('根目录的上级仍是根', fs.remoteDirname('/sdcard') === '/');
  check('最后一段', fs.remoteBasename('/sdcard/a.txt') === 'a.txt');

  /* Quoting: everything here reaches a real shell on the other end. */
  check('单引号包裹', fs.quoteShell('/sdcard/a b') === "'/sdcard/a b'", fs.quoteShell('/sdcard/a b'));
  check('内部单引号被转义', fs.quoteShell("it's") === "'it'\\''s'", fs.quoteShell("it's"));
  check(
    'shell 元字符被关在引号里',
    fs.quoteShell('$(reboot); rm -rf /') === "'$(reboot); rm -rf /'",
    fs.quoteShell('$(reboot); rm -rf /'),
  );

  /* `ls -la` parsing, toybox flavour (modern Android). */
  const toybox = [
    'total 12',
    'drwxr-xr-x  4 root root   4096 2024-06-01 12:00 Android',
    '-rw-rw----  1 root sdcard_rw    123 2024-06-01 12:00 a.txt',
    '-rw-rw----  1 root sdcard_rw      0 2024-06-01 12:00 空 文件.txt',
    'lrwxrwxrwx  1 root root      8 2024-06-01 12:00 sdcard -> /storage/emulated/0',
    'drwxr-xr-x.  2 root root      0 2024-06-01 12:00 selinux-dir',
  ].join('\n');
  const parsed = fs.parseLsOutput(toybox);
  check('total 行被跳过', parsed.length === 5, String(parsed.length));
  check('目录识别', parsed[0].kind === 'dir' && parsed[0].name === 'Android');
  check('文件大小', parsed[1].kind === 'file' && parsed[1].size === 123, String(parsed[1].size));
  check('中文名与空格保留', parsed[2].name === '空 文件.txt', parsed[2].name);
  check(
    '符号链接带目标',
    parsed[3].kind === 'link' && parsed[3].name === 'sdcard' && parsed[3].target === '/storage/emulated/0',
    JSON.stringify(parsed[3]),
  );
  check('SELinux 点标记不影响解析', parsed[4].kind === 'dir' && parsed[4].name === 'selinux-dir');
  check('日期原样保留（不做时区猜测）', parsed[1].date === '2024-06-01 12:00', parsed[1].date);

  /* busybox / older flavour. */
  const busybox = fs.parseLsOutput(
    '-rw-rw---- 1 root sdcard_rw 123 Jan  1  2024 a.txt\ndrwxrwxr-x 2 root sdcard_rw 4096 Dec 31 23:59 dir',
  );
  check('旧式日期也能解析', busybox.length === 2 && busybox[0].size === 123, JSON.stringify(busybox));
  check('无法解析的行被忽略', fs.parseLsOutput('garbage\n\r\n').length === 0);

  const sorted = fs.sortEntries([
    { name: 'b.txt', kind: 'file', size: 1, date: '' },
    { name: 'a.txt', kind: 'file', size: 1, date: '' },
    { name: 'zz', kind: 'dir', size: 1, date: '' },
  ]);
  check('目录排在文件前面', sorted[0].kind === 'dir', sorted.map((e) => e.name).join(','));
  check('同类型按名称排序', sorted[1].name === 'a.txt' && sorted[2].name === 'b.txt');

  check(
    '权限不足 → 403',
    fs.explainFailure('ls: /data: Permission denied', 'x').status === 403,
    String(fs.explainFailure('ls: /data: Permission denied', 'x').status),
  );
  check('路径不存在 → 404', fs.explainFailure('ls: /x: No such file or directory', 'x').status === 404);
  check('其它错误 → 500', fs.explainFailure('boom', 'x').status === 500);

  const savedRoot = process.env.WS_SCRCPY_FS_ROOT;
  process.env.WS_SCRCPY_FS_ROOT = 'mnt/sdcard';
  check('根目录可配置并补全前导斜杠', fs.rootDir() === '/mnt/sdcard', fs.rootDir());
  if (savedRoot === undefined) delete process.env.WS_SCRCPY_FS_ROOT;
  else process.env.WS_SCRCPY_FS_ROOT = savedRoot;
  check('默认根目录是 /sdcard', fs.rootDir() === '/sdcard', fs.rootDir());

  const savedDl = process.env.WS_SCRCPY_DOWNLOAD_MAX_MB;
  check('默认不限制下载大小', fs.maxDownloadBytes() === 0);
  process.env.WS_SCRCPY_DOWNLOAD_MAX_MB = '8';
  check('下载上限可配置', fs.maxDownloadBytes() === 8 * 1024 * 1024);
  if (savedDl === undefined) delete process.env.WS_SCRCPY_DOWNLOAD_MAX_MB;
  else process.env.WS_SCRCPY_DOWNLOAD_MAX_MB = savedDl;
}

/*
 * Regression: the fMP4 (`container=mse`) path rebuilds the video stream packet
 * by packet, and the browser reads it with the same StreamParser the raw path
 * uses — which consumes the 64-byte device-name field first. If the muxed
 * stream omits that field, every later read shifts by 64 bytes: the codec id
 * decodes to garbage and the init segment is never found, leaving a black
 * screen. Reproduce the byte sequence here so the contract cannot regress.
 */
console.log('mse stream framing (device name + codec + config + media)');
{
  const deviceName = 'redroid12_x86_64';
  const init = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const fragment = new Uint8Array([0, 0, 0, 16, 0x6d, 0x6f, 0x6f, 0x66, 0x00, 0x00, 0x00, 0x08]);

  // Exactly the order muxEvent() emits them.
  const emitted = concatBytes(
    encodeDeviceName(deviceName),
        encodeCodecEvent('h264'),
    encodeConfigPacket(init),
    encodeMediaPacket(fragment, 12345, true),
  );

  const parser = new StreamParser({ expectName: true });
  const events = [...parser.push(emitted)];

  check('the muxed stream starts with a parseable device name', events[0]?.kind === 'meta');
  check(
    'the device name survives the round trip',
    events[0]?.kind === 'meta' && events[0].deviceName === deviceName,
    events[0],
  );
  check(
    'the codec id is read as h264, not a shifted 0x…',
    events[1]?.kind === 'codec' && events[1].codec === 'h264',
    events[1],
  );
  check('the init segment arrives as a config packet', events[2]?.kind === 'packet' && events[2].packet.config === true);
  check(
    'the init segment bytes are intact',
    events[2]?.kind === 'packet' && hex(events[2].packet.data) === hex(init),
  );
  check(
    'the media packet arrives with its pts and key-frame flag',
    events[3]?.kind === 'packet' &&
      events[3].packet.pts === 12345 &&
      events[3].packet.keyFrame === true,
    events[3],
  );
}

/*
 * The MSE path rebuilds the video stream packet by packet, so it must re-emit
 * the session meta packet too (`Streamer.writeSessionMeta`, sent at the start
 * and again on every rotation / encoder restart). It is the only thing that
 * carries the new size in that mode: the browser maps touch coordinates onto
 * `event.width` / `event.height`, so dropping it leaves the input pointing at
 * the orientation the screen had when mirroring started.
 */
console.log('mse stream framing: session meta round trip');
{
  const session = encodeSessionMeta(2400, 1080, false);
  check('a session packet is one packet header long', session.length === PACKET_HEADER_SIZE, session.length);

  // The browser only reaches the packet state after the name and the codec id,
  // so the stream is fed exactly as the client sees it.
  const parseAfterHeader = (tail: Uint8Array): ReturnType<StreamParser['push']> =>
    new StreamParser({ expectName: true }).push(
      concatBytes(encodeDeviceName('redroid'), encodeCodecEvent('h264'), tail),
    );

  const events = parseAfterHeader(session);
  check('it parses as a session event', events.length === 3 && events[2].kind === 'session', events.map((e) => e.kind));
  check(
    'and carries the rotated size',
    events[2].kind === 'session' && events[2].width === 2400 && events[2].height === 1080,
    events[2],
  );
  check('with clientResize unset', events[2].kind === 'session' && events[2].clientResize === false);

  // Bit 0 of the flags word is the client-resize marker, per Streamer.
  const byClient = parseAfterHeader(encodeSessionMeta(720, 1280, true));
  check('the client-resize bit survives', byClient[2]?.kind === 'session' && byClient[2].clientResize === true, byClient[2]);

  // It must not swallow a following packet: a session packet has no payload.
  const withPacket = parseAfterHeader(
    concatBytes(session, encodeMediaPacket(new Uint8Array([9, 9]), 7, true)),
  );
  check(
    'a media packet after it is still parsed',
    withPacket.length === 4 && withPacket[3].kind === 'packet' && withPacket[3].packet.pts === 7,
    withPacket.map((e) => e.kind),
  );
}

/*
 * `Streamer.writeDisableStream` writes a code *instead of* the codec id when a
 * stream cannot start: 0 = this stream is off (audio could not be captured,
 * video continues), 1 = a configuration error, scrcpy stops. Naming them beats
 * reporting `unknown(0x0)` and leaving the user to guess why there is no sound.
 */
console.log('disabled-stream codes');
{
  check('code 0 is reported as "disabled"', codecIdToName(0) === 'disabled', codecIdToName(0));
  check('code 1 is reported as "error"', codecIdToName(1) === 'error', codecIdToName(1));
  check('real codec ids are unaffected', codecIdToName(0x68323634) === 'h264' && codecIdToName(0x6f707573) === 'opus');
}

/*
 * Same bug seen from the server side: the fMP4 path parses the stream and
 * rebuilds it, so `muxEvent` has to re-emit the session packet itself. Nothing
 * else in that mode tells the browser the screen turned, and touch coordinates
 * are mapped with `width`/`height` — so a dropped session packet means every
 * tap lands in the wrong place after a rotation, while the picture (carried by
 * the rebuilt init segment) looks perfectly fine.
 */
console.log('mse path forwards the session meta packet');
{
  const sent: Uint8Array[] = [];
  const session = new ScrcpySession(
    { serial: 'test', container: 'mse' },
    {
      onInit: () => undefined,
      onMedia: (_channel, data) => sent.push(data),
      onDeviceMessage: () => undefined,
      onLog: () => undefined,
      onClosed: () => undefined,
    },
  );
  const emit = (event: unknown) =>
    (session as unknown as { muxEvent(event: unknown): void }).muxEvent(event);

  sent.length = 0;
  emit({ kind: 'codec', codec: 'h264' });
  emit({ kind: 'session', width: 1080, height: 2400, clientResize: false });
  emit({ kind: 'session', width: 2400, height: 1080, clientResize: false });

  // The client reaches the packet state only after the codec id, so parse the
  // bytes the way they arrive on the wire.
  const parse = (data: Uint8Array) =>
    new StreamParser({ expectName: false }).push(concatBytes(encodeCodecEvent('h264'), data));
  check('a session packet is emitted for each session event', sent.length === 3, sent.length);
  const rotated = parse(sent[2]);
  check(
    'the last one carries the rotated size',
    rotated.length === 2 && rotated[1]?.kind === 'session' && rotated[1].width === 2400 && rotated[1].height === 1080,
    rotated,
  );
}

/*
 * The lock checks need `await`, and this file is bundled to CJS (top-level
 * await is not allowed there), so they live in an async function that also
 * prints the verdict.
 */
async function lockChecks(): Promise<void> {  const serial = '192.168.5.97:5555';
  const order: string[] = [];
  await registry.withDeviceLock(serial, async () => {
    await new Promise((r) => setTimeout(r, 20));
    order.push('first');
  });
  await registry.withDeviceLock(serial, async () => order.push('second'));
  await registry.withDeviceLock(serial, async () => {
    throw new Error('boom');
  }).catch(() => undefined);
  await registry.withDeviceLock(serial, async () => order.push('after-failure'));
  check('withDeviceLock 按设备串行执行', order.join(',') === 'first,second,after-failure', order);
  check('一次失败不会阻塞后续任务', order.includes('after-failure'));

  const other = '192.168.5.96:5555';
  const slow = registry.withDeviceLock(serial, async () => {
    await new Promise((r) => setTimeout(r, 30));
    return 'slow';
  });
  const fast = registry.withDeviceLock(other, async () => 'fast');
  check('不同设备互不阻塞', (await fast) === 'fast' && (await slow) === 'slow');
}

void uploadStreamChecks()
  .then(() => lockChecks())
  .then(() => {
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
});
