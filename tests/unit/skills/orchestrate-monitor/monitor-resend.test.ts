import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MONITOR = path.join(
  process.cwd(),
  '.claude/skills/orchestrate-monitor/scripts/monitor.sh',
);
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

/**
 * Loop parameters shared by every case below.
 *
 * The decision core counts *polls*, not seconds: the idle streak is incremented
 * once per poll, so with `--idle-threshold 1` the very first poll that classifies
 * IDLE is already actionable and the number of polls is the only thing that
 * decides how far a scenario gets. `--interval 0` therefore takes the wall clock
 * out of the test completely, and `--max-polls` (Issue #1527) ends the run from
 * the inside — the loop otherwise never exits, because count_commits /
 * count_uncommitted are stubbed to 0 so no worker is ever COMPLETE.
 *
 * This replaces the previous design, where the loop was killed by a 2.5s
 * spawnSync timeout: how many polls it managed depended on machine load, which
 * made the escalation assertion (needs a 2nd poll) racy under parallel test runs,
 * and left the two `toEqual([])` assertions passing even for a loop that had run
 * zero polls. Each case now names the polls it needs and proves they happened —
 * see expectPolls().
 */
const INTERVAL_SEC = 0;
const IDLE_THRESHOLD = 1;

/**
 * Safety net only: orders of magnitude above the real runtime (a bounded run is
 * a handful of subprocess spawns). No assertion depends on it — if it ever fires,
 * expectPolls() reports it as a failure instead of silently shortening the loop.
 */
const HARD_TIMEOUT_MS = 15_000;

interface RunResult {
  stdout: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  /** One line per `tmux ...` invocation the loop made. */
  tmuxCalls: string[];
  /** One line per `$CM capture ...` invocation, i.e. one per poll performed. */
  captureCalls: string[];
}

function logLines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

/**
 * Run the loop against a fixed capture frame for exactly `polls` rounds, with
 * `tmux` and the commandmate launcher replaced by logging shims. The loop stops
 * itself via --max-polls, which also exercises the EXIT trap on the normal path.
 */
