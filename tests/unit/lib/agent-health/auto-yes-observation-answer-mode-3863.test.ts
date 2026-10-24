/**
 * Issue #3863: the daily Auto-Yes observation counts answers and withheld
 * intervals by the answer mode their ledger lines name. A line without one —
 * another path, or written before the field — is counted as unknown, never as
 * either mode, and is still read as it was.
 *
 * Line builders as in `auto-yes-observation-3820.test.ts`.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { AUTO_YES_OBSERVATION_GRID_MS, measureAutoYesObservation } from '@/lib/agent-health/auto-yes-observation';
import { addLogLine, createLogAggregate } from '@/lib/agent-health/metrics-perf';
import type { MetricMeasurement } from '@/lib/agent-health/metrics-types';
import {
  AUTO_YES_LEDGER_EVENTS as EV,
  AUTO_YES_LEDGER_LOG_MODULE,
  type AttemptSettledLine,
  type ConfirmationClosedLine,
  type LedgerAliveLine,
  type LedgerLineBase,
  type WithholdEndedLine,
  type WithholdStartedLine,
} from '@/lib/polling/auto-yes-confirmation-ledger-types';

const H = AUTO_YES_OBSERVATION_GRID_MS;
const MIN = 60 * 1000;
const NOW = new Date('2026-10-21T07:30:00.000Z');
const E = Date.UTC(2026, 9, 21, 7, 0, 0);
const S = E - 24 * H;
const BOOT = 'boot3863';

type Fields<T extends LedgerLineBase> = Omit<T, 'ledgerVersion' | 'bootId'>;

function line<T extends LedgerLineBase>(event: string, fields: Fields<T>): string {
  const data = { ledgerVersion: 1, bootId: BOOT, ...fields };
  return `[${new Date(fields.atMs).toISOString()}] [INFO] [${AUTO_YES_LEDGER_LOG_MODULE}] ${event} ${JSON.stringify(data)}`;
}

function aliveDay(): string[] {
  const out: string[] = [];
  for (let at = S; at <= E; at += H) {
    out.push(
      line<LedgerAliveLine>(EV.alive, {
        atMs: at,
        logLevel: 'info',
        segments: [{ path: 'screen', startMs: at - H, endMs: at }],
        openConfirmations: 0,
        openIntervals: 0,
        ledgerErrors: 0,
      }),
    );
  }
  return out;
}

function closed(id: string, atMs: number, answerMode?: string, over: Partial<ConfirmationClosedLine> = {}): string {
  return line<ConfirmationClosedLine>(EV.closed, {
    atMs,
    confirmationId: id,
    worktreeId: 'wt',
    cliToolId: 'claude',
    instanceId: 'claude',
    source: 'screen',
    promptType: 'multiple_choice',
    decision: 'answer',
    basis: 'L3',
    attempts: { ok: 1, partial: 0, noKeysSent: 0, failed: 0 },
    attemptsPending: 0,
    answeredAtClose: true,
    resolution: 'resolved-after-answer',
    resolvedBy: 'unknown',
    openMs: 4000,
    withheldMsTotal: 0,
    unobservableMs: 0,
    intervals: 0,
    ...(answerMode === undefined ? {} : { answerMode: answerMode as ConfirmationClosedLine['answerMode'] }),
    ...over,
  });
}

function withheldInterval(id: string, startedAt: number, answerMode?: string): string[] {
  const base = { confirmationId: id, intervalId: `${id}#1`, cliToolId: 'claude' as const, source: 'screen' as const };
  const mode = answerMode === undefined ? {} : { answerMode: answerMode as WithholdStartedLine['answerMode'] };
  return [
    line<WithholdStartedLine>(EV.withholdStarted, {
      atMs: startedAt,
      ...base,
      reason: 'question-left-to-human',
      startedAtMs: startedAt,
      ...mode,
    }),
    line<WithholdEndedLine>(EV.withholdEnded, {
      atMs: startedAt + 5 * MIN,
      ...base,
      startedAtMs: startedAt,
      endedAtMs: startedAt + 5 * MIN,
      withheldMs: 5 * MIN,
      end: 'gone',
      lastReason: 'question-left-to-human',
      ...mode,
    }),
  ];
}

function measureOk(lines: readonly string[]): Extract<MetricMeasurement, { status: 'ok' }> {
  const agg = createLogAggregate(NOW);
  for (const raw of lines) addLogLine(agg, raw);
  const result = measureAutoYesObservation(agg.autoYes, agg);
  if (result.status !== 'ok') throw new Error(`expected ok, got skip: ${result.reason}`);
  return result;
}

describe('[#3863] answers and withheld intervals by answer mode', () => {
  it('counts each mode, and a line naming none as unknown', () => {
    const result = measureOk([
      ...aliveDay(),
      closed(`${BOOT}-1`, S + 1 * H, 'recommended', { answeredAnswerMode: 'recommended' }),
      closed(`${BOOT}-2`, S + 2 * H, 'recommended', { answeredAnswerMode: 'recommended' }),
      closed(`${BOOT}-3`, S + 3 * H),
      ...withheldInterval(`${BOOT}-4`, S + 4 * H, 'careful'),
      ...withheldInterval(`${BOOT}-5`, S + 5 * H),
      closed(`${BOOT}-6`, S + 6 * H, 'recommended', { basis: 'human' }),
    ]);
    expect(result.details).toMatchObject({
      answered: 3,
      answeredByHuman: 1,
      answeredRecommended: 2,
      answeredCareful: 0,
      answeredAnswerModeUnknown: 1,
      withheldIntervals: 2,
      withheldIntervalsRecommended: 0,
      withheldIntervalsCareful: 1,
      withheldIntervalsAnswerModeUnknown: 1,
    });
  });

  it('negative: a mode this build does not know is not counted as either', () => {
    const result = measureOk([...aliveDay(), closed(`${BOOT}-1`, S + H, 'bold', { answeredAnswerMode: 'bold' as never })]);
    expect(result.details).toMatchObject({ answered: 1, answeredRecommended: 0, answeredCareful: 0, answeredAnswerModeUnknown: 1 });
  });

  it('[#3882] a closed line with no answeredAnswerMode is unknown, not the last decision\'s mode', () => {
    const result = measureOk([...aliveDay(), closed(`${BOOT}-1`, S + H, 'careful'), closed(`${BOOT}-2`, S + 2 * H, 'recommended')]);
    expect(result.details).toMatchObject({ answered: 2, answeredRecommended: 0, answeredCareful: 0, answeredAnswerModeUnknown: 2 });
  });

  it('[#3882] a legacy entry carried over a hot reload (answered, no snapshot, now careful) is unknown', () => {
    const legacy = closed(`${BOOT}-1`, S + H, 'careful', { attempts: { ok: 1, partial: 0, noKeysSent: 0, failed: 0 } });
    expect(JSON.parse(legacy.slice(legacy.indexOf('{'))).answeredAnswerMode).toBeUndefined();
    const result = measureOk([...aliveDay(), legacy]);
    expect(result.details).toMatchObject({ answeredCareful: 0, answeredAnswerModeUnknown: 1 });
  });

  it('[#3882] positive: recommended answer then a switch to careful counts as recommended', () => {
    const result = measureOk([...aliveDay(), closed(`${BOOT}-1`, S + H, 'careful', { answeredAnswerMode: 'recommended' })]);
    expect(result.details).toMatchObject({ answeredRecommended: 1, answeredCareful: 0, answeredAnswerModeUnknown: 0 });
  });

  it('[#3882] restores from a successful attempt line of the same confirmation ID only', () => {
    const attempt = (id: string, at: number, result: string, mode: string) =>
      line<AttemptSettledLine>(EV.attemptSettled, {
        atMs: at,
        confirmationId: id,
        attemptId: `${id}.1`,
        cliToolId: 'claude',
        basis: 'L3',
        result,
        late: false,
        expired: false,
        answerMode: mode,
      } as never);
    const result = measureOk([
      ...aliveDay(),
      attempt(`${BOOT}-1`, S + H - 1000, 'ok', 'recommended'),
      closed(`${BOOT}-1`, S + H, 'careful'),
      attempt(`${BOOT}-2`, S + 2 * H - 1000, 'ok', 'recommended'),
      closed(`${BOOT}-3`, S + 3 * H, 'careful'),
      attempt(`${BOOT}-4`, S + 4 * H - 1000, 'failed', 'recommended'),
      closed(`${BOOT}-4`, S + 4 * H, 'careful'),
    ]);
    expect(result.details).toMatchObject({ answered: 3, answeredRecommended: 1, answeredCareful: 0, answeredAnswerModeUnknown: 2 });
  });

  it('[#3882] an earlier success naming no mode is not filled in by a later success naming one', () => {
    const attempt = (id: string, n: number, at: number, mode?: string) =>
      line<AttemptSettledLine>(EV.attemptSettled, {
        atMs: at,
        confirmationId: id,
        attemptId: `${id}.${n}`,
        cliToolId: 'claude',
        basis: 'L3',
        result: 'ok',
        late: false,
        expired: false,
        ...(mode === undefined ? {} : { answerMode: mode }),
      } as never);
    const result = measureOk([
      ...aliveDay(),
      attempt(`${BOOT}-1`, 1, S + H - 2000),
      attempt(`${BOOT}-1`, 2, S + H - 1000, 'recommended'),
      closed(`${BOOT}-1`, S + H, 'careful'),
    ]);
    expect(result.details).toMatchObject({ answered: 1, answeredRecommended: 0, answeredCareful: 0, answeredAnswerModeUnknown: 1 });
  });

  it('[#3882] a first success outside the window, or a missing attempt line, leaves it unknown', () => {
    const attempt = (id: string, n: number, at: number, ok: boolean, mode: string) =>
      line<AttemptSettledLine>(EV.attemptSettled, {
        atMs: at,
        confirmationId: id,
        attemptId: `${id}.${n}`,
        cliToolId: 'claude',
        basis: 'L3',
        result: ok ? 'ok' : 'failed',
        late: false,
        expired: false,
        answerMode: mode,
      } as never);
    const result = measureOk([
      ...aliveDay(),
      // attempt 1 (a success) is before the window; the one in it names a mode
      attempt(`${BOOT}-1`, 1, S - H, true, 'careful'),
      attempt(`${BOOT}-1`, 2, S + H - 1000, true, 'recommended'),
      closed(`${BOOT}-1`, S + H, 'careful'),
      // attempt 1's line is missing (numbers jump to 2)
      attempt(`${BOOT}-2`, 2, S + 2 * H - 1000, true, 'recommended'),
      closed(`${BOOT}-2`, S + 2 * H, 'careful'),
      // positive: 1 failed, 2 succeeded, both seen
      attempt(`${BOOT}-3`, 1, S + 3 * H - 2000, false, 'careful'),
      attempt(`${BOOT}-3`, 2, S + 3 * H - 1000, true, 'recommended'),
      closed(`${BOOT}-3`, S + 3 * H, 'careful'),
    ]);
    expect(result.details).toMatchObject({ answered: 3, answeredRecommended: 1, answeredCareful: 0, answeredAnswerModeUnknown: 2 });
  });

  it('[#3882] the first success is the first to come back, not the lowest attempt number', () => {
    // A send begun first (a lower number) can come back after a later one: the
    // ledger keeps the mode of the first result, so the count follows result order.
    const attempt = (id: string, n: number, at: number, mode: string) =>
      line<AttemptSettledLine>(EV.attemptSettled, {
        atMs: at,
        confirmationId: id,
        attemptId: `${id}.${n}`,
        cliToolId: 'claude',
        basis: 'L3',
        result: 'ok',
        late: false,
        expired: false,
        answerMode: mode,
      } as never);
    const twoOk = { attempts: { ok: 2, partial: 0, noKeysSent: 0, failed: 0 } };
    const result = measureOk([
      ...aliveDay(),
      // attempt 2 came back ok before the window, attempt 1 in it: the first
      // success is outside the window, so unknown
      attempt(`${BOOT}-1`, 2, S - 1000, 'careful'),
      attempt(`${BOOT}-1`, 1, S + 1000, 'recommended'),
      closed(`${BOOT}-1`, S + 2000, 'recommended', twoOk),
      // both in the window, attempt 2 (careful) first: careful
      attempt(`${BOOT}-2`, 2, S + 2 * H - 2000, 'careful'),
      attempt(`${BOOT}-2`, 1, S + 2 * H - 1000, 'recommended'),
      closed(`${BOOT}-2`, S + 2 * H, 'recommended', twoOk),
    ]);
    expect(result.details).toMatchObject({ answered: 2, answeredRecommended: 0, answeredCareful: 1, answeredAnswerModeUnknown: 1 });
  });

  it('[#3882] successes at the same millisecond: unknown unless their modes agree, whatever the input order', () => {
    // Lines at the same atMs are sorted by their JSON, not by when they were
    // written: which came back first is not known.
    const attempt = (id: string, n: number, at: number, mode: string) =>
      line<AttemptSettledLine>(EV.attemptSettled, {
        atMs: at,
        confirmationId: id,
        attemptId: `${id}.${n}`,
        cliToolId: 'claude',
        basis: 'L3',
        result: 'ok',
        late: false,
        expired: false,
        answerMode: mode,
      } as never);
    const twoOk = { attempts: { ok: 2, partial: 0, noKeysSent: 0, failed: 0 } };
    const day = (order: 'written' | 'reversed') => {
      const tied = [
        // attempt 2 (careful) came back first, attempt 1 (recommended) at the same ms
        attempt(`${BOOT}-1`, 2, S + H - 1000, 'careful'),
        attempt(`${BOOT}-1`, 1, S + H - 1000, 'recommended'),
        closed(`${BOOT}-1`, S + H, 'recommended', twoOk),
        // the same ms and the same mode: that mode
        attempt(`${BOOT}-2`, 2, S + 2 * H - 1000, 'careful'),
        attempt(`${BOOT}-2`, 1, S + 2 * H - 1000, 'careful'),
        closed(`${BOOT}-2`, S + 2 * H, 'recommended', twoOk),
        // different ms: the earlier one
        attempt(`${BOOT}-3`, 2, S + 3 * H - 2000, 'careful'),
        attempt(`${BOOT}-3`, 1, S + 3 * H - 1000, 'recommended'),
        closed(`${BOOT}-3`, S + 3 * H, 'recommended', twoOk),
      ];
      return measureOk([...aliveDay(), ...(order === 'written' ? tied : [...tied].reverse())]);
    };
    for (const order of ['written', 'reversed'] as const) {
      expect(day(order).details).toMatchObject({ answered: 3, answeredRecommended: 0, answeredCareful: 2, answeredAnswerModeUnknown: 1 });
    }
  });

  it('[#3882] negative: fewer successes seen than the closed line counts leaves it unknown', () => {
    const attempt = (id: string, n: number, at: number, ok: boolean, mode: string) =>
      line<AttemptSettledLine>(EV.attemptSettled, {
        atMs: at,
        confirmationId: id,
        attemptId: `${id}.${n}`,
        cliToolId: 'claude',
        basis: 'L3',
        result: ok ? 'ok' : 'failed',
        late: false,
        expired: false,
        answerMode: mode,
      } as never);
    const result = measureOk([
      ...aliveDay(),
      // the closed line counts 2 successes, only 1 is seen
      attempt(`${BOOT}-1`, 1, S + H - 1000, true, 'recommended'),
      closed(`${BOOT}-1`, S + H, 'careful', { attempts: { ok: 2, partial: 0, noKeysSent: 0, failed: 0 } }),
      // a closed line without a success count proves nothing
      attempt(`${BOOT}-2`, 1, S + 2 * H - 1000, true, 'recommended'),
      closed(`${BOOT}-2`, S + 2 * H, 'careful', { attempts: undefined as never }),
      // positive: 1 failed, 2 succeeded, the count matches
      attempt(`${BOOT}-3`, 1, S + 3 * H - 2000, false, 'careful'),
      attempt(`${BOOT}-3`, 2, S + 3 * H - 1000, true, 'recommended'),
      closed(`${BOOT}-3`, S + 3 * H, 'careful'),
    ]);
    expect(result.details).toMatchObject({ answered: 3, answeredRecommended: 1, answeredCareful: 0, answeredAnswerModeUnknown: 2 });
  });

  it('[#3882] negative: a person\'s answer stays counted apart', () => {
    const result = measureOk([...aliveDay(), closed(`${BOOT}-1`, S + H, 'careful', { basis: 'human' })]);
    expect(result.details).toMatchObject({ answered: 0, answeredByHuman: 1, answeredCareful: 0 });
  });
});
