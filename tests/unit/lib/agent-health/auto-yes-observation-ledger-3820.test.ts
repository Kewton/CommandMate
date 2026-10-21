/**
 * Issue #3820 PR 4: the daily aggregation reads the lines PR 1's ledger
 * actually writes. The ledger (`polling/auto-yes-confirmation-ledger.ts`) is
 * driven through its entry points with a stubbed clock; its logger is replaced
 * by one that keeps each line in the text format the production log has, and
 * those lines go through `addLogLine` as the daily read does.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const written = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('@/lib/logger', () => {
  const record = (level: string) => (event: string, data?: Record<string, unknown>) => {
    const atMs = typeof data?.atMs === 'number' ? data.atMs : Date.now();
    written.lines.push(`[${new Date(atMs).toISOString()}] [${level}] [auto-yes-confirmation-ledger] ${event} ${JSON.stringify(data)}`);
  };
  const logger = { debug: record('DEBUG'), info: record('INFO'), warn: record('WARN'), error: record('ERROR'), withContext: () => logger };
  return { createLogger: vi.fn(() => logger), generateRequestId: vi.fn(() => 'test-request-id') };
});

import {
  AUTO_YES_LEDGER_CLOCK_MS,
  AUTO_YES_LEDGER_RECORDED_PATHS,
  beginLedgerAttempt,
  beginLedgerTick,
  endLedgerTick,
  observeLedgerScreen,
  resetAutoYesConfirmationLedgerForTests,
  runAutoYesLedgerHourForTests,
  setAutoYesLedgerClockTimersForTests,
  settleLedgerAttempt,
  withholdLedgerConfirmation,
  type LedgerScope,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_PATHS } from '@/lib/polling/auto-yes-confirmation-ledger-types';
import { AUTO_YES_OBSERVATION_GRID_MS, measureAutoYesObservation } from '@/lib/agent-health/auto-yes-observation';
import { addLogLine, createLogAggregate } from '@/lib/agent-health/metrics-perf';

const H = AUTO_YES_LEDGER_CLOCK_MS;
const NOW = new Date('2026-10-21T07:30:00.000Z');
const E = Date.UTC(2026, 9, 21, 7, 0, 0);
const S = E - 24 * H;
const SCOPE: LedgerScope = { worktreeId: 'wt-secret-3820', cliToolId: 'claude', instanceId: 'claude' };

let now = S - H;

function tick(screenKey: string | null, during: () => void = () => {}): void {
  const token = beginLedgerTick(SCOPE);
  if (screenKey !== null) observeLedgerScreen(SCOPE, screenKey, 'multiple_choice');
  during();
  endLedgerTick(SCOPE, token);
}

/** The ledger's hour lines for every boundary in `[from, to]`. */
function hours(from: number, to: number): void {
  for (let at = from; at <= to; at += H) {
    now = at;
    runAutoYesLedgerHourForTests(at);
  }
}

beforeEach(() => {
  written.lines = [];
  resetAutoYesConfirmationLedgerForTests();
  now = S - H;
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

describe('[#3820 PR 4] the aggregation and the ledger agree', () => {
  it('uses the ledger’s clock grid and knows every path the ledger records', () => {
    expect(AUTO_YES_OBSERVATION_GRID_MS).toBe(AUTO_YES_LEDGER_CLOCK_MS);
    for (const path of AUTO_YES_LEDGER_RECORDED_PATHS) expect(AUTO_YES_LEDGER_PATHS).toContain(path);
  });

  it('reads a day of PR 1’s screen path: one withheld interval, one answer, a partial measurement', () => {
    tick(null); // the ledger starts (and its `started` line is written) an hour before the window
    hours(S, S + H);

    // withheld for five ticks, then gone
    for (let i = 0; i < 5; i += 1) {
      tick('screen-A', () => withholdLedgerConfirmation(SCOPE, 'type-not-allowed'));
      now += 2_000;
    }
    tick(null);
    // answered on L3, then gone
    now += 60_000;
    let handle: ReturnType<typeof beginLedgerAttempt> = null;
    tick('screen-B', () => {
      handle = beginLedgerAttempt(SCOPE, 'L3');
    });
    now += 1_000;
    settleLedgerAttempt(handle, 'ok');
    now += 2_000;
    tick(null);
    // still withheld at the end of the window
    now = E - 20 * 60 * 1000;
    tick('screen-C', () => withholdLedgerConfirmation(SCOPE, 'no-hook-receipt'));
    hours(S + 2 * H, E);

    const agg = createLogAggregate(NOW);
    for (const raw of written.lines) addLogLine(agg, raw);
    const result = measureAutoYesObservation(agg.autoYes, agg);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.details).toMatchObject({
      windowMs: 24 * H,
      coveredMs: 24 * H,
      partial: 1,
      pathsMissing: 'hook,api,prompt-response,agy-link',
      ledgerErrors: 0,
      confirmations: 3,
      confirmationsClosed: 2,
      openAtWindowEnd: 1,
      lostOnRestart: 0,
      answered: 1,
      attemptsOk: 1,
      resolvedAfterAnswer: 1,
      resolvedWhileWithheld: 1,
      withheldConfirmations: 2,
      withheldIntervals: 2,
      withheldMsTotal: 10_000 + 20 * 60 * 1000,
    });
    expect(result.records).toEqual(
      expect.arrayContaining([
        { kind: 'answered', tool: 'claude', basis: 'L3', count: 1 },
        { kind: 'withheld', tool: 'claude', reason: 'type-not-allowed', intervals: 1, totalMs: 10_000, maxMs: 10_000, reasonChanged: 0 },
        { kind: 'withheld', tool: 'claude', reason: 'no-hook-receipt', intervals: 1, totalMs: 20 * 60 * 1000, maxMs: 20 * 60 * 1000, reasonChanged: 0 },
      ])
    );
    expect(JSON.stringify(result)).not.toContain('wt-secret');
  });
});
