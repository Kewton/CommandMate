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
 *
 * Issue #3863: answers and withheld intervals are also counted by the Auto-Yes
 * answer mode their line names (`recommended` / `careful`). A line without
 * one — the hook and API paths, and every line written before the field — is
 * counted as `unknown`, never as either mode.
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
import { AUTO_YES_ANSWER_MODES } from '@/types/auto-yes-answer-mode';
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
/** Issue #3863: the answer mode a line names, or `unknown` (absent, or not a mode this build knows). */
const answerModeOf = (value: unknown): AnswerModeKey =>
  typeof value === 'string' && (AUTO_YES_ANSWER_MODES as readonly string[]).includes(value)
    ? (value as AnswerModeKey)
    : 'unknown';
type AnswerModeKey = 'recommended' | 'careful' | 'unknown';

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
  /** Issue #3863: the answer mode its lines name (`unknown` until one does). */
  answerMode: AnswerModeKey;
}

/** The window `[start, end]`: the last completed grid boundary at or before `windowEnd`, and as long as the shared one. */
export function autoYesObservationWindow(window: { windowStart: number; windowEnd: number }): { start: number; end: number } {
  const end = Math.floor(window.windowEnd / AUTO_YES_OBSERVATION_GRID_MS) * AUTO_YES_OBSERVATION_GRID_MS;
  return { start: end - (window.windowEnd - window.windowStart), end };
}

/** The window's lines in time order (`EVENT_RANK`, then the JSON as written, break ties). */
function linesInWindow(samples: AutoYesObservationSamples, s: number, e: number): LedgerLine[] {
  return samples.lines
    .filter((line) => line.atMs >= s && line.atMs <= e)
    .sort(
      (a, b) =>
        a.atMs - b.atMs ||
        (EVENT_RANK.get(a.event) ?? 0) - (EVENT_RANK.get(b.event) ?? 0) ||
        (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0)
    );
}

interface Coverage {
  coveredByPath: ReadonlyArray<readonly [string, number]>;
  coveredMs: number;
  pathsMissing: string[];
}

