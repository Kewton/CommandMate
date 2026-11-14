/**
 * Fakes shared by the flow PR1a tests (Issue #4367). Nothing here calls the real `gh`;
 * the identification git is answered from a table.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Call {
  cmd: string;
  args: string[];
  options: { timeout?: number; killSignal?: string; cwd?: string } & Record<string, unknown>;
}

export interface RunAnswer {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: { code?: string };
}

export interface FakeGit {
  /** origin URL; null = no origin. */
  origin?: string | null;
  /** refs/remotes/origin/develop exists. */
  develop?: boolean;
  /** target of refs/remotes/origin/HEAD, e.g. refs/remotes/origin/main; null = none. */
  originHead?: string | null;
  /** false = not a git repository. */
  isRepo?: boolean;
}

export type GhAnswer = (args: string[]) => RunAnswer;

export const GITHUB_ORIGIN = 'git@github.com:Kewton/CommandMate.git';

/** A `run` (spawnSync-shaped) that answers git from `git` and gh from `gh`, recording each call. */
export function fakeRun(git: FakeGit, gh: GhAnswer, calls: Call[] = []) {
  const state = { origin: GITHUB_ORIGIN, develop: true, originHead: null as string | null, isRepo: true, ...git };
  const run = (cmd: string, args: string[], options: Call['options']): RunAnswer => {
    calls.push({ cmd, args: [...args], options });
    if (cmd === 'gh') return gh(args);
    if (cmd !== 'git') return { status: 127, stdout: '', stderr: 'not found' };
    if (!state.isRepo) return { status: 128, stdout: '', stderr: 'fatal: not a git repository' };
    const joined = args.join(' ');
    if (joined === 'rev-parse --path-format=absolute --git-common-dir') return { status: 0, stdout: '/repo/.git\n', stderr: '' };
    if (joined === 'remote get-url origin') {
      return state.origin === null ? { status: 2, stdout: '', stderr: "error: No such remote 'origin'" } : { status: 0, stdout: `${state.origin}\n`, stderr: '' };
    }
    if (joined === 'rev-parse --verify refs/remotes/origin/develop') return state.develop ? { status: 0, stdout: 'abc\n', stderr: '' } : { status: 128, stdout: '', stderr: 'fatal' };
    if (joined === 'symbolic-ref refs/remotes/origin/HEAD') {
      return state.originHead ? { status: 0, stdout: `${state.originHead}\n`, stderr: '' } : { status: 128, stdout: '', stderr: 'fatal' };
    }
    return { status: 1, stdout: '', stderr: `unexpected git ${joined}` };
  };
  return run;
}

export function prList(field: 'createdAt' | 'mergedAt', items: Array<[number, string]>, base = 'develop'): string {
  return JSON.stringify(items.map(([number, at]) => ({ number, [field]: at, baseRefName: base })));
}

/** gh answers per search kind (`created` / `merged`). */
export function ghByKind(created: RunAnswer, merged: RunAnswer): GhAnswer {
  return (args) => (args[9]?.startsWith('created:') ? created : merged);
}

export const ok = (stdout: string): RunAnswer => ({ status: 0, stdout, stderr: '' });

/** A monotonic clock that advances by `step` ms on every read. */
export function steppingClock(start = 1000, step = 0) {
  let t = start;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

export class TempDirs {
  private dirs: string[] = [];
  make(prefix = 'flow-4367-'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    this.dirs.push(dir);
    return dir;
  }
  cleanup(): void {
    for (const dir of this.dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface Io {
  out: string[];
  err: string[];
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export function io(): Io {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
}

/** Whether `fn` runs without an assertion failing (for the mutation rows of T-M). */
export function holds(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}
