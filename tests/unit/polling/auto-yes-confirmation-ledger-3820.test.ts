/**
 * The Auto-Yes confirmation ledger, driven through its entry points the way the
 * poller calls them (Issue #3820, design `docs/design/auto-yes-measurement-3820.md`
 * §2〜§4・§8, PR 1).
 *
 * Every assertion reads the ledger's log lines — the only thing it produces.
 * The clock is the test's: `Date.now` is stubbed, and the hourly timer is
 * replaced so no real timer is armed.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import {
  AUTO_YES_LEDGER_CLOCK_MS,
  AUTO_YES_LEDGER_MAX_OPEN_TOTAL,
  AUTO_YES_LEDGER_UNOBSERVABLE_TIMEOUT_MS,
  beginLedgerAttempt,
  beginLedgerTick,
  endLedgerTick,
  getAutoYesLedgerErrorCountForTests,
  noteLedgerPollerStopped,
  observeLedgerScreen,
  resetAutoYesConfirmationLedgerForTests,
  runAutoYesLedgerHourForTests,
  setAutoYesLedgerClockTimersForTests,
  setAutoYesLedgerFaultForTests,
  settleLedgerAttempt,
  withholdLedgerConfirmation,
  type LedgerScope,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';
import { beginEnterFallbackSession } from '@/lib/polling/auto-yes-enter-fallback-state';

const T0 = Date.UTC(2026, 9, 21, 10, 0, 0);
const SCOPE: LedgerScope = { worktreeId: 'wt-3820', cliToolId: 'claude', instanceId: 'claude' };
const KEY = 'wt-3820:claude';

let now = T0;
let scheduled: number[] = [];

const lines = (event: string): Array<Record<string, unknown>> =>
  mockLogger.info.mock.calls.filter(([name]) => name === event).map(([, fields]) => fields as Record<string, unknown>);

/** One poller tick that reads the screen: sees `screenKey` (or nothing) and runs `during`. */
function tick(screenKey: string | null, during: () => void = () => {}): void {
  const token = beginLedgerTick(SCOPE);
  if (screenKey !== null) observeLedgerScreen(SCOPE, screenKey, 'multiple_choice');
  during();
  endLedgerTick(SCOPE, token);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAutoYesConfirmationLedgerForTests();
  now = T0;
  scheduled = [];
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  setAutoYesLedgerClockTimersForTests({
    setTimeout: (_fn, ms) => {
      scheduled.push(ms);
      return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {},
  });
});

afterEach(() => {
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
  vi.restoreAllMocks();
});

describe('[#3820] one confirmation, one withheld interval', () => {
  it('records a prompt withheld for five ticks and then gone as one confirmation and one interval', () => {
    for (let i = 0; i < 5; i += 1) {
      tick('screen-A', () => withholdLedgerConfirmation(SCOPE, 'type-not-allowed'));
      now += 2_000;
    }
    const goneAt = now;
    tick(null);

    expect(lines(EV.opened)).toHaveLength(1);
    expect(lines(EV.withholdStarted)).toEqual([expect.objectContaining({ reason: 'type-not-allowed', startedAtMs: T0 })]);
    expect(lines(EV.withholdReasonChanged)).toHaveLength(0);
    expect(lines(EV.withholdEnded)).toEqual([
      expect.objectContaining({ end: 'gone', startedAtMs: T0, endedAtMs: goneAt, withheldMs: goneAt - T0 }),
    ]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({
        resolution: 'resolved-while-withheld',
        resolvedBy: 'unknown',
        decision: 'withhold',
        intervals: 1,
        withheldMsTotal: goneAt - T0,
        answeredAtClose: false,
      }),
    ]);
  });

  it('records a reason change inside the interval and keeps it one interval', () => {
    tick('screen-A', () => withholdLedgerConfirmation(SCOPE, 'type-not-allowed'));
    now += 2_000;
    tick('screen-A', () => withholdLedgerConfirmation(SCOPE, 'deny-pattern'));
    now += 2_000;
    tick(null);

    expect(lines(EV.withholdStarted)).toHaveLength(1);
    expect(lines(EV.withholdReasonChanged)).toEqual([
      expect.objectContaining({ from: 'type-not-allowed', to: 'deny-pattern' }),
    ]);
    expect(lines(EV.withholdEnded)).toEqual([expect.objectContaining({ lastReason: 'deny-pattern' })]);
  });

  it('opens a new confirmation for another screen key and closes the first one as gone', () => {
    tick('screen-A');
    tick('screen-B');

    expect(lines(EV.opened)).toHaveLength(2);
    expect(lines(EV.closed)).toEqual([expect.objectContaining({ resolution: 'resolved-before-decision' })]);
  });

  it('closes nothing on a tick that saw the confirmation (negative control)', () => {
    tick('screen-A');
    tick('screen-A');

    expect(lines(EV.opened)).toHaveLength(1);
    expect(lines(EV.closed)).toHaveLength(0);
  });

  it('abandons the confirmation of a session the instance has since relaunched', () => {
    tick('screen-A', () => withholdLedgerConfirmation(SCOPE, 'mode-off'));
    beginEnterFallbackSession('wt-3820', 'claude', 'claude');
    tick('screen-A');

    expect(lines(EV.closed)[0]).toEqual(
      expect.objectContaining({ resolution: 'abandoned', abandonReason: 'session-epoch-changed' }),
    );
    expect(lines(EV.withholdEnded)[0]).toEqual(expect.objectContaining({ end: 'abandoned' }));
    expect(lines(EV.opened)).toHaveLength(2);
  });
});

