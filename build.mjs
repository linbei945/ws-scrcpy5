#!/usr/bin/env node
import esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'dist');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  target: 'es2020',
  logLevel: 'info',
  sourcemap: true,
};

const configs = [
  {
    ...common,
    entryPoints: [join(ROOT, 'src/server/index.ts')],
    outfile: join(DIST, 'server/index.js'),
    platform: 'node',
    format: 'cjs',
    external: ['ws'],
  },
  {
    ...common,
    entryPoints: [join(ROOT, 'src/app/main.ts')],
    outfile: join(DIST, 'public/app.js'),
    platform: 'browser',
    format: 'iife',
  },
  {
    // Software H.264 decoder (TinyH264/WASM), used when WebCodecs is not
    // available — i.e. a phone on `http://<lan-ip>`. Built as its own classic
    // worker script: `new Worker(url)` cannot load an ES module without the
    // `{type:'module'}` option, and IIFE keeps it loadable everywhere.
    ...common,
    entryPoints: [join(ROOT, 'vendor/tinyh264/H264NALDecoder.worker.ts')],
    outfile: join(DIST, 'public/decoder.worker.js'),
    platform: 'browser',
    format: 'iife',
  },
];

await rm(DIST, { recursive: true, force: true });
await mkdir(join(DIST, 'public'), { recursive: true });
await cp(join(ROOT, 'public'), join(DIST, 'public'), { recursive: true });

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching...');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  console.log('build ok');
}
