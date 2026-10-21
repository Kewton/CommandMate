/**
 * Issue #3820 PR 4: the daily Auto-Yes observation from the confirmation
 * ledger's lines (design `docs/design/auto-yes-measurement-3820.md` §4.3, §4.4,
 * §6, §7 PR 4). The lines are written here in the ledger's vocabulary
 * (`polling/auto-yes-confirmation-ledger-types.ts`) and the logger's text
 * format, and go through the same `addLogLine` the performance metrics use.
 *
 * Only the screen path exists until PR 2 and PR 3, so a day of the ledger as it
 * is today is a partial measurement (`pathsMissing`), and that is asserted too.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTO_YES_OBSERVATION_GRID_MS,
  autoYesObservationSummary,
  autoYesObservationWindow,
  measureAutoYesObservation,
} from '@/lib/agent-health/auto-yes-observation';
import { addLogLine, createLogAggregate } from '@/lib/agent-health/metrics-perf';
import { evaluateMetric } from '@/lib/agent-health/metrics-rules';
import type { MetricMeasurement } from '@/lib/agent-health/metrics-types';
import {
  AUTO_YES_LEDGER_EVENTS as EV,
  AUTO_YES_LEDGER_LOG_MODULE,
  AUTO_YES_LEDGER_PATHS,
  type AttemptSettledLine,
  type AutoYesLedgerPath,
  type CheckpointLine,
  type CliModeObservedLine,
  type ConfirmationClosedLine,
  type ConfirmationOpenedLine,
  type HookRequestClosedLine,
  type LedgerAliveLine,
  type LedgerLineBase,
  type LedgerStartedLine,
  type WithholdEndedLine,
  type WithholdReasonChangedLine,
  type WithholdStartedLine,
} from '@/lib/polling/auto-yes-confirmation-ledger-types';

const H = AUTO_YES_OBSERVATION_GRID_MS;
const MIN = 60 * 1000;
/** The run time: 07:30 UTC, so the window is 2026-10-20T07:00Z → 2026-10-21T07:00Z. */
const NOW = new Date('2026-10-21T07:30:00.000Z');
const E = Date.UTC(2026, 9, 21, 7, 0, 0);
const S = E - 24 * H;

const WT = 'wt-secret-3820';
const INSTANCE = 'inst-secret-3820';
const BOOT = 'bootaaaa';
const QUESTION = 'Do you want to run rm -rf /secret/path?';

type Fields<T extends LedgerLineBase> = Omit<T, 'ledgerVersion' | 'bootId'> & { bootId?: string };

/** One ledger line as the logger writes it (`[time] [INFO] [module] event {json}`); `loggedAt` defaults to `atMs`. */
function line<T extends LedgerLineBase>(event: string, fields: Fields<T>, loggedAt = fields.atMs): string {
  const data = { ledgerVersion: 1, bootId: BOOT, ...fields };
  return `[${new Date(loggedAt).toISOString()}] [INFO] [${AUTO_YES_LEDGER_LOG_MODULE}] ${event} ${JSON.stringify(data)}`;
}

/** `alive` lines on every boundary in `[from, to]`; the first segment starts at `startedAt`. */
function alive(
  from: number,
  to: number,
  options: { boot?: string; startedAt?: number; paths?: readonly AutoYesLedgerPath[]; errors?: (at: number) => number } = {}
): string[] {
  const out: string[] = [];
  let previous = options.startedAt ?? from - H;
  for (let at = from; at <= to; at += H) {
    out.push(
      line<LedgerAliveLine>(EV.alive, {
        bootId: options.boot ?? BOOT,
        atMs: at,
        logLevel: 'info',
        segments: (options.paths ?? ['screen']).map((path) => ({ path, startMs: previous, endMs: at })),
        openConfirmations: 0,
        openIntervals: 0,
        ledgerErrors: options.errors?.(at) ?? 0,
      })
    );
    previous = at;
  }
  return out;
}

const FULL_DAY = alive(S, E);
const ALL_PATHS_DAY = alive(S, E, { paths: AUTO_YES_LEDGER_PATHS });

