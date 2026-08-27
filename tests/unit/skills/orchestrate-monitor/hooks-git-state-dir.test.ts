import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HOOKS_STATE_DIR_ENV,
  expectDiagnostic,
  expectDiagnosticLines,
} from '@tests/helpers/hooks-git-diagnostics';
import {
  REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  assertSubprocessCompleted,
} from '@tests/helpers/real-shell-budget';
import { removeTempDir } from '@tests/helpers/temp-dir';

/**
 * Issue #2119 — where `hooks-git.sh` puts its once-per-worker markers when
 * NOBODY tells it, which is the standalone case the operator actually runs.
 *
 * Issue #2089 fixed the tests: every suite that sources `hooks-git.sh` now pins
 * `MONITOR_HOOKS_STATE_DIR` per test. That is why no other file in this
 * directory can see the defect any more — they all take the branch where the
 * caller decided. The production branch, `. hooks-git.sh` with neither
 * `MONITOR_HOOKS_STATE_DIR` nor monitor.sh's `STATE_DIR` in the environment,
 * still resolved to `$TMPDIR/cm-monitor-hooks-$$`:
 *
 *   - `$$` is the sourcing shell's pid, and pids recycle (macOS wraps at ~100k),
 *   - nothing outside monitor.sh ever removed one of those directories, so they
 *     only ever accumulate — 4129 of them holding 4214 markers on the
 *     development machine on 2026-08-27,
 *   - and the keys are `<worktree-id>.<cause>`, i.e. exactly the keys the next
 *     run wants to print.
 *
 * A run that drew a recycled pid therefore opened a store full of `warned-…`
 * files it had never written, `mh_report_once()` returned silently, and the one
 * line that distinguishes "git could not answer" from "the worker did nothing"
 * — the line #1614 and #1728 exist to make un-loseable — was gone.
 *
 * ## How the collision is made deterministic here
 *
 * A test cannot choose the pid the kernel hands the shell it spawns, and running
 * the same command often enough to hit a recycled one is a coin toss, not a
 * gate. So the collision is built from the inside: the spawned shell creates
 * `$TMPDIR/cm-monitor-hooks-$$/warned-<key>` for its OWN pid before it sources
 * the hooks. `$$` there is the same value the old fallback computed one command
 * later, so this is a recycled pid reproduced exactly — not a simulation of one.
 *
 * Measured against the pre-fix file (`git show HEAD:…/hooks-git.sh`), same
 * sandbox, same command, `mh_resolve nope-nope`:
 *
 *     old + poisoned $TMPDIR ... stderr EMPTY            <- the defect
 *     old + clean    $TMPDIR ... ERROR line, dir LEAKED  <- the litter producer
 *     new + poisoned $TMPDIR ... ERROR line
 *     new + clean    $TMPDIR ... ERROR line, no leftover
 *
 * Every run below is given its own `$TMPDIR`, so the suite neither reads nor
 * deletes the real accumulation on the developer's machine — that evidence has
 * to stay intact to tell "fixed" from "the proof was tidied away".
 */
const SCRIPTS = path.join(process.cwd(), '.claude/skills/orchestrate-monitor/scripts');
const HOOKS_GIT = path.join(SCRIPTS, 'hooks-git.sh');
const MONITOR = path.join(SCRIPTS, 'monitor.sh');
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

// Issue #1950: the shared guard, deliberately below the vitest budget that
// tests/setup.ts gives this family, so an overrun is reported by the guard
// rather than by a wall clock that names nothing.
const HARD_TIMEOUT_MS = REAL_SHELL_SUBPROCESS_TIMEOUT_MS;

/** Absolute, so a PATH shim named `git` can still call the real one. */
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

/** The id no checkout resolves to, and therefore the key every run reports on. */
const MISSING_ID = 'nope-nope';
const MISSING_KEY = `${MISSING_ID}.no-checkout`;
/** What `mh_resolve` prints for it — the diagnostic under test. */
const NO_CHECKOUT = `[${MISSING_ID}] no checkout resolved in`;

const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length > 0) removeTempDir(sandboxes.pop() as string);
});

/** A sandbox directory removed after the test, whatever it ends up holding. */
function sandbox(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  sandboxes.push(dir);
  return dir;
}

