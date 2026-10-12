/**
 * Device file manager — the backend of the 「文件管理」 panel.
 *
 *   GET  /api/fs?serial=&path=              list a directory
 *   GET  /api/fs/download?serial=&path=     extract one file to the browser
 *   POST /api/fs/upload?serial=&dir=&name=  push a file into a directory
 *
 * There is no `adb shell` file API worth speaking of, so this module is built
 * on the two primitives every Android device ships: `ls -la` (toybox or
 * busybox) and `adb pull`. Both are parsed/escaped here rather than in the
 * routes, which keeps the interesting logic in pure functions that
 * `tools/selftest.ts` can hammer without a device.
 *
 * Safety notes, because the same code ends up in a published container:
 *  - a remote path is normalised segment by segment, so `..` can never climb
 *    above `/` (`/../../etc` -> `/etc`);
 *  - paths handed to the device shell are single-quoted with `'` escaped, so a
 *    file named `; rm -rf /` is just a file name;
 *  - downloads stop before pulling a directory, which would otherwise recurse
 *    through an entire sdcard.
 */
import { statSync } from 'node:fs';

import * as adb from './adb';

export class FsError extends Error {
  constructor(
    message: string,
    /** HTTP status the server should report for this failure. */
    readonly status = 400,
  ) {
    super(message);
    this.name = 'FsError';
  }
}

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

/** Where the panel opens. `/sdcard` is the only directory a normal user owns. */
export function rootDir(): string {
  const raw = (process.env.WS_SCRCPY_FS_ROOT || '/sdcard').trim();
  return raw.startsWith('/') ? normalizeRemote(raw) : normalizeRemote(`/${raw}`);
}

const DEFAULT_MAX_DOWNLOAD_MB = 0;

/**
 * Cap for `GET /api/fs/download`. 0 (the default) means "no limit" — pulling a
 * video off your own phone is the point of the feature. Set
 * `WS_SCRCPY_DOWNLOAD_MAX_MB` when the panel is exposed to a network you do not
 * fully trust.
 */
export function maxDownloadBytes(): number {
  const raw = process.env.WS_SCRCPY_DOWNLOAD_MAX_MB;
  const mb = raw === undefined || raw === '' ? DEFAULT_MAX_DOWNLOAD_MB : Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) return 0;
  return Math.floor(mb * 1024 * 1024);
}

/* ------------------------------------------------------------------ */
/* pure helpers (covered by tools/selftest.ts)                         */
/* ------------------------------------------------------------------ */

/**
 * Collapse a user supplied path into an absolute, `..`-free remote path.
 *
 * `base` is the directory the input is resolved against. Windows separators are
 * accepted because the browser side may hand back a path pasted from Explorer.
 * `..` pops at most until the root, so the result always starts with `/`.
 */
export function normalizeRemote(input: string, base = '/'): string {
  const raw = String(input ?? '')
    .replace(/\\/g, '/')
    .trim();
  const basePath = '/' + clean(String(base ?? '/').replace(/\\/g, '/'));
  const joined = raw.startsWith('/') ? raw : `${basePath === '/' ? '' : basePath}/${raw}`;
  return '/' + clean(joined);
}

function clean(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

/** Parent directory of an absolute remote path (`/sdcard` -> `/`). */
export function remoteDirname(path: string): string {
  const flat = normalizeRemote(path);
  const cut = flat.lastIndexOf('/');
  return cut <= 0 ? '/' : flat.slice(0, cut);
}

/** Last segment of an absolute remote path. */
export function remoteBasename(path: string): string {
  const flat = normalizeRemote(path);
  const cut = flat.lastIndexOf('/');
  return cut < 0 ? flat : flat.slice(cut + 1);
}

/**
 * Quote a value for the device shell: `it's` -> `'it'\''s'`.
 *
 * Everything reaching this function comes from a query string, so it is the
 * one place that keeps a file named `$(reboot)` from being a command.
 */
export function quoteShell(value: string): string {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

export type RemoteKind = 'dir' | 'file' | 'link' | 'other';

export interface RemoteEntry {
  name: string;
  kind: RemoteKind;
  size: number;
  /** mtime as printed by `ls` — never converted, so no timezone guess is made. */
  date: string;
  /** For symlinks: what it points at. */
  target?: string;
}

/*
 * `ls -la` output, two flavours:
 *   toybox / modern: -rw-rw---- 1 root sdcard_rw 123 2024-06-01 12:00 name
 *   busybox / older: -rw-rw---- 1 root sdcard_rw 123 Jan  1  2024 name
 * Both may carry a trailing `.`/`+`/`@` after the mode bits (SELinux, ACLs,
 * extended attributes), and a symlink appends ` -> target`.
 */
/*
 * Both expressions must yield exactly four groups — [type, size, date, name] —
 * because the parse site destructures them positionally. Date and time are one
 * group: `ls` separates them, but a timestamp is only readable as a pair.
 */
const RE_ENTRY_ISO =
  /^([dlbcps-])[rwxsStT-]{9}[.+@]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+((?:\d{4}-\d{2}-\d{2})[ T]\d{2}:\d{2}(?::\d{2})?)(?:\s+[+-]\d{4})?\s+(.*)$/;
const RE_ENTRY_BSD =
  /^([dlbcps-])[rwxsStT-]{9}[.+@]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{4}|\d{2}:\d{2}))\s+(.*)$/;

