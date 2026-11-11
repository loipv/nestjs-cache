import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = join(repo, 'scripts', 'check-docs.mjs');

function run(root: string) {
  const result = spawnSync(process.execPath, [script, '--root', root], {
    cwd: repo,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('scripts/check-docs.mjs', () => {
  it('fails on a broken ts block, a broken link and a missing anchor, with file:line', () => {
    /* 0.9-T7 Review Focus 3: each problem in test/docs-fixtures is reported with the Markdown
       file and line, and the run exits non-zero; the `nocheck` block is skipped. */
    const { status, stderr } = run('test/docs-fixtures');

    expect(status).toBe(1);
    const lines = stderr.trim().split('\n');
    expect(lines).toContain(
      "test/docs-fixtures/README.md:9: TS2322: Type 'number' is not assignable to type 'string'. (in the ts block at line 7)",
    );
    expect(lines).toContain(
      'test/docs-fixtures/README.md:13: broken link "docs/missing.md": test/docs-fixtures/docs/missing.md does not exist',
    );
    expect(lines).toContain(
      'test/docs-fixtures/README.md:15: broken link "docs/guide.md#no-such-section": no heading for #no-such-section in test/docs-fixtures/docs/guide.md',
    );
    expect(lines).toContain(
      'test/docs-fixtures/docs/guide.md:5: broken link "#missing-anchor": no heading for #missing-anchor in test/docs-fixtures/docs/guide.md',
    );
    expect(stderr).not.toContain('not checked');
    expect(lines.at(-1)).toBe(
      'docs:check failed: 4 problem(s) in 2 files, 1 ts blocks checked (1 nocheck), 4 relative links',
    );
  }, 60_000);

  it('passes on valid docs: placeholder bodies, nocheck, GitHub anchors and skipped links', () => {
    /* 0.9-T7: a `/* ... *\/` method body, top-level await, a `nocheck` block, an anchor with
       inline code, a repeated heading (`-1`), a directory link, an external link and link syntax
       inside inline code all pass. */
    const { status, stdout, stderr } = run('test/docs-fixtures/clean');

    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(
      'docs:check passed: 2 files, 1 ts blocks checked (1 nocheck), 6 relative links',
    );
  }, 60_000);
});
