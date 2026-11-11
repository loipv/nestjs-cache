// Verifies the npm tarball contents. Runs `npm pack --dry-run --json` (on the existing dist/,
// so build first) and fails (exit 1) on any violation.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let info;
try {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  [info] = JSON.parse(out);
} catch (error) {
  const detail = error.status != null ? `exit ${error.status}` : error.message;
  console.error(`check:pack failed: \`npm pack --dry-run --json\` did not succeed (${detail})`);
  process.exit(1);
}
const files = info.files.map((f) => f.path);
const fileSet = new Set(files);
const violations = [];

// 1. Only the build output and these top-level files ship: no sources, tests, docs or tooling.
const requiredTop = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'];
for (const p of files) {
  if (!requiredTop.includes(p) && !p.startsWith('dist/')) {
    violations.push(`unexpected file in tarball: ${p}`);
  }
}
for (const p of requiredTop) {
  if (!fileSet.has(p)) violations.push(`required file missing from tarball: ${p}`);
}

// 2. Every file target in `exports` (at any nesting of conditions) is in the tarball.
function targets(value, path) {
  if (typeof value === 'string') return [[path, value]];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => targets(v, `${path}.${k}`));
}
for (const [path, target] of targets(pkg.exports ?? {}, 'exports')) {
  const rel = posix.normalize(target);
  if (!fileSet.has(rel)) violations.push(`${path} missing from tarball: ${rel}`);
}
for (const field of ['main', 'module', 'types']) {
  if (typeof pkg[field] === 'string' && !fileSet.has(posix.normalize(pkg[field]))) {
    violations.push(`${field} missing from tarball: ${pkg[field]}`);
  }
}

// 3. No test files.
for (const p of files) {
  if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(p) || /\.(spec|test)\.d\.[cm]?ts$/.test(p)) {
    violations.push(`test file shipped in tarball: ${p}`);
  }
}

// 4. Sourcemaps are self-contained: `src/` does not ship, so every source must be inlined.
for (const p of files) {
  if (!p.startsWith('dist/') || !p.endsWith('.map')) continue;
  let map;
  try {
    map = JSON.parse(readFileSync(join(root, p), 'utf8'));
  } catch (error) {
    violations.push(`cannot read sourcemap ${p}: ${error.message}`);
    continue;
  }
  const contents = map.sourcesContent ?? [];
  (map.sources ?? []).forEach((source, i) => {
    if (typeof contents[i] !== 'string') {
      violations.push(`sourcemap ${p} does not inline its source ${source}`);
    }
  });
}

// 5. The published declarations carry no member marked `@internal` (`stripInternal`): for
// example `CacheEvents.emit` and `sinkFor` stay out of the public types.
for (const p of ['dist/index.d.ts', 'dist/index.d.cts']) {
  if (!fileSet.has(p)) continue;
  const dts = readFileSync(join(root, p), 'utf8');
  if (dts.includes('@internal')) violations.push(`${p} contains a declaration marked @internal`);
  for (const member of ['emit<E extends keyof CacheEventMap>', 'sinkFor(']) {
    if (dts.includes(member)) violations.push(`${p} declares the internal member ${member}`);
  }
}

// 6. Peer dependencies are not bundled: rxjs (a peer since 0.9) is imported, not inlined.
for (const p of ['dist/index.js', 'dist/index.cjs']) {
  if (!fileSet.has(p)) continue;
  if (/function Observable\d*\(/.test(readFileSync(join(root, p), 'utf8'))) {
    violations.push(`${p} bundles rxjs (it must stay an external peer dependency)`);
  }
}

if (violations.length > 0) {
  console.error(`check:pack failed with ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`check:pack ok: ${files.length} files, ${info.size} bytes packed`);