let nextId = 0;
const confirmationId = () => `${BOOT}-${++nextId}`;

function opened(id: string, atMs: number, cliToolId = 'claude', instanceId = INSTANCE): string {
  return line<ConfirmationOpenedLine>(EV.opened, {
    atMs,
    confirmationId: id,
    worktreeId: WT,
    cliToolId: cliToolId as ConfirmationOpenedLine['cliToolId'],
    instanceId,
    source: 'screen',
    promptType: 'multiple_choice',
    // never a field the ledger writes; here to prove nothing unread is copied out
    ...({ question: QUESTION } as object),
  });
}

function closed(id: string, atMs: number, over: Partial<ConfirmationClosedLine> = {}): string {
  return line<ConfirmationClosedLine>(EV.closed, {
    atMs,
    confirmationId: id,
    worktreeId: WT,
    cliToolId: 'claude',
    instanceId: INSTANCE,
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
    ...over,
  });
}

function attempt(id: string, n: number, atMs: number, over: Partial<AttemptSettledLine> = {}): string {
  return line<AttemptSettledLine>(EV.attemptSettled, {
    atMs,
    confirmationId: id,
    attemptId: `${id}.${n}`,
    cliToolId: 'claude',
    basis: 'L3',
    result: 'ok',
    late: false,
    expired: false,
    ...over,
  });
}

const intervalBase = (id: string, n: number, cliToolId = 'claude') => ({
  confirmationId: id,
  intervalId: `${id}#${n}`,
  cliToolId: cliToolId as WithholdStartedLine['cliToolId'],
  source: 'screen' as const,
});

function started(id: string, n: number, atMs: number, reason: string, cliToolId = 'claude'): string {
  return line<WithholdStartedLine>(EV.withholdStarted, {
    atMs,
    ...intervalBase(id, n, cliToolId),
    reason: reason as WithholdStartedLine['reason'],
    startedAtMs: atMs,
  });
}

function reasonChanged(id: string, n: number, atMs: number, from: string, to: string): string {
  return line<WithholdReasonChangedLine>(EV.withholdReasonChanged, {
    atMs,
    ...intervalBase(id, n),
    from: from as WithholdReasonChangedLine['from'],
    to: to as WithholdReasonChangedLine['to'],
  });
}

function ended(id: string, n: number, startedAtMs: number, endedAtMs: number, lastReason: string, loggedAt = endedAtMs, cliToolId = 'claude'): string {
  return line<WithholdEndedLine>(
    EV.withholdEnded,
    {
      atMs: endedAtMs,
      ...intervalBase(id, n, cliToolId),
      startedAtMs,
      endedAtMs,
      withheldMs: endedAtMs - startedAtMs,
      end: 'gone',
      lastReason: lastReason as WithholdEndedLine['lastReason'],
    },
    loggedAt
  );
}

function checkpoint(id: string, atMs: number, interval: { n: number; startedAt: number; reason: string } | null, cliToolId = 'claude'): string {
  return line<CheckpointLine>(EV.checkpoint, {
    atMs,
    confirmationId: id,
    cliToolId: cliToolId as CheckpointLine['cliToolId'],
    source: 'screen',
    presence: 'present',
    answerability: interval === null ? 'answerable' : 'withheld',
    withheldMsTotal: interval === null ? 0 : atMs - interval.startedAt,
    ...(interval === null
      ? {}
      : {
          intervalId: `${id}#${interval.n}`,
          reason: interval.reason as CheckpointLine['reason'],
          intervalStartedAtMs: interval.startedAt,
          intervalMs: atMs - interval.startedAt,
        }),
  });
}

function hookClosed(n: number, atMs: number, over: Partial<HookRequestClosedLine> = {}): string {
  return line<HookRequestClosedLine>(EV.hookRequestClosed, {
    atMs,
    hookRequestId: `${BOOT}-h${n}`,
    cliToolId: 'claude',
    outcome: 'abstained',
    abstainReason: 'policy-suppressed',
    allowSuppressesDialog: true,
    replyMs: 12,
    ...over,
  });
}

