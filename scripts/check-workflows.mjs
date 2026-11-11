// Guards the security-relevant shape of the workflow files by matching strings in their text.
// Fails (exit 1) on any violation. Cheap and dependency-free; it does not check YAML syntax.
// Rules: every action is pinned by commit SHA; every install skips lifecycle scripts; every job
// has a timeout; release.yml is the only workflow that may write or publish, runs only after CI
// on main in the canonical repository, and uses no npm token; ci.yml's `ci-ok` gate always runs
// and needs every other job.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
const stripComments = (text) =>
  text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');

// The top-level block `name:` as its non-empty child lines, from comment-free text.
function topBlock(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `${name}:` || l.startsWith(`${name}: `));
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (line.trim() !== '') body.push(line);
  }
  return { head: lines[start], body };
}

// The jobs of the top-level `jobs:` block as { name: [lines of the job] }.
function jobsOf(text) {
  const block = topBlock(text, 'jobs');
  const jobs = {};
  let current = null;
  for (const line of block?.body ?? []) {
    const name = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (name) {
      current = name[1];
      jobs[current] = [];
    } else if (current) {
      jobs[current].push(line);
    }
  }
  return jobs;
}

const violations = [];
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();
for (const required of ['ci.yml', 'release.yml']) {
  if (!files.includes(required)) violations.push(`${required} is missing`);
}

for (const file of files) {
  const raw = readFileSync(join(dir, file), 'utf8');
  const body = stripComments(raw);
  const jobs = jobsOf(body);

  // Tags are mutable: every action is pinned by full commit SHA with a `# vX.Y.Z` comment, which
  // Dependabot updates together. Local actions (`./...`) and `docker://` images are exempt.
  for (const [, ref, rest] of raw.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm)) {
    if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
    if (!/^[^@]+@[0-9a-f]{40}$/.test(ref) || !/^\s+#\s*v\d+\.\d+\.\d+\s*$/.test(rest)) {
      violations.push(
        `${file}: \`${ref}\` must be pinned by full commit SHA with a \`# vX.Y.Z\` comment`,
      );
    }
  }

  // No dependency lifecycle scripts anywhere: CI proves the build works without them, and the
  // release jobs hold write permissions, the OIDC token, or build the published tarball.
  for (const [cmd] of body.matchAll(/\bnpm\s+(?:ci|install|i)\b.*$/gm)) {
    if (!/\s--ignore-scripts\b/.test(cmd)) {
      violations.push(`${file}: \`${cmd.trim()}\` must pass --ignore-scripts`);
    }
  }

  for (const [name, lines] of Object.entries(jobs)) {
    if (!lines.some((l) => /^ {4}timeout-minutes:\s*\d+\s*$/.test(l))) {
      violations.push(`${file}: job \`${name}\` needs \`timeout-minutes\``);
    }
  }

  if (/NPM_TOKEN|NODE_AUTH_TOKEN/.test(body)) {
    violations.push(`${file}: must not reference an npm token (use trusted publishing)`);
  }

  if (file === 'ci.yml') {
    // `ci-ok` is the single required check. A skipped required check counts as passing, so it
    // must run whatever its needs did (`if: always()`), and it must need every other job.
    const gate = jobs['ci-ok'];
    if (!gate) {
      violations.push('ci.yml: missing the `ci-ok` job');
    } else {
      if (!gate.some((l) => /^ {4}if:\s*(?:always\(\)|\$\{\{\s*always\(\)\s*\}\})\s*$/.test(l))) {
        violations.push('ci.yml: `ci-ok` must have `if: always()`');
      }
      const needsLine = gate.map((l) => /^ {4}needs:\s*\[(.*)\]\s*$/.exec(l)).find(Boolean);
      if (!needsLine) {
        violations.push('ci.yml: `ci-ok` must list its needs inline, as `needs: [job, ...]`');
      } else {
        const needs = needsLine[1].split(',').map((n) => n.trim());
        const missing = Object.keys(jobs).filter((j) => j !== 'ci-ok' && !needs.includes(j));
        if (missing.length > 0) {
          violations.push(
            `ci.yml: \`ci-ok\` must need every other job, missing: ${missing.join(', ')}`,
          );
        }
      }
    }
  }

  if (file === 'release.yml') {
    // Triggered only by a completed CI run on main: never by pull_request or
    // pull_request_target, which would run with fork-controlled code next to the release tokens.
    if (/\bpull_request/.test(body)) {
      violations.push('release.yml: must not use a pull_request or pull_request_target trigger');
    }
    const on = topBlock(body, 'on')?.body.map((l) => l.trim()) ?? [];
    const expected = ['workflow_run:', 'workflows: [CI]', 'types: [completed]', 'branches: [main]'];
    if (on.join('|') !== expected.join('|')) {
      violations.push(
        `release.yml: \`on:\` must be exactly ${expected.join(' ')}, found: ${on.join(' ')}`,
      );
    }
    if (!/^permissions:\s*\{\}\s*$/m.test(body)) {
      violations.push(
        'release.yml: top-level `permissions:` must be `{}` (each job asks for its own)',
      );
    }
    // Releases only the commit CI tested, only after it passed, only in the canonical repository.
    for (const [condition, text] of [
      [
        /github\.repository\s*==\s*'loipv\/nestjs-cache'/,
        "github.repository == 'loipv/nestjs-cache'",
      ],
      [
        /github\.event\.workflow_run\.conclusion\s*==\s*'success'/,
        "workflow_run.conclusion == 'success'",
      ],
      [/github\.event\.workflow_run\.event\s*==\s*'push'/, "workflow_run.event == 'push'"],
      [
        /github\.event\.workflow_run\.head_sha\s*==\s*github\.sha/,
        'workflow_run.head_sha == github.sha',
      ],
    ]) {
      if (!condition.test(body)) {
        violations.push(`release.yml: the first job's \`if\` must check \`${text}\``);
      }
    }
    if (!/^\s*id-token:\s*write\s*$/m.test(body)) {
      violations.push(
        'release.yml: missing `id-token: write` (required for npm trusted publishing)',
      );
    }
    for (const [, name] of body.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
      if (name !== 'GITHUB_TOKEN') {
        violations.push(`release.yml: only secrets.GITHUB_TOKEN is allowed, found secrets.${name}`);
      }
    }
  } else {
    // Every other workflow is read-only and cannot publish.
    if (!/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(body)) {
      violations.push(`${file}: top-level \`permissions:\` must be \`contents: read\``);
    }
    if (/:\s*write\s*$/m.test(body)) {
      violations.push(`${file}: must not request any \`write\` permission`);
    }
    if (/id-token/.test(body)) violations.push(`${file}: must not reference id-token`);
    if (/secrets\./.test(body)) violations.push(`${file}: must not reference secrets`);
  }
}

if (violations.length > 0) {
  console.error('check:workflows failed:');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`check:workflows ok: ${files.join(', ')}`);
