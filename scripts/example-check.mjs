// Builds and packs the library, installs the tarball into examples/basic, type-checks the example
// and runs its smoke test (memory store: no Redis needed). Fails (exit 1) unless the smoke test
// prints `SMOKE OK`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const example = join(root, 'examples', 'basic');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, cwd, env = process.env) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32' && command === npm,
  });
}

const packDir = mkdtempSync(join(tmpdir(), 'nestjs-cache-example-'));
let failed = null;

try {
  run(npm, ['run', 'build'], root);
  const packed = run(
    npm,
    ['pack', '--ignore-scripts', '--pack-destination', packDir, '--silent'],
    root,
  );
  const tarball = join(packDir, packed.trim().split('\n').pop());

  // The example's package.json does not list the library: it is installed from the tarball.
  const flags = ['--ignore-scripts', '--no-audit', '--no-fund'];
  run(npm, ['install', ...flags, '--no-package-lock'], example);
  run(npm, ['install', ...flags, '--no-save', '--no-package-lock', tarball], example);

  const tsc = join(example, 'node_modules', 'typescript', 'bin', 'tsc');
  run(process.execPath, [tsc, '-p', example], root);

  // A clean environment: the smoke test must run on the memory store, without metrics.
  const env = { ...process.env };
  delete env.REDIS_URL;
  delete env.METRICS;
  const output = run(process.execPath, [join(example, 'dist', 'smoke.js')], example, env);
  process.stdout.write(output);
  if (!output.split('\n').includes('SMOKE OK')) {
    throw new Error('the smoke test did not print SMOKE OK');
  }
} catch (error) {
  failed = error instanceof Error ? error.message : String(error);
} finally {
  rmSync(packDir, { recursive: true, force: true });
}

if (failed) {
  console.error(`example:check failed: ${failed}`);
  process.exit(1);
}
