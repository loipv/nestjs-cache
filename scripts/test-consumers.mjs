import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const consumersDir = join(root, 'test', 'consumers');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const apps = [
  { name: 'nest11-cjs', main: 'main.cjs' },
  { name: 'nest12-esm', main: 'main.mjs' },
];

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32' && command === npm,
  });
}

let tarball;
let failed = null;

try {
  run(npm, ['run', 'build'], root);
  const packed = run(npm, ['pack', '--pack-destination', consumersDir, '--silent'], root);
  tarball = join(consumersDir, packed.trim().split('\n').pop());

  for (const app of apps) {
    const cwd = join(consumersDir, app.name);
    try {
      run(npm, ['install', '--no-audit', '--no-fund', '--no-package-lock'], cwd);
      run(npm, ['install', '--no-save', '--no-audit', '--no-fund', tarball], cwd);
      const output = run(process.execPath, [app.main], cwd);
      if (output.trim() !== 'ok') {
        throw new Error(`unexpected output: ${output}`);
      }
      console.log(`${app.name}: ok`);
    } catch (error) {
      failed = app.name;
      console.error(`${app.name}: FAILED`);
      console.error(error instanceof Error ? error.message : error);
      break;
    }
  }
} catch (error) {
  failed = 'build/pack';
  console.error(error instanceof Error ? error.message : error);
} finally {
  if (tarball) rmSync(tarball, { force: true });
  for (const f of readdirSync(consumersDir)) {
    if (f.endsWith('.tgz')) rmSync(join(consumersDir, f), { force: true });
  }
}

if (failed) {
  console.error(`test:consumers failed: ${failed}`);
  process.exit(1);
}
