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

// Same loop parameters as the other loop tests (Issue #1527): polls, not seconds,
// drive every decision, so --interval 0 removes the wall clock and --max-polls
// ends the run from the inside.
const INTERVAL_SEC = 0;
const IDLE_THRESHOLD = 1;
const HARD_TIMEOUT_MS = 15_000;

/**
 * The session name monitor.sh addressed before Issue #1601 (SESSION_PREFIX="cm").
 * No such session has ever existed — `getSessionName()` builds
 * `mcbd-<cliToolId>-<worktreeId>` — and every `send-keys` at it ended in
 * `2>/dev/null || true`, so the loop reported interventions it had never made.
 * Named here so the tests below can assert its absence explicitly: reverting the
 * default has to fail on the target, not merely on a log string.
 */
const DEAD_TARGET = 'cm-w1';

interface RunOptions {
  /** Capture payloads served in order; the last one repeats. */
  fixtures: Array<string | Record<string, unknown>>;
  polls: number;
  /** Worker specs, i.e. `<worktree-id>[@<instance-id>]`. */
  specs?: string[];
  args?: string[];
  /**
   * tmux session names that exist. Omit to make every `has-session` succeed;
   * pass `[]` for a host where the worker's session is gone.
   */
  sessions?: string[];
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  /** One line per `tmux ...` invocation, `has-session` included. */
  tmuxCalls: string[];
  /** One line per `$CM capture ...` invocation, with its flags. */
  captureCalls: string[];
}

/** A payload derived from a real capture, so the classification stays faithful. */
function derived(fixture: string, overrides: Record<string, unknown>): Record<string, unknown> {
  const base = JSON.parse(readFileSync(path.join(FIXTURES, fixture), 'utf8')) as Record<
    string,
    unknown
  >;
  const out = { ...base, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete out[key];
  }
  return out;
}

function runLoop({
  fixtures,
  polls,
  specs = ['w1'],
  args = [],
  sessions,
}: RunOptions): RunResult {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-target-'));
  const tmuxLog = path.join(dir, 'tmux.log');
  const captureLog = path.join(dir, 'capture.log');
  const counter = path.join(dir, 'poll-count');

  const paths = fixtures.map((fixture, index) => {
    if (typeof fixture === 'string') return path.join(FIXTURES, fixture);
    const file = path.join(dir, `payload-${index}.json`);
    // JSON.stringify(payload, null, 2) — byte-identical to what `capture --json`
    // emits, including the  escapes ml_strip_ansi and ml_json_scalar expect.
    writeFileSync(file, JSON.stringify(fixture, null, 2));
    return file;
  });

  const arms = paths
    .map((file, index) => {
      const pattern = index === paths.length - 1 ? '*' : String(index + 1);
      return `  ${pattern}) cat "${file}" ;;`;
    })
    .join('\n');

  // The launcher shim serves payload n on poll n (the last repeats) and logs the
  // full flag list, so a test can prove which pane was polled, not just which was
  // typed into.
  writeFileSync(
    path.join(dir, 'fake-cm'),
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

  const hasSession =
    sessions === undefined
      ? 'exit 0'
      : [
          'case "$3" in',
          ...sessions.map((name) => `  "=${name}:") exit 0 ;;`),
          '  *) exit 1 ;;',
          'esac',
        ].join('\n');

  writeFileSync(
    path.join(dir, 'tmux'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${tmuxLog}"`,
      'if [ "$1" = "has-session" ]; then',
      hasSession,
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );

  chmodSync(path.join(dir, 'fake-cm'), 0o755);
  chmodSync(path.join(dir, 'tmux'), 0o755);
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
      ...args,
      ...specs,
    ],
    {
      encoding: 'utf8',
      timeout: HARD_TIMEOUT_MS,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        CM: path.join(dir, 'fake-cm'),
      },
    },
  );

  const lines = (file: string): string[] =>
    readFileSync(file, 'utf8').split('\n').filter(Boolean);

  return {
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    status: proc.status,
    signal: proc.signal,
    tmuxCalls: lines(tmuxLog),
    captureCalls: lines(captureLog),
  };
}

/** Gate for every assertion: prove the loop really polled before believing it. */
function expectPolls(run: RunResult, polls: number): void {
  expect({ status: run.status, signal: run.signal }).toEqual({ status: 0, signal: null });
  expect(run.captureCalls).toHaveLength(polls);
  expect(run.stdout).not.toContain('capture failed');
}

/** `<worktree-id>` + `<instance-id>` hooks-free counters, to reach COMPLETE. */
function writeHooks(body: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-target-hooks-'));
  const file = path.join(dir, 'hooks.sh');
  writeFileSync(file, body);
  return file;
}

