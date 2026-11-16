/**
 * Issue #4439: CommandMate must not reference agy / Gemini credential file names.
 * Only reads tracked files; never opens anything under $HOME.
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
  reason: string;
}

const ALLOWED: Allowed[] = [
  {
    file: 'src/lib/hooks/sources/gemini/shared-config-tree.ts',
    line: ' * ~/.gemini/oauth_creds.json       gemini, the credentials a session needs',
    reason: 'comment listing the shared config tree; not read by code',
  },
  {
    file: 'scripts/agent-health/tool-table.ts',
    line: '  // Starting gemini refreshes its OAuth token into `~/.gemini/oauth_creds.json`',
    reason: 'comment explaining why gemini is not started',
  },
  {
    file: 'scripts/agent-health/tool-table.ts',
    line: "        'サインインできない（2026-10-05 の実測、Issue #3313）。起動すると OAuth のトークン更新で利用者の ~/.gemini/oauth_creds.json を書き換えるため、毎朝は起動して確かめない',",
    reason: 'user-facing note text; not a path used by code',
  },
];

export interface Violation {
  file: string;
  lineNo: number;
  line: string;
}

export function findViolations(
  files: Array<{ file: string; content: string }>,
  allowed: Allowed[]
): Violation[] {
  const out: Violation[] = [];
  for (const { file, content } of files) {
    content.split('\n').forEach((line, i) => {
      if (!CRED_PATTERN.test(line)) return;
      if (allowed.some((a) => a.file === file && a.line === line)) return;
      out.push({ file, lineNo: i + 1, line });
    });
  }
  return out;
}

function trackedSourceFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', 'src', 'bin', 'scripts'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((f) => f && !f.startsWith('node_modules/') && !f.startsWith('tests/'));
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
    const files = trackedSourceFiles(root)
      .filter((f) => fs.existsSync(path.join(root, f)))
      .map((f) => ({ file: f, content: fs.readFileSync(path.join(root, f), 'utf8') }));
    expect(findViolations(files, ALLOWED)).toEqual([]);
  });

  it('allow list entries still match real lines (rewriting a line fails)', () => {
    const root = path.resolve(__dirname, '../../..');
    for (const a of ALLOWED) {
      const lines = fs.readFileSync(path.join(root, a.file), 'utf8').split('\n');
      expect(lines, `${a.file}: ${a.reason}`).toContain(a.line);
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
});
