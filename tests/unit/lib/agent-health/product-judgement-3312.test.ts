/**
 * Issue #3312: the final result of the product-path check, decided on the
 * user's side from the execution result and the leak verdict — every
 * combination of the rules, the not-run cases, and the skip streak.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  countProductSkipStreak,
  judgeProductRun,
  parseProductFinalResult,
  PRODUCT_SKIP_STREAK_ALERT_DAYS,
  type ProductLeakVerdict,
} from '@/lib/agent-health/product-judgement';
import type { ProductCheckStatus, ProductRunResult, ProductStageStatus } from '@/lib/agent-health/product-result';

const NOW = new Date('2026-10-05T23:00:00Z');

interface Overrides extends Partial<Omit<ProductRunResult, 'cleanup' | 'reclaim'>> {
  run?: ProductStageStatus;
  cleanup?: ProductCheckStatus;
  reclaim?: ProductCheckStatus;
}

function result(overrides: Overrides = {}): ProductRunResult {
  const { run = 'pass', cleanup = 'pass', reclaim = 'pass', ...rest } = overrides;
  return {
    schemaVersion: 1,
    date: '2026-10-06',
    runId: 'r1',
    sha: 'abcdef1',
    startedAt: '2026-10-05T22:15:00.000Z',
    finishedAt: '2026-10-05T22:30:00.000Z',
    lateStart: false,
    stages: [
      { id: 'reclaim', status: 'pass', reason: null },
      { id: 'run', status: run, reason: run === 'skip' ? 'auth expired' : null },
    ],
    cleanup: { status: cleanup, unknown: cleanup === 'pass' ? [] : ['server'] },
    reclaim: { status: reclaim, by: 'supervisor', reclaimed: [], unknown: [] },
    usage: [],
    ...rest,
  };
}

const judge = (runResult: ProductRunResult | null, leak: ProductLeakVerdict = 'pass', extra = {}) =>
  judgeProductRun({ date: '2026-10-06', runResult, leak, now: NOW, ...extra });

describe('judgeProductRun', () => {
  const parts: Array<'pass' | 'fail' | 'unknown' | 'skip'> = ['pass', 'fail', 'unknown', 'skip'];
  const checks: ProductCheckStatus[] = ['pass', 'fail', 'unknown'];

  // Every combination of run stage × cleanup × reclaim × leak.
  for (const run of parts) {
    for (const cleanup of checks) {
      for (const reclaim of checks) {
        for (const leak of checks) {
          const all = [run, cleanup, reclaim, leak];
          const expected = all.includes('fail')
            ? 'fail'
            : all.includes('unknown')
              ? 'unknown'
              : all.includes('skip')
                ? 'skip'
                : 'pass';
          it(`run=${run} cleanup=${cleanup} reclaim=${reclaim} leak=${leak} -> ${expected}`, () => {
            const final = judge(result({ run, cleanup, reclaim }), leak);
            expect(final.status).toBe(expected);
            expect(final.reasons.length).toBeGreaterThan(0);
          });
        }
      }
    }
  }

  it('a skip carries its reason', () => {
    expect(judge(result({ run: 'skip' })).reasons.join('\n')).toContain('auth expired');
    const late = judge(result({ lateStart: true, stages: [{ id: 'reclaim', status: 'pass', reason: null }] }));
    expect(late.status).toBe('skip');
    expect(late.reasons.join('\n')).toContain('late-start');
  });

  it('no stages at all is unknown, not pass', () => {
    expect(judge(result({ stages: [] })).status).toBe('unknown');
  });

  it('not-run: no JSON, another day, stale, another run id, another SHA', () => {
    expect(judge(null).status).toBe('not-run');
    expect(judge(result({ date: '2026-10-05' })).status).toBe('not-run');
    expect(judge(result({ finishedAt: '2026-10-03T22:30:00.000Z' })).status).toBe('not-run');
    expect(judge(result(), 'pass', { expectedRunId: 'r2' }).status).toBe('not-run');
    expect(judge(result(), 'pass', { expectedSha: 'fedcba9' }).status).toBe('not-run');
    // Negative control: the expected ones match.
    expect(judge(result(), 'pass', { expectedRunId: 'r1', expectedSha: 'abcdef1' }).status).toBe('pass');
  });

  it('not-run wins over a fail inside a result for another day', () => {
    expect(judge(result({ date: '2026-10-05', run: 'fail' }), 'fail').status).toBe('not-run');
  });

  it('says when the deadline guard, not the supervisor, finished the run', () => {
    const final = judge(result({ run: 'unknown' }));
    expect(final.reclaimedBy).toBe('supervisor');
    const guarded = judge({ ...result({ run: 'unknown' }), reclaim: { status: 'pass', by: 'deadline-guard', reclaimed: [], unknown: [] } });
    expect(guarded.reclaimedBy).toBe('deadline-guard');
    expect(guarded.reasons.join('\n')).toContain('期限の番人が回収した');
  });

  it('round-trips through parseProductFinalResult', () => {
    const final = judge(result());
    expect(parseProductFinalResult(JSON.stringify(final))).toEqual(final);
    expect(parseProductFinalResult('{"schemaVersion":1,"date":"x","status":"great"}')).toBeNull();
  });
});

describe('countProductSkipStreak', () => {
  const day = (date: string, status: 'skip' | 'pass') => ({ date, status });

  it(`counts days of skip in a row ending today (${PRODUCT_SKIP_STREAK_ALERT_DAYS} needs action)`, () => {
    expect(PRODUCT_SKIP_STREAK_ALERT_DAYS).toBe(3);
    const results = [day('2026-10-03', 'skip'), day('2026-10-04', 'skip'), day('2026-10-05', 'skip'), day('2026-10-06', 'skip')];
    expect(countProductSkipStreak(results, '2026-10-06')).toBe(4);
    expect(countProductSkipStreak(results, '2026-10-05')).toBe(3);
  });

  it('a missing day or another status ends the streak', () => {
    expect(countProductSkipStreak([day('2026-10-04', 'skip'), day('2026-10-06', 'skip')], '2026-10-06')).toBe(1);
    expect(countProductSkipStreak([day('2026-10-05', 'pass'), day('2026-10-06', 'skip')], '2026-10-06')).toBe(1);
    expect(countProductSkipStreak([day('2026-10-06', 'pass')], '2026-10-06')).toBe(0);
  });
});
