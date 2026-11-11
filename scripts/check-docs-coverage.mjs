// Proves that splitting the README lost nothing: every fragment of the README at the base commit
// (each paragraph, list item, heading, table row and fenced code block) must appear in the current
// README.md, RELEASING.md or a docs/*.md file. Fails (exit 1) listing each missing fragment with
// its line in the base README.
//
//   node scripts/check-docs-coverage.mjs [--base <commit>]   (default: 720a834, the README before the split)
//
// The default base 720a834 must stay reachable from the branch that runs this check: merge with a
// fast-forward or a merge commit, never a squash or rebase that drops it.
//
// A code block that is not found verbatim still counts when its lines appear, in order, in one
// code block of the current docs: imports and declared stubs added to make a block type-check
// (`docs:check`) lose nothing.
//
// Fragments and the current docs are compared after normalisation: runs of whitespace become one
// space, table rows are compared cell by cell without padding, heading markers are dropped, and a
// link `[text](target)` keeps only `[text]` (moving a section rewrites link targets; `docs:check`
// verifies the targets). A fragment that was rewritten on purpose is listed in
// scripts/docs-coverage-allowlist.json with the reason; an allowlist entry that matches no
// missing fragment is an error too, so the list cannot go stale.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const baseArg = args.indexOf('--base');
const base = baseArg === -1 ? '720a834' : args[baseArg + 1];

const tableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const separatorRow = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line);
const normaliseRow = (line) =>
  `| ${line
    .trim()
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim())
    .join(' | ')} |`;
const normalise = (text) =>
  text
    .replace(/(!?\[[^\]]*\])\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

// The base README as fragments: { line, kind, text }.
function fragmentsOf(markdown) {
  const fragments = [];
  const lines = markdown.split('\n');
  let current = null; // the paragraph or list item being collected
  const flush = () => {
    if (current) fragments.push(current);
    current = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush();
      const body = [line.trim()];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        body.push(lines[j].trim());
        const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[j]);
        if (close && close[1][0] === fence[2][0] && close[1].length >= fence[2].length) break;
      }
      fragments.push({
        line: i + 1,
        kind: 'code block',
        text: body.join('\n'),
        lines: body.filter(Boolean),
      });
      i = j;
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (tableRow(line)) {
      flush();
      if (!separatorRow(line))
        fragments.push({ line: i + 1, kind: 'table row', text: normaliseRow(line) });
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      fragments.push({ line: i + 1, kind: 'heading', text: heading[1] });
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) {
      flush();
      current = { line: i + 1, kind: 'list item', text: line };
      continue;
    }
    if (current) current.text += `\n${line}`;
    else current = { line: i + 1, kind: 'paragraph', text: line };
  }
  flush();
  return fragments.map((f) => ({ ...f, text: normalise(f.text), lines: f.lines?.map(normalise) }));
}

function currentDocs() {
  const files = ['README.md', 'RELEASING.md']
    .map((f) => join(repo, f))
    .filter((f) => existsSync(f));
  for (const name of readdirSync(join(repo, 'docs')).sort()) {
    if (name.endsWith('.md')) files.push(join(repo, 'docs', name));
  }
  const text = files
    .map((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => (tableRow(line) ? normaliseRow(line) : line))
        .join('\n'),
    )
    .join('\n\n');
  const codeBlocks = fragmentsOf(text)
    .filter((f) => f.kind === 'code block')
    .map((f) => f.lines);
  return { files, haystack: normalise(text), codeBlocks };
}

let baseReadme;
try {
  baseReadme = execFileSync('git', ['show', `${base}:README.md`], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  console.error(`docs:coverage failed: cannot read README.md at ${base} (${error.message.trim()})`);
  process.exit(1);
}

const allowlist = JSON.parse(
  readFileSync(join(repo, 'scripts', 'docs-coverage-allowlist.json'), 'utf8'),
);
const used = new Set();
// Whether `lines` appear in order (not necessarily adjacent) in `block`.
function isSubsequence(lines, block) {
  let i = 0;
  for (const line of block) if (line === lines[i]) i += 1;
  return i === lines.length;
}

const { files, haystack, codeBlocks } = currentDocs();
const fragments = fragmentsOf(baseReadme);
const missing = [];
let extended = 0;
for (const fragment of fragments) {
  if (haystack.includes(fragment.text)) continue;
  if (fragment.lines && codeBlocks.some((block) => isSubsequence(fragment.lines, block))) {
    extended += 1;
    continue;
  }
  const entry = allowlist.findIndex((a) => fragment.text.startsWith(normalise(a.fragment)));
  if (entry !== -1) {
    used.add(entry);
    continue;
  }
  missing.push(fragment);
}

const problems = missing.map(
  (f) =>
    `README.md@${base}:${f.line}: ${f.kind} not found in the current docs: ${f.text.slice(0, 160)}`,
);
allowlist.forEach((a, i) => {
  if (!a.reason) problems.push(`allowlist entry ${i} has no reason: ${a.fragment.slice(0, 80)}`);
  if (!used.has(i))
    problems.push(`allowlist entry ${i} matches no missing fragment: ${a.fragment.slice(0, 80)}`);
});

const summary = `${fragments.length} fragments of README.md@${base} against ${files.length} files, ${extended} code blocks extended, ${used.size} allowlisted`;
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(`docs:coverage failed: ${problems.length} problem(s); ${summary}`);
  process.exit(1);
}
console.log(`docs:coverage passed: ${summary}`);
