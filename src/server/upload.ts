/**
 * File push / APK install.
 *
 *   POST /api/push?serial=...&name=...&mode=auto|install|file
 *   body: the raw file bytes (content-type is irrelevant)
 *
 * The browser sends the `File` object straight from an `<input>` or a drop, so
 * there is no multipart encoding to parse and no extra dependency — the body is
 * streamed to a temp file, then handed to `adb install` (`.apk`) or
 * `adb push` (everything else).
 *
 * Everything here is deliberately defensive because this project is meant to be
 * published as a Docker image: the upload is capped, the name is sanitised, the
 * serial is validated and the temp file is always removed.
 */
import { createWriteStream } from 'node:fs';
import type { IncomingMessage } from 'node:http';

import * as adb from './adb';
import { formatBytes } from './util';

export class UploadError extends Error {
  constructor(
    message: string,
    /** HTTP status the server should report for this failure. */
    readonly status = 400,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Upload size cap — **unlimited by default**.
 *
 * A cap used to default to 512 MB, which sounded generous and was not: a single
 * game package (.apk, or an .obb / .xapk bundle) routinely runs to 1–2 GB, so
 * the limit rejected exactly the files people actually want to push. This tool
 * runs on the user's own LAN behind their own router, so an arbitrary ceiling
 * only ever got in the way.
 *
 * `0` means "no limit", the same convention the download side already uses
 * (`fs.maxDownloadBytes`). To cap it anyway: `WS_SCRCPY_UPLOAD_MAX_MB=2048`.
 * To switch push/install off entirely: `WS_SCRCPY_UPLOAD=off`.
 */
export function maxUploadBytes(): number {
  const raw = process.env.WS_SCRCPY_UPLOAD_MAX_MB;
  if (raw === undefined || raw === '') return 0;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) return 0;
  return Math.floor(mb * 1024 * 1024);
}

const OFF = new Set(['0', 'off', 'false', 'no', 'none', 'disabled']);

/**
 * Whether push/install is available at all.
 *
 * Separate from the size cap, because "unlimited" and "off" are different
 * answers and both need to be expressible. `WS_SCRCPY_UPLOAD=off` is the switch
 * to reach when the container is exposed beyond the LAN — browsing and
 * extracting stay available, nothing can be written to the device.
 */
export function uploadEnabled(): boolean {
  const raw = process.env.WS_SCRCPY_UPLOAD;
  if (raw === undefined || raw === '') return true;
  return !OFF.has(raw.trim().toLowerCase());
}

/** Where non-APK files land on the device. */
export function uploadDir(): string {
  return process.env.WS_SCRCPY_UPLOAD_DIR || '/sdcard/Download';
}

/* ------------------------------------------------------------------ */
/* pure helpers (covered by tools/selftest.ts)                         */
/* ------------------------------------------------------------------ */

/** Control chars and anything that could turn into a path or an argument. */
const UNSAFE_NAME = new RegExp('[\\u0000-\\u001f\\u007f/\\\\:*?\"<>|]', 'g');

/**
 * Reduce an attacker-supplied `name` to something safe to append to a remote
 * path. Keeps non-ASCII (Chinese filenames are normal here), drops separators
 * so the name can never escape the upload directory, and caps the length so a
 * huge name cannot blow up the adb command line.
 */
export function safeFileName(raw: string, fallback = 'upload.bin'): string {
  /*
   * Strip the directory part by hand rather than with `path.basename()`: the
   * win32 implementation treats a leading `x:` as a drive letter and would
   * drop it, so the same name sanitises differently on Windows and in the
   * Linux container this project ships as.
   */
  const flat = (raw ?? '').replace(/\\/g, '/');
  const slash = flat.lastIndexOf('/');
  let name = (slash >= 0 ? flat.slice(slash + 1) : flat)
    .replace(UNSAFE_NAME, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name === '.' || name === '..') name = fallback;
  if (name.length > 120) {
    // Trim the stem, keep the extension — `.apk` is what decides the action.
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    const stem = ext ? name.slice(0, dot) : name;
    name = stem.slice(0, Math.max(1, 120 - ext.length)) + ext;
  }
  return name;
}

/** adb serials: `192.168.5.1:5555`, `emulator-5554`, a USB serial… */
const SERIAL = /^[A-Za-z0-9._:-]{1,64}$/;

export function validateSerial(value: string): string {
  const serial = (value ?? '').trim();
  if (!serial) throw new UploadError('缺少设备地址，请先填写并连接设备', 400);
  if (!SERIAL.test(serial)) throw new UploadError(`设备地址「${serial}」含有非法字符`, 400);
  return serial;
}

export type PushKind = 'apk' | 'file';
export type PushMode = 'auto' | 'install' | 'file';

/** Split-APK bundles: adb cannot install them, so they go in as plain files. */
const BUNDLE = /\.(apks|apkm|xapk)$/i;

export function resolveKind(name: string, mode: PushMode = 'auto'): PushKind {
  if (mode === 'install') return 'apk';
  if (mode === 'file') return 'file';
  return /\.apk$/i.test(name) ? 'apk' : 'file';
}

export function isBundle(name: string): boolean {
  return BUNDLE.test(name);
}

/** adb prints `Failure [INSTALL_FAILED_...]`; surface just the code. */
export function parseInstallFailure(output: string): string {
  const match = /Failure\s*\[([^\]]+)\]/.exec(output);
  if (match) return match[1];
  const flat = output.replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, 300) : '未知错误';
}

