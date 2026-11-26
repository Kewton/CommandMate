/**
 * Issue #4574 N-V — the orchestrate tools say, first thing on stderr, when the
 * checkout they run from is behind origin/develop.
 *
 * Scope: what this guards against is a supervisor (monitor.sh), a contract
 * generator (contract.mjs) or a waiter (wait-verify.mjs) run from an OLD
 * checkout without anyone noticing — S11 ran all of them from a primary
 * checkout three commits behind the fix (#4532) they were trusted for. Using an
 * old version on purpose is outside this scope: the note is a WARN, nothing is
 * refused and no exit code changes.
 *
 * Invariants pinned here:
 *   - N-V: HEAD lacking a commit the LOCAL `origin/develop` ref has → one WARN
 *     line, the first line on stderr, for each of the three tools. Same ref, or
 *     a branch ahead of it → nothing (the controls).
 *   - N-F: never fetches (every git call is recorded and none is a fetch / pull
 *     / remote update / ls-remote); no git repository, no ref, or a failing git
 *     → silent, no throw, and the same exit code as the control.
 *
 * The checks under vitest are skipped (`VITEST` set) so a test run never
 * depends on how far the developer's own origin/develop has moved; every run
 * here removes VITEST from the child's environment on purpose. The fake
 * repositories are under os.tmpdir() and pointed at with GIT_DIR (the tools ask
 * git about their own directory, and GIT_DIR takes precedence over discovery),
 * so nothing in the repository is written and the real checkout's refs are not
 * read.
 *
 * @vitest-environment node
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  assertSubprocessCompleted,
} from '@tests/helpers/real-shell-budget';
import * as waitVerify from '../../../../scripts/orchestrate/wait-verify.mjs';

const ROOT = process.cwd();
const MONITOR = path.join(ROOT, '.claude/skills/orchestrate-monitor/scripts/monitor.sh');
const LIB = path.join(ROOT, '.claude/skills/orchestrate-monitor/scripts/monitor-lib.sh');
const CONTRACT = path.join(ROOT, 'scripts/orchestrate/contract.mjs');
const WAIT_VERIFY = path.join(ROOT, 'scripts/orchestrate/wait-verify.mjs');
const HARD_TIMEOUT_MS = REAL_SHELL_SUBPROCESS_TIMEOUT_MS;

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const WARN_RE = /^(monitor\.sh|contract\.mjs|wait-verify\.mjs): WARN this checkout is behind origin\/develop by (\d+) commit\(s\)/;
/** A git call that would reach the network or move the ref the check compares with. */
const FETCHING = /(^|\s)(fetch|pull|ls-remote|remote\s+update)(\s|$)/;

