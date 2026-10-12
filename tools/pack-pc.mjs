/**
 * Builds the distributable `ws-scrcpy5-pc.zip`.
 *
 * Written because this machine has no `zip` or `7z` binary, and the archive has
 * to be produced identically every time. Uses only Node's `zlib`, so it runs
 * anywhere the rest of the project does.
 *
 * Two things matter for "works on another computer":
 *
 *  1. **Forward slashes and a single top-level folder.** Windows Explorer and
 *     cmd.exe both choke on archives whose entries use backslashes, and
 *     extracting straight into a folder full of loose files is how users end up
 *     running `start.cmd` from the wrong directory.
 *
 *  2. **The executable bits and CRLF endings survive.** `adb.exe` is binary and
 *     `start.cmd` must keep its CRLF; both are read and written as raw bytes
 *     here, never through a text conversion.
 *
 *   node tools/pack-pc.mjs [output.zip]
 */
import { createWriteStream, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(process.argv[2] ?? join(ROOT, 'ws-scrcpy5-pc.zip'));
/** Folder created on extraction: everything lands under this one name. */
const PREFIX = 'ws-scrcpy5-pc';

/**
 * Never shipped.
 *
 * `node_modules/.cache` holds the bundle cache the test suite writes and can
 * grow to tens of megabytes of stale build products. `.workbuddy` is this
 * project's own notes/memory - useful to us, meaningless (and confusing) to
 * whoever receives the archive. `dist` is deliberately *kept*: it makes the
 * first launch instant, and `start.cmd` rebuilds it on every run anyway, so a
 * stale copy cannot linger. `adbkeys` holds the adb *private* authorization key
 * (`adbkey`) for every phone this machine has ever paired — machine-specific and
 * never something to hand to relatives. `certs` is a leftover self-signed TLS
 * private key from when the project had built-in HTTPS; the feature was removed
 * (the project is HTTP-only now, TLS is terminated by a reverse proxy), so these
 * are stale local files whose key material must not be distributed.
 */
const EXCLUDE_DIRS = new Set(['.cache', '.workbuddy', '.git', 'adbkeys', 'certs']);
/**
 * `ws-scrcpy5-images.tar.gz` is the exported Docker image (hundreds of MB) —
 * useful for moving the container to another machine, meaningless inside the
 * self-contained PC archive.
 */
const EXCLUDE_FILES = new Set([
  'ws-scrcpy5-pc.zip',
  'ws-scrcpy5-docker-amd64.tar.gz',
  'ws-scrcpy5-docker-arm64.tar.gz',
  '.DS_Store',
  'Thumbs.db',
]);

function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_FILES.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      collect(full, out);
    } else if (st.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ crc32 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------- zip local records */

/*
 * A ZIP entry is a local file header + name + compressed data, followed (after
 * all entries) by a central directory describing each one, then an end-of-
 * central-directory record. Offsets in the central directory are absolute from
 * the start of the file, so they are tracked as we stream.
 */
function dosDateTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

const files = collect(ROOT).sort();
const chunks = [];
const central = [];
let offset = 0;

for (const file of files) {
  const data = readFileSync(file); // raw bytes: binary files and CRLF survive
  const name = `${PREFIX}/${relative(ROOT, file).split(sep).join('/')}`;
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const deflated = deflateRawSync(data, { level: 9 });
  // Store uncompressed when deflate does not help (tiny or already-compressed).
  const useStore = deflated.length >= data.length;
  const body = useStore ? data : deflated;
  const method = useStore ? 0 : 8;
  const { time, day } = dosDateTime(statSync(file).mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra length

  chunks.push(local, nameBuf, body);

  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4); // version made by
  dir.writeUInt16LE(20, 6); // version needed
  dir.writeUInt16LE(0, 8);
  dir.writeUInt16LE(method, 10);
  dir.writeUInt16LE(time, 12);
  dir.writeUInt16LE(day, 14);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(body.length, 20);
  dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(nameBuf.length, 28);
  dir.writeUInt16LE(0, 30); // extra
  dir.writeUInt16LE(0, 32); // comment
  dir.writeUInt16LE(0, 34); // disk
  dir.writeUInt16LE(0, 36); // internal attrs
  // 0o755 << 16 marks the entry executable, which is what preserves adb.exe's
  // run permission if the archive is ever extracted on a unix host. The shift
  // overflows signed 32-bit, so coerce back with `>>> 0`.
  dir.writeUInt32LE((0o100755 << 16) >>> 0, 38);
  dir.writeUInt32LE(offset, 42);
  central.push(dir, nameBuf);

  offset += local.length + nameBuf.length + body.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

const out = createWriteStream(OUT);
for (const c of chunks) out.write(c);
out.write(centralBuf);
out.write(end);
out.end();

await new Promise((r, j) => {
  out.on('finish', r);
  out.on('error', j);
});

const total = statSync(OUT).size;
const raw = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(`${relative(ROOT, OUT)}`);
console.log(`  files   ${files.length}`);
console.log(`  raw     ${(raw / 1048576).toFixed(1)} MB`);
console.log(`  zipped  ${(total / 1048576).toFixed(1)} MB`);
console.log(`  root    ${PREFIX}/`);