describe('[#3820] send attempts', () => {
  it('starts the interval at the first failure and ends it at the ok that follows', () => {
    let first: ReturnType<typeof beginLedgerAttempt> = null;
    tick('screen-A', () => {
      first = beginLedgerAttempt(SCOPE, 'L3');
      settleLedgerAttempt(first, 'failed');
    });
    const failedAt = now;
    now += 2_000;
    tick('screen-A', () => settleLedgerAttempt(beginLedgerAttempt(SCOPE, 'L3'), 'ok'));
    const okAt = now;
    now += 2_000;
    tick(null);

    expect(lines(EV.attemptSettled).map((line) => [line.attemptId, line.result, line.late])).toEqual([
      [`${String(lines(EV.opened)[0].confirmationId)}.1`, 'failed', false],
      [`${String(lines(EV.opened)[0].confirmationId)}.2`, 'ok', false],
    ]);
    expect(lines(EV.withholdStarted)).toEqual([expect.objectContaining({ reason: 'send-failed', startedAtMs: failedAt })]);
    expect(lines(EV.withholdEnded)).toEqual([expect.objectContaining({ end: 'answered', endedAtMs: okAt })]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({
        resolution: 'resolved-after-answer',
        resolvedBy: 'unknown',
        attempts: { ok: 1, partial: 0, noKeysSent: 0, failed: 1 },
        answeredAtClose: true,
        basis: 'L3',
        decision: 'answer',
      }),
    ]);
  });

  it('opens a new interval when the confirmation is withheld again after an ok', () => {
    tick('screen-A', () => withholdLedgerConfirmation(SCOPE, 'no-hook-receipt'));
    tick('screen-A', () => settleLedgerAttempt(beginLedgerAttempt(SCOPE, 'L3'), 'ok'));
    tick('screen-A', () => withholdLedgerConfirmation(SCOPE, 'partial-answer'));

    const confirmationId = String(lines(EV.opened)[0].confirmationId);
    expect(lines(EV.withholdStarted).map((line) => line.intervalId)).toEqual([
      `${confirmationId}#1`,
      `${confirmationId}#2`,
    ]);
  });

  it('does not call a send that put no key on the pane a partial answer', () => {
    tick('screen-A', () => settleLedgerAttempt(beginLedgerAttempt(SCOPE, 'L4'), 'no-keys-sent'));
    expect(lines(EV.withholdStarted)).toEqual([expect.objectContaining({ reason: 'send-no-keys' })]);
  });

  it('calls a send stopped with keys on the pane a partial answer', () => {
    tick('screen-A', () => settleLedgerAttempt(beginLedgerAttempt(SCOPE, 'L4'), 'partial'));
    expect(lines(EV.withholdStarted)).toEqual([expect.objectContaining({ reason: 'partial-answer' })]);
  });

  it('gives a result that comes back after the confirmation closed to that confirmation, late, without reopening it', () => {
    let handle: ReturnType<typeof beginLedgerAttempt> = null;
    tick('screen-A', () => {
      handle = beginLedgerAttempt(SCOPE, 'L3');
    });
    noteLedgerPollerStopped(KEY, 'session-killed');
    now += 1_000;
    settleLedgerAttempt(handle, 'ok');
    settleLedgerAttempt(handle, 'ok');

    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({
        resolution: 'unresolved-after-send',
        abandonReason: 'session-killed',
        attemptsPending: 1,
        answeredAtClose: false,
      }),
    ]);
    expect(lines(EV.attemptSettled)).toEqual([
      expect.objectContaining({ confirmationId: handle!.confirmationId, result: 'ok', late: true }),
    ]);
    expect(lines(EV.opened)).toHaveLength(1);
    expect(lines(EV.withholdStarted)).toHaveLength(0);
  });
});