function modeObserved(atMs: number, instanceId: string, mode: string, change: 'first' | 'changed' = 'first'): string {
  return line<CliModeObservedLine>(EV.cliModeObserved, { atMs, worktreeId: WT, cliToolId: 'claude', instanceId, sessionEpoch: 1, mode, change });
}

const dialogUnobservedLine = (atMs: number, hookRequestId: string) =>
  line<LedgerLineBase & { hookRequestId: string }>(EV.hookRequestDialogUnobserved, { atMs, hookRequestId });

type Ok = Extract<MetricMeasurement, { status: 'ok' }>;

function measure(lines: readonly string[], now = NOW): MetricMeasurement {
  const agg = createLogAggregate(now);
  for (const raw of lines) addLogLine(agg, raw);
  return measureAutoYesObservation(agg.autoYes, agg);
}

function measureOk(lines: readonly string[], now = NOW): Ok {
  const result = measure(lines, now);
  if (result.status !== 'ok') throw new Error(`expected ok, got skip: ${result.reason}`);
  return result;
}

describe('[#3820 PR 4] the window ends on the last completed hour boundary', () => {
  it('is 24 hours long and ends on the boundary before the run, so the next day starts where it ended', () => {
    const agg = createLogAggregate(NOW);
    expect(autoYesObservationWindow(agg)).toEqual({ start: S, end: E });
    const tomorrow = createLogAggregate(new Date(NOW.getTime() + 24 * H));
    expect(autoYesObservationWindow(tomorrow).start).toBe(E);
  });
});

describe('[#3820 PR 4] measured or not (design §4.4)', () => {
  it('skips a window with no alive line instead of reporting 0', () => {
    const id = confirmationId();
    const result = measure([opened(id, S + H), started(id, 1, S + H, 'type-not-allowed'), ended(id, 1, S + H, S + 2 * H, 'type-not-allowed')]);
    expect(result).toMatchObject({ metricId: 'auto-yes-observation', status: 'skip' });
    expect(evaluateMetric(result, null)).toMatchObject({ status: 'skip', value: null });
  });

  it('counts half a day of alive lines as half a day measured', () => {
    const half = alive(S + 12 * H, E, { startedAt: S + 12 * H });
    expect(measureOk(half).details).toMatchObject({ windowMs: 24 * H, coveredMs: 12 * H, gapMs: 12 * H, partial: 1 });
  });

  it('counts a process that started just after a boundary from its start, not from the boundary', () => {
    const late = alive(E, E, { startedAt: E - 50 * MIN });
    expect(measureOk(late).details).toMatchObject({ coveredMs: 50 * MIN, gapMs: 24 * H - 50 * MIN, partial: 1 });
  });

  it('is a partial measurement while only the screen path is recorded (PR 1 without PR 2 and PR 3)', () => {
    expect(measureOk(FULL_DAY).details).toMatchObject({
      coveredMs: 24 * H,
      gapMs: 0,
      partial: 1,
      pathsMissing: 'hook,api,prompt-response,agy-link',
    });
  });

  it('is partial when every path is there for one hour only, and not partial for a full day of every path', () => {
    const mixed = [...alive(S, E - H), ...alive(E, E, { paths: AUTO_YES_LEDGER_PATHS })];
    const details = measureOk(mixed).details!;
    expect(details).toMatchObject({ coveredMs: 24 * H, partial: 1, pathsMissing: 'hook,api,prompt-response,agy-link' });
    expect(details.coveredMsByPath).toBe(`screen ${24 * H} / hook ${H} / api ${H} / prompt-response ${H} / agy-link ${H}`);

    expect(measureOk(ALL_PATHS_DAY).details).toMatchObject({ coveredMs: 24 * H, gapMs: 0, partial: 0, pathsMissing: '' });
  });

  it('is partial when the ledger swallowed errors inside the window, and not for errors from before it', () => {
    const grew = alive(S, E, { paths: AUTO_YES_LEDGER_PATHS, errors: (at) => (at < E ? 2 : 3) });
    expect(measureOk(grew).details).toMatchObject({ ledgerErrors: 1, partial: 1 });
    const steady = alive(S, E, { paths: AUTO_YES_LEDGER_PATHS, errors: () => 2 });
    expect(measureOk(steady).details).toMatchObject({ ledgerErrors: 0, partial: 0 });
  });
});

