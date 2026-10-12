/**
 * Guards a Windows-only footgun: `.cmd` / `.bat` files must keep CRLF line
 * endings. cmd.exe parses LF-only batch files incorrectly — every line after a
 * `for ... do (` block explodes with「'xxx' 不是内部或外部命令」— and editors /
 * patch tools happily rewrite the whole file with LF. This check runs as part
 * of `npm test` so the breakage can never ship unnoticed.
 *
 *   node tools/check-eol.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
/*
 * Only dirs that could hold binary or generated files are skipped. `pc/adb`
 * and `pc/server` are deliberately walked: they hold no `.cmd`, so they cost
 * nothing, and skipping by bare name would also swallow `src/server`.
 */
const SKIP = new Set(['node_modules', 'dist', 'certs', 'docs', '.git']);
const PATTERNS = /\.(cmd|bat)$/i;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (PATTERNS.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const broken = [];

for (const file of files) {
  const data = readFileSync(file, 'utf8');
  const crlf = (data.match(/\r\n/g) ?? []).length;
  const lf = (data.match(/\n/g) ?? []).length;
  const loneLf = lf - crlf;
  // A non-ASCII byte in a batch file is echoed through the console code page,
  // which garbles UTF-8 on a Chinese Windows install — keep them ASCII.
  const nonAscii = [...data].some((ch) => ch.charCodeAt(0) > 126);
  if (loneLf > 0 || crlf === 0) {
    broken.push(`${relative(ROOT, file)}: ${loneLf} 个 LF 行尾（需要 CRLF）`);
  } else if (nonAscii) {
    broken.push(`${relative(ROOT, file)}: 含非 ASCII 字符（cmd 默认代码页会乱码）`);
  }
}

for (const file of files) console.log(`  ok  ${relative(ROOT, file)}`);
if (broken.length === 0) {
  console.log('all batch files use CRLF and ASCII only');
} else {
  for (const line of broken) console.error(`  FAIL ${line}`);
  console.error('\n用下面这行修：python -c "p=\'start.cmd\';d=open(p,\'rb\').read();open(p,\'wb\').write(d.replace(b\'\\r\\n\',b\'\\n\').replace(b\'\\n\',b\'\\r\\n\'))"');
  process.exitCode = 1;
}
