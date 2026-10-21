/**
 * Issue #3820, the integration of PR 2 with PR 4: the daily aggregation reads
 * the lines PR 2's paths write (`/prompt-response`, the API approval, Auto-Yes
 * switched off under it) as the ledger actually writes them. The ledger is
 * driven through its entry points with a stubbed clock; its logger keeps each
 * line in the production log's text format, and the lines go through
 * `addLogLine` as the daily read does.
 *
 *  - A person's `/prompt-response` answer (basis `human`) is not an Auto-Yes
 *    answer: it is `answeredByHuman`, never `answered`. The browser's Auto-Yes
 *    (basis `browser`) and the API's allow (`L1`) are `answered`.
 *  - An interval closed `end: 'stopped'` (Auto-Yes off under an API approval)
 *    counts no time after the OFF, though the approval stays open and on every
 *    checkpoint.
 *  - With PR 2's paths recorded, only `agy-link` (PR 3) is missing.
 *
 * Positive control: before this change the human answer was counted in
 * `answered` (and `answeredByHuman` did not exist).
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
  beginLedgerApiAdjudication,
  beginLedgerTick,
  endLedgerTick,
  noteLedgerPollerStopped,
  recordLedgerApiAdjudication,
  recordLedgerPromptResponse,
  resetAutoYesConfirmationLedgerForTests,
  runAutoYesLedgerHourForTests,
  setAutoYesLedgerClockTimersForTests,
  type LedgerScope,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { measureAutoYesObservation } from '@/lib/agent-health/auto-yes-observation';
import { addLogLine, createLogAggregate } from '@/lib/agent-health/metrics-perf';

const H = AUTO_YES_LEDGER_CLOCK_MS;
const NOW = new Date('2026-10-21T07:30:00.000Z');
const E = Date.UTC(2026, 9, 21, 7, 0, 0);
const S = E - 24 * H;
const SCREEN: LedgerScope = { worktreeId: 'wt-secret-3820', cliToolId: 'claude', instanceId: 'claude' };
const API: LedgerScope = { worktreeId: 'wt-secret-3820', cliToolId: 'opencode', instanceId: 'opencode' };

let now = S - H;

function hours(from: number, to: number): void {
  for (let at = from; at <= to; at += H) {
    now = at;
    runAutoYesLedgerHourForTests(at);
  }
}

/** The ledger starts an hour before the window, and its first hour lines are written. */
function startLedger(): void {
  endLedgerTick(SCREEN, beginLedgerTick(SCREEN));
  hours(S, S + H);
  now = S + H + 60_000;
}

function measure() {
  const agg = createLogAggregate(NOW);
  for (const raw of written.lines) addLogLine(agg, raw);
  const result = measureAutoYesObservation(agg.autoYes, agg);
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('skipped');
  return result;
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

describe('[#3820 PR 2 × PR 4] who answered, in the daily aggregation', () => {
  it('counts a person’s /prompt-response answer apart from Auto-Yes’s', () => {
    startLedger();
    recordLedgerPromptResponse(SCREEN, { basis: 'human', promptType: 'yes_no', result: 'ok' });
    hours(S + 2 * H, E);

    const result = measure();
    expect(result.details).toMatchObject({ answered: 0, answeredByHuman: 1, confirmations: 1, resolvedByHumanUi: 1 });
    expect(result.items).toMatchObject({ answered: 0 });
    expect(result.records).toEqual(expect.arrayContaining([{ kind: 'answered', tool: 'claude', basis: 'human', count: 1 }]));
  });

  it('counts the browser’s Auto-Yes and the API’s allow as Auto-Yes answers', () => {
    startLedger();
    recordLedgerPromptResponse(SCREEN, { basis: 'browser', promptType: 'yes_no', result: 'ok' });
    recordLedgerApiAdjudication(API, 'per_1', { outcome: 'allow', delivered: true, settled: true, promptType: 'multiple_choice' });
    hours(S + 2 * H, E);

    expect(measure().details).toMatchObject({ answered: 2, answeredByHuman: 0 });
  });

  it('counts no failed answer of either, and no human answer twice', () => {
    startLedger();
    recordLedgerPromptResponse(SCREEN, { basis: 'human', promptType: 'yes_no', result: 'failed' });
    recordLedgerPromptResponse(SCREEN, { basis: 'browser', promptType: 'yes_no', result: 'failed' });
    recordLedgerPromptResponse(SCREEN, { basis: 'human', promptType: 'yes_no', result: 'ok' });
    hours(S + 2 * H, E);

    expect(measure().details).toMatchObject({ answered: 0, answeredByHuman: 1, attemptsFailed: 2, unresolvedAfterSend: 2 });
  });
});

describe('[#3820 PR 2 × PR 4] Auto-Yes off under a withheld API approval', () => {
  it('counts the interval up to the OFF and nothing after, though the approval stays open', () => {
    startLedger();
    beginLedgerApiAdjudication(API, 'per_1', { outcome: 'abstained', withholdReason: 'deny-pattern', promptType: 'multiple_choice' });
    now += 10 * 60_000;
    noteLedgerPollerStopped('wt-secret-3820:opencode', 'manual');
    hours(S + 2 * H, E);

    const result = measure();
    expect(result.details).toMatchObject({
      withheldIntervals: 1,
      withheldMsTotal: 10 * 60_000,
      openAtWindowEnd: 1,
      confirmationsClosed: 0,
    });
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'withheld', tool: 'opencode', reason: 'deny-pattern', intervals: 1, totalMs: 10 * 60_000 }),
      ])
    );
  });

  it('counts the whole day when Auto-Yes stays on (negative control)', () => {
    startLedger();
    const startedAt = now;
    beginLedgerApiAdjudication(API, 'per_1', { outcome: 'abstained', withholdReason: 'deny-pattern', promptType: 'multiple_choice' });
    hours(S + 2 * H, E);

    expect(measure().details).toMatchObject({ withheldIntervals: 1, withheldMsTotal: E - startedAt });
  });
});

describe('[#3820 PR 2 × PR 4] the paths a PR 2 ledger records', () => {
  it('leaves only agy-link missing', () => {
    startLedger();
    hours(S + 2 * H, E);

    expect(measure().details).toMatchObject({ pathsMissing: 'agy-link', partial: 1 });
  });
});