describe('[#3820 PR 4] answers and attempts', () => {
  it('counts answers by tool and basis, and does not count a confirmation whose sends all failed', () => {
    const [a, b, c, d] = [confirmationId(), confirmationId(), confirmationId(), confirmationId()];
    const result = measureOk([
      ...FULL_DAY,
      opened(a, S + H),
      attempt(a, 1, S + H + 1000),
      closed(a, S + H + 4000),
      opened(b, S + 2 * H),
      attempt(b, 1, S + 2 * H + 1000),
      closed(b, S + 2 * H + 4000),
      opened(c, S + 3 * H, 'codex'),
      attempt(c, 1, S + 3 * H + 1000, { cliToolId: 'codex', basis: 'L4' }),
      closed(c, S + 3 * H + 4000, { cliToolId: 'codex', basis: 'L4' }),
      // failed, partial, no keys sent: never an answer
      opened(d, S + 4 * H),
      attempt(d, 1, S + 4 * H + 1000, { result: 'failed' }),
      attempt(d, 2, S + 4 * H + 2000, { result: 'partial' }),
      attempt(d, 3, S + 4 * H + 3000, { result: 'no-keys-sent' }),
      closed(d, S + 4 * H + 9000, {
        answeredAtClose: false,
        attempts: { ok: 0, partial: 1, noKeysSent: 1, failed: 1 },
        resolution: 'resolved-while-withheld',
      }),
    ]);
    expect(result.details).toMatchObject({
      confirmations: 4,
      confirmationsClosed: 4,
      answered: 3,
      answeredLate: 0,
      attemptsOk: 3,
      attemptsFailed: 1,
      attemptsPartial: 1,
      attemptsNoKeysSent: 1,
      resolvedAfterAnswer: 3,
      resolvedWhileWithheld: 1,
      resolvedByUnknown: 4,
    });
    expect(result.records!.filter((r) => r.kind === 'answered')).toEqual([
      { kind: 'answered', tool: 'claude', basis: 'L3', count: 2 },
      { kind: 'answered', tool: 'codex', basis: 'L4', count: 1 },
    ]);
    expect(result.records!.filter((r) => r.kind === 'attempt')).toContainEqual({
      kind: 'attempt',
      tool: 'claude',
      basis: 'L3',
      result: 'failed',
      count: 1,
    });
  });

  it('N1: a confirmation closed and then its late ok in the same window is answeredLate, not answered', () => {
    const id = confirmationId();
    const result = measureOk([
      ...FULL_DAY,
      opened(id, S + H),
      closed(id, S + H + 5000, {
        answeredAtClose: false,
        attempts: { ok: 0, partial: 0, noKeysSent: 0, failed: 0 },
        attemptsPending: 1,
        resolution: 'abandoned',
        abandonReason: 'session-killed',
      }),
      attempt(id, 1, S + H + 8000, { late: true }),
    ]);
    expect(result.details).toMatchObject({ answered: 0, answeredLate: 1, attemptsLate: 1, attemptsOk: 1, confirmations: 1, lostOnRestart: 0 });
  });

  it('N1: a late ok after the window belongs to the next day’s window', () => {
    const id = confirmationId();
    const lines = [
      ...alive(S, E + 24 * H),
      opened(id, E - 10 * MIN),
      closed(id, E - 5 * MIN, { answeredAtClose: false, attemptsPending: 1, resolution: 'abandoned', abandonReason: 'session-killed' }),
      attempt(id, 1, E + 10 * MIN, { late: true }),
    ];
    expect(measureOk(lines).details).toMatchObject({ answered: 0, answeredLate: 0, confirmationsClosed: 1 });
    const nextDay = measureOk(lines, new Date(NOW.getTime() + 24 * H));
    expect(nextDay.details).toMatchObject({ answered: 0, answeredLate: 1, confirmations: 0, confirmationsClosed: 0 });
  });
});