describe('monitor.sh derives the intervention target from the capture payload (Issue #1601)', () => {
  it('addresses mcbd-<cliToolId>-<worktree-id> with no flags at all', () => {
    // The acceptance case: the stock invocation an operator actually types. The
    // shipped default used to be `cm`, so this exact run delivered nothing.
    const run = runLoop({ fixtures: ['rate-limit.json'], polls: 1 });
    expectPolls(run, 1);

    expect(run.tmuxCalls).toEqual([
      'has-session -t =mcbd-claude-w1:',
      'send-keys -t =mcbd-claude-w1: a Enter',
    ]);
    expect(run.stdout).toContain('monitor[w1]: intervention target = mcbd-claude-w1');
    // Explicit, so restoring the old default fails here and not only on wording.
    expect(run.tmuxCalls.join('\n')).not.toContain(DEAD_TARGET);
  }, 20_000);

  it('follows the payload to a non-claude agent instead of assuming claude', () => {
    // A fleet running claude and codex at once is the reason a single fixed
    // prefix cannot be repaired by changing its default value.
    const run = runLoop({
      fixtures: [derived('rate-limit.json', { cliToolId: 'codex' })],
      polls: 1,
    });
    expectPolls(run, 1);

    expect(run.tmuxCalls).toEqual([
      'has-session -t =mcbd-codex-w1:',
      'send-keys -t =mcbd-codex-w1: a Enter',
    ]);
  }, 20_000);

  it('resolves <id>@<instance> to the instance session AND polls that instance', () => {
    // Both halves matter: `--agent`/`--instance` put the capture on the
    // instance's pane, and the same instance decides the session suffix, so the
    // pane that is classified is the pane that is typed into. Without --agent the
    // server would resolve the tool from the worktree row
    // (src/app/api/worktrees/[id]/current-output/route.ts) and look at a pane
    // belonging to a different agent.
    const run = runLoop({
      fixtures: [derived('rate-limit.json', { cliToolId: 'codex' })],
      polls: 1,
      specs: ['w1@codex-2'],
    });
    expectPolls(run, 1);

    expect(run.captureCalls).toEqual(['capture w1 --json --agent codex --instance codex-2']);
    // deriveSessionSuffix() strips the leading `codex-`, so the session is
    // mcbd-codex-w1-2 — never mcbd-codex-w1-codex-2.
    expect(run.tmuxCalls).toEqual([
      'has-session -t =mcbd-codex-w1-2:',
      'send-keys -t =mcbd-codex-w1-2: a Enter',
    ]);
    expect(run.stdout).toContain('monitor[w1@codex-2]: intervention target = mcbd-codex-w1-2');
  }, 20_000);

  it('keeps two instances of the same worktree apart', () => {
    // Per-worker state is keyed by `<id>@<instance>`, not by worktree id: sharing
    // a key would make one pane's approval reset the other's idle streak.
    const run = runLoop({
      fixtures: ['rate-limit.json'],
      polls: 1,
      specs: ['w1', 'w1@claude-2'],
    });
    expectPolls(run, 2);

    expect(run.captureCalls).toEqual([
      'capture w1 --json',
      'capture w1 --json --agent claude --instance claude-2',
    ]);
    expect(run.tmuxCalls).toEqual([
      'has-session -t =mcbd-claude-w1:',
      'send-keys -t =mcbd-claude-w1: a Enter',
      'has-session -t =mcbd-claude-w1-2:',
      'send-keys -t =mcbd-claude-w1-2: a Enter',
    ]);
  }, 20_000);

  it('uses tmux exact-match targets so an intervention cannot leak to another instance', () => {
    // Issue #1156: a bare `-t <name>` falls back to prefix matching when nothing
    // matches exactly, and `mcbd-claude-w1` is a prefix of `mcbd-claude-w1-2`.
    // Without `=`, keys aimed at a primary that is not running land in the `-2`
    // instance's pane.
    const run = runLoop({ fixtures: ['rate-limit.json'], polls: 1 });
    expectPolls(run, 1);

    const targets = run.tmuxCalls.map((call) => call.split(' -t ')[1]);
    expect(targets).toHaveLength(2);
    for (const target of targets) {
      expect(target.startsWith('=')).toBe(true);
      expect(target.split(' ')[0].endsWith(':')).toBe(true);
    }
  }, 20_000);

  it('replaces only the derived head when the legacy --session-prefix is given', () => {
    // Kept for a session this tool did not create. The instance suffix is still
    // appended, so an override cannot silently re-point an instance at its
    // primary's pane.
    const run = runLoop({
      fixtures: [derived('rate-limit.json', { cliToolId: 'codex' })],
      polls: 1,
      specs: ['w1@codex-2'],
      args: ['--session-prefix', 'legacy'],
    });
    expectPolls(run, 1);

    expect(run.tmuxCalls).toEqual([
      'has-session -t =legacy-w1-2:',
      'send-keys -t =legacy-w1-2: a Enter',
    ]);
  }, 20_000);
});