/**
 * A repository `git worktree list` answers for, on a base ref that resolves.
 *
 * Both matter: a failing `git worktree list` would report a different cause, and
 * an unresolvable base would add the source-time WARN at the bottom of
 * hooks-git.sh to stderr, so neither the presence nor the COUNT of diagnostic
 * lines below would be measuring what it claims to.
 */
function makeRepo(): string {
  const repo = path.join(sandbox('hooks-state-repo-'), 'myrepo');
  mkdirSync(repo);
  execFileSync(REAL_GIT, ['-c', 'init.defaultBranch=develop', 'init', '--quiet', repo], {
    stdio: 'ignore',
  });
  execFileSync(
    REAL_GIT,
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '--allow-empty', '-m', 'base'],
    { cwd: repo, stdio: 'ignore' },
  );
  return repo;
}

/** Names under a directory that the pid-keyed / mktemp store would use. */
function hookStores(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('cm-monitor-hooks-'));
}

interface ShellRun {
  stdout: string;
  stderr: string;
  /** Lines of stdout, so a snippet can report several values in order. */
  lines: string[];
  status: number | null;
}

/**
 * Source the hooks standalone and run `snippet`, with `$TMPDIR` pointed at a
 * sandbox and BOTH state-dir inputs removed from the environment.
 *
 * The deletions are the point of the harness: vitest inherits the developer's
 * shell, and an inherited `MONITOR_HOOKS_STATE_DIR` — or a `STATE_DIR` left over
 * from anything else — would take the branch this file is not testing and every
 * assertion below would pass without touching the fallback.
 */
function runStandalone(opts: {
  tmp: string;
  repo: string;
  snippet: string;
  /** Runs in the same shell BEFORE the hooks are sourced. */
  prelude?: string;
  env?: Record<string, string>;
}): ShellRun {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: opts.tmp,
    MONITOR_HOOKS_REPO: opts.repo,
    MONITOR_HOOKS_BASE: 'develop',
    // The git search is what resolves ids here; an inherited root would answer
    // for free and no diagnostic would be reached.
    MONITOR_WORKTREE_ROOT: '',
  };
  delete env[HOOKS_STATE_DIR_ENV];
  delete env.STATE_DIR;
  Object.assign(env, opts.env ?? {});

  const command = [opts.prelude, `. "${HOOKS_GIT}"`, opts.snippet]
    .filter((part) => part !== undefined && part !== '')
    .join('; ');
  const proc = spawnSync('bash', ['-c', command], {
    encoding: 'utf8',
    env,
    timeout: HARD_TIMEOUT_MS,
  });
  assertSubprocessCompleted(proc, 'hooks-git-state-dir.test.ts');

  const stdout = proc.stdout ?? '';
  return {
    stdout,
    stderr: proc.stderr ?? '',
    lines: stdout.split('\n').filter((line) => line !== ''),
    status: proc.status,
  };
}

/**
 * The prelude that reproduces a recycled pid exactly: the shell writes the
 * marker for its own `$$`, which is the directory the pre-#2119 fallback picked
 * on the next line.
 */
const POISON_OWN_PID =
  `mkdir -p "$TMPDIR/cm-monitor-hooks-$$" && : > "$TMPDIR/cm-monitor-hooks-$$/warned-${MISSING_KEY}"`;