/* ------------------------------------------------------------------ */
/* receiving                                                           */
/* ------------------------------------------------------------------ */

/**
 * Stream the request body to `dest`, refusing anything past `limit`.
 *
 * Returns the byte count. On overflow the request is destroyed — draining a
 * multi-gigabyte body we are going to throw away is worse than an abrupt end.
 */
export function receiveUpload(
  req: IncomingMessage,
  dest: string,
  /** 0 = no limit. */
  limit: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const out = createWriteStream(dest);
    let size = 0;
    let settled = false;

    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      out.destroy();
      reject(e);
    };

    out.on('error', fail);
    req.on('error', fail);
    req.on('aborted', () => fail(new UploadError('上传被中断', 499)));

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (limit > 0 && size > limit) {
        try {
          req.destroy();
        } catch {
          /* already gone */
        }
        fail(new UploadError(`文件超过上限 ${formatBytes(limit)}`, 413));
        return;
      }
      if (!out.write(chunk)) req.pause();
    });
    out.on('drain', () => req.resume());
    req.on('end', () => {
      if (settled) return;
      settled = true;
      out.end(() => resolve(size));
    });
  });
}

/* ------------------------------------------------------------------ */
/* pushing to the device                                               */
/* ------------------------------------------------------------------ */

export interface PushResult {
  ok: boolean;
  kind: PushKind;
  name: string;
  size: number;
  message: string;
  remote?: string;
}

/**
 * Install or push `local` to `serial`. `adb` itself failing (device offline,
 * binary missing) throws; a refused install returns `ok: false` with adb's
 * reason, because that is an answer, not a crash.
 *
 * `dir` overrides the destination directory (the file manager uploads into
 * whatever folder is on screen); it is expected to be a normalised absolute
 * remote path — see `fs.normalizeRemote`.
 */
export async function pushToDevice(
  serial: string,
  name: string,
  local: string,
  size: number,
  mode: PushMode = 'auto',
  dir?: string,
): Promise<PushResult> {
  await adb.ensureConnected(serial);
  const kind = resolveKind(name, mode);
  const human = formatBytes(size);

  if (kind === 'apk') {
    // A multi-GB game package has to be streamed over and then dexopt'd; the
    // fixed 5-minute budget aborted those installs part-way through.
    const { ok, output } = await adb.install(serial, local, adb.transferTimeout(size, 300_000));
    return {
      ok,
      kind,
      name,
      size,
      message: ok ? `已安装 ${name}（${human}）` : `安装 ${name} 失败：${parseInstallFailure(output)}`,
      remote: ok ? 'installed' : undefined,
    };
  }

  // `/` has no trailing slash to strip, hence the empty base handling.
  const base = (dir || uploadDir()).replace(/\/+$/, '');
  const remote = `${base}/${name}`;
  await adb.push(serial, local, remote, adb.transferTimeout(size));
  const hint = isBundle(name) ? '（拆分包需先合并，已按普通文件推送）' : '';
  return {
    ok: true,
    kind,
    name,
    size,
    message: `已推送 ${name}（${human}）→ ${remote}${hint}`,
    remote,
  };
}

