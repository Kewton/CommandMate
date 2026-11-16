/**
 * Issue #4439: CommandMate must not reference agy / Gemini credential file names
 * (oauth_creds, jetski-standalone-oauth-token, google_accounts) in src/, bin/, scripts/.
 *
 * Threat scope: this is a test that fails when such a name is added by accident.
 * Deliberate obfuscation (concatenation through variables, eval-like constructs,
 * generating code from strings, etc.) is the responsibility of code review.
 *
 * What is guaranteed:
 * - Reading (N1'): for every tracked file, the working-tree entry is lstat-ed. A regular
 *   file is read only when its realpath is inside the repository, so unstaged edits are
 *   scanned and nothing outside the repository is ever opened. A symlink is never
 *   followed: its git blob (the target path string) is scanned instead. Files deleted
 *   from the working tree are skipped.
 * - Detection (N2'): every original line is matched against the names. In addition,
 *   .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs files are parsed with the TypeScript compiler
 *   API and constant strings are folded — only concatenation of string literals with `+`
 *   (parentheses included) and template literals whose `${}` parts fold the same way
 *   (e.g. 'oauth_' + ('creds.json'), `oauth_${'cre' + 'ds'}`). A folded match is
 *   reported at the original line where the expression starts. Other files (.sh, .md,
 *   ...) are checked by raw lines only, never normalized.
 * - Out of scope: anything beyond that fold — variables, function or method calls
 *   (['oauth_', 'creds'].join('')), computed properties, `as` casts, etc.
 * - Out of scope: a race where another process swaps a file during the scan (between the check and the read).
 * - Allow list (N3'): an exemption applies only when the original line at the reported
 *   line number equals an allowed (file, line) exactly; occurrences of each allowed line
 *   are counted on original lines and must equal `count`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const CRED_PATTERN = /oauth_creds|jetski-standalone-oauth-token|google_accounts/i;

interface Allowed {
  file: string;
  line: string;
  count: number;
  reason: string;
}

const ALLOWED: Allowed[] = [
  {
    file: 'src/lib/hooks/sources/gemini/shared-config-tree.ts',
    line: ' * ~/.gemini/oauth_creds.json       gemini, the credentials a session needs',
    count: 1,
    reason: 'comment listing the shared config tree; not read by code',
  },
  {
    file: 'scripts/agent-health/tool-table.ts',
    line: '  // Starting gemini refreshes its OAuth token into `~/.gemini/oauth_creds.json`',
    count: 1,
    reason: 'comment explaining why gemini is not started',
  },
  {
    file: 'scripts/agent-health/tool-table.ts',
    line: "        'サインインできない（2026-10-05 の実測、Issue #3313）。起動すると OAuth のトークン更新で利用者の ~/.gemini/oauth_creds.json を書き換えるため、毎朝は起動して確かめない',",
    count: 1,
    reason: 'user-facing note text; not a path used by code',
  },
];

export interface Violation {
  file: string;
  lineNo: number;
  line: string;
  kind: 'reference' | 'folded-reference' | 'allow-count-mismatch';
}

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
};

/** Folds a constant string expression; undefined when it is not one (out of scope). */
function foldConstantString(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return foldConstantString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = foldConstantString(node.left);
    if (l === undefined) return undefined;
    const r = foldConstantString(node.right);
    return r === undefined ? undefined : l + r;
  }
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) {
      const v = foldConstantString(span.expression);
      if (v === undefined) return undefined;
      s += v + span.literal.text;
    }
    return s;
  }
  return undefined;
}