describe('hooks-git.sh reports through a stale pid-keyed store in $TMPDIR (Issue #2119)', () => {
  it('prints the diagnostic even when $TMPDIR already holds this pid’s markers', () => {
    // The positive control, and the whole Issue: before the fix this stderr was
    // empty, reported as `expected '' to contain '…'`.
    const tmp = sandbox('hooks-state-poisoned-');
    const run = runStandalone({
      tmp,
      repo: makeRepo(),
      prelude: POISON_OWN_PID,
      snippet: `mh_resolve ${MISSING_ID} >/dev/null; printf '%s\\n' "$MONITOR_HOOKS_STATE_DIR" "$TMPDIR/cm-monitor-hooks-$$"`,
    });

    expectDiagnostic(run.stderr, NO_CHECKOUT, 'stale pid-keyed store in $TMPDIR');
    // And it printed because the store MOVED, not because the marker check was
    // weakened: the two paths the snippet reports must differ.
    expect(run.lines[0]).not.toBe(run.lines[1]);
    expect(path.basename(run.lines[0])).not.toBe(path.basename(run.lines[1]));
  });

  it('leaves the other run’s store alone instead of clearing it', () => {
    // The tempting cheap fix — delete whatever is in the pid-keyed directory at
    // source time — is wrong for the same reason the defect is: that directory
    // may belong to a live process, and removing its markers makes IT print a
    // line it already printed, breaking once-per-worker from the other side.
    const tmp = sandbox('hooks-state-foreign-');
    const run = runStandalone({
      tmp,
      repo: makeRepo(),
      prelude: POISON_OWN_PID,
      snippet: `mh_resolve ${MISSING_ID} >/dev/null; printf '%s\\n' "$TMPDIR/cm-monitor-hooks-$$"`,
    });

    const foreign = run.lines[0];
    expect(existsSync(path.join(foreign, `warned-${MISSING_KEY}`))).toBe(true);
  });

  it('still reports each cause once per run, not once per call', () => {
    // The negative control for the fix's granularity. `mktemp -d` runs ONCE, at
    // source time — a store minted per call would make every poll of a 20s
    // supervision loop print the same line, which is the per-poll noise #1614
    // removed and the opposite of what this Issue asks for.
    const tmp = sandbox('hooks-state-once-');
    const run = runStandalone({
      tmp,
      repo: makeRepo(),
      snippet: `mh_resolve ${MISSING_ID} >/dev/null; mh_resolve ${MISSING_ID} >/dev/null; mh_resolve ${MISSING_ID} >/dev/null`,
    });

    expectDiagnosticLines(
      run.stderr,
      (line) => line.includes(NO_CHECKOUT),
      1,
      'three calls in one standalone shell',
    );
  });

  it('says nothing extra when $TMPDIR is clean and the worker resolves', () => {
    // The other negative control: the fix must not turn a healthy run noisy.
    // `myrepo` is the repository's own directory name, so it resolves.
    const tmp = sandbox('hooks-state-clean-');
    const run = runStandalone({
      tmp,
      repo: makeRepo(),
      snippet: `count_commits myrepo; count_uncommitted myrepo`,
    });

    expect(run.stderr).toBe('');
    expect(run.lines).toEqual(['0', '0']);
  });
});

describe('hooks-git.sh removes only the store it minted itself (Issue #2119)', () => {
  it('takes its private store back out of $TMPDIR when the shell exits', () => {
    // The leak the pid-keyed name could not fix on its own: every standalone
    // source used to leave a directory behind for ever, which is how 4129 of
    // them reached one machine's $TMPDIR.
    const tmp = sandbox('hooks-state-cleanup-');
    const run = runStandalone({
      tmp,
      repo: makeRepo(),
      snippet: `mh_resolve ${MISSING_ID} >/dev/null; printf '%s\\n' "$MONITOR_HOOKS_STATE_DIR"`,
    });

    // It existed while the run was alive...
    expect(run.lines[0].startsWith(tmp)).toBe(true);
    expectDiagnostic(run.stderr, NO_CHECKOUT, 'private store, clean $TMPDIR');
    // ...and is gone now that it exited.
    expect(existsSync(run.lines[0])).toBe(false);
    expect(hookStores(tmp)).toEqual([]);
  });

  it('never removes a store the caller handed it', () => {
    // A pinned directory belongs to the caller — every other suite in this
    // folder pins one per test (Issue #2089) and asserts on the markers left in
    // it afterwards. Deleting it would be a different regression with the same
    // symptom.
    const tmp = sandbox('hooks-state-given-tmp-');
    const given = sandbox('hooks-state-given-');
    const run = runStandalone({
      tmp,
      repo: makeRepo(),
      snippet: `mh_resolve ${MISSING_ID} >/dev/null; printf '%s\\n' "$MONITOR_HOOKS_STATE_DIR"`,
      env: { [HOOKS_STATE_DIR_ENV]: given },
    });

    expect(run.lines[0]).toBe(given);
    expect(existsSync(path.join(given, `warned-${MISSING_KEY}`))).toBe(true);
    // A caller who pinned a directory did not ask for a temporary one.
    expect(hookStores(tmp)).toEqual([]);
  });

  it('never replaces an EXIT trap the sourcing shell already installed', () => {
    // bash keeps ONE EXIT trap, not a chain, so `trap … EXIT` from a sourced
    // file silently disarms the operator's own cleanup. Losing their trap to
    // save an empty directory of ours is the worse trade, so the trap is armed
    // only when `trap -p EXIT` is empty.
    const tmp = sandbox('hooks-state-operator-trap-');
    const run = runStandalone({
      tmp,
      repo: makeRepo(),
      prelude: `trap 'echo OPERATOR-CLEANUP-RAN >&2' EXIT`,
      snippet: `mh_resolve ${MISSING_ID} >/dev/null; printf '%s\\n' "$MONITOR_HOOKS_STATE_DIR"`,
    });

    expect(run.stderr).toContain('OPERATOR-CLEANUP-RAN');
    // The diagnostic is unaffected either way — the trap decision is about
    // cleanup, never about whether the report is printed.
    expectDiagnostic(run.stderr, NO_CHECKOUT, 'operator EXIT trap present');
    // And the price of keeping their trap, stated rather than implied: the
    // store outlives the shell.
    expect(existsSync(run.lines[0])).toBe(true);
  });
});