function runLoop(fixture: string, polls: number, extraArgs: string[] = []): RunResult {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-resend-'));
  const tmuxLog = path.join(dir, 'tmux.log');
  const captureLog = path.join(dir, 'capture.log');
  const tmuxShim = path.join(dir, 'tmux');
  const cmShim = path.join(dir, 'fake-cm');

  writeFileSync(tmuxShim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${tmuxLog}"\nexit 0\n`);
  // Logs its own invocation before serving the frame, so the test can count the
  // polls the loop really made instead of trusting the loop's own stdout.
  writeFileSync(
    cmShim,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${captureLog}"\ncat "${path.join(FIXTURES, fixture)}"\n`,
  );
  chmodSync(tmuxShim, 0o755);
  chmodSync(cmShim, 0o755);
  writeFileSync(tmuxLog, '');
  writeFileSync(captureLog, '');

  const proc = spawnSync(
    'bash',
    [
      MONITOR,
      '--interval',
      String(INTERVAL_SEC),
      '--idle-threshold',
      String(IDLE_THRESHOLD),
      '--max-polls',
      String(polls),
      ...extraArgs,
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
    status: proc.status,
    signal: proc.signal,
    tmuxCalls: logLines(tmuxLog),
    captureCalls: logLines(captureLog),
  };
}

/**
 * Gate for every assertion below, and the whole point of Issue #1527: prove the
 * loop actually completed `polls` rounds before believing anything it did or did
 * not do. It exited through its own --max-polls branch (status 0, no signal), the
 * launcher shim was called once per round, and no round bailed out early as an
 * unparseable frame. Without this, `expect(tmuxCalls).toEqual([])` is equally
 * satisfied by a loop that never looked at the pane at all.
 */
function expectPolls(run: RunResult, polls: number): void {
  expect({ status: run.status, signal: run.signal }).toEqual({ status: 0, signal: null });
  expect(run.captureCalls).toEqual(Array.from({ length: polls }, () => 'capture w1 --json'));
  expect(run.stdout).toContain(
    `reached --max-polls (${polls}) after ${polls} poll round(s)`,
  );
  expect(run.stdout).not.toContain('capture failed');
}

describe('monitor.sh recovers from retry exhaustion (Issue #1522, defect 4)', () => {
  it('resends once the CLI has given up and fallen back to an idle prompt', () => {
    const MAX_RESENDS = 1;
    const RESEND_MESSAGE = 'resume please';
    // Poll 1: IDLE + terminal API error, the streak reaches IDLE_THRESHOLD ->
    //         resend (1/1), which resets the streak to 0.
    // Poll 2: the streak reaches the threshold again, budget is spent -> escalate.
    const POLLS = MAX_RESENDS + 1;

    const run = runLoop('live-api-error-exhausted.json', POLLS, [
      '--max-resends',
      String(MAX_RESENDS),
      '--resend-message',
      RESEND_MESSAGE,
    ]);
    expectPolls(run, POLLS);

    expect(run.stdout).toContain(`resent to mcbd-claude-w1 (1/${MAX_RESENDS})`);
    // Capped, then escalated instead of typing into the pane forever: the second
    // poll is now guaranteed to have happened, so this is no longer a race.
    expect(run.stdout).toContain('resend budget spent');
    // Issue #1601: the target is derived from the poll's cliToolId (no flag was
    // passed), checked for existence first, and addressed with tmux's exact-match
    // `=name:` form. The old expectation here was `cm-w1` — a session that has
    // never existed, which is precisely why every resend was a no-op.
    expect(run.tmuxCalls).toEqual([
      'has-session -t =mcbd-claude-w1:',
      `send-keys -t =mcbd-claude-w1: ${RESEND_MESSAGE} Enter`,
    ]);
  }, 20_000);

  it('never intervenes while the CLI is still inside its own backoff', () => {
    // The production harm: input sent mid-backoff is queued, then delivered once
    // the retry succeeds, pushing the worker into work it was never asked to do.
    // Three polls: at IDLE_THRESHOLD 1 any intervening branch would fire on the
    // first look at this frame, and two more rounds cover a streak-driven one.
    const POLLS = 3;
    const run = runLoop('live-retrying-529.json', POLLS);
    expectPolls(run, POLLS);

    expect(run.tmuxCalls).toEqual([]);
    expect(run.stdout).not.toContain('rate limit');
    expect(run.stdout).not.toContain('resent');
    // The frame was treated as a live, started worker: had it classified as idle
    // or not-running, the streak would have crossed the threshold and reported
    // NOT_STARTED. That keeps the empty-tmuxCalls claim about *this* state.
    expect(run.stdout).not.toContain('NOT_STARTED');
  }, 20_000);

  it('never intervenes on a healthy worker whose pane shows rate-limiter source', () => {
    // The 5th defect at loop level: this frame used to classify as RATE_LIMIT and
    // get an `a` typed into it.
    const POLLS = 3;
    const run = runLoop('live-generating-rate-limit-source.json', POLLS);
    expectPolls(run, POLLS);

    expect(run.tmuxCalls).toEqual([]);
    expect(run.stdout).not.toContain("sent 'a'");
    expect(run.stdout).not.toContain('NOT_STARTED');
  }, 20_000);

  it('still sends "a" on a genuine usage-limit banner', () => {
    // RATE_LIMIT is acted on immediately, so a single poll is the whole scenario.
    const POLLS = 1;
    const run = runLoop('rate-limit.json', POLLS);
    expectPolls(run, POLLS);

    // The log now states the RESULT and names the session it reached: before
    // #1601 it printed "sending 'a'" *before* a send-keys whose failure was
    // swallowed, so the line was emitted whether or not anything was delivered.
    expect(run.stdout).toContain("rate limit -> sent 'a' to mcbd-claude-w1");
    expect(run.tmuxCalls).toEqual([
      'has-session -t =mcbd-claude-w1:',
      'send-keys -t =mcbd-claude-w1: a Enter',
    ]);
  }, 20_000);
});