describe('[#3820 PR 4] withheld time inside the window (design §4.3)', () => {
  it('counts by tool and the interval’s last reason, from the server’s times', () => {
    const [a, b] = [confirmationId(), confirmationId()];
    const result = measureOk([
      ...FULL_DAY,
      opened(a, S + H),
      started(a, 1, S + H, 'type-not-allowed'),
      ended(a, 1, S + H, S + H + 5 * MIN, 'type-not-allowed'),
      opened(b, S + 2 * H),
      started(b, 1, S + 2 * H, 'type-not-allowed'),
      reasonChanged(b, 1, S + 2 * H + MIN, 'type-not-allowed', 'deny-pattern'),
      ended(b, 1, S + 2 * H, S + 2 * H + 3 * MIN, 'deny-pattern'),
    ]);
    expect(result.value).toBe(8);
    expect(result.details).toMatchObject({
      withheldConfirmations: 2,
      withheldIntervals: 2,
      withheldMsTotal: 8 * MIN,
      withheldMsMax: 5 * MIN,
      withheldMsMedian: 3 * MIN,
    });
    expect(result.records!.filter((r) => r.kind === 'withheld')).toEqual([
      { kind: 'withheld', tool: 'claude', reason: 'deny-pattern', intervals: 1, totalMs: 3 * MIN, maxMs: 3 * MIN, reasonChanged: 1 },
      { kind: 'withheld', tool: 'claude', reason: 'type-not-allowed', intervals: 1, totalMs: 5 * MIN, maxMs: 5 * MIN, reasonChanged: 0 },
    ]);
  });

  it('does not take the time between lines as withheld time', () => {
    const [a, b] = [confirmationId(), confirmationId()];
    const result = measureOk([
      ...FULL_DAY,
      // the end line was written 40 minutes after the server's end of the interval
      opened(a, S + H),
      started(a, 1, S + H, 'type-not-allowed'),
      ended(a, 1, S + H, S + H + 5 * MIN, 'type-not-allowed', S + H + 45 * MIN),
      // open for an hour and never withheld
      opened(b, S + 3 * H),
      closed(b, S + 4 * H, { openMs: H }),
    ]);
    expect(result.details).toMatchObject({ withheldMsTotal: 5 * MIN, withheldIntervals: 1 });
  });

  it('cuts an interval that began before the window to its part inside, without the earlier lines', () => {
    const id = confirmationId();
    const lines = [
      ...FULL_DAY,
      // `started` at S - 30 min is older than anything read
      started(id, 1, S - 30 * MIN, 'no-hook-receipt'),
      checkpoint(id, S, { n: 1, startedAt: S - 30 * MIN, reason: 'no-hook-receipt' }),
      ended(id, 1, S - 30 * MIN, S + 10 * MIN, 'no-hook-receipt'),
      closed(id, S + 10 * MIN, { answeredAtClose: false, resolution: 'resolved-while-withheld', decision: 'withhold', intervals: 1 }),
    ];
    expect(measureOk(lines).details).toMatchObject({ withheldMsTotal: 10 * MIN, withheldIntervals: 1, confirmationsClosed: 1 });
  });

  it('cuts an interval still open at the end of the window at the last boundary and counts it open', () => {
    const id = confirmationId();
    const result = measureOk([
      ...FULL_DAY,
      opened(id, E - 20 * MIN),
      started(id, 1, E - 20 * MIN, 'type-not-allowed'),
      checkpoint(id, E, { n: 1, startedAt: E - 20 * MIN, reason: 'type-not-allowed' }),
      // the unsettled tail after the last boundary is the next day's
      ended(id, 1, E - 20 * MIN, E + 10 * MIN, 'type-not-allowed'),
      closed(id, E + 10 * MIN, { answeredAtClose: false, resolution: 'resolved-while-withheld' }),
    ]);
    expect(result.details).toMatchObject({ withheldMsTotal: 20 * MIN, openAtWindowEnd: 1, confirmationsClosed: 0, lostOnRestart: 0 });
  });

  it('puts an interval of the day before that never changed into the breakdown from the checkpoints alone', () => {
    const id = confirmationId();
    const checkpoints: string[] = [];
    for (let at = S; at <= E; at += H) {
      checkpoints.push(checkpoint(id, at, { n: 1, startedAt: S - 5 * H, reason: 'no-hook-receipt' }, 'antigravity'));
    }
    const result = measureOk([...FULL_DAY, ...checkpoints]);
    expect(result.details).toMatchObject({ withheldMsTotal: 24 * H, openAtWindowEnd: 1, withheldConfirmations: 1 });
    expect(result.records!.filter((r) => r.kind === 'withheld')).toEqual([
      { kind: 'withheld', tool: 'antigravity', reason: 'no-hook-receipt', intervals: 1, totalMs: 24 * H, maxMs: 24 * H, reasonChanged: 0 },
    ]);
  });

  it('tells an interval that ended after the last checkpoint from the next one by intervalId', () => {
    const id = confirmationId();
    const result = measureOk([
      ...FULL_DAY,
      checkpoint(id, E - H, { n: 1, startedAt: S - H, reason: 'type-not-allowed' }),
      ended(id, 1, S - H, E - 30 * MIN, 'type-not-allowed'),
      started(id, 2, E - 20 * MIN, 'answered-recently'),
      checkpoint(id, E, { n: 2, startedAt: E - 20 * MIN, reason: 'answered-recently' }),
    ]);
    expect(result.records!.filter((r) => r.kind === 'withheld')).toEqual([
      { kind: 'withheld', tool: 'claude', reason: 'answered-recently', intervals: 1, totalMs: 20 * MIN, maxMs: 20 * MIN, reasonChanged: 0 },
      { kind: 'withheld', tool: 'claude', reason: 'type-not-allowed', intervals: 1, totalMs: 23.5 * H, maxMs: 23.5 * H, reasonChanged: 0 },
    ]);
    expect(result.details).toMatchObject({ withheldIntervals: 2, withheldConfirmations: 1 });
  });

  it('counts a confirmation a restart lost up to its last checkpoint, and as lostOnRestart', () => {
    const id = confirmationId();
    const result = measureOk([
      ...alive(S, S + 3 * H),
      opened(id, S + H),
      started(id, 1, S + H, 'type-not-allowed'),
      checkpoint(id, S + 2 * H, { n: 1, startedAt: S + H, reason: 'type-not-allowed' }),
      checkpoint(id, S + 3 * H, { n: 1, startedAt: S + H, reason: 'type-not-allowed' }),
      // the process died after S + 3 h; another came up
      line<LedgerStartedLine>(EV.started, { bootId: 'bootbbbb', atMs: S + 3.5 * H, logLevel: 'info', paths: ['screen'] }),
      ...alive(S + 4 * H, E, { boot: 'bootbbbb', startedAt: S + 3.5 * H }),
    ]);
    expect(result.details).toMatchObject({
      withheldMsTotal: 2 * H,
      lostOnRestart: 1,
      openAtWindowEnd: 0,
      confirmations: 1,
      coveredMs: 23.5 * H,
      gapMs: 0.5 * H,
    });
  });

  it('gives no time to hook requests that abstained', () => {
    const result = measureOk([
      ...FULL_DAY,
      hookClosed(1, S + H),
      hookClosed(2, S + 2 * H, { abstainReason: 'auto-yes-disabled' }),
      hookClosed(3, S + 3 * H, { outcome: 'allow', abstainReason: undefined }),
    ]);
    expect(result.details).toMatchObject({ hookRequests: 3, hookAllowed: 1, hookAbstained: 2, withheldMsTotal: 0, withheldIntervals: 0 });
    const abstained = result.records!.filter((r) => r.kind === 'hook-abstained');
    expect(abstained).toEqual([
      { kind: 'hook-abstained', tool: 'claude', reason: 'auto-yes-disabled', count: 1 },
      { kind: 'hook-abstained', tool: 'claude', reason: 'policy-suppressed', count: 1 },
    ]);
  });
});

