import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Issue #1614: every external command the monitor depends on must have its exit
 * code read. Two failure families are covered here, and they are pinned in
 * separate tests on purpose — a run where git could not answer and a run where
 * the worker genuinely wrote nothing produce the SAME counters (0), so only a
 * test that asserts on the report can tell them apart:
 *
 *   1. hooks-git.sh — `git worktree list` / `git log` / `git status`. The old
 *      `git ... | wc -l` handed the pipeline's exit code to `wc`, so a failing
 *      git was reported as zero work and a finished worker read as NOT_STARTED.
 *   2. monitor.sh — classify-state.sh / verify-completion.sh. An empty `state`
 *      is not inert: it reaches verify-completion.sh, is not recognised as a
 *      live signal, and lets a busy worker fall through to a COMPLETE.
 */
const SCRIPTS = path.join(process.cwd(), '.claude/skills/orchestrate-monitor/scripts');
const HOOKS_GIT = path.join(SCRIPTS, 'hooks-git.sh');
const VERIFY = path.join(SCRIPTS, 'verify-completion.sh');
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

/** Absolute path, so a PATH shim named `git` can still call the real one. */
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

const HARD_TIMEOUT_MS = 15_000;

function git(cwd: string, ...args: string[]): void {
  execFileSync(REAL_GIT, ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

interface Repo {
  repo: string;
  id: string;
  base: string;
}

/**
 * A repo whose feature worktree carries exactly `commits` commits ahead of the
 * base and `changes` files `git status --porcelain` would list. The id is what
 * generateWorktreeId('feature/x', 'myrepo') produces, i.e. what monitor.sh is
 * given in a real run.
 */
function makeRepo(commits: number, changes: number): Repo {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hooks-git-'));
  const repo = path.join(root, 'myrepo');
  mkdirSync(repo);
  execFileSync(REAL_GIT, ['-c', 'init.defaultBranch=main', 'init', '--quiet', repo], {
    stdio: 'ignore',
  });
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'base');

  const worktree = path.join(root, 'myrepo-x');
  git(repo, 'worktree', 'add', '--quiet', '-b', 'feature/x', worktree);
  for (let n = 1; n <= commits; n += 1) {
    writeFileSync(path.join(worktree, `c${n}.txt`), `${n}\n`);
    git(worktree, 'add', '.');
    git(worktree, 'commit', '--quiet', '-m', `work ${n}`);
  }
  for (let n = 1; n <= changes; n += 1) {
    writeFileSync(path.join(worktree, `wip${n}.txt`), `${n}\n`);
  }

  return { repo, id: 'myrepo-feature-x', base: 'main' };
}

/**
 * A `git` that fails for exactly one subcommand and calls through for the rest,
 * so a test can break `git log` while `git worktree list` still answers. That
 * separation is the point: the two counters must be able to disagree about
 * whether they could be measured.
 */
function gitShim(failFor: string, exitCode = 128): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'git-shim-'));
  const shim = path.join(dir, 'git');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      'for a in "$@"; do',
      `  if [ "$a" = "${failFor}" ]; then`,
      `    echo "git ${failFor}: simulated failure" >&2`,
      `    exit ${exitCode}`,
      '  fi',
      'done',
      `exec ${REAL_GIT} "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(shim, 0o755);
  return dir;
}

interface ProbeResult {
  counts: string;
  stderr: string;
  status: number | null;
}

/** Source the hooks and print `<commits> <uncommitted>` for one worktree id. */
function probeCounters(repo: Repo, opts: { shimDir?: string; id?: string } = {}): ProbeResult {
  const id = opts.id ?? repo.id;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MONITOR_HOOKS_REPO: repo.repo,
    MONITOR_HOOKS_BASE: repo.base,
  };
  if (opts.shimDir) {
    env.PATH = `${opts.shimDir}:${process.env.PATH ?? ''}`;
  }

  const proc = spawnSync(
    'bash',
    ['-c', `. "${HOOKS_GIT}"; printf '%s %s\\n' "$(count_commits ${id})" "$(count_uncommitted ${id})"`],
    { encoding: 'utf8', env, timeout: HARD_TIMEOUT_MS },
  );

  return {
    counts: (proc.stdout ?? '').trim(),
    stderr: proc.stderr ?? '',
    status: proc.status,
  };
}

describe('hooks-git.sh counts exactly, for zero / one / many (Issue #1614)', () => {
  // The counting form is pinned at all three sizes because the obvious way to
  // read git's exit code — capture the output first, then count it — breaks the
  // count itself: `$()` strips the trailing newline, so `printf '%s' "$out" |
  // wc -l` reports one fewer line than there are (measured on bash 3.2.57:
  // 1 record -> 0, 2 -> 1). A fix for the exit code that quietly undercounts
  // work would recreate the very false NOT_STARTED it was meant to remove.
  it.each([
    { commits: 0, changes: 0, expected: '0 0' },
    { commits: 1, changes: 1, expected: '1 1' },
    { commits: 3, changes: 2, expected: '3 2' },
  ])('reports "$expected" for $commits commit(s) and $changes change(s)', ({ commits, changes, expected }) => {
    const probe = probeCounters(makeRepo(commits, changes));
    expect({ counts: probe.counts, status: probe.status }).toEqual({ counts: expected, status: 0 });
  }, 20_000);

  it('stays silent for a worker that genuinely has no commits and no changes', () => {
    // The control arm for every failure test below, and the reason they cannot
    // satisfy each other's assertion: true zero-work must produce the same "0 0"
    // with NOTHING on stderr. A guard that warned here would make the warning
    // meaningless — an operator would learn to ignore the one line that matters.
    const probe = probeCounters(makeRepo(0, 0));

    expect(probe.counts).toBe('0 0');
    expect(probe.stderr).toBe('');
  }, 20_000);
});

