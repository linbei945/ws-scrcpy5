/**
 * Live-session registry, keyed by device serial.
 *
 * Every WebSocket owns its own `ScrcpySession`, so several phones / browsers
 * can mirror the same device at the same time. That means teardown has to stay
 * *private* to the client that asked for it: one viewer pressing 停止 must never
 * disturb another one.
 *
 * `adb disconnect` is the one genuinely global operation in the app. It drops
 * the adb transport that every session on that device shares, which takes all
 * the `adb forward` tunnels with it and therefore kills every other viewer's
 * session — that is the bug this registry exists to fix. The transport is now
 * released only once the last session is gone, and only after a short grace
 * period so that 停止 → 开始 does not have to reconnect.
 */
import * as adb from './adb';

export interface SettingsBackup {
  table: adb.SettingsTable;
  key: string;
  value: string;
}

/**
 * Grace period (ms) between "the last viewer left" and `adb disconnect`.
 * 0 disables the automatic disconnect entirely (the device then stays
 * connected, which is also fine — 开始 reconnects anyway).
 */
const RELEASE_DELAY_MS = Number(process.env.WS_SCRCPY_RELEASE_MS ?? 3000) || 0;

interface Entry {
  sessions: Set<object>;
  timer?: NodeJS.Timeout;
  /**
   * `show_touches` / `stay_on_while_plugged_in` are device-global, so they are
   * captured by the first session and put back by the last one. Capturing them
   * per session would let a second viewer snapshot its own already-modified
   * value and bake it in.
   */
  settings?: SettingsBackup[];
}

const devices = new Map<string, Entry>();

function entryFor(serial: string): Entry {
  let entry = devices.get(serial);
  if (!entry) {
    entry = { sessions: new Set() };
    devices.set(serial, entry);
  }
  return entry;
}

/** Register a live session. Returns how many viewers now use this device. */
export function acquire(serial: string, token: object): number {
  const entry = entryFor(serial);
  if (entry.timer) {
    // Somebody started a new session during the grace period — keep the transport.
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
  entry.sessions.add(token);
  return entry.sessions.size;
}

/** Unregister a session. Returns how many viewers are left. */
export function release(serial: string, token: object): number {
  const entry = devices.get(serial);
  if (!entry) return 0;
  entry.sessions.delete(token);
  const left = entry.sessions.size;
  if (left === 0) scheduleRelease(serial);
  return left;
}

export function activeCount(serial: string): number {
  return devices.get(serial)?.sessions.size ?? 0;
}

/**
 * True when the caller is the only session left on this device.
 *
 * A session may still be registered when it is being torn down (the WS is
 * closed after `{type:'stop'}` is handled), hence `<= 1` and not `=== 0`.
 */
export function isLastViewer(serial: string): boolean {
  return activeCount(serial) <= 1;
}

export function settingsBackup(serial: string): SettingsBackup[] | undefined {
  return devices.get(serial)?.settings;
}

export function setSettingsBackup(serial: string, backup: SettingsBackup[]): void {
  entryFor(serial).settings = backup;
}

/** Hands the backup over to the last session and forgets it. */
export function takeSettingsBackup(serial: string): SettingsBackup[] | undefined {
  const entry = devices.get(serial);
  const backup = entry?.settings;
  if (entry) entry.settings = undefined;
  return backup;
}

function scheduleRelease(serial: string): void {
  if (RELEASE_DELAY_MS <= 0) return;
  // `adb disconnect` only applies to `host:port` transports.
  if (!adb.isNetworkAddress(serial)) return;
  const entry = entryFor(serial);
  if (entry.timer) return;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    if (activeCount(serial) > 0) return;
    void adb
      .disconnect(serial)
      .then((text) => console.log(`[${serial}] 最后一个会话已结束，adb disconnect: ${text || 'ok'}`))
      .catch((e: Error) => console.error(`[${serial}] adb disconnect 失败: ${e.message}`));
  }, RELEASE_DELAY_MS);
  // Never keep the process alive just for a pending disconnect.
  entry.timer.unref?.();
}

/**
 * Serialise the operations that touch something shared by every session on a
 * device — currently the `adb push` of the server jar. Two viewers pressing 开始
 * at the same time would otherwise write the same file concurrently.
 */
const locks = new Map<string, Promise<unknown>>();

export function withDeviceLock<T>(serial: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(serial) ?? Promise.resolve();
  // Run `fn` whether or not the previous holder failed.
  const current = previous.then(fn, fn);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  locks.set(serial, settled);
  void settled.then(() => {
    if (locks.get(serial) === settled) locks.delete(serial);
  });
  return current;
}
