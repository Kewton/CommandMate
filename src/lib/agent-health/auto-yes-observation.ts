/**
 * Auto-Yes observation from the production log (Issue #3820, PR 4; design
 * `docs/design/auto-yes-measurement-3820.md` §4.3, §4.4, §6). Pure: parsed log
 * lines in, one {@link MetricMeasurement} out. The lines are read once for the
 * performance metrics (`metrics-perf.ts` `addLogLine`), which hands this module
 * the confirmation ledger's lines (`polling/auto-yes-confirmation-ledger.ts`).
 *
 * Observation only, like `hook-observation`: category `process`, never a
 * candidate. What should become one is decided after two weeks of numbers.
 *
 * The window is the last {@link PERF_LOG_WINDOW_HOURS}-long stretch that ends
 * on a completed UTC hour boundary — the time of the ledger's last `alive` and
 * `checkpoint` lines. The unsettled tail after it is left to the next day's
 * window, which starts where this one ended, so the lines are taken from one
 * grid step before the shared read's window ({@link AUTO_YES_OBSERVATION_LOOKBACK_MS}).
 *
 * Time comes only from what the server computed (`startedAtMs` / `endedAtMs`
 * of an interval, a checkpoint's own time), never from the gaps between lines.
 * Lines are sorted by their `atMs` before anything is built: the log is read
 * newest file first, which is not time order.
 *
 * The repository is public, so the details and records carry counts,
 * durations, tool names, bases, reason codes and paths from the ledger's fixed
 * vocabulary only — anything else becomes `(other)`. Worktree, instance,
 * confirmation, interval and hook request ids pair lines up and are never
 * copied out.
 */

import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import {
  ANSWER_BASES,
  ATTEMPT_RESULTS,
  AUTO_YES_LEDGER_EVENTS,
  AUTO_YES_LEDGER_LOG_MODULE,
  AUTO_YES_LEDGER_PATHS,
  CLI_PERMISSION_MODES,
  CONFIRMATION_RESOLUTIONS,
  CONFIRMATION_RESOLVED_BY,
  HOOK_ABSTAIN_REASONS,
  LEDGER_WITHHOLD_REASONS,
  type AutoYesLedgerEvent,
} from '@/lib/polling/auto-yes-confirmation-ledger-types';
import type { ParsedLogLine } from './metrics-perf';
import type { MetricMeasurement, MetricRecord } from './metrics-types';

/** The ledger's clock grid (`AUTO_YES_LEDGER_CLOCK_MS`): every UTC hour boundary. */
export const AUTO_YES_OBSERVATION_GRID_MS = 60 * 60 * 1000;

/** How far before the shared read's window this module still takes lines (one grid step). */
export const AUTO_YES_OBSERVATION_LOOKBACK_MS = AUTO_YES_OBSERVATION_GRID_MS;

const OTHER = '(other)';
const EV = AUTO_YES_LEDGER_EVENTS;
const PREFIX = `${AUTO_YES_LEDGER_LOG_MODULE} `;

/** Tie-break for lines with the same `atMs`, so the result does not depend on the read order. */
const EVENT_ORDER: readonly AutoYesLedgerEvent[] = [
  EV.started,
  EV.alive,
  EV.opened,
  EV.presenceChanged,
  EV.withholdStarted,
  EV.withholdReasonChanged,
  EV.attemptSettled,
  EV.withholdEnded,
  EV.checkpoint,
  EV.closed,
  EV.hookRequestClosed,
  EV.hookRequestDialogUnobserved,
  EV.cliModeObserved,
];
const EVENT_RANK: ReadonlyMap<string, number> = new Map(EVENT_ORDER.map((event, index) => [event, index]));

interface LedgerLine {
  event: AutoYesLedgerEvent;
  /** The server's `atMs`, or the log line's time when it is missing. */
  atMs: number;
  data: Record<string, unknown>;
  /** The JSON as written: the last tie-break. */
  raw: string;
}

export interface AutoYesObservationSamples {
  lines: LedgerLine[];
}

