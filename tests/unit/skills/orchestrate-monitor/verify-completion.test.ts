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
});