describe('[#3820] a send whose worktree ID moved while it was in flight', () => {
  it('still settles under the confirmation it was begun for, not the moved key', () => {
    let handle: ReturnType<typeof beginLedgerAttempt> = null;
    tick('screen-A', () => {
      handle = beginLedgerAttempt(SCOPE, 'L3');
    });
    noteLedgerPollerStopped(KEY, 'worktree-id-migrated');
    const moved: LedgerScope = { worktreeId: 'wt-3820-moved', cliToolId: 'claude', instanceId: 'claude' };
    observeLedgerScreen(moved, 'screen-A', 'multiple_choice');
    settleLedgerAttempt(handle, 'partial');

    const [original, successor] = lines(EV.opened).map((line) => line.confirmationId);
    expect(successor).not.toBe(original);
    expect(lines(EV.attemptSettled)).toEqual([
      expect.objectContaining({ confirmationId: original, result: 'partial', late: true }),
    ]);
    // The successor is not withheld by a send that was never its own.
    expect(lines(EV.withholdStarted)).toHaveLength(0);
  });
});

describe('[#3820] Auto-Yes off and on again over the same confirmation', () => {
  it('keeps one confirmation and gives each enabled period its own interval', () => {
    tick('screen-A', () => withholdLedgerConfirmation(SCOPE, 'mode-off'));
    now += 10_000;
    noteLedgerPollerStopped(KEY, 'manual');
    now += 60_000;
    tick('screen-A', () => withholdLedgerConfirmation(SCOPE, 'mode-off'));
    now += 5_000;
    tick(null);

    expect(lines(EV.opened)).toHaveLength(1);
    expect(lines(EV.withholdEnded).map((line) => [line.end, line.withheldMs])).toEqual([
      ['unobservable', 10_000],
      ['gone', 5_000],
    ]);
    expect(lines(EV.presenceChanged).map((line) => [line.from, line.to])).toEqual([
      ['present', 'unobservable'],
      ['unobservable', 'present'],
    ]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ intervals: 2, withheldMsTotal: 15_000, unobservableMs: 60_000 }),
    ]);
  });

  it('closes it as gone while unobservable when it is not there any more once Auto-Yes is back', () => {
    tick('screen-A', () => withholdLedgerConfirmation(SCOPE, 'mode-off'));
    noteLedgerPollerStopped(KEY, 'expired');
    now += 30_000;
    tick(null);

    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ resolution: 'gone-while-unobservable', unobservableMs: 30_000 }),
    ]);
  });

  it('lets an unobservable confirmation go after 24 hours', () => {
    tick('screen-A');
    noteLedgerPollerStopped(KEY, 'manual');
    runAutoYesLedgerHourForTests(T0 + AUTO_YES_LEDGER_UNOBSERVABLE_TIMEOUT_MS);

    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ resolution: 'abandoned', abandonReason: 'unobservable-timeout' }),
    ]);
  });
});

