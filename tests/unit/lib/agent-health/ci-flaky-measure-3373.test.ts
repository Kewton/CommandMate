import { describe, expect, it } from 'vitest';
import { measureCiFlaky, type CiAttempt, type CiRun } from '@/lib/agent-health/ci-flaky';

const now = new Date('2026-10-06T00:00:00Z');
const run = (id: number, sha: string, attempt: number, conclusion: string, at: string): CiRun => ({
  id,
  sha,
  workflow: 'CI',
  attempt,
  conclusion,
  createdAt: at,
});
const failedAttempt = (runId: number, attemptNo: number): CiAttempt => ({
  runId,
  attempt: attemptNo,
  jobs: [{ name: 'unit', conclusion: 'failure', steps: [{ name: 'Run tests', conclusion: 'failure' }] }],
  failedLog: 'unit\tRun tests\t2026-10-05T00:00:00Z FAIL a.test.ts > case one\n',
});
const passedAttempt = (runId: number, attemptNo: number): CiAttempt => ({
  runId,
  attempt: attemptNo,
  jobs: [{ name: 'unit', conclusion: 'success', steps: [] }],
  failedLog: null,
});

describe('measureCiFlaky stages (#3373)', () => {
  it('reports a test that passed on rerun as flaky', () => {
    const m = measureCiFlaky(
      [run(1, 'abcdef1', 2, 'success', '2026-10-05T00:00:00Z')],
      [failedAttempt(1, 1), passedAttempt(1, 2)],
      now
    );
    expect(m.status).toBe('ok');
    if (m.status !== 'ok') return;
    expect(m.value).toBe(1);
    expect(m.details).toMatchObject({ retrySuccesses: 1, flakyTests: 1, brokenTests: 0, failedAttempts: 1, testFailures: 1 });
    expect(m.records).toHaveLength(1);
  });

  it('counts unread attempts without adding records', () => {
    const m = measureCiFlaky([run(2, 'abcdef2', 2, 'failure', '2026-10-05T00:00:00Z')], [], now);
    if (m.status !== 'ok') throw new Error('skip');
    expect(m.value).toBe(0);
    expect(m.details).toMatchObject({ attemptsNotRead: 2 });
    expect(m.records).toEqual([]);
  });
});
