/**
 * HTTP surface of the server: static files + the REST API.
 *
 *   GET  /api/version            -> { scrcpy, server }
 *   GET  /api/devices            -> adb device list
 *   POST /api/connect            -> { address }  adb connect host:port
 *   POST /api/disconnect         -> { address }  adb disconnect host:port
 *   POST /api/pair               -> { address, code }  adb pair (Android 11+)
 *   GET  /api/fs                 -> { path, parent, entries } device directory
 *   GET  /api/fs/download        -> raw bytes; adb pull of one device file
 *   POST /api/fs/upload          -> raw file body; push into a device directory
 *   POST /api/push               -> same as /api/fs/upload (kept for compat)
 *
 * Everything lives behind one request handler so that the http and the https
 * listener can share it: there is exactly one app, served twice.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import * as adb from './adb';
import * as registry from './registry';
import * as upload from './upload';
import * as fs from './fs';
import { cleanup, ensureTempDir, formatBytes, tempPathFor } from './util';
import { SCRCPY_VERSION } from '../common/protocol';

/** dist/server/routes.js -> <project>/dist/public */
const PUBLIC_DIR = resolve(dirname(__dirname), 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** POST helper: parse a JSON body, run the handler, serialise the result. */
function postJson(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (body: Record<string, unknown>) => Promise<unknown>,
): void {
  readBody(req)
    .then(async (raw) => {
      let body: Record<string, unknown> = {};
      if (raw.trim()) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          sendJson(res, 400, { error: '请求体不是合法的 JSON' });
          return;
        }
      }
      sendJson(res, 200, await handler(body));
    })
    .catch((e: Error) => {
      const status = e instanceof adb.AdbError ? e.status : 500;
      sendJson(res, status, { error: e.message });
    });
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let relative = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  if (relative === '/' || relative === '\\') relative = '/index.html';
  const filePath = join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback
    const index = join(PUBLIC_DIR, 'index.html');
    if (existsSync(index)) {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      createReadStream(index).pipe(res);
      return;
    }
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}

/**
 * The file-manager routes share the upload module's serial validation, so a bad
 * address arrives as `upload.UploadError` and not as `fs.FsError`. Mapping every
 * carrier matters: without it a rejected serial came back as a 500, which the
 * browser reports as a server crash instead of "fill in the address".
 */
function errorStatus(e: unknown): number {
  const err = e as Error & { status?: number };
  if (err instanceof upload.UploadError) return err.status;
  if (err instanceof fs.FsError) return err.status;
  if (err instanceof adb.AdbError) return err.status;
  return 500;
}

/* ------------------------------------------------------------------ */
/* upload / install                                                    */
/* ------------------------------------------------------------------ */

/**
 * Refusals that happen before a single byte is stored (feature disabled, bad
 * serial, oversized `content-length`) answer immediately and then drain the
 * body. Draining rather than destroying matters: a destroyed socket races the
 * response and the browser reports a network error instead of the reason, which
 * leaves the user staring at "推送失败: 网络错误" with no clue what was wrong.
 * The bytes are discarded, never written to disk.
 */
function refuseUpload(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  error: string,
): void {
  sendJson(res, status, { error });
  req.resume();
}

/**
 * `POST /api/fs/upload` (and the older `/api/push`) — raw file body, metadata in
 * the query string. `dir` is the destination directory the browser is showing.
 */
async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url || '').split('?')[0];
  const url = new URL(req.url || path, `http://${req.headers.host || 'localhost'}`);
  if (!upload.uploadEnabled()) {
    refuseUpload(req, res, 403, '文件推送已关闭（WS_SCRCPY_UPLOAD=off）');
    return;
  }
  let serial: string;
  try {
    serial = upload.validateSerial(url.searchParams.get('serial') ?? '');
  } catch (e) {
    refuseUpload(req, res, (e as upload.UploadError).status ?? 400, (e as Error).message);
    return;
  }
  const name = upload.safeFileName(url.searchParams.get('name') ?? '');
  const modeRaw = url.searchParams.get('mode');
  const mode: upload.PushMode =
    modeRaw === 'install' || modeRaw === 'file' ? modeRaw : 'auto';
  // The file manager sends the folder it is showing; without it files keep
  // landing in the download directory as before.
  const dirRaw = url.searchParams.get('dir');
  const dir = dirRaw ? fs.normalizeRemote(dirRaw) : undefined;
  // `limit === 0` means unlimited, so both checks have to be skipped then.
  const limit = upload.maxUploadBytes();
  const declared = Number(req.headers['content-length'] ?? '0');
  if (limit > 0 && Number.isFinite(declared) && declared > limit) {
    refuseUpload(req, res, 413, `文件超过上限 ${formatBytes(limit)}（可用 WS_SCRCPY_UPLOAD_MAX_MB 调整）`);
    return;
  }

  const tmp = tempPathFor(name);
  try {
    await ensureTempDir();
    const size = await upload.receiveUpload(req, tmp, limit);
    if (size === 0) {
      sendJson(res, 400, { error: '文件为空' });
      return;
    }
    const result = await upload.pushToDevice(serial, name, tmp, size, mode, dir);
    console.log(`[${serial}] ${result.message}`);
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, errorStatus(e), { error: (e as Error).message });
  } finally {
    // Always: a half-written APK in /tmp is a leak, and on a phone-sized
    // disk it is the kind of leak that eventually fills the volume.
    await cleanup(tmp);
  }
}

/* ------------------------------------------------------------------ */
/* device file manager                                                 */
/* ------------------------------------------------------------------ */