describe('[#3820] checkpoints, alive lines and the clock', () => {
  it('writes a restorable snapshot of an interval at each hour boundary it spans', () => {
    tick('screen-A', () => withholdLedgerConfirmation(SCOPE, 'deny-pattern'));
    const h1 = (Math.floor(T0 / AUTO_YES_LEDGER_CLOCK_MS) + 1) * AUTO_YES_LEDGER_CLOCK_MS;
    runAutoYesLedgerHourForTests(h1);
    runAutoYesLedgerHourForTests(h1 + AUTO_YES_LEDGER_CLOCK_MS);

    const confirmationId = String(lines(EV.opened)[0].confirmationId);
    expect(lines(EV.checkpoint)).toEqual([
      expect.objectContaining({
        atMs: h1,
        confirmationId,
        cliToolId: 'claude',
        source: 'screen',
        presence: 'present',
        answerability: 'withheld',
        intervalId: `${confirmationId}#1`,
        reason: 'deny-pattern',
        intervalStartedAtMs: T0,
        intervalMs: h1 - T0,
        withheldMsTotal: h1 - T0,
      }),
      expect.objectContaining({ atMs: h1 + AUTO_YES_LEDGER_CLOCK_MS, withheldMsTotal: h1 + AUTO_YES_LEDGER_CLOCK_MS - T0 }),
    ]);
    // Measured from when the ledger started, never a whole hour for one line.
    expect(lines(EV.alive).map((line) => line.segments)).toEqual([
      [{ path: 'screen', startMs: T0, endMs: h1 }],
      [{ path: 'screen', startMs: h1, endMs: h1 + AUTO_YES_LEDGER_CLOCK_MS }],
    ]);
    expect(lines(EV.alive)[0]).toEqual(
      expect.objectContaining({ openConfirmations: 1, openIntervals: 1, ledgerErrors: 0 }),
    );
  });

  it('arms one clock, on the first use, aligned to the next hour boundary', () => {
    expect(scheduled).toEqual([]);
    tick('screen-A');
    tick('screen-A');
    withholdLedgerConfirmation(SCOPE, 'mode-off');

    const h1 = (Math.floor(T0 / AUTO_YES_LEDGER_CLOCK_MS) + 1) * AUTO_YES_LEDGER_CLOCK_MS;
    expect(scheduled).toEqual([h1 - T0]);
    expect(lines(EV.started)).toEqual([expect.objectContaining({ atMs: T0, paths: ['screen'] })]);
  });

  it('keeps the bootId, the sequence and the clock across a reload of the module', async () => {
    tick('screen-A');
    const firstId = String(lines(EV.opened)[0].confirmationId);
    vi.resetModules();
    const reloaded = await import('@/lib/polling/auto-yes-confirmation-ledger');
    const token = reloaded.beginLedgerTick(SCOPE);
    reloaded.observeLedgerScreen(SCOPE, 'screen-B', 'yes_no');
    reloaded.endLedgerTick(SCOPE, token);

    const secondId = String(lines(EV.opened)[1].confirmationId);
    const [bootA, seqA] = firstId.split('-');
    const [bootB, seqB] = secondId.split('-');
    expect(bootB).toBe(bootA);
    expect(Number(seqB)).toBe(Number(seqA) + 1);
    expect(scheduled).toHaveLength(1);
    expect(lines(EV.started)).toHaveLength(1);
  });
});

describe('[#3820] limits and failures', () => {
  it('lets the oldest open confirmation go past the process limit', () => {
    for (let i = 0; i < AUTO_YES_LEDGER_MAX_OPEN_TOTAL + 1; i += 1) {
      observeLedgerScreen({ worktreeId: `wt-${i}`, cliToolId: 'claude', instanceId: 'claude' }, 's', 'yes_no');
    }
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ worktreeId: 'wt-0', resolution: 'abandoned', abandonReason: 'capacity' }),
    ]);
  });

  it('never throws when its body fails, and counts the failure', () => {
    tick('screen-A');
    setAutoYesLedgerFaultForTests(new Error('injected'));
    expect(() => {
      tick('screen-A', () => withholdLedgerConfirmation(SCOPE, 'mode-off'));
      settleLedgerAttempt(beginLedgerAttempt(SCOPE, 'L3'), 'ok');
      noteLedgerPollerStopped(KEY, 'manual');
    }).not.toThrow();
    setAutoYesLedgerFaultForTests(null);
    expect(getAutoYesLedgerErrorCountForTests()).toBeGreaterThanOrEqual(5);
  });

  it('never throws when its logger throws, and counts it on the next alive line', () => {
    mockLogger.info.mockImplementation(() => {
      throw new Error('logger down');
    });
    expect(() => tick('screen-A', () => withholdLedgerConfirmation(SCOPE, 'mode-off'))).not.toThrow();
    mockLogger.info.mockReset();
    runAutoYesLedgerHourForTests(T0 + AUTO_YES_LEDGER_CLOCK_MS);
    expect(Number(lines(EV.alive)[0].ledgerErrors)).toBeGreaterThan(0);
  });

  it('writes no screen key, question or command into any line', () => {
    const secret = 'Do you want to run rm -rf /tmp/x?';
    tick(secret, () => settleLedgerAttempt(beginLedgerAttempt(SCOPE, 'L4'), 'ok'));
    tick(null);
    runAutoYesLedgerHourForTests(T0 + AUTO_YES_LEDGER_CLOCK_MS);
    expect(JSON.stringify(mockLogger.info.mock.calls)).not.toContain('rm -rf');
  });
});