const made: string[] = [];
afterEach(() => {
  while (made.length) rmSync(made.pop() as string, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Plain git for the setup, isolated from the developer's config. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(REAL_GIT, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...childEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

/** The child's environment: no VITEST (the tools skip the check under it), no inherited GIT_*. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.VITEST;
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return { ...env, ...extra };
}

type Shape = 'behind' | 'same' | 'ahead';

/**
 * A working repository whose `origin/develop` came from a fake origin (a bare
 * repository under os.tmpdir()) by a fetch done HERE, in the setup — the tool
 * under test only compares with the ref that fetch left.
 *   behind: origin/develop has one commit HEAD lacks
 *   same:   origin/develop is HEAD
 *   ahead:  HEAD has one commit origin/develop lacks (a branch, not stale)
 */
function fakeCheckout(shape: Shape): string {
  const base = tmp('stale-checkout-4574-');
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  const other = path.join(base, 'other');
  git(base, 'init', '-q', '--bare', '-b', 'develop', origin);
  git(base, 'clone', '-q', origin, work);
  git(work, 'checkout', '-q', '-b', 'develop');
  writeFileSync(path.join(work, 'a.txt'), 'a\n');
  git(work, 'add', 'a.txt');
  git(work, 'commit', '-q', '-m', 'a');
  git(work, 'push', '-q', 'origin', 'develop');
  if (shape === 'behind') {
    git(base, 'clone', '-q', '-b', 'develop', origin, other);
    writeFileSync(path.join(other, 'b.txt'), 'b\n');
    git(other, 'add', 'b.txt');
    git(other, 'commit', '-q', '-m', 'b');
    git(other, 'push', '-q', 'origin', 'develop');
  }
  git(work, 'fetch', '-q', 'origin');
  if (shape === 'ahead') {
    writeFileSync(path.join(work, 'c.txt'), 'c\n');
    git(work, 'add', 'c.txt');
    git(work, 'commit', '-q', '-m', 'c');
  }
  return work;
}

/** A directory with a `git` that records every call, and either runs the real one or fails. */
function gitRecorder(mode: 'real' | 'fail'): { bin: string; calls: () => string[] } {
  const bin = tmp('stale-checkout-git-4574-');
  const log = path.join(bin, 'git.log');
  writeFileSync(log, '');
  writeFileSync(
    path.join(bin, 'git'),
    ['#!/bin/sh', `printf '%s\\n' "$*" >> "${log}"`, mode === 'real' ? `exec "${REAL_GIT}" "$@"` : 'exit 128', ''].join('\n'),
  );
  chmodSync(path.join(bin, 'git'), 0o755);
  return { bin, calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

/** A fake `commandmate` CLI and tmux for one bounded monitor run (an idle claude frame). */
function monitorShims(): { dir: string; cm: string } {
  const dir = tmp('stale-checkout-cm-4574-');
  const cm = path.join(dir, 'fake-cm');
  const frame = path.join(dir, 'frame.json');
  writeFileSync(
    frame,
    JSON.stringify({ isRunning: true, cliToolId: 'claude', content: '❯ ', realtimeSnippet: '❯ ', isPromptWaiting: false, promptData: null }, null, 2),
  );
  writeFileSync(cm, ['#!/bin/sh', 'case " $* " in', '  *" --pane "*) printf \'❯ \\n\' ;;', `  *) cat "${frame}" ;;`, 'esac', ''].join('\n'));
  writeFileSync(path.join(dir, 'tmux'), '#!/bin/sh\nexit 0\n');
  chmodSync(cm, 0o755);
  chmodSync(path.join(dir, 'tmux'), 0o755);
  return { dir, cm };
}

interface ToolRun {
  status: number | null;
  stderr: string;
  calls: string[];
}

type Tool = 'monitor.sh' | 'contract.mjs' | 'wait-verify.mjs';
const TOOLS: Tool[] = ['monitor.sh', 'contract.mjs', 'wait-verify.mjs'];

/**
 * Start one tool the way an operator does, with git answering about `gitDir`.
 * contract.mjs and wait-verify.mjs get no arguments (usage, exit 2: nothing is
 * generated or waited on); monitor.sh is bounded by --max-polls on a fake CLI.
 */
function runTool(tool: Tool, gitDir: string | null, gitMode: 'real' | 'fail' = 'real'): ToolRun {
  const recorder = gitRecorder(gitMode);
  const extra: Record<string, string> = gitDir ? { GIT_DIR: gitDir } : {};
  let proc;
  if (tool === 'monitor.sh') {
    const shims = monitorShims();
    proc = spawnSync(
      'bash',
      [MONITOR, '--interval', '0', '--idle-threshold', '1', '--max-polls', '1', '--no-auto-approve', 'w1'],
      {
        encoding: 'utf8',
        timeout: HARD_TIMEOUT_MS,
        cwd: os.tmpdir(),
        env: childEnv({ ...extra, PATH: `${recorder.bin}:${shims.dir}:${process.env.PATH ?? ''}`, CM: shims.cm }),
      },
    );
  } else {
    proc = spawnSync(process.execPath, [tool === 'contract.mjs' ? CONTRACT : WAIT_VERIFY], {
      encoding: 'utf8',
      timeout: HARD_TIMEOUT_MS,
      cwd: os.tmpdir(),
      env: childEnv({ ...extra, PATH: `${recorder.bin}:${process.env.PATH ?? ''}` }),
    });
  }
  assertSubprocessCompleted(proc, 'monitor-stale-checkout-4574.test.ts');
  return { status: proc.status, stderr: proc.stderr ?? '', calls: recorder.calls() };
}

const warnLines = (stderr: string): string[] => stderr.split('\n').filter((line) => WARN_RE.test(line));

describe('N-V: each tool says it runs from a checkout behind origin/develop (Issue #4574)', () => {
  for (const tool of TOOLS) {
    it(`${tool}: the first stderr line is the WARN, and the exit code is the control's`, () => {
      const behind = fakeCheckout('behind');
      const same = fakeCheckout('same');

      const stale = runTool(tool, path.join(behind, '.git'));
      const control = runTool(tool, path.join(same, '.git'));

      const first = stale.stderr.split('\n')[0];
      expect(first).toMatch(WARN_RE);
      expect(WARN_RE.exec(first)?.[1]).toBe(tool);
      expect(WARN_RE.exec(first)?.[2]).toBe('1');
      expect(first).toContain('nothing was fetched');
      expect(warnLines(stale.stderr)).toHaveLength(1);

      // Same ref: nothing said. The exit code does not move (N-F).
      expect(warnLines(control.stderr)).toEqual([]);
      expect(stale.status).toBe(control.status);

      // The check really asked git, and never fetched (N-F).
      expect(stale.calls.some((call) => /rev-list/.test(call))).toBe(true);
      expect([...stale.calls, ...control.calls].filter((call) => FETCHING.test(call))).toEqual([]);
    }, 3 * HARD_TIMEOUT_MS);

    it(`${tool}: silent and the same exit code when git fails, or there is no repository`, () => {
      const same = fakeCheckout('same');
      const control = runTool(tool, path.join(same, '.git'));
      const failing = runTool(tool, path.join(same, '.git'), 'fail');
      const noRepo = runTool(tool, path.join(tmp('stale-checkout-norepo-4574-'), 'missing.git'));

      for (const run of [failing, noRepo]) {
        expect(warnLines(run.stderr)).toEqual([]);
        expect(run.status).toBe(control.status);
        expect(run.calls.filter((call) => FETCHING.test(call))).toEqual([]);
      }
    }, 4 * HARD_TIMEOUT_MS);
  }
});

describe('N-V: the rule the two readers share (behind / same / ahead / no ref)', () => {
  /** monitor-lib.sh's check, run on a directory (no GIT_DIR: it asks git about the directory itself). */
  function shellNote(dir: string, env: Record<string, string> = {}): { stdout: string; status: number | null } {
    const recorder = gitRecorder('real');
    const out = spawnSync('bash', ['-c', `. "${LIB}"; ml_stale_checkout_warning "$1" monitor.sh`, 'bash', dir], {
      encoding: 'utf8',
      timeout: HARD_TIMEOUT_MS,
      env: childEnv({ PATH: `${recorder.bin}:${process.env.PATH ?? ''}`, ...env }),
    });
    assertSubprocessCompleted(out, 'monitor-stale-checkout-4574.test.ts');
    expect(recorder.calls().filter((call) => FETCHING.test(call))).toEqual([]);
    return { stdout: out.stdout ?? '', status: out.status };
  }

  /** wait-verify.mjs's check on the same directory, with git calls recorded. */
  function jsNote(dir: string): string | null {
    const calls: string[][] = [];
    const run = (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return waitVerify.defaultRun(command, args);
    };
    const note = waitVerify.staleCheckoutWarning(dir, { tool: 'monitor.sh', run, env: childEnv() });
    expect(calls.filter((call) => FETCHING.test(call.join(' ')))).toEqual([]);
    return note;
  }

  it('behind: both say the same WARN line; same and ahead: both say nothing', () => {
    const behind = fakeCheckout('behind');
    const shell = shellNote(behind);
    expect(shell.status).toBe(0);
    expect(shell.stdout.trimEnd()).toMatch(WARN_RE);
    expect(jsNote(behind)).toBe(shell.stdout.trimEnd());

    for (const shape of ['same', 'ahead'] as const) {
      const dir = fakeCheckout(shape);
      expect(shellNote(dir)).toEqual({ stdout: '', status: 0 });
      expect(jsNote(dir)).toBeNull();
    }
  }, 4 * HARD_TIMEOUT_MS);

  it('no repository, or no origin/develop ref: both silent, no throw, exit 0', () => {
    const bare = tmp('stale-checkout-plain-4574-');
    expect(shellNote(bare)).toEqual({ stdout: '', status: 0 });
    expect(jsNote(bare)).toBeNull();

    const noRef = tmp('stale-checkout-noref-4574-');
    git(noRef, 'init', '-q', '-b', 'develop');
    writeFileSync(path.join(noRef, 'a.txt'), 'a\n');
    git(noRef, 'add', 'a.txt');
    git(noRef, 'commit', '-q', '-m', 'a');
    expect(shellNote(noRef)).toEqual({ stdout: '', status: 0 });
    expect(jsNote(noRef)).toBeNull();
  }, 3 * HARD_TIMEOUT_MS);

  it('a git runner that throws is null, not a throw (N-F)', () => {
    const run = () => {
      throw new Error('spawn git ENOENT');
    };
    expect(waitVerify.staleCheckoutWarning(os.tmpdir(), { tool: 'contract.mjs', run, env: {} as NodeJS.ProcessEnv })).toBeNull();
  });

  it('under vitest (VITEST set) both stay silent, even behind', () => {
    const behind = fakeCheckout('behind');
    expect(shellNote(behind, { VITEST: 'true' })).toEqual({ stdout: '', status: 0 });
    expect(waitVerify.staleCheckoutWarning(behind, { tool: 'monitor.sh', env: childEnv({ VITEST: 'true' }) })).toBeNull();
  }, 2 * HARD_TIMEOUT_MS);
});
