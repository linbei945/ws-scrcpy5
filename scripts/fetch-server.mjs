#!/usr/bin/env node
/**
 * Download the official scrcpy-server binary matching SCRCPY_VERSION.
 *
 * WS-scrcpy5 does NOT need a patched scrcpy server: it drives the official
 * one over an adb tunnel, so the jar is simply downloaded from the upstream
 * release page.
 */
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, stat, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = process.env.SCRCPY_VERSION || '5.0.1';
/*
 * Mirror defaultServerJar(): write next to the runtime that will look for it.
 * In the repository that is `pc/server/`; in the standalone `pc/` folder there
 * is no `pc/` inside it, so it is simply `server/`.
 */
const TARGET_DIR = existsSync(join(ROOT, 'pc')) ? join(ROOT, 'pc', 'server') : join(ROOT, 'server');
const TARGET = join(TARGET_DIR, `scrcpy-server-v${VERSION}`);
const URL = `https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`;

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'user-agent': 'ws-scrcpy5' } }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects > 5) return reject(new Error('Too many redirects'));
          return resolve(download(res.headers.location, redirects + 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`Download failed: HTTP ${status}`));
        }
        const tmp = `${TARGET}.part`;
        const file = createWriteStream(tmp);
        res.pipe(file);
        file.on('error', reject);
        file.on('finish', () => resolve(tmp));
      })
      .on('error', reject);
  });
}

async function main() {
  await mkdir(TARGET_DIR, { recursive: true });
  try {
    const s = await stat(TARGET);
    if (s.size > 1024) {
      console.log(`scrcpy-server v${VERSION} already present (${s.size} bytes): ${TARGET}`);
      return;
    }
  } catch {
    // not downloaded yet
  }
  console.log(`Downloading ${URL}`);
  const tmp = await download(URL);
  await rename(tmp, TARGET);
  const s = await stat(TARGET);
  console.log(`Saved ${TARGET} (${s.size} bytes)`);
}

main().catch(async (e) => {
  console.error(e.message);
  try {
    await unlink(`${TARGET}.part`);
  } catch {
    /* ignore */
  }
  process.exit(1);
});
