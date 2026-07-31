import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.join(
  process.cwd(),
  '.claude/skills/orchestrate-monitor/scripts/verify-completion.sh',
);

function verify(args: string[]): string {
  return execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8' }).trim();
}

describe('verify-completion STARTED guard', () => {
  // Regression #1 (named in Issue #1512): an unstarted worker must never be
  // reported COMPLETE. `commandmate send` can leave the task in the composer
  // with Enter unconfirmed, so the worker never generates; the idle streak then
  // climbs and the naive baseline emits COMPLETE with commits=0 uncommitted=0.
  // The signature of an *unsent* task — no generation anchor ever observed AND
  // zero work — must classify as NOT_STARTED.
  it('reports NOT_STARTED for an idle worker that never started with no work', () => {
    const out = verify([
      '--started', '0',
      '--state', 'IDLE',
      '--idle-streak', '10',
      '--idle-threshold', '5',
      '--commits', '0',
      '--uncommitted', '0',
    ]);
    expect(out).toBe('NOT_STARTED');
  });

  it('reports COMPLETE only when the worker started and produced work', () => {
    const out = verify([
      '--started', '1',
      '--state', 'IDLE',
      '--idle-streak', '10',
      '--idle-threshold', '5',
      '--commits', '2',
      '--uncommitted', '0',
    ]);
    expect(out).toBe('COMPLETE');
  });

  it('counts uncommitted-only work as evidence of a real completion', () => {
    const out = verify([
      '--started', '1',
      '--state', 'IDLE',
      '--idle-streak', '8',
      '--idle-threshold', '5',
      '--commits', '0',
      '--uncommitted', '3',
    ]);
    expect(out).toBe('COMPLETE');
  });

  it('treats a started worker with zero work + idle as NOT_STARTED, not COMPLETE', () => {
    const out = verify([
      '--started', '1',
      '--state', 'IDLE',
      '--idle-streak', '10',
      '--idle-threshold', '5',
      '--commits', '0',
      '--uncommitted', '0',
    ]);
    expect(out).toBe('NOT_STARTED');
  });

  it('stays WORKING while still generating', () => {
    const out = verify([
      '--started', '1',
      '--state', 'GENERATING',
      '--idle-streak', '0',
      '--idle-threshold', '5',
      '--commits', '1',
      '--uncommitted', '1',
    ]);
    expect(out).toBe('WORKING');
  });

  it('stays WORKING when idle streak has not reached the threshold', () => {
    const out = verify([
      '--started', '1',
      '--state', 'IDLE',
      '--idle-streak', '2',
      '--idle-threshold', '5',
      '--commits', '1',
      '--uncommitted', '0',
    ]);
    expect(out).toBe('WORKING');
  });

  it('treats a generating worker as WORKING even before the anchor latched', () => {
    // started=0 + a live pane. Reached only because the live-signal branch now
    // runs ahead of the STARTED guard (Issue #1581); without that ordering the
    // guard would call a visibly generating worker NOT_STARTED.
    const out = verify([
      '--started', '0',
      '--state', 'GENERATING',
      '--idle-streak', '0',
      '--idle-threshold', '5',
      '--commits', '0',
      '--uncommitted', '0',
    ]);
    expect(out).toBe('WORKING');
  });
});

