// Type-checks the built `dist/index.d.ts` with the minimum supported TypeScript (TS_MIN), through
// test/types-min. That compiler is installed on demand into node_modules/.cache (git-ignored), not
// as a dependency, so it never competes with the repo's own `tsc`. Run `npm run build` first.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TS_MIN = '5.4.5';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = join(root, 'node_modules', '.cache', 'typescript-min');
const pkgJson = join(prefix, 'node_modules', 'typescript', 'package.json');
const tsc = join(prefix, 'node_modules', 'typescript', 'bin', 'tsc');

function installedVersion() {
  if (!existsSync(pkgJson)) return null;
  return JSON.parse(readFileSync(pkgJson, 'utf8')).version;
}

if (installedVersion() !== TS_MIN) {
  const install = spawnSync(
    'npm',
    [
      'install',
      '--prefix',
      prefix,
      '--no-save',
      '--no-package-lock',
      '--ignore-scripts',
      `typescript@${TS_MIN}`,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (install.status !== 0 || installedVersion() !== TS_MIN) {
    console.error(`typecheck:min: could not install typescript@${TS_MIN}`);
    process.exit(1);
  }
}

const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'test', 'types-min')], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
