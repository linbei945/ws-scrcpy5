/**
 * Small server-side helpers shared by the file upload and file manager routes.
 *
 * Kept in one place because both modules need the exact same two things — a
 * human readable size for the log, and a temp directory that is always cleaned
 * up. Duplicating either is how a leak in `finally` gets fixed in one file and
 * forgotten in the other.
 */
import { mkdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Scratch space for files in transit — an APK being installed, a file being
 * pulled off the device.
 *
 * `os.tmpdir()` rather than a project folder: it is writable everywhere
 * including a read-only container filesystem, and in Docker it lands on the
 * container's writable layer (mount a tmpfs if you push big files through it).
 */
export function tempDir(): string {
  return join(tmpdir(), 'ws-scrcpy5-uploads');
}

/** Randomised temp path so two viewers cannot collide on the same name. */
export function tempPathFor(name: string): string {
  return join(tempDir(), `${randomBytes(8).toString('hex')}-${safeSegment(name)}`);
}

export async function ensureTempDir(): Promise<void> {
  await mkdir(tempDir(), { recursive: true });
}

export async function cleanup(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    /* nothing else we can do; the OS reclaims /tmp */
  }
}

/** Only used to keep the temp name readable — it never reaches a shell. */
function safeSegment(name: string): string {
  return String(name ?? '')
    .replace(/[^\w.\-一-龥]/g, '_')
    .slice(0, 80);
}