describe('under monitor.sh the markers still ride along in STATE_DIR (Issue #2119)', () => {
  it('adopts STATE_DIR verbatim, mints nothing and arms no trap', () => {
    // monitor.sh creates STATE_DIR and installs `trap cleanup EXIT` BEFORE it
    // sources any hooks file, so both guards say "not yours" and this branch is
    // exactly what it was before the Issue.
    const tmp = sandbox('hooks-state-monitor-env-tmp-');
    const stateDir = sandbox('hooks-state-monitor-env-');
    const run = runStandalone({
      tmp,
      repo: makeRepo(),
      snippet: `mh_resolve ${MISSING_ID} >/dev/null; printf '%s\\n' "$MONITOR_HOOKS_STATE_DIR" "[$MONITOR_HOOKS_STATE_DIR_OWNED]" "[$(trap -p EXIT)]"`,
      env: { STATE_DIR: stateDir },
    });

    expect(run.lines).toEqual([stateDir, '[]', '[]']);
    expect(existsSync(path.join(stateDir, `warned-${MISSING_KEY}`))).toBe(true);
    expect(hookStores(tmp)).toEqual([]);
  });

  it('warns once across a four-poll run and leaves no store behind', () => {
    // The end-to-end arm: the real monitor.sh, no MONITOR_HOOKS_STATE_DIR in the
    // environment at all, so the ride-along is chosen by hooks-git.sh rather
    // than pinned by the test. One warning for four polls is the once-per-worker
    // rule (#1614); the empty $TMPDIR afterwards is monitor.sh's own EXIT trap
    // taking the markers with its STATE_DIR, which is the behaviour #2119 must
    // not disturb.
    const tmp = sandbox('hooks-state-monitor-run-');
    const shims = sandbox('hooks-state-monitor-shims-');
    const repo = makeRepo();

    const captureLog = path.join(shims, 'capture.log');
    const cmShim = path.join(shims, 'fake-cm');
    const tmuxShim = path.join(shims, 'tmux');
    writeFileSync(
      cmShim,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${captureLog}"\ncat "${path.join(FIXTURES, 'live-idle.json')}"\n`,
    );
    writeFileSync(tmuxShim, '#!/bin/sh\nexit 0\n');
    chmodSync(cmShim, 0o755);
    chmodSync(tmuxShim, 0o755);
    writeFileSync(captureLog, '');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: tmp,
      PATH: `${shims}:${process.env.PATH ?? ''}`,
      CM: cmShim,
      MONITOR_HOOKS_REPO: repo,
      MONITOR_HOOKS_BASE: 'develop',
      MONITOR_WORKTREE_ROOT: '',
    };
    delete env[HOOKS_STATE_DIR_ENV];
    delete env.STATE_DIR;

    const proc = spawnSync(
      'bash',
      [MONITOR, '--interval', '0', '--idle-threshold', '1', '--max-polls', '4',
        '--hooks', HOOKS_GIT, MISSING_ID],
      { encoding: 'utf8', env, timeout: HARD_TIMEOUT_MS },
    );
    assertSubprocessCompleted(proc, 'hooks-git-state-dir.test.ts');

    expectDiagnosticLines(
      proc.stderr ?? '',
      (line) => line.includes(NO_CHECKOUT),
      1,
      'four polls under monitor.sh, one warning',
    );
    // monitor.sh's own STATE_DIR is a `mktemp -d -t cm-monitor.XXXXXX`, i.e. it
    // lands in this sandbox too — so an empty listing says both stores were
    // removed, not merely ours.
    expect(readdirSync(tmp)).toEqual([]);
  });
});