describe('monitor.sh reports undelivered interventions instead of swallowing them (Issue #1601)', () => {
  it('does not send, and says so, when the session does not exist', () => {
    // The production shape of the defect: the target is wrong (or the pane died),
    // `tmux send-keys` fails, and the old `2>/dev/null || true` turned that into
    // silence behind a log line that claimed success.
    const run = runLoop({ fixtures: ['rate-limit.json'], polls: 2, sessions: [] });
    expectPolls(run, 2);

    expect(run.tmuxCalls).toEqual([
      'has-session -t =mcbd-claude-w1:',
      'has-session -t =mcbd-claude-w1:',
    ]);
    expect(run.stderr).toContain(
      "monitor[w1]: rate limit 'a' NOT delivered — no tmux session 'mcbd-claude-w1'",
    );
    // The success wording must be absent: a failed intervention is never logged
    // as one, which is the whole point of moving the log after the send.
    expect(run.stdout).not.toContain("sent 'a'");
  }, 20_000);

  it('refuses to invent a session name when the payload carries no cliToolId', () => {
    // Guessing here is exactly what #1601 was. With nothing to derive from and no
    // override, the loop must not touch tmux at all.
    const run = runLoop({
      fixtures: [derived('rate-limit.json', { cliToolId: undefined })],
      polls: 1,
    });
    expectPolls(run, 1);

    expect(run.tmuxCalls).toEqual([]);
    expect(run.stderr).toContain('no tmux session could be derived');
    expect(run.stdout).not.toContain('intervention target');
  }, 20_000);

  it('counts an approval only when tmux accepted the Enter', () => {
    // GENERATING latches started=1, PROMPT triggers the auto-approve, IDLE at the
    // threshold with wired counters reaches COMPLETE — whose `approvals=` is the
    // number an operator reads as "prompts I no longer have to look at".
    const fixtures = ['live-generating-token.json', 'prompt-submit-answers.json', 'live-idle.json'];
    const hooks = writeHooks('count_commits() { echo 1; }\ncount_uncommitted() { echo 1; }\n');

    const delivered = runLoop({ fixtures, polls: 5, args: ['--hooks', hooks] });
    expect(delivered.stdout).toContain('monitor[w1]: COMPLETE (approvals=1)');
    expect(delivered.tmuxCalls).toEqual([
      'has-session -t =mcbd-claude-w1:',
      'send-keys -t =mcbd-claude-w1: Enter',
    ]);

    // Same run, same prompt, but nothing can receive the Enter. Before #1601 the
    // counter was incremented BEFORE the send-keys, so this run reported
    // `approvals=1` — an approval that never happened, on a worker still blocked
    // at its prompt.
    const missed = runLoop({ fixtures, polls: 5, args: ['--hooks', hooks], sessions: [] });
    expect(missed.stdout).toContain('monitor[w1]: COMPLETE (approvals=0)');
    expect(missed.stderr).toContain('prompt approval Enter NOT delivered');
    expect(missed.tmuxCalls).toEqual(['has-session -t =mcbd-claude-w1:']);
  }, 20_000);

  it('does not spend the resend budget on a resend that never landed', () => {
    // Spending it would escalate to "resend budget spent — operator needed" after
    // reporting recoveries that never reached a pane. The streak is kept too, so
    // the next poll retries and keeps reporting.
    const run = runLoop({
      fixtures: ['live-api-error-exhausted.json'],
      polls: 3,
      args: ['--max-resends', '1'],
      sessions: [],
    });
    expectPolls(run, 3);

    expect(run.stdout).not.toContain('resent');
    expect(run.stdout).not.toContain('resend budget spent');
    expect(run.stderr.split('\n').filter((l) => l.includes('NOT delivered'))).toHaveLength(3);
  }, 20_000);
});

describe('monitor.sh validates worker specs before they reach tmux (Issue #1601)', () => {
  it.each([
    ['w1;rm -rf /', 'invalid worktree id'],
    ['w1@bad;id', 'invalid instance id'],
    ['w1@', "has no instance id after '@'"],
  ])('rejects %s with exit 2', (spec, message) => {
    const run = runLoop({ fixtures: ['rate-limit.json'], polls: 1, specs: [spec] });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain(message);
    // Nothing ran: an id that is interpolated into a tmux target is checked
    // before it can be, mirroring validateSessionName() on the product side.
    expect(run.captureCalls).toEqual([]);
    expect(run.tmuxCalls).toEqual([]);
  }, 20_000);
});
