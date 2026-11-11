// Checks the Markdown docs: README.md, RELEASING.md and docs/*.md under the root (default: the
// repository; `--root <dir>` points it elsewhere, as the unit test does with test/docs-fixtures).
// Fails (exit 1) with `file:line` on any problem.
//
// 1. Every ```ts (or ```typescript) block is type-checked, unless its info string contains
//    `nocheck` (for intentional fragments, such as another library's code). Each block becomes
//    its own module in a temporary directory, compiled with the repository's tsconfig.json plus a
//    generated `paths` mapping that resolves '@loipv/nestjs-cache' to src/index.ts. A method body
//    that is only `/* ... */` is a placeholder: the "must return a value" error (TS2355) is ignored
//    there and nowhere else. Packages the examples import but the repository does not install
//    (`@nestjs/config`) get a minimal declaration (SHIMS below). `--keep` leaves the generated
//    files in node_modules/.cache/check-docs-<pid>/ for debugging.
// 2. Every relative link and image must point to an existing file, and its `#anchor` (or an
//    in-page `#anchor`) must match a heading of the target Markdown file (GitHub slugs).
//    External links (`scheme:` or `//`) are not followed.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const rootArg = args.indexOf('--root');
const root = rootArg === -1 ? repo : resolve(args[rootArg + 1] ?? '.');
const keep = args.includes('--keep');

// Placeholder bodies such as `findById(id: string): Promise<User> { /* ... */ }`.
const PLACEHOLDER = '/* ... */';
// Packages that doc examples import but the repository does not install.
const SHIMS = `declare module '@nestjs/config' {
  export class ConfigModule {}
  export class ConfigService {
    getOrThrow<T = unknown>(key: string): T;
  }
}
`;

const show = (file) => relative(process.cwd(), file) || file;

function markdownFiles() {
  const files = ['README.md', 'RELEASING.md']
    .map((f) => join(root, f))
    .filter((f) => existsSync(f));
  const docs = join(root, 'docs');
  if (existsSync(docs)) {
    for (const name of readdirSync(docs).sort()) {
      const file = join(docs, name);
      if (name.endsWith('.md') && statSync(file).isFile()) files.push(file);
    }
  }
  return files;
}

// Splits a Markdown file into fenced code blocks and the remaining prose lines.
function parse(text) {
  const lines = text.split('\n');
  const blocks = [];
  const prose = []; // { line (1-based), text }
  let open = null;
  lines.forEach((text, i) => {
    if (open) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(text);
      if (close && close[1][0] === open.fence[0] && close[1].length >= open.fence.length) {
        blocks.push(open);
        open = null;
      } else {
        open.body.push(
          text.startsWith(open.indent) ? text.slice(open.indent.length) : text.trimStart(),
        );
      }
      return;
    }
    const start = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(text);
    if (start) {
      open = { indent: start[1], fence: start[2], info: start[3].trim(), line: i + 1, body: [] };
      return;
    }
    prose.push({ line: i + 1, text });
  });
  if (open) blocks.push(open);
  return { blocks, prose };
}

const stripInlineCode = (text) => text.replace(/(`+)[\s\S]*?\1/g, (m) => ' '.repeat(m.length));

// GitHub's heading anchors: lowercased, punctuation dropped, spaces turned into hyphens, and
// `-1`, `-2`, ... appended to repeats.
function anchorsOf(text) {
  const anchors = new Set();
  const seen = new Map();
  for (const { text: line } of parse(text).prose) {
    for (const m of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(m[1]);
    const heading = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (!heading) continue;
    const plain = heading[1].replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '');
    const base = plain
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

const anchorCache = new Map();
function anchorsOfFile(file) {
  if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(readFileSync(file, 'utf8')));
  return anchorCache.get(file);
}

const problems = [];
let linkCount = 0;

function checkLinks(file, prose) {
  for (const { line, text } of prose) {
    for (const m of stripInlineCode(text).matchAll(
      /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
    )) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
      linkCount += 1;
      const hash = target.indexOf('#');
      const path = decodeURI(hash === -1 ? target : target.slice(0, hash));
      const anchor = hash === -1 ? undefined : decodeURIComponent(target.slice(hash + 1));
      const dest = path === '' ? file : resolve(dirname(file), path);
      const where = `${show(file)}:${line}`;
      if (!existsSync(dest)) {
        problems.push(`${where}: broken link "${target}": ${show(dest)} does not exist`);
        continue;
      }
      if (anchor !== undefined && dest.endsWith('.md') && !anchorsOfFile(dest).has(anchor)) {
        problems.push(
          `${where}: broken link "${target}": no heading for #${anchor} in ${show(dest)}`,
        );
      }
    }
  }
}