// Issue #1581: when the delegation carried an execution contract, the server
// adjudicates the task with the verification gates and records a terminal
// status. That verdict outranks anything inferred from pane text — the point of
// the change is that "the worker stopped" stops being read as "the work is good".
describe('verify-completion task status as the primary source', () => {
  // Statuses measured live against `commandmate task list` on the Epic #1539
  // certification worktree, which holds one run of each: succeeded / failed /
  // not_started.
  const idleWithNoWork = [
    '--state', 'IDLE',
    '--idle-streak', '10',
    '--idle-threshold', '5',
    '--commits', '0',
    '--uncommitted', '0',
  ];

  it('reports COMPLETE for a succeeded task even with no local work evidence', () => {
    // commits=0 && uncommitted=0 is the STARTED-guard's NOT_STARTED signature, so
    // this case can only come out COMPLETE if the task status really did decide
    // it. The counters are not corroborating evidence here — the server already
    // ran work-evidence as part of the gates that produced `succeeded`.
    const out = verify(['--started', '0', ...idleWithNoWork, '--task-status', 'succeeded']);
    expect(out).toBe('COMPLETE');
  });

  it('reports VERIFY_FAILED for a failed task instead of COMPLETE', () => {
    // The regression this whole issue targets: the worker finished and left
    // commits behind, so every capture-derived signal says COMPLETE, but the
    // gates rejected it. Merging on that verdict is the "completed but broken"
    // failure the contract exists to catch.
    const out = verify([
      '--started', '1',
      '--state', 'IDLE',
      '--idle-streak', '10',
      '--idle-threshold', '5',
      '--commits', '3',
      '--uncommitted', '0',
      '--task-status', 'failed',
    ]);
    expect(out).toBe('VERIFY_FAILED');
  });

  it('reports VERIFY_FAILED for a cancelled task', () => {
    const out = verify([
      '--started', '1',
      '--state', 'IDLE',
      '--idle-streak', '10',
      '--idle-threshold', '5',
      '--commits', '3',
      '--uncommitted', '0',
      '--task-status', 'cancelled',
    ]);
    expect(out).toBe('VERIFY_FAILED');
  });

  it('reports NOT_STARTED for a not_started task even when work is present', () => {
    const out = verify([
      '--started', '1',
      '--state', 'IDLE',
      '--idle-streak', '10',
      '--idle-threshold', '5',
      '--commits', '2',
      '--uncommitted', '1',
      '--task-status', 'not_started',
    ]);
    expect(out).toBe('NOT_STARTED');
  });

  it('lets a live pane veto a stale terminal status', () => {
    // `task list --limit 1` answers with the newest task, which is the one in
    // flight for the standard recipe — but not if a plain send followed an
    // earlier contract. A worker that is visibly generating cannot be done, so
    // the pane state is evaluated before the ledger.
    const out = verify([
      '--started', '1',
      '--state', 'GENERATING',
      '--idle-streak', '0',
      '--idle-threshold', '5',
      '--commits', '0',
      '--uncommitted', '0',
      '--task-status', 'succeeded',
    ]);
    expect(out).toBe('WORKING');
  });

  it.each(['pending', 'running', 'waiting_input', 'verifying'])(
    'falls back to the capture heuristics for the non-terminal status %s',
    (status) => {
      // `running` is the important one: `send` marks the task running as soon as
      // the message goes out, so a composer that never got its Enter sits in
      // `running` forever. Deciding from that status would hand the STARTED
      // guard's regression straight back.
      expect(verify(['--started', '0', ...idleWithNoWork, '--task-status', status])).toBe(
        'NOT_STARTED',
      );
      expect(
        verify([
          '--started', '1',
          '--state', 'IDLE',
          '--idle-streak', '10',
          '--idle-threshold', '5',
          '--commits', '2',
          '--uncommitted', '0',
          '--task-status', status,
        ]),
      ).toBe('COMPLETE');
    },
  );

  it.each(['', 'bogus-status'])(
    'falls back to the capture heuristics when the status is %o',
    (status) => {
      // Empty is what every hook returns when there is no contract, no ledger, or
      // an older CLI; an unrecognised value is what a changed output format would
      // produce. Both must degrade to the old behaviour, never to a verdict.
      expect(verify(['--started', '1', ...idleWithNoWork, '--task-status', status])).toBe(
        'NOT_STARTED',
      );
      expect(
        verify([
          '--started', '1',
          '--state', 'IDLE',
          '--idle-streak', '10',
          '--idle-threshold', '5',
          '--commits', '2',
          '--uncommitted', '0',
          '--task-status', status,
        ]),
      ).toBe('COMPLETE');
    },
  );
});