describe('[#3820 PR 4] the read order is not the time order (design §4.3, recommendation 7)', () => {
  it('gives the same result for the lines read newest first', () => {
    const [a, b] = [confirmationId(), confirmationId()];
    const lines = [
      ...alive(S, E),
      opened(a, S + H),
      started(a, 1, S + H, 'type-not-allowed'),
      reasonChanged(a, 1, S + H + MIN, 'type-not-allowed', 'deny-pattern'),
      checkpoint(a, S + 2 * H, { n: 1, startedAt: S + H, reason: 'deny-pattern' }),
      ended(a, 1, S + H, S + 2 * H + 5 * MIN, 'deny-pattern'),
      closed(a, S + 2 * H + 5 * MIN, { answeredAtClose: false, resolution: 'resolved-while-withheld' }),
      opened(b, S + 5 * H),
      attempt(b, 1, S + 5 * H + 1000),
      closed(b, S + 5 * H + 3000),
      modeObserved(S + 6 * H, INSTANCE, 'default', 'first'),
      modeObserved(S + 7 * H, INSTANCE, 'plan', 'changed'),
    ];
    const forward = measureOk(lines);
    const backward = measureOk([...lines].reverse());
    expect(backward).toEqual(forward);
    // the latest mode in time order, whatever the read order
    expect(forward.records!.filter((r) => r.kind === 'cli-mode')).toEqual([{ kind: 'cli-mode', tool: 'claude', mode: 'plan', instances: 1 }]);
  });
});