export function createAutoYesObservationSamples(): AutoYesObservationSamples {
  return { lines: [] };
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function known(value: unknown, vocabulary: readonly string[]): string {
  return typeof value === 'string' && vocabulary.includes(value) ? value : OTHER;
}
const toolOf = (data: Record<string, unknown>) => known(data.cliToolId, CLI_TOOL_IDS);
const reasonOf = (value: unknown) => known(value, LEDGER_WITHHOLD_REASONS);
const basisOf = (value: unknown) => known(value, ANSWER_BASES);

/**
 * Take one line of the shared read (in its window or up to
 * {@link AUTO_YES_OBSERVATION_LOOKBACK_MS} before it); lines that are not the
 * ledger's are ignored.
 */
export function addAutoYesObservationLine(samples: AutoYesObservationSamples, line: ParsedLogLine): void {
  if (!line.name.startsWith(PREFIX) || line.data === null) return;
  const event = line.name.slice(PREFIX.length);
  if (!EVENT_RANK.has(event)) return;
  let json: unknown;
  try {
    json = JSON.parse(line.data);
  } catch {
    return;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return;
  const data = json as Record<string, unknown>;
  samples.lines.push({ event: event as AutoYesLedgerEvent, atMs: num(data.atMs) ?? line.time, data, raw: line.data });
}

/** Nearest-rank percentile, rounded to whole ms (the same as `metrics-perf.ts`). */
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
}

/** Total length of the union of `[start, end]` spans. */
function unionMs(spans: Array<[number, number]>): number {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cursor = -Infinity;
  for (const [start, end] of sorted) {
    const from = Math.max(start, cursor);
    if (end > from) total += end - from;
    cursor = Math.max(cursor, end);
  }
  return total;
}

function increment(map: Map<string, MetricRecord>, key: string, make: () => MetricRecord, field = 'count', by = 1): void {
  const record = map.get(key) ?? make();
  record[field] = (record[field] as number) + by;
  map.set(key, record);
}

const sortedRecords = (map: Map<string, MetricRecord>): MetricRecord[] =>
  [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, record]) => record);

interface Interval {
  confirmationId: string;
  tool: string;
  /**
   * `withhold-ended`'s `startedAtMs` → `withhold-started`'s → a checkpoint's
   * `intervalStartedAtMs`. All null: the start is unknown and the interval is untimed.
   */
  endedStart: number | null;
  startedStart: number | null;
  checkpointStart: number | null;
  endedAt: number | null;
  /** The latest of its lines; where an interval no `withhold-ended` closed is counted to. */
  lastAt: number;
  reason: string;
  endedReason: string | null;
  reasonChanged: boolean;
}

/** The window `[start, end]`: the last completed grid boundary at or before `windowEnd`, and as long as the shared one. */
export function autoYesObservationWindow(window: { windowStart: number; windowEnd: number }): { start: number; end: number } {
  const end = Math.floor(window.windowEnd / AUTO_YES_OBSERVATION_GRID_MS) * AUTO_YES_OBSERVATION_GRID_MS;
  return { start: end - (window.windowEnd - window.windowStart), end };
}

