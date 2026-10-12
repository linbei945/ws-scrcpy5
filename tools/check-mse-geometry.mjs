/**
 * Regression guard for the "mirrors but cannot be controlled" bug.
 *
 * The MSE path paints the picture into a `<video>` layered over `#screen`, but
 * every pointer event (`pointerdown` / `pointermove` / `wheel` in `main.ts`) is
 * bound to the *canvas*, and `toDeviceCoords()` reads that canvas's bounding box
 * to turn a click into device coordinates.
 *
 * When `MseVideoPlayer.resize()` was a no-op the canvas kept its markup size of
 * 1x1: a single pixel in the middle of the stage. Clicks passed straight through
 * the `<video>` (which is `pointer-events: none`) and landed on `#stage` instead,
 * so no listener ever fired — video worked, input did not. It only ever showed
 * up away from localhost, because that is where WebCodecs is withheld and the
 * MSE player is selected at all.
 *
 * The failure is silent and browser-only, so it needs a guard: this asserts the
 * resize implementation still owns the canvas geometry.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const FILE = join(ROOT, 'src', 'app', 'mse-video.ts');

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

console.log('mse input geometry');

const src = readFileSync(FILE, 'utf8');

check('mse-video.ts keeps a canvas reference', /private\s+readonly\s+canvas:\s*HTMLCanvasElement/.test(src));

/*
 * Match the method and capture everything up to the next `  }` at the same
 * indent, which is the closing brace of the method in this file's style.
 */
const method = /resize\(([^)]*)\)\s*:\s*void\s*\{([\s\S]*?)\n {2}\}/.exec(src);
check('mse-video.ts declares resize()', !!method);

if (method) {
  const [, params, body] = method;
  // A `_width` signature is how the previous no-op was written; it is the exact
  // shape this guard exists to catch.
  check('resize() is not written as a no-op', !/_\w+/.test(params), params.trim());
  check('resize() assigns canvas.width', /this\.canvas\.width\s*=/.test(body));
  check('resize() assigns canvas.height', /this\.canvas\.height\s*=/.test(body));
  check('resize() guards against a zero size', /width\s*>\s*0/.test(body));
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