describe('hooks-git.sh separates a failed git from zero work (Issue #1614)', () => {
  it('reports a failing `git worktree list` instead of counting zero silently', () => {
    // The worst of the three: the path resolution feeds BOTH counters, so one
    // failure sinks them together and the worker reads exactly like a session
    // whose task never left the composer.
    const repo = makeRepo(2, 1);
    const probe = probeCounters(repo, { shimDir: gitShim('worktree') });

    expect(probe.counts).toBe('0 0');
    expect(probe.stderr).toContain(`[${repo.id}] 'git -C ${repo.repo} worktree list --porcelain' failed (exit 128)`);
    expect(probe.stderr).toContain('UNKNOWN and reported as 0');
  }, 20_000);

  it('reports a failing `git log` while the uncommitted counter still answers', () => {
    // Asymmetry on purpose: `git status` is untouched here, so the run proves the
    // commit counter alone went unknown rather than the whole hook giving up.
    const repo = makeRepo(2, 1);
    const probe = probeCounters(repo, { shimDir: gitShim('log', 129) });

    expect(probe.counts).toBe('0 1');
    expect(probe.stderr).toContain(`[${repo.id}] 'git -C `);
    expect(probe.stderr).toContain(`log --oneline main..HEAD' failed (exit 129)`);
    expect(probe.stderr).toContain('the commit count is UNKNOWN and reported as 0');
  }, 20_000);

  it('reports a failing `git status` while the commit counter still answers', () => {
    const repo = makeRepo(2, 1);
    const probe = probeCounters(repo, { shimDir: gitShim('status', 130) });

    expect(probe.counts).toBe('2 0');
    expect(probe.stderr).toContain(`status --porcelain' failed (exit 130)`);
    expect(probe.stderr).toContain('the uncommitted-change count is UNKNOWN and reported as 0');
  }, 20_000);

  it('reports an id that resolves to no checkout, which also sinks both counters', () => {
    // Not a git failure, the same silent floor of 0: `git worktree list` answered
    // and nothing matched. The existing base-ref warning exists for this exact
    // shape of mistake; an unresolvable id deserved the same line.
    const repo = makeRepo(2, 1);
    const probe = probeCounters(repo, { id: 'nope-nope' });

    expect(probe.counts).toBe('0 0');
    expect(probe.stderr).toContain('[nope-nope] no checkout resolved');
    expect(probe.stderr).toContain('not because the worker did nothing');
  }, 20_000);
});