/** 1-based line numbers (split on '\n', same as the raw lines) where a folded match starts. */
function foldedMatchLines(file: string, content: string): number[] {
  const kind = SCRIPT_KINDS[path.extname(file).toLowerCase()];
  if (kind === undefined) return [];
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false, kind);
  const out: number[] = [];
  const visit = (node: ts.Node): void => {
    const v = foldConstantString(node);
    if (v !== undefined && CRED_PATTERN.test(v)) {
      const start = node.getStart(sf);
      let line = 1;
      for (let i = content.indexOf('\n'); i !== -1 && i < start; i = content.indexOf('\n', i + 1)) {
        line++;
      }
      out.push(line);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function findViolations(
  files: Array<{ file: string; content: string }>,
  allowed: Allowed[]
): Violation[] {
  const out: Violation[] = [];
  for (const { file, content } of files) {
    const lines = content.split('\n');
    const rawHits = new Set<number>();
    lines.forEach((line, i) => {
      if (CRED_PATTERN.test(line)) rawHits.add(i + 1);
    });
    const candidates = new Set<number>([...rawHits, ...foldedMatchLines(file, content)]);
    const allowedHere = allowed.filter((a) => a.file === file);
    for (const lineNo of [...candidates].sort((a, b) => a - b)) {
      const line = lines[lineNo - 1];
      if (allowedHere.some((a) => a.line === line)) continue;
      out.push({
        file,
        lineNo,
        line,
        kind: rawHits.has(lineNo) ? 'reference' : 'folded-reference',
      });
    }
    for (const a of allowedHere) {
      const n = lines.filter((l) => l === a.line).length;
      if (n > 0 && n !== a.count) {
        out.push({ file, lineNo: 0, line: a.line, kind: 'allow-count-mismatch' });
      }
    }
  }
  return out;
}

function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}

/**
 * Reads tracked files under src/bin/scripts as they are in the working tree.
 * Regular files are read only when their realpath is inside the repository;
 * symlinks are never followed (their git blob, the target path string, is used).
 */
export function readTrackedFiles(
  root: string,
  env: NodeJS.ProcessEnv = process.env
): Array<{ file: string; content: string }> {
  const opts = { cwd: root, env, maxBuffer: 256 * 1024 * 1024 };
  const listing = execFileSync('git', ['ls-files', '-s', '-z', '--', 'src', 'bin', 'scripts'], {
    ...opts,
    encoding: 'utf8',
  });
  const realRoot = fs.realpathSync(root);
  const result: Array<{ file: string; content: string }> = [];
  const symlinks: Array<{ file: string; sha: string }> = [];
  for (const rec of listing.split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) \d\t(.*)$/s.exec(rec);
    if (!m || m[1] === '160000') continue;
    const file = m[3];
    if (file.includes('node_modules/') || file.startsWith('tests/')) continue;
    const abs = path.join(root, file);
    const st = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (!st) continue; // deleted from the working tree
    if (st.isSymbolicLink()) {
      symlinks.push({ file, sha: m[2] });
      continue;
    }
    if (!st.isFile()) continue;
    const real = fs.realpathSync(abs);
    if (!isInside(realRoot, real)) continue; // a parent directory points outside the repo
    result.push({ file, content: fs.readFileSync(real, 'utf8') });
  }
  if (symlinks.length === 0) return result;
  const raw = execFileSync('git', ['cat-file', '--batch'], {
    ...opts,
    input: symlinks.map((e) => e.sha).join('\n') + '\n',
  });
  let pos = 0;
  for (const e of symlinks) {
    const nl = raw.indexOf(0x0a, pos);
    const size = Number(raw.subarray(pos, nl).toString('utf8').split(' ')[2]);
    result.push({ file: e.file, content: raw.subarray(nl + 1, nl + 1 + size).toString('utf8') });
    pos = nl + 1 + size + 1;
  }
  return result;
}