describe('[#3820 PR 4] the CLI’s own mode and dialogs not observed (design §3.4, §2.6)', () => {
  it('counts observed modes per instance and the identified instances with no mode as unknown', () => {
    const [a, b] = [confirmationId(), confirmationId()];
    const result = measureOk([
      ...FULL_DAY,
      modeObserved(S + H, INSTANCE, 'default', 'first'),
      opened(a, S + 2 * H, 'claude', INSTANCE),
      opened(b, S + 3 * H, 'codex', 'inst-secret-codex'),
    ]);
    expect(result.details).toMatchObject({ cliModeObserved: 1, cliModeUnknownInstances: 1 });
    expect(result.records!.filter((r) => r.kind === 'cli-mode')).toEqual([
      { kind: 'cli-mode', tool: 'claude', mode: 'default', instances: 1 },
      { kind: 'cli-mode', tool: 'codex', mode: 'unknown', instances: 1 },
    ]);
  });

  it('gives no unknown count when no instance could be identified (no population, not 0)', () => {
    expect(measureOk(FULL_DAY).details).toMatchObject({ cliModeObserved: 0, cliModeUnknownInstances: null });
  });

  it('counts each hook request whose dialog was not observed once', () => {
    const result = measureOk([
      ...FULL_DAY,
      hookClosed(1, S + H, { outcome: 'allow', abstainReason: undefined, allowSuppressesDialog: false, dialogUnobserved: true }),
      dialogUnobservedLine(S + H + 10, `${BOOT}-h1`),
      dialogUnobservedLine(S + 2 * H, `${BOOT}-h2`),
    ]);
    expect(result.details).toMatchObject({ dialogUnobserved: 2, answered: 0, hookAllowed: 1 });
  });
});

