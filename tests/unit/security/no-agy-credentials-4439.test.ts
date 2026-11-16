/**
 * Issue #4439: CommandMate must not reference agy / Gemini credential file names.
 *
 * - Contents are read from git objects (`git ls-files -s` + `git cat-file --batch`),
 *   never from the working tree, so no path outside the repository (a symlink
 *   target under $HOME, for example) is ever opened. A symlink is a blob holding
 *   the target path string; that string is what gets scanned.
 * - Constant string concatenation / template pieces are also detected
 *   ('oauth_' + 'creds', `oauth_${'creds'}`). Names assembled from dynamic values
 *   ('oauth_' + userName) are out of scope of this guard's guarantee.
 * - The allow list pins file, exact line and occurrence count.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  kind: 'reference' | 'joined-reference' | 'allow-count-mismatch';
}

/** Strip constant string joins so split names become contiguous. */
export function normalizeStringJoins(content: string): string {
  return content
    .replace(/\$\{\s*(['"`])([^'"`]*)\1\s*\}/g, '$2')
    .replace(/(['"`])\s*\+\s*(['"`])/g, '');
}

export function findViolations(
  files: Array<{ file: string; content: string }>,
  allowed: Allowed[]
): Violation[] {
  const out: Violation[] = [];
  for (const { file, content } of files) {
    const lines = content.split('\n');
    const rawSet = new Set(lines);
    lines.forEach((line, i) => {
      if (!CRED_PATTERN.test(line)) return;
      if (allowed.some((a) => a.file === file && a.line === line)) return;
      out.push({ file, lineNo: i + 1, line, kind: 'reference' });
    });
    normalizeStringJoins(content)
      .split('\n')
      .forEach((line, i) => {
        if (!CRED_PATTERN.test(line) || rawSet.has(line)) return;
        out.push({ file, lineNo: i + 1, line, kind: 'joined-reference' });
      });
    for (const a of allowed.filter((x) => x.file === file)) {
      const n = lines.filter((l) => l === a.line).length;
      if (n > 0 && n !== a.count) {
        out.push({ file, lineNo: 0, line: a.line, kind: 'allow-count-mismatch' });
      }
    }
  }
  return out;
}

/** Reads tracked files from git objects only; never opens working-tree paths. */
export function readTrackedFiles(
  root: string,
  env: NodeJS.ProcessEnv = process.env
): Array<{ file: string; content: string }> {
  const opts = { cwd: root, env, maxBuffer: 256 * 1024 * 1024 };
  const listing = execFileSync('git', ['ls-files', '-s', '-z', '--', 'src', 'bin', 'scripts'], {
    ...opts,
    encoding: 'utf8',
  });
  const entries: Array<{ file: string; sha: string }> = [];
  for (const rec of listing.split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) \d\t(.*)$/s.exec(rec);
    if (!m || m[1] === '160000') continue;
    const file = m[3];
    if (file.includes('node_modules/') || file.startsWith('tests/')) continue;
    entries.push({ file, sha: m[2] });
  }
  if (entries.length === 0) return [];
  const raw = execFileSync('git', ['cat-file', '--batch'], {
    ...opts,
    input: entries.map((e) => e.sha).join('\n') + '\n',
  });
  const result: Array<{ file: string; content: string }> = [];
  let pos = 0;
  for (const e of entries) {
    const nl = raw.indexOf(0x0a, pos);
    const header = raw.subarray(pos, nl).toString('utf8').split(' ');
    const size = Number(header[2]);
    const body = raw.subarray(nl + 1, nl + 1 + size);
    result.push({ file: e.file, content: body.toString('utf8') });
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
  });

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
});