describe('no agy/Gemini credential references (#4439)', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function writeTmp(name: string, content: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-agy-creds-'));
    tmpDirs.push(dir);
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return { file: name, content: fs.readFileSync(p, 'utf8') };
  }

  it('tracked src/bin/scripts contain no credential file names beyond the allow list', () => {
    const root = path.resolve(__dirname, '../../..');
    const files = readTrackedFiles(root);
    expect(findViolations(files, ALLOWED)).toEqual([]);
  }, 30_000); // parses every tracked .ts/.js file; slow under a loaded full unit run

  it('allow list entries still match real lines (rewriting a line fails)', () => {
    const root = path.resolve(__dirname, '../../..');
    const files = readTrackedFiles(root);
    for (const a of ALLOWED) {
      const f = files.find((x) => x.file === a.file);
      expect(f, `${a.file} must be tracked`).toBeDefined();
      const n = f!.content.split('\n').filter((l) => l === a.line).length;
      expect(n, `${a.file}: ${a.reason}`).toBe(a.count);
    }
  });

  it('positive control: a path built from oauth_creds is a violation', () => {
    const f = writeTmp(
      'x.ts',
      "const p = path.join(os.homedir(), '.gemini', 'oauth_creds.json');\n"
    );
    const v = findViolations([f], ALLOWED);
    expect(v).toHaveLength(1);
    expect(v[0].lineNo).toBe(1);
  });

  it.each(['jetski-standalone-oauth-token', 'google_accounts.json', 'OAUTH_CREDS'])(
    'positive control: %s is a violation',
    (name) => {
      const f = writeTmp('y.ts', `const n = '${name}';\n`);
      expect(findViolations([f], ALLOWED)).toHaveLength(1);
    }
  );

  it('negative control: an allowed line passes only in its own file, exactly', () => {
    const a = ALLOWED[0];
    expect(findViolations([{ file: a.file, content: a.line }], ALLOWED)).toEqual([]);
    expect(findViolations([{ file: a.file, content: a.line + ' x' }], ALLOWED)).toHaveLength(1);
    expect(findViolations([{ file: 'src/other.ts', content: a.line }], ALLOWED)).toHaveLength(1);
  });

  it('negative control: unrelated words do not fail', () => {
    const f = writeTmp('z.ts', 'const oauth = 1; // credentials and tokens\n');
    expect(findViolations([f], ALLOWED)).toEqual([]);
  });

  it.each([
    ["path.join('.gemini', 'oauth_' + 'creds.json')"],
    ["const n = 'jetski-standalone-' +\n  'oauth-token';"],
    ['const n = `oauth_${\'creds\'}.json`;'],
    ['const n = "google_" + \'accounts.json\';'],
  ])('positive control (N2): constant-assembled name is a violation: %s', (src) => {
    const f = writeTmp('j.ts', src + '\n');
    expect(findViolations([f], ALLOWED).length).toBeGreaterThan(0);
  });

  it('negative control (N2): concatenation with a variable is not a violation', () => {
    const f = writeTmp('k.ts', "const n = 'oauth_' + userName;\n");
    expect(findViolations([f], ALLOWED)).toEqual([]);
  });

  it('negative control (N3): duplicating an allowed line in the same file fails', () => {
    const a = ALLOWED[0];
    const v = findViolations([{ file: a.file, content: a.line + '\n' + a.line }], ALLOWED);
    expect(v.length).toBeGreaterThan(0);
  });

  it('N1: a tracked symlink target outside the repo is never opened', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'no-agy-creds-n1-'));
    tmpDirs.push(base);
    const fakeHome = path.join(base, 'home');
    const repo = path.join(base, 'repo');
    fs.mkdirSync(fakeHome);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const dummy = path.join(fakeHome, 'dummy.txt');
    fs.writeFileSync(dummy, 'SENTINEL-4439\n');
    fs.symlinkSync(dummy, path.join(repo, 'src', 'link.ts'));
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    const env = {
      ...process.env,
      HOME: fakeHome,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: repo,
        env,
        stdio: 'pipe',
      });
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const files = readTrackedFiles(repo, env);
    const link = files.find((f) => f.file === 'src/link.ts');
    expect(link?.content).toBe(dummy);
    expect(JSON.stringify(files)).not.toContain('SENTINEL-4439');
    expect(files.find((f) => f.file === 'src/a.ts')?.content).toContain('export const a');
  });

  // ---- N1' / N2' / N3' ----

  function makeRepo(prefix: string) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(base);
    const fakeHome = path.join(base, 'home');
    const repo = path.join(base, 'repo');
    fs.mkdirSync(fakeHome);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const env = {
      ...process.env,
      HOME: fakeHome,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: repo,
        env,
        stdio: 'pipe',
      });
    git('init', '-q');
    return { fakeHome, repo, env, git };
  }

  it("N1': an unstaged edit adding a credential name to a tracked file is a violation", () => {
    const { repo, env, git } = makeRepo('no-agy-creds-n1u-');
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    fs.writeFileSync(
      path.join(repo, 'src', 'a.ts'),
      "export const a = 1;\nexport const p = '.gemini/oauth_creds.json';\n"
    );
    const v = findViolations(readTrackedFiles(repo, env), ALLOWED);
    expect(v).toEqual([expect.objectContaining({ file: 'src/a.ts', lineNo: 2 })]);
  });

  it("N1': a symlink to a directory outside the repo is never opened", () => {
    const { fakeHome, repo, env, git } = makeRepo('no-agy-creds-n1d-');
    const outside = path.join(fakeHome, 'outside-dir');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'b.ts'), 'SENTINEL-4439 oauth_creds\n');
    fs.symlinkSync(outside, path.join(repo, 'src', 'dirlink'));
    fs.mkdirSync(path.join(repo, 'src', 'sub'));
    fs.writeFileSync(path.join(repo, 'src', 'sub', 'b.ts'), 'export const b = 1;\n');
    fs.writeFileSync(path.join(repo, 'src', 'gone.ts'), 'export const g = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    // Unstaged: the tracked directory src/sub becomes a symlink to the outside dir,
    // and src/gone.ts is deleted from the working tree.
    fs.rmSync(path.join(repo, 'src', 'sub'), { recursive: true });
    fs.symlinkSync(outside, path.join(repo, 'src', 'sub'));
    fs.rmSync(path.join(repo, 'src', 'gone.ts'));
    const files = readTrackedFiles(repo, env);
    expect(JSON.stringify(files)).not.toContain('SENTINEL-4439');
    expect(files.find((f) => f.file === 'src/dirlink')?.content).toBe(outside);
    expect(files.find((f) => f.file === 'src/sub/b.ts')).toBeUndefined();
    expect(files.find((f) => f.file === 'src/gone.ts')).toBeUndefined();
  });

  it.each([
    ["const p = 'oauth_' + 'creds.json';", 1],
    ["const p = 'oauth_' + ('creds.json');", 1],
    ["const p = `oauth_${'cre' + 'ds'}.json`;", 1],
    ["// header\nconst p =\n  'oauth_' +\n  'creds.json';", 3],
    ["const a = 'x' +\n  'y';\nconst p = 'oauth_' + 'creds';", 3],
  ])("positive control (N2'): constant fold %j is a violation at its start line", (src, lineNo) => {
    const f = writeTmp('f.ts', src + '\n');
    const v = findViolations([f], ALLOWED);
    expect(v).toEqual([expect.objectContaining({ file: 'f.ts', lineNo })]);
  });

  it.each(['f.js', 'f.mjs', 'f.cjs', 'f.tsx'])(
    "positive control (N2'): constant fold is evaluated in %s",
    (name) => {
      const f = writeTmp(name, "const p = 'google_' + ('accounts' + '.json');\n");
      expect(findViolations([f], ALLOWED)).toHaveLength(1);
    }
  );

  it("negative control (N2'): a shell `+` stays in the value, so it is not a credential name", () => {
    const f = writeTmp('n.sh', "n='oauth_'+'creds.json'\n");
    expect(findViolations([f], ALLOWED)).toEqual([]);
  });

  it.each([
    ["const a = 'oauth_';\nconst p = a + 'creds.json';"],
    ["const p = ['oauth_', 'creds.json'].join('');"],
    ["const p = String('oauth_') + 'creds.json';"],
    ["const o = { ['oauth_' + 'x']: 1 };\nconst p = o.oauth_x + 'creds';"],
  ])("out of scope (N2'): assembly via variables / calls is not detected: %j", (src) => {
    const f = writeTmp('o.ts', src + '\n');
    expect(findViolations([f], ALLOWED)).toEqual([]);
  });

  it("negative control (N3'): an allowed line plus a split copy of it in the same file fails", () => {
    const a = ALLOWED[2];
    const split = a.line.replace('oauth_creds', "oauth_' + 'creds");
    expect(split).not.toBe(a.line);
    const content = `const notes = [\n${a.line}\n${split}\n];\n`;
    const v = findViolations([{ file: a.file, content }], ALLOWED);
    expect(v).toEqual([expect.objectContaining({ file: a.file, lineNo: 3 })]);
  });
});
