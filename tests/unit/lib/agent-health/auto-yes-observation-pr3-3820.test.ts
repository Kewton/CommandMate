/**
 * Issue #3820 PR 3 × PR 4: once the ledger records the agy link (`agy-link`),
 * a day of its `alive` lines has every path and is not a partial measurement;
 * a day that mixes in lines of a PR 2 ledger (no `agy-link`) still is, with
 * `agy-link` missing (design `docs/design/auto-yes-measurement-3820.md` §6.4).
 *
 * The PR 3 lines come from the real ledger (stubbed clock, the logger keeping
 * the production text format); the PR 2 lines are written as that version
 * wrote them. Positive control: before PR 3 added `agy-link` to the ledger's
 * paths, the first case was `partial: 1`, `pathsMissing: agy-link`.
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
  beginLedgerTick,
  endLedgerTick,
  resetAutoYesConfirmationLedgerForTests,
  runAutoYesLedgerHourForTests,
  setAutoYesLedgerClockTimersForTests,
  type LedgerScope,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';
import { measureAutoYesObservation } from '@/lib/agent-health/auto-yes-observation';
import { addLogLine, createLogAggregate } from '@/lib/agent-health/metrics-perf';

const H = AUTO_YES_LEDGER_CLOCK_MS;
const NOW = new Date('2026-10-22T07:30:00.000Z');
const E = Date.UTC(2026, 9, 22, 7, 0, 0);
const S = E - 24 * H;
const SCOPE: LedgerScope = { worktreeId: 'wt-3820-pr3', cliToolId: 'antigravity', instanceId: 'antigravity' };
const PR2_PATHS = ['screen', 'hook', 'api', 'prompt-response'] as const;

let now = S - H;

/** The real ledger's hour lines on every boundary in `[from, to]`. */
function hours(from: number, to: number): void {
  for (let at = from; at <= to; at += H) {
    now = at;
    runAutoYesLedgerHourForTests(at);
  }
}

/** `alive` lines a PR 2 ledger (another process) wrote on every boundary in `[from, to]`. */
function pr2Alive(from: number, to: number): string[] {
  const out: string[] = [];
  let previous = from - H;
  for (let at = from; at <= to; at += H) {
    const data = {
      ledgerVersion: 1,
      bootId: 'pr2boot1',
      atMs: at,
      logLevel: 'info',
      segments: PR2_PATHS.map((path) => ({ path, startMs: previous, endMs: at })),
      openConfirmations: 0,
      openIntervals: 0,
      ledgerErrors: 0,
    };
    out.push(`[${new Date(at).toISOString()}] [INFO] [auto-yes-confirmation-ledger] ${EV.alive} ${JSON.stringify(data)}`);
    previous = at;
  }
  return out;
}

function measure(lines: readonly string[]) {
  const agg = createLogAggregate(NOW);
  for (const raw of lines) addLogLine(agg, raw);
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

describe('[#3820 PR 3 × PR 4] the agy link completes the paths', () => {
  it('records agy-link as a path of its own', () => {
    expect(AUTO_YES_LEDGER_RECORDED_PATHS).toContain('agy-link');
  });

  it('is not partial for a day of a PR 3 ledger’s alive lines only', () => {
    endLedgerTick(SCOPE, beginLedgerTick(SCOPE));
    hours(S, E);

    expect(measure(written.lines).details).toMatchObject({ coveredMs: 24 * H, gapMs: 0, partial: 0, pathsMissing: '' });
  });

  it('is partial, with agy-link missing, when a PR 2 ledger’s lines make up part of the day (negative control)', () => {
    const before = pr2Alive(S, S + 11 * H);
    now = S + 11 * H;
    endLedgerTick(SCOPE, beginLedgerTick(SCOPE));
    hours(S + 12 * H, E);

    expect(measure([...before, ...written.lines]).details).toMatchObject({
      coveredMs: 24 * H,
      partial: 1,
      pathsMissing: 'agy-link',
    });
  });
});
