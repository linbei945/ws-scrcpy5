/**
 * WS-scrcpy5 server entry point: one HTTP listener and a WebSocket bridge.
 *
 *   http://<host>:8080   the only listener. `localhost` is a secure context, so
 *                        WebCodecs is available there; behind a reverse proxy the
 *                        browser also sees https and gets WebCodecs. Plain http on
 *                        a LAN IP falls back to MSE (no certificate to install).
 *
 * The REST API and the static files live in `routes.ts`; this file only wires
 * the listeners and turns each WebSocket into one scrcpy session.
 *
 * WebSocket frames (server -> browser)
 *   text   : JSON events (init / clipboard / log / closed / error)
 *   binary : [1 byte channel][raw scrcpy stream bytes]
 *
 * WebSocket frames (browser -> server)
 *   binary : raw scrcpy control message, forwarded as-is to the device
 *   text   : JSON commands ({ "type": "stop" })
 */
import http from 'node:http';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';

import * as adb from './adb';
import * as registry from './registry';
import * as upload from './upload';
import * as fs from './fs';
import { formatBytes } from './util';
import { createRequestHandler } from './routes';
import { ScrcpySession, type SessionOptions } from './session';
import { SCRCPY_VERSION, DeviceMessageType, closeReason } from '../common/protocol';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const handleRequest = createRequestHandler();

/*
 * `requestTimeout` covers receiving the *whole* request, body included, and
 * Node 18+ defaults it to 300 s. That silently kills a large file upload: a
 * 2 GB game package at even 7 MB/s needs nearly five minutes to arrive, and the
 * server answers 408 and drops the socket half-way through. Uploads are sized
 * by whatever the user picked, so there is no correct finite value — disable it
 * and let the route finish. (This is a LAN tool; a deliberately stalled upload
 * is not the threat model.)
 */
const NO_REQUEST_TIMEOUT = { requestTimeout: 0 } as const;

const server = http.createServer(NO_REQUEST_TIMEOUT, handleRequest);

/*
 * `noServer` + a manual upgrade handler, because the WebSocket server is reached
 * over ws:// on the single http listener.
 */
const wss = new WebSocketServer({ noServer: true });