describe('[#3820 PR 4] the repository is public', () => {
  it('folds values outside the vocabulary into (other)', () => {
    const id = confirmationId();
    const result = measureOk([
      ...FULL_DAY,
      opened(id, S + H, 'newtool'),
      started(id, 1, S + H, 'a-reason-from-pr-9', 'newtool'),
      ended(id, 1, S + H, S + H + MIN, 'a-reason-from-pr-9', S + H + MIN, 'newtool'),
      attempt(id, 1, S + H + 2 * MIN, { cliToolId: 'newtool' as AttemptSettledLine['cliToolId'], basis: 'L9' as AttemptSettledLine['basis'] }),
      closed(id, S + H + 3 * MIN, { cliToolId: 'newtool' as ConfirmationClosedLine['cliToolId'], basis: 'L9' as ConfirmationClosedLine['basis'] }),
      hookClosed(1, S + 2 * H, { abstainReason: 'a-new-abstain' }),
      modeObserved(S + 3 * H, 'other-inst', 'superMode', 'first'),
    ]);
    const records = result.records!;
    expect(records).toContainEqual({ kind: 'answered', tool: '(other)', basis: '(other)', count: 1 });
    expect(records).toContainEqual(expect.objectContaining({ kind: 'withheld', tool: '(other)', reason: '(other)' }));
    expect(records).toContainEqual({ kind: 'hook-abstained', tool: 'claude', reason: '(other)', count: 1 });
    expect(records).toContainEqual({ kind: 'cli-mode', tool: 'claude', mode: '(other)', instances: 1 });
  });

  it('copies no worktree, instance, boot, confirmation, interval or request id and no question', () => {
    const id = confirmationId();
    const result = measureOk([
      ...FULL_DAY,
      opened(id, S + H),
      started(id, 1, S + H, 'type-not-allowed'),
      checkpoint(id, S + 2 * H, { n: 1, startedAt: S + H, reason: 'type-not-allowed' }),
      ended(id, 1, S + H, S + 2 * H + MIN, 'type-not-allowed'),
      attempt(id, 1, S + 2 * H + 2 * MIN),
      closed(id, S + 2 * H + 3 * MIN),
      hookClosed(7, S + 3 * H, { dialogUnobserved: true }),
      modeObserved(S + 4 * H, INSTANCE, 'default', 'first'),
    ]);
    const published = JSON.stringify(evaluateMetric(result, null));
    expect(published).not.toMatch(/wt-secret|inst-secret|boot[a-z]{4}|#1|\.1"|-h7|rm -rf|secret\/path/);
  });
});

describe('[#3820 PR 4] the report', () => {
  it('is an observation: never fails, never a candidate, with a one-line summary', () => {
    const id = confirmationId();
    const result = evaluateMetric(
      measureOk([
        ...FULL_DAY,
        opened(id, S + H),
        started(id, 1, S + H, 'type-not-allowed'),
        ended(id, 1, S + H, S + H + 90 * 1000, 'type-not-allowed'),
        attempt(id, 1, S + H + 100 * 1000, { result: 'failed' }),
        attempt(id, 2, S + H + 110 * 1000),
        closed(id, S + H + 120 * 1000),
      ]),
      null
    );
    expect(result).toMatchObject({ metricId: 'auto-yes-observation', category: 'process', status: 'pass', candidates: [], value: 1.5 });
    expect(result.summary).toBe('停止 1.5m（確認 1 件・区間 1）／回答 1（試行の失敗 1）／計測 24h/24h・部分計測');
    expect(autoYesObservationSummary(undefined)).toBe('停止 0m（確認 0 件・区間 0）／回答 0（試行の失敗 0）／計測 0h/0h');
  });
});

describe('[#3820 PR 4] the other log metrics are unchanged by the hour read back', () => {
  it('keeps a ledger line from the hour before the shared window out of log-volume’s count', () => {
    const agg = createLogAggregate(NOW);
    addLogLine(agg, alive(S, S)[0]); // 2026-10-20T07:00Z: before windowStart (07:30Z), inside the look-back
    expect(agg.lines).toBe(0);
    expect(agg.byName).toEqual({});
    expect(agg.autoYes.lines).toHaveLength(1);
    addLogLine(agg, alive(S - H, S - H)[0]); // older than the look-back
    expect(agg.autoYes.lines).toHaveLength(1);
  });
});
