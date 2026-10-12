/**
 * Minimal `adb` command line wrapper.
 *
 * WS-scrcpy5 drives the official scrcpy-server through `adb`, so the only
 * dependency is the platform-tools binary available in PATH (or in $ADB).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
}

export class AdbError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    /** HTTP status the server should report for this failure. */
    readonly status = 500,
  ) {
    super(message);
    this.name = 'AdbError';
  }
}

/** Caller supplied something adb cannot work with (bad address, bad code…). */
function badRequest(message: string): AdbError {
  return new AdbError(message, undefined, 400);
}

/**
 * Project root. Both `dist/server/index.js` and `src/server/*.ts` sit exactly
 * two levels below it, so a single rule covers built and source runs.
 */
const PROJECT_ROOT = resolve(
  typeof __dirname === 'string' ? join(__dirname, '..', '..') : process.cwd(),
);

/**
 * Every `adb` the project may have shipped next to the runtime, most specific
 * first:
 *
 *   <root>/adb            - the standalone `pc/` folder (self-contained copy)
 *   <root>/pc/adb         - inside the repository
 *   <root>/tools/platform-tools - layout used before the pc/ split
 *
 * `PROJECT_ROOT` is two levels up from `dist/server/index.js`; a run from the
 * source tree resolves the same way because `src/server/*.ts` is the same
 * depth. `process.cwd()` covers `node dist/server/index.js` from a directory
 * other than the project root.
 */