function handleUpgrade(
  req: http.IncomingMessage,
  socket: import('node:stream').Duplex,
  head: Buffer,
): void {
  const path = (req.url || '').split('?')[0];
  if (path !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

server.on('upgrade', handleUpgrade);

function num(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const url = new URL(req.url || '/ws', `http://${req.headers.host || 'localhost'}`);
  const q = url.searchParams;
  const serial = q.get('serial');
  if (!serial) {
    ws.send(JSON.stringify({ type: 'error', message: 'missing "serial" query parameter' }));
    ws.close(4000, closeReason('missing serial'));
    return;
  }

  const options: SessionOptions = {
    serial,
    // The video codec is not negotiable: every client decoder this project
    // ships (WebCodecs, MSE, WASM) is fed H.264 by construction, so the codec
    // is pinned in `ScrcpySession.buildServerArgs()` rather than read from the
    // query string.
    container: q.get('container') === 'mse' ? 'mse' : undefined,
    audioCodec: q.get('audioCodec') || 'opus',
    audio: q.get('audio') === 'true' || q.get('audio') === '1',
    video: q.get('video') !== 'false',
    control: q.get('control') !== 'false',
    maxSize: num(q.get('maxSize')),
    videoBitRate: num(q.get('videoBitRate')),
    audioBitRate: num(q.get('audioBitRate')),
    maxFps: num(q.get('maxFps')),
    displayId: num(q.get('displayId')),
    crop: q.get('crop') || undefined,
    videoEncoder: q.get('videoEncoder') || undefined,
    audioEncoder: q.get('audioEncoder') || undefined,
    stayAwake: q.get('stayAwake') === 'true',
    showTouches: q.get('showTouches') === 'true',
    // off by default: CleanUp unlinks the server jar and kills the session on
    // some devices (redroid). Opt in with cleanup=true.
    cleanup: q.get('cleanup') === 'true',
    logLevel: q.get('logLevel') || 'info',
  };

  /*
   * Count this viewer against the device. Everything that is shared per device
   * (the adb transport, the jar, the display settings) consults the registry, so
   * one viewer's teardown can never take another viewer down with it.
   */
  const viewers = registry.acquire(serial, ws);
  if (viewers > 1) console.log(`[${serial}] 第 ${viewers} 个会话接入（互不干扰）`);

  let closed = false;
  const safeSend = (data: string | Buffer): void => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(data);
    } catch {
      /* ignore */
    }
  };

  let session: ScrcpySession;
  try {
    session = new ScrcpySession(options, {
      onInit: (init) => safeSend(JSON.stringify({ type: 'init', ...init })),
      onMedia: (channel, data) => {
        const frame = Buffer.allocUnsafe(data.length + 1);
        frame[0] = channel;
        Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(frame, 1);
        safeSend(frame);
      },
      onDeviceMessage: (msg) => {
        if (msg.type === DeviceMessageType.CLIPBOARD) {
          safeSend(JSON.stringify({ type: 'clipboard', text: msg.text }));
        } else if (msg.type === DeviceMessageType.ACK_CLIPBOARD) {
          safeSend(JSON.stringify({ type: 'clipboardAck', sequence: msg.sequence }));
        }
      },
      onLog: (message) => {
        console.log(`[${serial}] ${message}`);
        if (process.env.WS_SCRCPY_VERBOSE === '1') {
          safeSend(JSON.stringify({ type: 'log', message }));
        }
      },
      onClosed: (reason) => {
        safeSend(JSON.stringify({ type: 'closed', reason: reason ?? 'stopped' }));
        closed = true;
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, closeReason(reason ?? 'stopped'));
      },
    });
  } catch (e) {
    // e.g. `video=false` + no audio: nothing was started, so unregister at once
    // (a stale entry would block the automatic `adb disconnect` forever).
    registry.release(serial, ws);
    const message = (e as Error).message;
    safeSend(JSON.stringify({ type: 'error', message }));
    ws.close(4002, closeReason(message));
    return;
  }

  ws.on('message', (raw, isBinary) => {
    // A single malformed client frame must never take the server down.
    try {
      if (isBinary) {
        const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as Buffer);
        session.sendControl(new Uint8Array(data));
        return;
      }
      const text = raw.toString();
      try {
        const msg = JSON.parse(text) as { type?: string };
        if (msg.type === 'stop') {
          void session.stop('stopped by client');
        }
      } catch {
        /* ignore malformed json */
      }
    } catch (e) {
      console.error(`[${serial}] failed to handle client message: ${(e as Error).message}`);
    }
  });

  const closeSession = (): void => {
    closed = true;
    // Release first: `session.stop()` then sees the *other* viewers only and
    // knows whether it is the last one out (device settings, adb transport).
    const left = registry.release(serial, ws);
    void session.stop(left > 0 ? 'client disconnected' : 'client disconnected (last viewer)');
  };
  ws.on('close', closeSession);
  ws.on('error', closeSession);

  session
    .start()
    .then(() => {
      console.log(
        `[${serial}] session started (video=h264${options.container ? `/${options.container}` : ''}, audio=${options.audio})`,
      );
    })
    .catch((e: Error) => {
      console.error(`[${serial}] ${e.message}`);
      registry.release(serial, ws);
      safeSend(JSON.stringify({ type: 'error', message: e.message }));
      closed = true;
      if (ws.readyState === WebSocket.OPEN) ws.close(4001, closeReason(e.message));
    });
});

/** Non-internal IPv4 addresses, so the same box can be opened from a phone. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function logStartup(): void {
  const bin = adb.adbPath();
  console.log(`ws-scrcpy5 (scrcpy-server ${SCRCPY_VERSION}) is ready`);
  console.log(`  本机    http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  局域网  http://${ip}:${PORT}`);
  console.log('  说明    手机用上面的 http 地址即可：自动启用硬件解码（MSE），无需证书');
  console.log(
    `  adb     ${bin}${existsSync(bin) ? '' : '  (未找到，请安装 platform-tools 或设置 ADB 环境变量)'}`,
  );
  if (upload.uploadEnabled()) {
    const cap = upload.maxUploadBytes();
    console.log(
      `  文件    上传${cap > 0 ? `上限 ${formatBytes(cap)}` : '无大小限制'}，默认目录 ${upload.uploadDir()}`,
    );
  } else {
    console.log('  文件    上传/安装已关闭（WS_SCRCPY_UPLOAD=off），浏览与提取不受影响');
  }
  const dlLimit = fs.maxDownloadBytes();
  console.log(
    `  提取    根目录 ${fs.rootDir()}${dlLimit > 0 ? `，单个文件上限 ${formatBytes(dlLimit)}` : ''}`,
  );
}

server.listen(PORT, HOST, logStartup);

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
