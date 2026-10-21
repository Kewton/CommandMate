/**
 * An API approval in the Auto-Yes confirmation ledger, against Auto-Yes stopping
 * and a result that comes back late (Issue #3820 PR 2, the review of
 * `.commandmate/tasks/review-3820-pr2.md` items 1 and 2; design
 * `docs/design/auto-yes-measurement-3820.md` §2.4・§2.5・§4.2).
 *
 *  - Auto-Yes stopping (OFF, `manual`) keeps the approval open and `present` —
 *    its reply still settles it — but ends its withheld interval
 *    (`end: 'stopped'`), so the time Auto-Yes is off is not withheld time: not
 *    on the interval, not on a checkpoint.
 *  - The send of an `allow` is taken before the delivery and its result returned
 *    to it: a confirmation that closed meanwhile gets a `late` line and is not
 *    opened again by the decision id.
 *
 * Positive controls: before this change the `manual` stop left the interval
 * open (no `withhold-ended`, the checkpoint counting the hour), and the late
 * result opened a second confirmation answered `late: false`. Negative
 * controls: a session ending still abandons the approval, and a result that
 * comes back while the confirmation is open is its answer as before.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: vi.fn() };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import {
  AUTO_YES_LEDGER_CLOCK_MS,
  beginLedgerApiAdjudication,
  beginLedgerTick,
  noteLedgerPollerStopped,
  noteLedgerWorktreeStopped,
  observeLedgerScreen,
  recordLedgerApiAdjudication,
  resetAutoYesConfirmationLedgerForTests,
  runAutoYesLedgerHourForTests,
  setAutoYesLedgerClockTimersForTests,
  setAutoYesLedgerFaultForTests,
  settleLedgerApiAdjudication,
  type LedgerScope,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';

const T0 = Date.UTC(2026, 9, 21, 10, 0, 0);
const API: LedgerScope = { worktreeId: 'wt-3820b', cliToolId: 'opencode', instanceId: 'opencode' };
const OTHER: LedgerScope = { worktreeId: 'wt-3820b-other', cliToolId: 'opencode', instanceId: 'opencode' };
const SCREEN: LedgerScope = { worktreeId: 'wt-3820b', cliToolId: 'claude', instanceId: 'claude' };
const API_KEY = 'wt-3820b:opencode';

const WITHHELD = { outcome: 'abstained', withholdReason: 'deny-pattern', promptType: 'multiple_choice' } as const;
const ALLOW = { outcome: 'allow', promptType: 'multiple_choice' } as const;

let now = T0;

const lines = (event: string): Array<Record<string, unknown>> =>
  mockLogger.info.mock.calls.filter(([name]) => name === event).map(([, fields]) => fields as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  resetAutoYesConfirmationLedgerForTests();
  now = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
});

afterEach(() => {
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
  vi.restoreAllMocks();
});

describe('[#3820 PR 2] Auto-Yes stopping under a withheld API approval (review item 1)', () => {
  it('ends the interval at the OFF and keeps the approval open and present', () => {
    beginLedgerApiAdjudication(API, 'per_1', WITHHELD);
    now += 10_000;
    noteLedgerPollerStopped(API_KEY, 'manual');

    expect(lines(EV.withholdEnded)).toEqual([
      expect.objectContaining({ end: 'stopped', withheldMs: 10_000, lastReason: 'deny-pattern', source: 'api' }),
    ]);
    expect(lines(EV.presenceChanged)).toHaveLength(0);
    expect(lines(EV.closed)).toHaveLength(0);
  });

  it('puts none of the time it is off on a checkpoint', () => {
    beginLedgerApiAdjudication(API, 'per_1', WITHHELD);
    now += 10_000;
    noteLedgerPollerStopped(API_KEY, 'manual');
    runAutoYesLedgerHourForTests(T0 + AUTO_YES_LEDGER_CLOCK_MS);

    expect(lines(EV.checkpoint)).toEqual([
      expect.objectContaining({ source: 'api', presence: 'present', answerability: 'answerable', withheldMsTotal: 10_000 }),
    ]);
  });

  it('opens a new interval on the same confirmation when Auto-Yes comes back and withholds it again', () => {
    beginLedgerApiAdjudication(API, 'per_1', WITHHELD);
    now += 10_000;
    noteLedgerPollerStopped(API_KEY, 'manual');
    now += 60_000;
    beginLedgerApiAdjudication(API, 'per_1', WITHHELD);
    now += 5_000;
    recordLedgerApiAdjudication(API, 'per_1', { ...ALLOW, delivered: true, settled: true });

    expect(lines(EV.opened)).toHaveLength(1);
    expect(lines(EV.withholdStarted).map((line) => line.intervalId)).toHaveLength(2);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ resolution: 'resolved-by-reply', intervals: 2, withheldMsTotal: 15_000 }),
    ]);
  });

  it('ends it the same way for every Auto-Yes stop that does not end the session', () => {
    for (const reason of ['expired', 'not-enabled', 'stop-pattern', 'consecutive-errors', 'shutdown']) {
      vi.clearAllMocks();
      resetAutoYesConfirmationLedgerForTests();
      beginLedgerApiAdjudication(API, 'per_1', WITHHELD);
      noteLedgerPollerStopped(API_KEY, reason);
      expect(lines(EV.withholdEnded)).toEqual([expect.objectContaining({ end: 'stopped' })]);
    }
  });

  it('still abandons the approval when the session ends (negative control)', () => {
    beginLedgerApiAdjudication(API, 'per_1', WITHHELD);
    noteLedgerPollerStopped(API_KEY, 'session-killed');

    expect(lines(EV.withholdEnded)).toEqual([expect.objectContaining({ end: 'abandoned' })]);
    expect(lines(EV.closed)).toEqual([expect.objectContaining({ resolution: 'abandoned', abandonReason: 'session-killed' })]);
  });

  it('still turns a screen confirmation unobservable (negative control)', () => {
    beginLedgerTick(SCREEN);
    observeLedgerScreen(SCREEN, 'screen-A', 'yes_no');
    noteLedgerPollerStopped('wt-3820b:claude', 'manual');

    expect(lines(EV.presenceChanged)).toEqual([expect.objectContaining({ from: 'present', to: 'unobservable', cause: 'manual' })]);
  });
});

describe('[#3820 PR 2] a worktree’s confirmations, whatever pollers ran (review item 3)', () => {
  it('abandons every open confirmation of a deleted worktree, and only its', () => {
    beginLedgerApiAdjudication(API, 'per_1', { outcome: 'abstained', promptType: 'multiple_choice' });
    beginLedgerApiAdjudication(OTHER, 'per_2', { outcome: 'abstained', promptType: 'multiple_choice' });
    noteLedgerWorktreeStopped('wt-3820b', 'worktree-deleted');

    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ worktreeId: 'wt-3820b', resolution: 'abandoned', abandonReason: 'worktree-deleted' }),
    ]);
    runAutoYesLedgerHourForTests(T0 + AUTO_YES_LEDGER_CLOCK_MS);
    expect(lines(EV.checkpoint)).toEqual([expect.objectContaining({ source: 'api' })]);
    expect(lines(EV.checkpoint)).toHaveLength(1);
  });

  it('ends the intervals of a worktree switched off as a whole', () => {
    beginLedgerApiAdjudication(API, 'per_1', WITHHELD);
    noteLedgerWorktreeStopped('wt-3820b', 'manual');

    expect(lines(EV.withholdEnded)).toEqual([expect.objectContaining({ end: 'stopped' })]);
    expect(lines(EV.closed)).toHaveLength(0);
  });

  it('writes nothing twice when the per-instance stop came first', () => {
    beginLedgerApiAdjudication(API, 'per_1', WITHHELD);
    noteLedgerPollerStopped(API_KEY, 'worktree-deleted');
    noteLedgerWorktreeStopped('wt-3820b', 'worktree-deleted');

    expect(lines(EV.closed)).toHaveLength(1);
    expect(lines(EV.withholdEnded)).toHaveLength(1);
  });
});

describe('[#3820 PR 2] an API result that comes back after its confirmation closed (review item 2)', () => {
  it('is that confirmation’s late result, and opens nothing', () => {
    const handle = beginLedgerApiAdjudication(API, 'per_1', ALLOW);
    // The session is killed while the delivery is in flight.
    noteLedgerPollerStopped(API_KEY, 'session-killed');
    settleLedgerApiAdjudication(handle, { delivered: true, settled: true });

    const [opened] = lines(EV.opened);
    expect(lines(EV.opened)).toHaveLength(1);
    expect(lines(EV.attemptSettled)).toEqual([
      expect.objectContaining({ confirmationId: opened.confirmationId, attemptId: handle?.attemptId, result: 'ok', late: true }),
    ]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ resolution: 'unresolved-after-send', answeredAtClose: false, attemptsPending: 1 }),
    ]);
  });

  it('does not answer a confirmation opened again for the same decision meanwhile', () => {
    const handle = beginLedgerApiAdjudication(API, 'per_1', ALLOW);
    noteLedgerPollerStopped(API_KEY, 'session-killed');
    beginLedgerApiAdjudication(API, 'per_1', { outcome: 'abstained', promptType: 'multiple_choice' });
    settleLedgerApiAdjudication(handle, { delivered: true, settled: true });

    const [first, second] = lines(EV.opened);
    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ confirmationId: first.confirmationId, late: true })]);
    expect(lines(EV.closed).map((line) => line.confirmationId)).toEqual([first.confirmationId]);
    expect(second).toBeDefined();
  });

  it('answers the confirmation when it comes back while it is open (negative control)', () => {
    const handle = beginLedgerApiAdjudication(API, 'per_1', ALLOW);
    settleLedgerApiAdjudication(handle, { delivered: true, settled: true });

    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ result: 'ok', late: false })]);
    expect(lines(EV.closed)).toEqual([expect.objectContaining({ resolution: 'resolved-by-reply', answeredAtClose: true })]);
  });

  it('takes no send for an abstention', () => {
    expect(beginLedgerApiAdjudication(API, 'per_1', WITHHELD)).toBeNull();
    expect(() => settleLedgerApiAdjudication(null, { delivered: false, settled: false })).not.toThrow();
  });

  it('never throws', () => {
    setAutoYesLedgerFaultForTests(new Error('injected'));
    expect(beginLedgerApiAdjudication(API, 'per_1', ALLOW)).toBeNull();
    expect(() => {
      settleLedgerApiAdjudication({ confirmationId: 'x', attemptId: 'x.1' }, { delivered: true, settled: true });
      noteLedgerWorktreeStopped('wt-3820b', 'worktree-deleted');
    }).not.toThrow();
  });
});