/** The `[start, end]` spans one `alive` line's segments cover, per ledger path, cut to the window. */
function addAliveSpans(spansByPath: Map<string, Array<[number, number]>>, line: LedgerLine, s: number, e: number): void {
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

// ── coverage (design §4.4, §6.4) ──
function measureCoverage(alive: readonly LedgerLine[], s: number, e: number): Coverage {
  const spansByPath = new Map<string, Array<[number, number]>>(AUTO_YES_LEDGER_PATHS.map((path) => [path, []]));
  for (const line of alive) addAliveSpans(spansByPath, line, s, e);
  const coveredByPath = AUTO_YES_LEDGER_PATHS.map((path) => [path, unionMs(spansByPath.get(path) ?? [])] as const);
  const coveredMs = Math.max(...coveredByPath.map(([, ms]) => ms));
  const pathsMissing = coveredByPath.filter(([, ms]) => ms < coveredMs || ms === 0).map(([path]) => path);
  return { coveredByPath, coveredMs, pathsMissing };
}

// ── errors the ledger swallowed inside the window, per process ──
function countLedgerErrors(lines: readonly LedgerLine[], alive: readonly LedgerLine[]): number {
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
  return ledgerErrors;
}

/** What the one pass over the lines collects. */
interface LinePass {
  seen: Set<string>;
  closed: Set<string>;
  openAtEnd: Set<string>;
  intervals: Map<string, Interval>;
  resolutions: Map<string, number>;
  resolvedBy: Map<string, number>;
  attempts: Map<string, number>;
  attemptsLate: number;
  answered: number;
  answeredByHuman: number;
  answeredLate: number;
  answeredRecords: Map<string, MetricRecord>;
  /** Issue #3863: Auto-Yes's answers by answer mode. */
  answeredByMode: Map<AnswerModeKey, number>;
  /** Issue #3882: confirmation ID → the mode its first successful (non-late) attempt line named. */
  okAttemptMode: Map<string, AnswerModeKey>;
  attemptRecords: Map<string, MetricRecord>;
  abstainRecords: Map<string, MetricRecord>;
  hookRequests: number;
  hookAllowed: number;
  hookAbstained: number;
  dialogUnobserved: Set<string>;
  identified: Map<string, string>;
  modes: Map<string, { tool: string; mode: string; instance: string }>;
}

function createLinePass(): LinePass {
  return {
    seen: new Set<string>(),
    closed: new Set<string>(),
    openAtEnd: new Set<string>(),
    intervals: new Map<string, Interval>(),
    resolutions: new Map<string, number>(),
    resolvedBy: new Map<string, number>(),
    attempts: new Map<string, number>(),
    attemptsLate: 0,
    answered: 0,
    answeredByHuman: 0,
    answeredLate: 0,
    answeredRecords: new Map<string, MetricRecord>(),
    answeredByMode: new Map<AnswerModeKey, number>(),
    okAttemptMode: new Map<string, AnswerModeKey>(),
    attemptRecords: new Map<string, MetricRecord>(),
    abstainRecords: new Map<string, MetricRecord>(),
    hookRequests: 0,
    hookAllowed: 0,
    hookAbstained: 0,
    dialogUnobserved: new Set<string>(),
    identified: new Map<string, string>(),
    modes: new Map<string, { tool: string; mode: string; instance: string }>(),
  };
}

const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

function identify(pass: LinePass, data: Record<string, unknown>): void {
  const worktreeId = str(data.worktreeId);
  const instanceId = str(data.instanceId);
  if (worktreeId !== null && instanceId !== null) pass.identified.set(`${worktreeId}\u0000${instanceId}`, toolOf(data));
}

function applyIntervalEvent(interval: Interval, event: AutoYesLedgerEvent, atMs: number, data: Record<string, unknown>): void {
  // Issue #3863: the first line that names a mode decides it.
  if (interval.answerMode === 'unknown') interval.answerMode = answerModeOf(data.answerMode);
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

function trackInterval(pass: LinePass, line: LedgerLine, confirmationId: string | null): void {
  const { event, atMs, data } = line;
  const intervalId = str(data.intervalId);
  if (intervalId === null || confirmationId === null) return;
  const interval = pass.intervals.get(intervalId) ?? {
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
    answerMode: 'unknown',
  };
  pass.intervals.set(intervalId, interval);
  interval.lastAt = Math.max(interval.lastAt, atMs);
  applyIntervalEvent(interval, event, atMs, data);
}

function onClosed(pass: LinePass, data: Record<string, unknown>, confirmationId: string | null): void {
  identify(pass, data);
  if (confirmationId !== null) pass.closed.add(confirmationId);
  bump(pass.resolutions, known(data.resolution, CONFIRMATION_RESOLUTIONS));
  bump(pass.resolvedBy, known(data.resolvedBy, CONFIRMATION_RESOLVED_BY));
  if (data.answeredAtClose === true) {
    // A person's `/prompt-response` answer (basis `human`, #3820 PR 2) is a
    // confirmation answered, but not by Auto-Yes: counted apart, kept in
    // the records under its basis.
    if (data.basis === 'human') pass.answeredByHuman++;
    else {
      pass.answered++;
      // Issue #3863: by the mode of the send that answered it
      // (`answeredAnswerMode`) — not the last decision's, which a mode change
      // while the answered screen waits to be redrawn moves.
      // Issue #3882: a line without it (a legacy entry carried over a hot
      // reload, an old log) is never filled from `answerMode` (the last
      // decision's); only a successful attempt line with the same
      // confirmation ID that names a mode restores it, else it is unknown.
      const attemptMode = confirmationId === null ? undefined : pass.okAttemptMode.get(confirmationId);
      const mode = data.answeredAnswerMode !== undefined ? answerModeOf(data.answeredAnswerMode) : (attemptMode ?? 'unknown');
      pass.answeredByMode.set(mode, (pass.answeredByMode.get(mode) ?? 0) + 1);
    }
    const tool = toolOf(data);
    const basis = basisOf(data.basis);
    increment(pass.answeredRecords, `${tool}\u0000${basis}`, () => ({ kind: 'answered', tool, basis, count: 0 }));
  }
}

function onAttemptSettled(pass: LinePass, data: Record<string, unknown>, late: boolean): void {
  const attemptConfirmationId = str(data.confirmationId);
  if (!late && attemptConfirmationId !== null && data.result === 'ok' && !pass.okAttemptMode.has(attemptConfirmationId)) {
    const attemptMode = answerModeOf(data.answerMode);
    if (attemptMode !== 'unknown') pass.okAttemptMode.set(attemptConfirmationId, attemptMode);
  }
  const tool = toolOf(data);
  const basis = basisOf(data.basis);
  const result = known(data.result, ATTEMPT_RESULTS);
  bump(pass.attempts, result);
  if (late) {
    pass.attemptsLate++;
    if (result === 'ok') pass.answeredLate++;
  }
  increment(pass.attemptRecords, `${tool}\u0000${basis}\u0000${result}`, () => ({ kind: 'attempt', tool, basis, result, count: 0 }));
}

function onHookRequestClosed(pass: LinePass, data: Record<string, unknown>): void {
  pass.hookRequests++;
  if (data.outcome === 'allow') pass.hookAllowed++;
  else if (data.outcome === 'abstained') {
    pass.hookAbstained++;
    const tool = toolOf(data);
    const reason = known(data.abstainReason, HOOK_ABSTAIN_REASONS);
    increment(pass.abstainRecords, `${tool}\u0000${reason}`, () => ({ kind: 'hook-abstained', tool, reason, count: 0 }));
  }
  const hookRequestId = str(data.hookRequestId);
  if (data.dialogUnobserved === true && hookRequestId !== null) pass.dialogUnobserved.add(hookRequestId);
}

function onHookRequestDialogUnobserved(pass: LinePass, data: Record<string, unknown>): void {
  const hookRequestId = str(data.hookRequestId);
  if (hookRequestId !== null) pass.dialogUnobserved.add(hookRequestId);
}

function onCliModeObserved(pass: LinePass, data: Record<string, unknown>): void {
  identify(pass, data);
  const worktreeId = str(data.worktreeId);
  const instanceId = str(data.instanceId);
  if (worktreeId === null || instanceId === null) return;
  const instance = `${worktreeId}\u0000${instanceId}`;
  // The latest mode of each session epoch: the lines are in time order.
  pass.modes.set(`${instance}\u0000${num(data.sessionEpoch) ?? ''}`, {
    tool: toolOf(data),
    mode: known(data.mode, CLI_PERMISSION_MODES),
    instance,
  });
}

function applyLine(pass: LinePass, line: LedgerLine, e: number): void {
  const { event, atMs, data } = line;
  const confirmationId = str(data.confirmationId);
  const late = event === EV.attemptSettled && data.late === true;
  if (confirmationId !== null && !late) pass.seen.add(confirmationId);
  trackInterval(pass, line, confirmationId);
  switch (event) {
    case EV.opened:
      identify(pass, data);
      break;
    case EV.checkpoint:
      if (confirmationId !== null && atMs === e) pass.openAtEnd.add(confirmationId);
      break;
    case EV.closed:
      onClosed(pass, data, confirmationId);
      break;
    case EV.attemptSettled:
      onAttemptSettled(pass, data, late);
      break;
    case EV.hookRequestClosed:
      onHookRequestClosed(pass, data);
      break;
    case EV.hookRequestDialogUnobserved:
      onHookRequestDialogUnobserved(pass, data);
      break;
    case EV.cliModeObserved:
      onCliModeObserved(pass, data);
      break;
  }
}

// ── one pass over the lines ──
function passOverLines(lines: readonly LedgerLine[], e: number): LinePass {
  const pass = createLinePass();
  for (const line of lines) applyLine(pass, line, e);
  return pass;
}

interface Withheld {
  records: Map<string, MetricRecord>;
  lengths: number[];
  confirmations: Set<string>;
  untimed: number;
  /** Issue #3863: intervals by answer mode, timed or not. */
  byMode: Map<AnswerModeKey, number>;
}

function addWithheldInterval(withheld: Withheld, interval: Interval, s: number, e: number): void {
  const reason = interval.endedReason ?? interval.reason;
  withheld.byMode.set(interval.answerMode, (withheld.byMode.get(interval.answerMode) ?? 0) + 1);
  const record = withheld.records.get(`${interval.tool}\u0000${reason}`) ?? {
    kind: 'withheld',
    tool: interval.tool,
    reason,
    intervals: 0,
    totalMs: 0,
    maxMs: 0,
    reasonChanged: 0,
    untimed: 0,
  };
  withheld.confirmations.add(interval.confirmationId);
  if (interval.reasonChanged) record.reasonChanged = (record.reasonChanged as number) + 1;
  const start = interval.endedStart ?? interval.startedStart ?? interval.checkpointStart;
  if (start === null) {
    // Only a `withhold-reason-changed` line, which has no start: the time is
    // unknown, so it is counted and not timed — never timed from `s`.
    withheld.untimed++;
    record.untimed = (record.untimed as number) + 1;
    withheld.records.set(`${interval.tool}\u0000${reason}`, record);
    return;
  }
  const end = interval.endedAt ?? interval.lastAt;
  const ms = Math.max(0, Math.min(end, e) - Math.max(start, s));
  withheld.lengths.push(ms);
  record.intervals = (record.intervals as number) + 1;
  record.totalMs = (record.totalMs as number) + ms;
  record.maxMs = Math.max(record.maxMs as number, ms);
  withheld.records.set(`${interval.tool}\u0000${reason}`, record);
}

// ── withheld time cut to the window, interval by interval (design §4.3) ──
function measureWithheld(intervals: Map<string, Interval>, s: number, e: number): Withheld {
  const withheld: Withheld = {
    records: new Map<string, MetricRecord>(),
    lengths: [],
    confirmations: new Set<string>(),
    untimed: 0,
    byMode: new Map<AnswerModeKey, number>(),
  };
  for (const interval of intervals.values()) addWithheldInterval(withheld, interval, s, e);
  return withheld;
}

function withheldStat(lengths: readonly number[], p: number | 'max'): number | null {
  return lengths.length === 0 ? null : p === 'max' ? Math.max(...lengths) : percentile(lengths, p);
}

// ── open at the end, or lost: a confirmation neither closed nor in the last checkpoint ──
function countUnclosed(pass: LinePass): { openAtWindowEnd: number; lostOnRestart: number } {
  let openAtWindowEnd = 0;
  let lostOnRestart = 0;
  for (const id of pass.seen) {
    if (pass.closed.has(id)) continue;
    if (pass.openAtEnd.has(id)) openAtWindowEnd++;
    else lostOnRestart++;
  }
  return { openAtWindowEnd, lostOnRestart };
}

interface CliModes {
  records: Map<string, MetricRecord>;
  observedInstances: Set<string>;
  unknownInstances: number;
}

// ── the CLI's own permission mode, as far as it was observed (design §3.4) ──
function measureCliModes(pass: LinePass): CliModes {
  const modeRecords = new Map<string, MetricRecord>();
  const observedInstances = new Set<string>();
  for (const { tool, mode, instance } of pass.modes.values()) {
    observedInstances.add(instance);
    increment(modeRecords, `${tool}\u0000${mode}`, () => ({ kind: 'cli-mode', tool, mode, instances: 0 }), 'instances');
  }
  let unknownInstances = 0;
  for (const [instance, tool] of pass.identified) {
    if (observedInstances.has(instance)) continue;
    unknownInstances++;
    increment(modeRecords, `${tool}\u0000unknown`, () => ({ kind: 'cli-mode', tool, mode: 'unknown', instances: 0 }), 'instances');
  }
  return { records: modeRecords, observedInstances, unknownInstances };
}

interface Observed {
  windowMs: number;
  coverage: Coverage;
  ledgerErrors: number;
  pass: LinePass;
  withheld: Withheld;
  unclosed: { openAtWindowEnd: number; lostOnRestart: number };
  cliModes: CliModes;
}

function observationMeasurement({ windowMs, coverage, ledgerErrors, pass, withheld, unclosed, cliModes }: Observed): MetricMeasurement {
  const { coveredByPath, coveredMs, pathsMissing } = coverage;
  const { attempts, resolutions, resolvedBy, seen, answered } = pass;
  const lengths = withheld.lengths;
  const withheldMsTotal = lengths.reduce((sum, ms) => sum + ms, 0);
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
      confirmationsClosed: pass.closed.size,
      openAtWindowEnd: unclosed.openAtWindowEnd,
      lostOnRestart: unclosed.lostOnRestart,
      answered,
      answeredByHuman: pass.answeredByHuman,
      answeredLate: pass.answeredLate,
      attemptsOk: count(attempts, 'ok'),
      attemptsPartial: count(attempts, 'partial'),
      attemptsNoKeysSent: count(attempts, 'no-keys-sent'),
      attemptsFailed: count(attempts, 'failed'),
      attemptsLate: pass.attemptsLate,
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
      withheldConfirmations: withheld.confirmations.size,
      withheldIntervals: lengths.length,
      withheldIntervalsUntimed: withheld.untimed,
      withheldMsTotal,
      withheldMsMedian: withheldStat(lengths, 50),
      withheldMsP90: withheldStat(lengths, 90),
      withheldMsMax: withheldStat(lengths, 'max'),
      hookRequests: pass.hookRequests,
      hookAllowed: pass.hookAllowed,
      hookAbstained: pass.hookAbstained,
      dialogUnobserved: pass.dialogUnobserved.size,
      cliModeObserved: cliModes.observedInstances.size,
      cliModeUnknownInstances: pass.identified.size === 0 ? null : cliModes.unknownInstances,
      // Issue #3863: Auto-Yes's answers and withheld intervals by the answer
      // mode their lines name; `Unknown` is a line naming none (another path,
      // or written before the field).
      answeredRecommended: pass.answeredByMode.get('recommended') ?? 0,
      answeredCareful: pass.answeredByMode.get('careful') ?? 0,
      answeredAnswerModeUnknown: pass.answeredByMode.get('unknown') ?? 0,
      withheldIntervalsRecommended: withheld.byMode.get('recommended') ?? 0,
      withheldIntervalsCareful: withheld.byMode.get('careful') ?? 0,
      withheldIntervalsAnswerModeUnknown: withheld.byMode.get('unknown') ?? 0,
    },
    records: [
      ...sortedRecords(pass.answeredRecords),
      ...sortedRecords(pass.attemptRecords),
      ...sortedRecords(withheld.records),
      ...sortedRecords(pass.abstainRecords),
      ...sortedRecords(cliModes.records),
    ],
  };
}

export function measureAutoYesObservation(
  samples: AutoYesObservationSamples,
  window: { windowStart: number; windowEnd: number }
): MetricMeasurement {
  const { start: s, end: e } = autoYesObservationWindow(window);
  const windowMs = e - s;
  const lines = linesInWindow(samples, s, e);
  const alive = lines.filter((line) => line.event === EV.alive);
  const coverage = measureCoverage(alive, s, e);
  // An `alive` line stands for the span before it: one on the window's first
  // boundary (or none at all) measured nothing inside the window.
  if (coverage.coveredMs === 0) {
    return {
      metricId: 'auto-yes-observation',
      status: 'skip',
      reason: '窓の中に Auto-Yes の記録の計測区間が無い（生存の行 auto-yes-ledger-alive が窓の中を覆っていない。計測なし。0 件とは扱わない）',
    };
  }
  const ledgerErrors = countLedgerErrors(lines, alive);
  const pass = passOverLines(lines, e);
  const withheld = measureWithheld(pass.intervals, s, e);
  const unclosed = countUnclosed(pass);
  const cliModes = measureCliModes(pass);
  return observationMeasurement({ windowMs, coverage, ledgerErrors, pass, withheld, unclosed, cliModes });
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