/** `GET /api/fs?serial=&path=` — one directory; `parent` is null at `/`. */
async function handleFsList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/api/fs', `http://${req.headers.host || 'localhost'}`);
  try {
    const serial = upload.validateSerial(url.searchParams.get('serial') ?? '');
    const path = url.searchParams.get('path') || fs.rootDir();
    sendJson(res, 200, await fs.listDir(serial, path));
  } catch (e) {
    sendJson(res, errorStatus(e), { error: (e as Error).message });
  }
}

/** Content-Disposition for a possibly non-ASCII name: RFC 5987 + ASCII fallback. */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * `GET /api/fs/download?serial=&path=` — extract one device file.
 *
 * The file is pulled to the temp directory first (adb pull has no usable
 * streaming mode) and piped to the response; the temp copy is removed when the
 * stream finishes. Directories are refused on purpose: `adb pull` on a folder
 * recurses, and one mis-click on `/sdcard` would mirror an entire phone.
 */
async function handleDownload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(
    req.url || '/api/fs/download',
    `http://${req.headers.host || 'localhost'}`,
  );
  let serial: string;
  let remote: string;
  try {
    serial = upload.validateSerial(url.searchParams.get('serial') ?? '');
    const raw = url.searchParams.get('path') ?? '';
    if (!raw.trim()) throw new fs.FsError('缺少要提取的文件路径');
    remote = fs.normalizeRemote(raw);
  } catch (e) {
    sendJson(res, errorStatus(e), { error: (e as Error).message });
    return;
  }

  const name = fs.remoteBasename(remote) || 'download.bin';
  let tmp: string | undefined;
  try {
    const info = await fs.statRemote(serial, remote);
    if (info.kind === 'dir') {
      throw new fs.FsError('这是一个目录，请进入目录后再提取其中的文件');
    }
    if (info.kind === 'link') {
      throw new fs.FsError('暂不支持提取符号链接，请进入链接指向的目录');
    }
    const limit = fs.maxDownloadBytes();
    if (limit > 0 && info.size > limit) {
      throw new fs.FsError(`文件超过下载上限 ${formatBytes(limit)}`, 413);
    }

    /*
     * `?check=1` is the browser's pre-flight. `<a download>` swallows a 403 or
     * 404 and saves the JSON error as a file, which is a terrible way to learn
     * that a directory was clicked; so the panel asks first and only then lets
     * the browser fetch the bytes.
     */
    if (url.searchParams.get('check') === '1') {
      sendJson(res, 200, { ok: true, path: remote, name, size: info.size });
      return;
    }

    await ensureTempDir();
    tmp = tempPathFor(name);
    await fs.pullToTemp(serial, remote, tmp);

    const size = fs.localSize(tmp);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(size),
      'content-disposition': disposition(name),
      'cache-control': 'no-store',
    });
    console.log(`[${serial}] 提取 ${remote}（${formatBytes(size)}）`);
    const stream = createReadStream(tmp);
    // The temp copy must outlive the stream, so it is removed on close rather
    // than in a finally block.
    stream.on('close', () => void cleanup(tmp as string));
    stream.on('error', () => {
      res.destroy();
      void cleanup(tmp as string);
    });
    stream.pipe(res);
  } catch (e) {
    if (tmp) await cleanup(tmp);
    sendJson(res, errorStatus(e), { error: (e as Error).message });
  }
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

export function createRequestHandler(): (
  req: IncomingMessage,
  res: ServerResponse,
) => void {
  return function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/api/version') {
      sendJson(res, 200, {
        scrcpy: SCRCPY_VERSION,
        name: 'ws-scrcpy5',
        version: '1.0.0',
      });
      return;
    }
    if (urlPath === '/api/devices') {
      adb
        .devices()
        .then((list) => sendJson(res, 200, { devices: list }))
        .catch((e: Error) => sendJson(res, 500, { error: e.message }));
      return;
    }
    if (urlPath === '/api/ping') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (urlPath === '/api/connect' && req.method === 'POST') {
      postJson(req, res, async (body) => {
        const address = String(body.address ?? '');
        const message = await adb.connect(address);
        return { ok: true, message: message || `已连接 ${address}`, devices: await adb.devices() };
      });
      return;
    }
    if (urlPath === '/api/disconnect' && req.method === 'POST') {
      postJson(req, res, async (body) => {
        const address = String(body.address ?? '');
        const force = body.force === true || body.force === 'true';
        const viewers = registry.activeCount(address);
        /*
         * `adb disconnect` drops the transport that every session on this device
         * shares, so it would kill every other viewer as well. Refuse while
         * somebody is still mirroring — pass `force` to override.
         */
        if (viewers > 0 && !force) {
          return {
            ok: false,
            skipped: true,
            viewers,
            message: `仍有 ${viewers} 个投屏会话在使用 ${address}，未断开 adb（停掉全部会话后会自动断开）`,
          };
        }
        const message = await adb.disconnect(address);
        return { ok: true, message: message || `已断开 ${address}`, devices: await adb.devices() };
      });
      return;
    }
    if (urlPath === '/api/pair' && req.method === 'POST') {
      postJson(req, res, async (body) => {
        const address = String(body.address ?? '');
        const code = String(body.code ?? '');
        const message = await adb.pair(address, code);
        return { ok: true, message: message || `配对成功：${address}`, devices: await adb.devices() };
      });
      return;
    }
    if ((urlPath === '/api/fs/upload' || urlPath === '/api/push') && req.method === 'POST') {
      void handleUpload(req, res);
      return;
    }
    if (urlPath === '/api/fs/download') {
      void handleDownload(req, res);
      return;
    }
    if (urlPath === '/api/fs') {
      void handleFsList(req, res);
      return;
    }
    serveStatic(req, res);
  };
}
