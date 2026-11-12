// Type-checks the built `dist/index.d.ts` and `dist/index.d.cts` with the minimum supported
// TypeScript (TS_MIN), through test/types-min. That compiler is installed on demand into
// node_modules/.cache (git-ignored), not as a dependency, so it never competes with the repo's
// own `tsc`. Run `npm run build` first.
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
  // `npm run` sets npm_execpath to npm's JS entry point, which runs without a shell on every
  // platform (Node refuses to spawn a `.cmd` file without one).
  const npmCli = process.env.npm_execpath;
  if (!npmCli && process.platform === 'win32') {
    console.error('typecheck:min: run it through `npm run typecheck:min`');
    process.exit(1);
  }
  const installArgs = [
    'install',
    '--prefix',
    prefix,
    '--no-save',
    '--no-package-lock',
    '--ignore-scripts',
    `typescript@${TS_MIN}`,
  ];
  const install = npmCli
    ? spawnSync(process.execPath, [npmCli, ...installArgs], { cwd: root, stdio: 'inherit' })
    : spawnSync('npm', installArgs, { cwd: root, stdio: 'inherit' });
  if (install.status !== 0 || installedVersion() !== TS_MIN) {
    console.error(`typecheck:min: could not install typescript@${TS_MIN}`);
    process.exit(1);
  }
}

// The ESM declarations (`dist/index.d.ts`) and the CommonJS ones (`dist/index.d.cts`) are each
// checked against the same consumer.
for (const project of ['tsconfig.json', 'tsconfig.cjs.json']) {
  const result = spawnSync(
    process.execPath,
    [tsc, '-p', join(root, 'test', 'types-min', project)],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