function bundledAdb(): string | undefined {
  const names = process.platform === 'win32' ? ['adb.exe', 'adb'] : ['adb'];
  const roots = [
    join(PROJECT_ROOT, 'adb'),
    join(PROJECT_ROOT, 'pc', 'adb'),
    join(PROJECT_ROOT, '..', 'pc', 'adb'),
    join(PROJECT_ROOT, 'tools', 'platform-tools'),
    join(process.cwd(), 'adb'),
    join(process.cwd(), 'pc', 'adb'),
    join(process.cwd(), 'tools', 'platform-tools'),
  ];
  for (const root of roots) {
    for (const name of names) {
      const candidate = join(root, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Turns a bare command name into an absolute path by searching PATH.
 *
 * `spawn` happily accepts a bare name, but the startup banner prints the adb it
 * is going to run and then calls `existsSync()` on it — false for `adb`, so a
 * perfectly working install was reported as "未找到" (every Docker run, and any
 * Linux box relying on PATH). Resolving once keeps that report honest.
 *
 * Windows needs PATHEXT (`adb.exe`, `adb.cmd`…); POSIX does not.
 */
export function resolveOnPath(name: string): string | undefined {
  if (name.includes('/') || name.includes('\\')) return name;
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const suffixes =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((s) => s.trim()).filter(Boolean)]
      : [''];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, name + suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

let resolvedAdb: string | undefined;

export function adbPath(): string {
  if (process.env.ADB) return process.env.ADB;
  if (!resolvedAdb) resolvedAdb = bundledAdb() ?? resolveOnPath('adb') ?? 'adb';
  return resolvedAdb;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(args: string[], timeoutMs = 20000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(adbPath(), args, { windowsHide: true });
    } catch (e) {
      reject(new AdbError('adb executable not found. Install Android platform-tools and/or set $ADB.'));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new AdbError(`adb ${args.join(' ')} timed out`));
    }, timeoutMs);

    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (e.code === 'ENOENT') {
        reject(new AdbError('adb executable not found. Install Android platform-tools and/or set $ADB.'));
      } else {
        reject(new AdbError(`adb failed: ${e.message}`));
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

export async function version(): Promise<string> {
  const { stdout } = await run(['version']);
  return stdout.trim();
}

export async function startServer(): Promise<void> {
  await run(['start-server']);
}

/** `adb devices -l` */
export async function devices(): Promise<AdbDevice[]> {
  await startServer();
  const { stdout } = await run(['devices', '-l']);
  const out: AdbDevice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('List of devices') || trimmed.startsWith('*')) continue;
    const [serial, state, ...rest] = trimmed.split(/\s+/);
    if (!serial || !state) continue;
    const device: AdbDevice = { serial, state };
    for (const token of rest) {
      const idx = token.indexOf(':');
      if (idx === -1) continue;
      const key = token.slice(0, idx);
      const value = token.slice(idx + 1);
      if (key === 'model') device.model = value;
      else if (key === 'product') device.product = value;
      else if (key === 'device') device.device = value;
      else if (key === 'transport_id') device.transportId = value;
    }
    out.push(device);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* wireless / tcp-ip devices                                           */
/* ------------------------------------------------------------------ */

/** `192.168.5.1:5555`, `localhost:5555`, `my-phone.local:5555` … */
const NETWORK_ADDRESS = /^[A-Za-z0-9._-]+:\d{1,5}$/;

export function isNetworkAddress(serial: string): boolean {
  return NETWORK_ADDRESS.test(serial.trim());
}

const CONNECT_FAILURE =
  /cannot connect|failed to connect|unable to connect|connection refused|actively refused|no route to host|timed out|unknown host|unable to resolve/i;

/**
 * `adb connect host:port` (Android 11+ wireless debugging, or `adb tcpip`).
 *
 * adb exits with 0 even when it cannot reach the device, so the output has to
 * be inspected as well.
 */
export async function connect(address: string, timeoutMs = 20000): Promise<string> {
  const target = address.trim();
  if (!isNetworkAddress(target)) {
    throw badRequest(`无效的地址「${address}」，应形如 192.168.5.1:5555`);
  }
  const { stdout, stderr, code } = await run(['connect', target], timeoutMs);
  const text = `${stdout}${stderr}`.trim();
  if (code !== 0 || CONNECT_FAILURE.test(text)) {
    throw badRequest(`adb connect ${target} 失败：${text || `exit code ${code}`}`);
  }
  return text;
}

export async function disconnect(address: string): Promise<string> {
  const target = address.trim();
  const { stdout, stderr, code } = await run(['disconnect', target]);
  const text = `${stdout}${stderr}`.trim();
  if (code !== 0) {
    throw badRequest(`adb disconnect ${target} 失败：${text || `exit code ${code}`}`);
  }
  return text;
}

/** Android 11+ pairing: `adb pair host:port code`. */
export async function pair(address: string, code: string, timeoutMs = 30000): Promise<string> {
  const target = address.trim();
  if (!isNetworkAddress(target)) {
    throw badRequest(`无效的配对地址「${address}」，应形如 192.168.5.1:37000`);
  }
  const pin = code.trim();
  if (!/^\d{4,8}$/.test(pin)) {
    throw badRequest('配对码必须是 4~8 位数字');
  }
  const { stdout, stderr, code: exit } = await run(['pair', target, pin], timeoutMs);
  const text = `${stdout}${stderr}`.trim();
  if (exit !== 0 || /failed|cannot|unable|incorrect|wrong/i.test(text)) {
    throw badRequest(`adb pair ${target} 失败：${text || `exit code ${exit}`}`);
  }
  return text;
}

/**
 * Make sure a network device is reachable before `adb push`/`shell` is used.
 * USB serials and emulators are returned untouched.
 */
export async function ensureConnected(serial: string): Promise<void> {
  if (!isNetworkAddress(serial)) return;
  const list = await devices();
  const found = list.find((d) => d.serial === serial);
  if (found && found.state === 'device') return;
  await connect(serial);
}

/**
 * A timeout budget for moving `bytes` to or from a device.
 *
 * Fixed budgets cut large transfers off in the middle: the old `adb push` cap
 * was 5 minutes, which a 1–2 GB game package over wireless adb never fits in.
 * The floor is a deliberately pessimistic 2 MB/s — wireless adb is usually
 * several times faster, so this is only an upper bound; the call still returns
 * as soon as adb is done.
 */
export function transferTimeout(bytes: number, baseMs = 120_000): number {
  const perByteMs = 1000 / (2 * 1024 * 1024);
  const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return Math.round(baseMs + size * perByteMs);
}

export async function push(
  serial: string,
  local: string,
  remote: string,
  timeoutMs = transferTimeout(0),
): Promise<void> {
  const { stdout, stderr, code } = await run(['-s', serial, 'push', local, remote], timeoutMs);
  if (code !== 0) {
    throw new AdbError(`adb push failed: ${stderr.trim() || stdout.trim()}`);
  }
}

/**
 * `adb install -r -t <apk>`.
 *
 * - `-r` reinstall while keeping the app's data (installing over an existing
 *   app is the whole point of dropping an APK twice).
 * - `-t` allows test-only packages, which is what most debug builds are.
 *
 * adb reports a failed install on stdout/stderr rather than only through the
 * exit code, so the raw output is handed back for the caller to explain.
 */
export async function install(
  serial: string,
  apk: string,
  timeoutMs = 300_000,
): Promise<{ ok: boolean; output: string }> {
  const { stdout, stderr, code } = await run(['-s', serial, 'install', '-r', '-t', apk], timeoutMs);
  const output = `${stdout}${stderr}`.trim();
  return { ok: code === 0 && !/Failure\s*\[/i.test(output), output };
}

/**
 * `adb forward tcp:<port> localabstract:<name>`.
 * When port is 0, adb picks a free port and prints it.
 */
export async function forward(serial: string, abstractName: string, port = 0): Promise<number> {
  const { stdout, stderr, code } = await run([
    '-s',
    serial,
    'forward',
    `tcp:${port}`,
    `localabstract:${abstractName}`,
  ]);
  if (code !== 0) {
    throw new AdbError(`adb forward failed: ${stderr.trim() || stdout.trim()}`);
  }
  const parsed = parseInt(stdout.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AdbError(`adb forward returned an unexpected port: "${stdout.trim()}"`);
  }
  return parsed;
}

export async function removeForward(serial: string, port: number): Promise<void> {
  try {
    await run(['-s', serial, 'forward', '--remove', `tcp:${port}`]);
  } catch {
    // best effort
  }
}

/** Run a short command on the device and return its stdout. */
export async function shellOut(serial: string, args: string[], timeoutMs = 15000): Promise<string> {
  const { stdout } = await run(['-s', serial, 'shell', ...args], timeoutMs);
  return stdout.trim();
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run a whole shell command string on the device, keeping stderr and the exit
 * code.
 *
 * The file manager needs both: `ls` reports "Permission denied" / "No such
 * file" on stderr and still exits 0 on some ROMs, so an empty stdout alone
 * cannot be told apart from an empty directory.
 *
 * `command` is passed as a *single* argument, which makes adb hand the string
 * to the device shell verbatim — the caller is responsible for quoting any
 * user-supplied path (see `fs.quoteShell`).
 */
export async function shellResult(
  serial: string,
  command: string,
  timeoutMs = 20000,
): Promise<ShellResult> {
  return run(['-s', serial, 'shell', command], timeoutMs);
}

/** `adb pull <remote> <local>` — used to extract a device file. */
export async function pull(
  serial: string,
  remote: string,
  local: string,
  timeoutMs = 300_000,
): Promise<void> {
  const { stdout, stderr, code } = await run(['-s', serial, 'pull', remote, local], timeoutMs);
  if (code !== 0) {
    throw new AdbError(`adb pull failed: ${stderr.trim() || stdout.trim()}`);
  }
}

export type SettingsTable = 'system' | 'global' | 'secure';

export async function getSetting(
  serial: string,
  table: SettingsTable,
  key: string,
): Promise<string> {
  return shellOut(serial, ['settings', 'get', table, key]);
}

export async function putSetting(
  serial: string,
  table: SettingsTable,
  key: string,
  value: string,
): Promise<void> {
  await shellOut(serial, ['settings', 'put', table, key, value]);
}

export async function deleteSetting(
  serial: string,
  table: SettingsTable,
  key: string,
): Promise<void> {
  await shellOut(serial, ['settings', 'delete', table, key]);
}

export interface ShellProcess {
  child: ChildProcess;
  onExit: (cb: (code: number | null) => void) => void;
  kill: () => void;
}

/**
 * Start a long running command on the device: `adb -s <serial> shell <args...>`.
 */
export function shell(serial: string, args: string[]): ShellProcess {
  const child = spawn(adbPath(), ['-s', serial, 'shell', ...args], { windowsHide: true });
  return {
    child,
    onExit: (cb) => child.on('close', cb),
    kill: () => {
      if (!child.killed && child.exitCode === null) child.kill();
    },
  };
}