// The function-like node whose return type annotation contains `pos`, if its body is only a
// placeholder comment.
function isPlaceholderBody(source, pos) {
  let found = false;
  const visit = (node) => {
    if (found || pos < node.getFullStart() || pos > node.getEnd()) return;
    if (
      ts.isFunctionLike(node) &&
      node.type &&
      node.body &&
      pos >= node.type.getStart(source) &&
      pos <= node.type.getEnd()
    ) {
      const body = node.body.getText(source).slice(1, -1).trim();
      if (body === PLACEHOLDER) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function checkBlocks(entries) {
  if (entries.length === 0) return;
  // Inside the repository, so the blocks resolve '@nestjs/common', 'ioredis' and the rest from
  // its node_modules. One directory per run, so concurrent runs do not collide.
  const dir = join(repo, 'node_modules', '.cache', `check-docs-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const byFile = new Map();
  entries.forEach(({ file, block }, i) => {
    const name = join(dir, `block-${String(i).padStart(3, '0')}.ts`);
    // `export {}` makes every block a module, so blocks do not share globals and may use
    // top-level `await`.
    writeFileSync(name, `${block.body.join('\n')}\nexport {};\n`);
    byFile.set(name, { file, block });
  });
  writeFileSync(join(dir, 'shims.d.ts'), SHIMS);
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        extends: join(repo, 'tsconfig.json'),
        compilerOptions: {
          noEmit: true,
          paths: { '@loipv/nestjs-cache': [join(repo, 'src', 'index.ts')] },
        },
        files: [join(dir, 'shims.d.ts'), ...byFile.keys()],
        include: [],
      },
      null,
      2,
    ),
  );
  try {
    compile(dir, byFile);
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

function compile(dir, byFile) {
  const config = ts.getParsedCommandLineOfConfigFile(
    join(dir, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
  const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
  for (const d of diagnostics) {
    const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    const origin = d.file && byFile.get(resolve(d.file.fileName));
    if (!origin) {
      const where = d.file ? `${show(d.file.fileName)}: ` : '';
      problems.push(`${where}TS${d.code}: ${message}`);
      continue;
    }
    if (d.code === 2355 && d.start !== undefined && isPlaceholderBody(d.file, d.start)) continue;
    const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
    const mdLine = origin.block.line + 1 + Math.min(line, origin.block.body.length - 1);
    problems.push(
      `${show(origin.file)}:${mdLine}: TS${d.code}: ${message} (in the ts block at line ${origin.block.line})`,
    );
  }
}

const files = markdownFiles();
const entries = [];
let skipped = 0;
for (const file of files) {
  const { blocks, prose } = parse(readFileSync(file, 'utf8'));
  checkLinks(file, prose);
  for (const block of blocks) {
    const [lang, ...rest] = block.info.split(/\s+/);
    if (lang !== 'ts' && lang !== 'typescript') continue;
    if (rest.includes('nocheck')) skipped += 1;
    else entries.push({ file, block });
  }
}
checkBlocks(entries);

const summary = `${files.length} files, ${entries.length} ts blocks checked (${skipped} nocheck), ${linkCount} relative links`;
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(`docs:check failed: ${problems.length} problem(s) in ${summary}`);
  process.exit(1);
}
console.log(`docs:check passed: ${summary}`);