export function measureAutoYesObservation(
  samples: AutoYesObservationSamples,
  window: { windowStart: number; windowEnd: number }
): MetricMeasurement {
  const { start: s, end: e } = autoYesObservationWindow(window);
  const windowMs = e - s;
  const lines = samples.lines
    .filter((line) => line.atMs >= s && line.atMs <= e)
    .sort(
      (a, b) =>
        a.atMs - b.atMs ||
        (EVENT_RANK.get(a.event) ?? 0) - (EVENT_RANK.get(b.event) ?? 0) ||
        (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0)
    );
  const alive = lines.filter((line) => line.event === EV.alive);

  // ── coverage (design §4.4, §6.4) ──
  const spansByPath = new Map<string, Array<[number, number]>>(AUTO_YES_LEDGER_PATHS.map((path) => [path, []]));
  for (const line of alive) {
    const segments = Array.isArray(line.data.segments) ? (line.data.segments as unknown[]) : [];
    for (const segment of segments) {
      if (typeof segment !== 'object' || segment === null) continue;
      const { path, startMs, endMs } = segment as Record<string, unknown>;
      const spans = typeof path === 'string' ? spansByPath.get(path) : undefined;
      const from = num(startMs);
      const to = num(endMs);
      if (spans === undefined || from === null || to === null) continue;
      spans.push([Math.max(from, s), Math.min(to, e)]);
    }
  }
  const coveredByPath = AUTO_YES_LEDGER_PATHS.map((path) => [path, unionMs(spansByPath.get(path) ?? [])] as const);
  const coveredMs = Math.max(...coveredByPath.map(([, ms]) => ms));
  // An `alive` line stands for the span before it: one on the window's first
  // boundary (or none at all) measured nothing inside the window.
  if (coveredMs === 0) {
    return {
      metricId: 'auto-yes-observation',
      status: 'skip',
      reason: '窓の中に Auto-Yes の記録の計測区間が無い（生存の行 auto-yes-ledger-alive が窓の中を覆っていない。計測なし。0 件とは扱わない）',
    };
  }
  const pathsMissing = coveredByPath.filter(([, ms]) => ms < coveredMs || ms === 0).map(([path]) => path);

  // ── errors the ledger swallowed inside the window, per process ──
  const startedBoots = new Set(lines.filter((line) => line.event === EV.started).map((line) => str(line.data.bootId)));
  const errorsByBoot = new Map<string | null, { first: number; last: number }>();
  for (const line of alive) {
    const boot = str(line.data.bootId);
    const errors = num(line.data.ledgerErrors) ?? 0;
    const seen = errorsByBoot.get(boot);
    if (seen === undefined) errorsByBoot.set(boot, { first: startedBoots.has(boot) ? 0 : errors, last: errors });
    else seen.last = errors;
  }
  let ledgerErrors = 0;
  for (const { first, last } of errorsByBoot.values()) ledgerErrors += Math.max(0, last - first);

  // ── one pass over the lines ──
  const seen = new Set<string>();
  const closed = new Set<string>();
  const openAtEnd = new Set<string>();
  const intervals = new Map<string, Interval>();
  const resolutions = new Map<string, number>();
  const resolvedBy = new Map<string, number>();
  const attempts = new Map<string, number>();
  let attemptsLate = 0;
  let answered = 0;
  let answeredLate = 0;
  const answeredRecords = new Map<string, MetricRecord>();
  const attemptRecords = new Map<string, MetricRecord>();
  const abstainRecords = new Map<string, MetricRecord>();
  let hookRequests = 0;
  let hookAllowed = 0;
  let hookAbstained = 0;
  const dialogUnobserved = new Set<string>();
  const identified = new Map<string, string>();
  const modes = new Map<string, { tool: string; mode: string; instance: string }>();
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  const identify = (data: Record<string, unknown>) => {
    const worktreeId = str(data.worktreeId);
    const instanceId = str(data.instanceId);
    if (worktreeId !== null && instanceId !== null) identified.set(`${worktreeId}\u0000${instanceId}`, toolOf(data));
  };

  for (const { event, atMs, data } of lines) {
    const confirmationId = str(data.confirmationId);
    const late = event === EV.attemptSettled && data.late === true;
    if (confirmationId !== null && !late) seen.add(confirmationId);
    const intervalId = str(data.intervalId);
    if (intervalId !== null && confirmationId !== null) {
      const interval = intervals.get(intervalId) ?? {
        confirmationId,
        tool: toolOf(data),
        endedStart: null,
        startedStart: null,
        checkpointStart: null,
        endedAt: null,
        lastAt: atMs,
        reason: OTHER,
        endedReason: null,
        reasonChanged: false,
      };
      intervals.set(intervalId, interval);
      interval.lastAt = Math.max(interval.lastAt, atMs);
      if (event === EV.withholdStarted) {
        interval.startedStart = num(data.startedAtMs) ?? atMs;
        interval.reason = reasonOf(data.reason);
      } else if (event === EV.withholdReasonChanged) {
        interval.reasonChanged = true;
        interval.reason = reasonOf(data.to);
      } else if (event === EV.checkpoint) {
        interval.checkpointStart ??= num(data.intervalStartedAtMs);
        interval.reason = reasonOf(data.reason);
      } else if (event === EV.withholdEnded) {
        interval.endedStart = num(data.startedAtMs);
        interval.endedAt = num(data.endedAtMs) ?? atMs;
        interval.endedReason = reasonOf(data.lastReason);
      }
    }
    switch (event) {
      case EV.opened:
        identify(data);
        break;
      case EV.checkpoint:
        if (confirmationId !== null && atMs === e) openAtEnd.add(confirmationId);
        break;
      case EV.closed: {
        identify(data);
        if (confirmationId !== null) closed.add(confirmationId);
        bump(resolutions, known(data.resolution, CONFIRMATION_RESOLUTIONS));
        bump(resolvedBy, known(data.resolvedBy, CONFIRMATION_RESOLVED_BY));
        if (data.answeredAtClose === true) {
          answered++;
          const tool = toolOf(data);
          const basis = basisOf(data.basis);
          increment(answeredRecords, `${tool}\u0000${basis}`, () => ({ kind: 'answered', tool, basis, count: 0 }));
        }
        break;
      }
      case EV.attemptSettled: {
        const tool = toolOf(data);
        const basis = basisOf(data.basis);
        const result = known(data.result, ATTEMPT_RESULTS);
        bump(attempts, result);
        if (late) {
          attemptsLate++;
          if (result === 'ok') answeredLate++;
        }
        increment(attemptRecords, `${tool}\u0000${basis}\u0000${result}`, () => ({ kind: 'attempt', tool, basis, result, count: 0 }));
        break;
      }
      case EV.hookRequestClosed: {
        hookRequests++;
        if (data.outcome === 'allow') hookAllowed++;
        else if (data.outcome === 'abstained') {
          hookAbstained++;
          const tool = toolOf(data);
          const reason = known(data.abstainReason, HOOK_ABSTAIN_REASONS);
          increment(abstainRecords, `${tool}\u0000${reason}`, () => ({ kind: 'hook-abstained', tool, reason, count: 0 }));
        }
        const hookRequestId = str(data.hookRequestId);
        if (data.dialogUnobserved === true && hookRequestId !== null) dialogUnobserved.add(hookRequestId);
        break;
      }
      case EV.hookRequestDialogUnobserved: {
        const hookRequestId = str(data.hookRequestId);
        if (hookRequestId !== null) dialogUnobserved.add(hookRequestId);
        break;
      }
      case EV.cliModeObserved: {
        identify(data);
        const worktreeId = str(data.worktreeId);
        const instanceId = str(data.instanceId);
        if (worktreeId === null || instanceId === null) break;
        const instance = `${worktreeId}\u0000${instanceId}`;
        // The latest mode of each session epoch: the lines are in time order.
        modes.set(`${instance}\u0000${num(data.sessionEpoch) ?? ''}`, {
          tool: toolOf(data),
          mode: known(data.mode, CLI_PERMISSION_MODES),
          instance,
        });
        break;
      }
    }
  }

  // ── withheld time cut to the window, interval by interval (design §4.3) ──
  const withheldRecords = new Map<string, MetricRecord>();
  const lengths: number[] = [];
  const withheldConfirmations = new Set<string>();
  let withheldIntervalsUntimed = 0;
  for (const interval of intervals.values()) {
    const reason = interval.endedReason ?? interval.reason;
    const record = withheldRecords.get(`${interval.tool}\u0000${reason}`) ?? {
      kind: 'withheld',
      tool: interval.tool,
      reason,
      intervals: 0,
      totalMs: 0,
      maxMs: 0,
      reasonChanged: 0,
      untimed: 0,
    };
    withheldConfirmations.add(interval.confirmationId);
    if (interval.reasonChanged) record.reasonChanged = (record.reasonChanged as number) + 1;
    const start = interval.endedStart ?? interval.startedStart ?? interval.checkpointStart;
    if (start === null) {
      // Only a `withhold-reason-changed` line, which has no start: the time is
      // unknown, so it is counted and not timed — never timed from `s`.
      withheldIntervalsUntimed++;
      record.untimed = (record.untimed as number) + 1;
      withheldRecords.set(`${interval.tool}\u0000${reason}`, record);
      continue;
    }
    const end = interval.endedAt ?? interval.lastAt;
    const ms = Math.max(0, Math.min(end, e) - Math.max(start, s));
    lengths.push(ms);
    record.intervals = (record.intervals as number) + 1;
    record.totalMs = (record.totalMs as number) + ms;
    record.maxMs = Math.max(record.maxMs as number, ms);
    withheldRecords.set(`${interval.tool}\u0000${reason}`, record);
  }
  const withheldMsTotal = lengths.reduce((sum, ms) => sum + ms, 0);
  const stat = (p: number | 'max'): number | null =>
    lengths.length === 0 ? null : p === 'max' ? Math.max(...lengths) : percentile(lengths, p);

  // ── open at the end, or lost: a confirmation neither closed nor in the last checkpoint ──
  let openAtWindowEnd = 0;
  let lostOnRestart = 0;
  for (const id of seen) {
    if (closed.has(id)) continue;
    if (openAtEnd.has(id)) openAtWindowEnd++;
    else lostOnRestart++;
  }

  // ── the CLI's own permission mode, as far as it was observed (design §3.4) ──
  const modeRecords = new Map<string, MetricRecord>();
  const observedInstances = new Set<string>();
  for (const { tool, mode, instance } of modes.values()) {
    observedInstances.add(instance);
    increment(modeRecords, `${tool}\u0000${mode}`, () => ({ kind: 'cli-mode', tool, mode, instances: 0 }), 'instances');
  }
  let unknownInstances = 0;
  for (const [instance, tool] of identified) {
    if (observedInstances.has(instance)) continue;
    unknownInstances++;
    increment(modeRecords, `${tool}\u0000unknown`, () => ({ kind: 'cli-mode', tool, mode: 'unknown', instances: 0 }), 'instances');
  }

  const partial = pathsMissing.length > 0 || coveredMs < windowMs || ledgerErrors > 0;
  const count = (map: Map<string, number>, key: string) => map.get(key) ?? 0;
  const withheldMinutes = Math.round((withheldMsTotal / 60_000) * 10) / 10;
  const attemptsFailedTotal = count(attempts, 'partial') + count(attempts, 'no-keys-sent') + count(attempts, 'failed');
  return {
    metricId: 'auto-yes-observation',
    status: 'ok',
    value: withheldMinutes,
    items: { withheldMinutes, confirmations: seen.size, answered, attemptsFailedTotal },
    findings: {},
    details: {
      windowMs,
      coveredMs,
      gapMs: windowMs - coveredMs,
      coveredMsByPath: coveredByPath.map(([path, ms]) => `${path} ${ms}`).join(' / '),
      partial: partial ? 1 : 0,
      pathsMissing: pathsMissing.join(','),
      ledgerErrors,
      confirmations: seen.size,
      confirmationsClosed: closed.size,
      openAtWindowEnd,
      lostOnRestart,
      answered,
      answeredLate,
      attemptsOk: count(attempts, 'ok'),
      attemptsPartial: count(attempts, 'partial'),
      attemptsNoKeysSent: count(attempts, 'no-keys-sent'),
      attemptsFailed: count(attempts, 'failed'),
      attemptsLate,
      resolvedAfterAnswer: count(resolutions, 'resolved-after-answer'),
      resolvedWhileWithheld: count(resolutions, 'resolved-while-withheld'),
      resolvedByReply: count(resolutions, 'resolved-by-reply'),
      resolvedBeforeDecision: count(resolutions, 'resolved-before-decision'),
      unresolvedAfterSend: count(resolutions, 'unresolved-after-send'),
      goneWhileUnobservable: count(resolutions, 'gone-while-unobservable'),
      abandoned: count(resolutions, 'abandoned'),
      resolvedByAuto: count(resolvedBy, 'auto'),
      resolvedByHumanUi: count(resolvedBy, 'human-ui'),
      resolvedByUnknown: count(resolvedBy, 'unknown'),
      withheldConfirmations: withheldConfirmations.size,
      withheldIntervals: lengths.length,
      withheldIntervalsUntimed,
      withheldMsTotal,
      withheldMsMedian: stat(50),
      withheldMsP90: stat(90),
      withheldMsMax: stat('max'),
      hookRequests,
      hookAllowed,
      hookAbstained,
      dialogUnobserved: dialogUnobserved.size,
      cliModeObserved: observedInstances.size,
      cliModeUnknownInstances: identified.size === 0 ? null : unknownInstances,
    },
    records: [
      ...sortedRecords(answeredRecords),
      ...sortedRecords(attemptRecords),
      ...sortedRecords(withheldRecords),
      ...sortedRecords(abstainRecords),
      ...sortedRecords(modeRecords),
    ],
  };
}

/** One line for the report's `summary` (design §6.2). */
export function autoYesObservationSummary(details: Record<string, number | string | null> | undefined): string {
  const d = details ?? {};
  const n = (value: number | string | null | undefined) => (typeof value === 'number' ? value : 0);
  const hours = (ms: number) => Math.round((ms / AUTO_YES_OBSERVATION_GRID_MS) * 10) / 10;
  const minutes = Math.round((n(d.withheldMsTotal) / 60_000) * 10) / 10;
  const failures = n(d.attemptsPartial) + n(d.attemptsNoKeysSent) + n(d.attemptsFailed);
  return (
    `停止 ${minutes}m（確認 ${n(d.withheldConfirmations)} 件・区間 ${n(d.withheldIntervals)}）／` +
    `回答 ${n(d.answered)}（試行の失敗 ${failures}）／計測 ${hours(n(d.coveredMs))}h/${hours(n(d.windowMs))}h` +
    (d.partial === 1 ? '・部分計測' : '')
  );
}