function kindOf(letter: string): RemoteKind {
  if (letter === 'd') return 'dir';
  if (letter === 'l') return 'link';
  if (letter === '-') return 'file';
  return 'other';
}

/** Parse `ls -la` output. `total 0` headers and unparsable lines are skipped. */
export function parseLsOutput(text: string): RemoteEntry[] {
  const out: RemoteEntry[] = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('total ')) continue;
    const match = RE_ENTRY_ISO.exec(line) ?? RE_ENTRY_BSD.exec(line);
    if (!match) continue;
    const [, type, size, date, rawName] = match;
    let name = rawName.trim();
    let target: string | undefined;
    const arrow = name.indexOf(' -> ');
    if (arrow >= 0) {
      target = name.slice(arrow + 4).trim();
      name = name.slice(0, arrow).trim();
    }
    if (!name) continue;
    const parsed = Number(size);
    out.push({
      name,
      kind: kindOf(type),
      size: Number.isFinite(parsed) ? parsed : 0,
      date: date.replace(/\s+/g, ' '),
      target,
    });
  }
  return out;
}

/** Directories (and symlinks, which usually point at one) first, then by name. */
export function sortEntries(entries: RemoteEntry[]): RemoteEntry[] {
  return [...entries].sort((a, b) => {
    const da = a.kind === 'file' || a.kind === 'other' ? 1 : 0;
    const db = b.kind === 'file' || b.kind === 'other' ? 1 : 0;
    if (da !== db) return da - db;
    // No locale argument: whatever the host's default is, names still sort
    // by name, and hard-coding one region only helps a subset of users.
    return a.name.localeCompare(b.name);
  });
}

/** 403 for a permission wall, 404 for a missing path, 500 otherwise. */
export function explainFailure(stderr: string, fallback: string): FsError {
  const text = String(stderr ?? '');
  if (/permission denied|not permitted|operation not permitted/i.test(text)) {
    return new FsError('没有权限访问该路径（Android 应用私有目录需要 root）', 403);
  }
  if (/no such file or directory|does not exist|not found/i.test(text)) {
    return new FsError('路径不存在', 404);
  }
  return new FsError(text.trim() || fallback, 500);
}

/* ------------------------------------------------------------------ */
/* talking to the device                                               */
/* ------------------------------------------------------------------ */

export interface DirListing {
  path: string;
  parent: string | null;
  entries: RemoteEntry[];
}

/** `LC_ALL=C` keeps month names and decimal separators predictable. */
async function ls(serial: string, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return adb.shellResult(serial, `LC_ALL=C ${command}`);
}

export async function listDir(serial: string, path: string): Promise<DirListing> {
  const target = normalizeRemote(path || rootDir());
  /*
   * The trailing slash is what makes `ls` descend into the directory. Without
   * it, `ls -la /sdcard` on almost every Android build lists the *symlink*
   * (`/sdcard -> /storage/emulated/0`) and nothing else — the panel would show
   * an empty phone. `/` is left alone so the command never becomes `//`.
   */
  const suffix = target === '/' ? '' : '/';
  const { stdout, stderr, code } = await ls(serial, `ls -la ${quoteShell(target + suffix)}`);
  if (!stdout.trim() && code !== 0) {
    throw explainFailure(stderr, `无法读取目录 ${target}`);
  }
  const entries = parseLsOutput(stdout).filter((e) => e.name !== '.' && e.name !== '..');
  if (entries.length === 0 && /permission denied/i.test(stderr)) {
    throw explainFailure(stderr, `无法读取目录 ${target}`);
  }
  return {
    path: target,
    parent: target === '/' ? null : remoteDirname(target),
    entries: sortEntries(entries),
  };
}

export interface RemoteStat {
  kind: RemoteKind;
  size: number;
}

/** `ls -ld` — metadata of one entry without descending into it. */
export async function statRemote(serial: string, path: string): Promise<RemoteStat> {
  const target = normalizeRemote(path);
  const { stdout, stderr } = await ls(serial, `ls -ld ${quoteShell(target)}`);
  const entry = parseLsOutput(stdout)[0];
  if (!entry) throw explainFailure(stderr, `无法读取 ${target}`);
  return { kind: entry.kind, size: entry.size };
}

/**
 * Pull one file into the temp directory and hand back the local path.
 *
 * Callers own the file from here on: it must be streamed out and then removed
 * with `util.cleanup()`, or a phone-sized disk eventually fills up with copies
 * of the user's videos.
 */
export async function pullToTemp(serial: string, remote: string, local: string): Promise<string> {
  await adb.pull(serial, remote, local);
  return local;
}

/** Local file size of a completed pull, for `content-length`. */
export function localSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