/* ------------------------------------------------------------------ *
 * monitor.sh: the helper calls next to the one that was already checked
 * ------------------------------------------------------------------ */

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  captureCalls: string[];
}

/**
 * Copy the shipped scripts to a temp dir so a helper can be replaced by a stub.
 * monitor.sh resolves CLASSIFY / VERIFY from its own directory, which is exactly
 * why the copy — not a flag — is how a dying helper is simulated.
 */
function stageScripts(overrides: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-scripts-'));
  for (const file of readdirSync(SCRIPTS)) {
    const staged = path.join(dir, file);
    copyFileSync(path.join(SCRIPTS, file), staged);
    chmodSync(staged, 0o755);
  }
  for (const [name, body] of Object.entries(overrides)) {
    const staged = path.join(dir, name);
    writeFileSync(staged, body);
    chmodSync(staged, 0o755);
  }
  return dir;
}

function runLoop(opts: {
  scriptsDir: string;
  fixtures: string[];
  polls: number;
  idleThreshold?: number;
  args?: string[];
}): RunResult {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-exit-'));
  const captureLog = path.join(dir, 'capture.log');
  const counter = path.join(dir, 'poll-count');
  const cmShim = path.join(dir, 'fake-cm');
  const tmuxShim = path.join(dir, 'tmux');

  const arms = opts.fixtures
    .map((f, index) => {
      const pattern = index === opts.fixtures.length - 1 ? '*' : String(index + 1);
      return `  ${pattern}) cat "${path.join(FIXTURES, f)}" ;;`;
    })
    .join('\n');

  writeFileSync(
    cmShim,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${captureLog}"`,
      `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
      'n=$((n + 1))',
      `echo "$n" > "${counter}"`,
      'case "$n" in',
      arms,
      'esac',
      '',
    ].join('\n'),
  );
  writeFileSync(tmuxShim, '#!/bin/sh\nexit 0\n');
  chmodSync(cmShim, 0o755);
  chmodSync(tmuxShim, 0o755);
  writeFileSync(captureLog, '');

  const proc = spawnSync(
    'bash',
    [
      path.join(opts.scriptsDir, 'monitor.sh'),
      '--interval', '0',
      '--idle-threshold', String(opts.idleThreshold ?? 1),
      '--max-polls', String(opts.polls),
      ...(opts.args ?? []),
      'w1',
    ],
    {
      encoding: 'utf8',
      timeout: HARD_TIMEOUT_MS,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CM: cmShim },
    },
  );

  return {
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    status: proc.status,
    captureCalls: readFileSync(captureLog, 'utf8').split('\n').filter(Boolean),
  };
}

/** GENERATING latches started=1; every later poll is IDLE and climbs the streak. */
const STARTED_THEN_IDLE = ['live-generating-token.json', 'live-idle.json'];

/**
 * A hooks file whose commit counter answers 0 until the Nth call and 2 after it:
 * the worker that was idle-with-nothing has now committed. Written as a file so
 * the count survives the `$(...)` subshell monitor.sh calls the hook in.
 */
function latecomerHooks(dir: string, flipAt: number): string {
  const file = path.join(dir, 'hooks-latecomer.sh');
  const state = path.join(dir, 'commit-calls');
  writeFileSync(
    file,
    [
      'count_commits() {',
      `  n=$(cat "${state}" 2>/dev/null || echo 0)`,
      '  n=$((n + 1))',
      `  echo "$n" > "${state}"`,
      `  if [ "$n" -ge ${flipAt} ]; then echo 2; else echo 0; fi`,
      '}',
      '',
    ].join('\n'),
  );
  return file;
}

describe('verify-completion.sh treats an empty --state as no live signal (Issue #1614)', () => {
  // Characterisation, not a wish: this is WHY monitor.sh may never hand it an
  // empty state. Measured on bash 3.2.57. If this ever stops being true the
  // guard in monitor.sh can be reconsidered — until then it is load-bearing.
  it('returns COMPLETE for an idle-streak worker with commits when --state is empty', () => {
    const proc = spawnSync(
      'bash',
      [VERIFY, '--started', '1', '--state', '', '--idle-streak', '10', '--idle-threshold', '5',
        '--commits', '2', '--uncommitted', '0', '--task-status', ''],
      { encoding: 'utf8' },
    );
    expect((proc.stdout ?? '').trim()).toBe('COMPLETE');
  });

  it('returns WORKING for the same inputs when --state is the real GENERATING', () => {
    const proc = spawnSync(
      'bash',
      [VERIFY, '--started', '1', '--state', 'GENERATING', '--idle-streak', '10', '--idle-threshold', '5',
        '--commits', '2', '--uncommitted', '0', '--task-status', ''],
      { encoding: 'utf8' },
    );
    expect((proc.stdout ?? '').trim()).toBe('WORKING');
  });
});

describe('monitor.sh checks classify-state.sh the way it already checked capture (Issue #1614)', () => {
  /**
   * Polls 1-3 classify for real, so the worker latches started=1 and the idle
   * streak reaches the threshold with zero work (NOT_STARTED, correctly). The
   * classifier then dies on poll 4, at the moment the worker's first commit
   * lands. With the exit code ignored, `state` is empty, the streak stays where
   * it was, and verify-completion.sh reports COMPLETE for a worker whose pane
   * nobody could read.
   */
  function dyingClassifier(dir: string, dieFrom: number, mode: 'exit' | 'silent'): string {
    const state = path.join(dir, 'classify-calls');
    return [
      '#!/bin/sh',
      `n=$(cat "${state}" 2>/dev/null || echo 0)`,
      'n=$((n + 1))',
      `echo "$n" > "${state}"`,
      `if [ "$n" -ge ${dieFrom} ]; then`,
      mode === 'exit' ? '  exit 7' : '  exit 0',
      'fi',
      `exec "${path.join(SCRIPTS, 'classify-state.sh')}" "$@"`,
      '',
    ].join('\n');
  }

  it.each([
    { mode: 'exit' as const, label: 'a non-zero exit', expected: 'classify-state failed (exit 7), skipping poll' },
    { mode: 'silent' as const, label: 'exit 0 with no output', expected: 'classify-state failed (exit 0), skipping poll' },
  ])('skips the poll and says so on $label', ({ mode, expected }) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-classify-'));
    const scriptsDir = stageScripts({ 'classify-state.sh': dyingClassifier(dir, 4, mode) });
    const run = runLoop({
      scriptsDir,
      fixtures: ['live-generating-token.json', 'live-idle.json'],
      polls: 6,
      idleThreshold: 2,
      args: ['--verbose', '--hooks', latecomerHooks(dir, 4)],
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`monitor[w1]: ${expected}`);
    // The defect, stated as an absence: a worker whose pane could not be read is
    // never reported done. Without the guard this run ends on poll 4 with
    // `COMPLETE (approvals=0)`.
    expect(run.stdout).not.toContain('COMPLETE');
    expect(run.stdout).toContain('reached --max-polls');
    // Polls 4-6 produce no verdict at all, so only the first three carry a poll line.
    expect(run.stdout.split('\n').filter((line) => / poll \d+ -> /.test(line))).toHaveLength(3);
  }, 20_000);

  it('still reaches COMPLETE on the same schedule when the classifier works', () => {
    // The control: without it, "no COMPLETE" above could be an artifact of the
    // fixture sequence rather than of the guard.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-classify-ok-'));
    const run = runLoop({
      scriptsDir: stageScripts({}),
      fixtures: ['live-generating-token.json', 'live-idle.json'],
      polls: 6,
      idleThreshold: 2,
      args: ['--verbose', '--hooks', latecomerHooks(dir, 4)],
    });

    expect(run.stdout).toContain('monitor[w1]: COMPLETE (approvals=0)');
    expect(run.stdout).not.toContain('classify-state failed');
  }, 20_000);
});

describe('monitor.sh checks verify-completion.sh instead of skipping the poll silently (Issue #1614)', () => {
  it.each([
    { body: '#!/bin/sh\nexit 9\n', label: 'a non-zero exit', code: 9 },
    { body: '#!/bin/sh\nexit 0\n', label: 'exit 0 with no verdict', code: 0 },
  ])('reports $label with the inputs the call was given', ({ body, code }) => {
    const run = runLoop({
      scriptsDir: stageScripts({ 'verify-completion.sh': body }),
      fixtures: STARTED_THEN_IDLE,
      polls: 2,
      args: ['--verbose'],
    });

    expect(run.status).toBe(0);
    // `case "$verdict"` has no default arm, so before this guard the poll passed
    // through in total silence — the loop looked healthy while deciding nothing.
    expect(run.stdout).toContain(
      `monitor[w1]: verify-completion failed (exit ${code}), no verdict this poll ` +
        '(state=GENERATING started=1 streak=0 commits=0 uncommitted=0 task=-)',
    );
    expect(run.stdout).toContain(
      `monitor[w1]: verify-completion failed (exit ${code}), no verdict this poll ` +
        '(state=IDLE started=1 streak=1 commits=0 uncommitted=0 task=-)',
    );
    // Both polls happened and neither produced a verdict line.
    expect(run.captureCalls).toHaveLength(2);
    expect(run.stdout.split('\n').filter((line) => / poll \d+ -> /.test(line))).toHaveLength(0);
  }, 20_000);
});

describe('hooks-git.sh warns once per worker, not once per poll (Issue #1614)', () => {
  it('prints the git failure a single time across a multi-poll run', () => {
    // Same granularity as the base-ref warning it sits next to. A per-poll line
    // at the operator's 20s interval buries the stream it exists to make
    // readable, and the cause cannot change between polls.
    const repo = makeRepo(2, 1);
    const shim = gitShim('worktree');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-hooks-once-'));
    const captureLog = path.join(dir, 'capture.log');
    const cmShim = path.join(dir, 'fake-cm');
    const tmuxShim = path.join(dir, 'tmux');
    writeFileSync(
      cmShim,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${captureLog}"\ncat "${path.join(FIXTURES, 'live-idle.json')}"\n`,
    );
    writeFileSync(tmuxShim, '#!/bin/sh\nexit 0\n');
    chmodSync(cmShim, 0o755);
    chmodSync(tmuxShim, 0o755);
    writeFileSync(captureLog, '');

    const proc = spawnSync(
      'bash',
      [path.join(SCRIPTS, 'monitor.sh'), '--interval', '0', '--idle-threshold', '1',
        '--max-polls', '4', '--hooks', HOOKS_GIT, repo.id],
      {
        encoding: 'utf8',
        timeout: HARD_TIMEOUT_MS,
        env: {
          ...process.env,
          PATH: `${dir}:${shim}:${process.env.PATH ?? ''}`,
          CM: cmShim,
          MONITOR_HOOKS_REPO: repo.repo,
          MONITOR_HOOKS_BASE: repo.base,
        },
      },
    );

    const warnings = (proc.stderr ?? '')
      .split('\n')
      .filter((line) => line.includes("worktree list --porcelain' failed"));
    expect(readFileSync(captureLog, 'utf8').split('\n').filter(Boolean)).toHaveLength(4);
    expect(warnings).toHaveLength(1);
  }, 20_000);
});
