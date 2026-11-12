/**
 * The promote path writes a worktree's file and an Issue comment, and nothing more
 * (Issue #4225, design §5.4・§6.2):
 *
 * - no git write: E's sources never run git themselves (its only git is mem's
 *   `observeWorktreeHead`, a read) — so no commit, add, push, stash, checkout …;
 * - one `--method` under `src/`: the comment's POST in `lib/promote/github-write.ts`.
 *   Until #4225, A〜D passed none (the stage "nothing writes outside" is fixed here);
 * - mem's and the brief's libraries do not write files;
 * - E leaves nothing running: no interval, worker, detached child, `unref` or
 *   scheduler, and `setTimeout` only for the screen's fetch timeout.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

const ROOT = process.cwd();

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

const promoteSources = () => [
  ...files(path.join(ROOT, 'src/lib/promote')),
  path.join(ROOT, 'src/lib/db/mem-promote-db.ts'),
  ...files(path.join(ROOT, 'src/app/api/repositories/[id]/mem/decisions')),
];

const GIT_WRITE_VERBS = ['commit', 'add', 'push', 'stash', 'checkout', 'reset', 'restore', 'switch', 'merge', 'rebase', 'tag'];

/** Why a source of E would run git, or null. */
export function gitWriteFinding(source: string): string | null {
  const code = stripComments(source);
  if (/from\s+['"]@\/lib\/git\//.test(code)) return 'imports lib/git';
  if (/\b(?:execFile|execFileSync|spawn|spawnSync|exec|execSync)\s*\(\s*['"]git['"]/.test(code)) return 'runs git';
  for (const verb of GIT_WRITE_VERBS) {
    if (new RegExp(`\\[\\s*['"]${verb}['"]`).test(code)) return `a git write verb as an argument (${verb})`;
  }
  return null;
}

/** Whether a source passes `--method` to gh. */
const passesMethod = (source: string) => /['"]--method['"]/.test(stripComments(source));

const FS_WRITE = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|writeSync|linkSync|unlinkSync|createWriteStream)\s*\(/;

const RESIDENT = [/\bsetInterval\s*\(/, /\bsetImmediate\s*\(/, /\bnew\s+Worker\s*\(/, /\bfork\s*\(/, /detached\s*:\s*true/, /\.unref\s*\(/, /schedule-manager|timer-manager/];
const TIMEOUT_ALLOWED = new Set(['screen-client.ts']);

export function residentFinding(file: string, source: string): string | null {
  const code = stripComments(source);
  for (const pattern of RESIDENT) if (pattern.test(code)) return `${pattern}`;
  if (/\bsetTimeout\s*\(/.test(code) && !TIMEOUT_ALLOWED.has(path.basename(file))) return 'setTimeout outside screen-client.ts';
  return null;
}

describe('the promote path writes no git, one POST, and leaves nothing running (§5.4・§6.2)', () => {
  it('flags git, a git write verb, a resident and a stray timer (positive control)', () => {
    expect(gitWriteFinding("execFile('git', ['commit', '-m', 'x'])")).not.toBeNull();
    expect(gitWriteFinding("run(['push', 'origin'])")).not.toBeNull();
    expect(gitWriteFinding("import { execGitCommand } from '@/lib/git/git-exec';")).not.toBeNull();
    expect(residentFinding('src/lib/promote/x.ts', 'setInterval(() => 1, 5);')).not.toBeNull();
    expect(residentFinding('src/lib/promote/x.ts', 'const t = setTimeout(() => 1, 5);')).not.toBeNull();
    expect(passesMethod("args: ['api', '--method', 'POST']")).toBe(true);
    expect(FS_WRITE.test("writeFileSync(p, 'x')")).toBe(true);
  });

  it('(control) what E does is not flagged', () => {
    expect(gitWriteFinding("const head = await observeWorktreeHead(path);")).toBeNull();
    expect(gitWriteFinding("args: ['api', '--hostname', host, 'user']")).toBeNull();
    expect(residentFinding('src/lib/promote/screen-client.ts', 'const timer = setTimeout(() => c.abort(), 1);')).toBeNull();
  });

  it('finds the sources at all', () => {
    const found = promoteSources().map(rel);
    expect(found).toContain('src/lib/promote/service.ts');
    expect(found).toContain('src/lib/promote/doc-write.ts');
    expect(found.some((file) => file.includes('mem/decisions'))).toBe(true);
  });

  it('no source of E runs git or leaves something running', () => {
    const findings = promoteSources()
      .map((file) => [rel(file), gitWriteFinding(readFileSync(file, 'utf8')) ?? residentFinding(file, readFileSync(file, 'utf8'))] as const)
      .filter(([, finding]) => finding !== null);
    expect(findings).toEqual([]);
  });

  it('only lib/promote/github-write.ts passes --method to gh, and only POST', () => {
    const passing = files(path.join(ROOT, 'src'))
      .filter((file) => passesMethod(readFileSync(file, 'utf8')))
      .map(rel);
    expect(passing).toEqual(['src/lib/promote/github-write.ts']);
    const source = stripComments(readFileSync(path.join(ROOT, 'src/lib/promote/github-write.ts'), 'utf8'));
    expect([...source.matchAll(/['"]--method['"],\s*['"](\w+)['"]/g)].map((match) => match[1])).toEqual(['POST']);
  });

  it('mem and the brief write no files (the only file writes of this Epic are E’s doc-write.ts)', () => {
    const writing = [...files(path.join(ROOT, 'src/lib/mem')), ...files(path.join(ROOT, 'src/lib/brief'))]
      .filter((file) => FS_WRITE.test(stripComments(readFileSync(file, 'utf8'))))
      .map(rel);
    expect(writing).toEqual([]);
    const promoteWriting = files(path.join(ROOT, 'src/lib/promote'))
      .filter((file) => FS_WRITE.test(stripComments(readFileSync(file, 'utf8'))))
      .map(rel);
    expect(promoteWriting).toEqual(['src/lib/promote/doc-write.ts']);
  });
});
