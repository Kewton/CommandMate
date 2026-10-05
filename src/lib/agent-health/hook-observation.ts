/**
 * Hook observation from the production log (Issue #3311). Pure: parsed log
 * lines in, one {@link MetricMeasurement} out. The lines are read once for the
 * performance metrics (`metrics-perf.ts` `addLogLine`), which hands this
 * module the ones it wants.
 *
 * Observation only: the measurement has no findings and no subjects, its
 * category is `process` (never fails) and nothing here becomes a candidate or
 * an Issue. Deciding what should — after two weeks of these numbers — is a
 * separate Issue.
 *
 * Two things are measured:
 *
 *  - **Drops that were not copies.** `agent-event-duplicate-dropped` is the
 *    receiver dropping an event as a repeat of one it applied inside the
 *    window. Most are copies (a second hook delivering the same event a few ms
 *    later); #3289 and #3301 were not — a second turn's `stop` or start the
 *    window swallowed.
 *  - **How long the screen and the agent disagreed.** One
 *    `detection-divergence-resolved` line per disagreement, with its length.
 *
 * The repository is public, so the details carry counts, durations and event
 * names only. The worktree, instance and (hashed) session ids on the lines are
 * used to pair lines up and are never copied out.
 */

import type { ParsedLogLine } from './metrics-perf';
import type { MetricMeasurement } from './metrics-types';

/** The events that open or continue a turn — `src/lib/session/provisional-turn.ts` TURN_ACTIVITY_EVENTS. */
const TURN_ACTIVITY_EVENTS: ReadonlySet<string> = new Set(['user_prompt_submit', 'pre_tool_use', 'post_tool_use']);
/** Event names that may be published (the same vocabulary as `metrics-perf.ts`). */
const SAFE_EVENT = /^[A-Za-z0-9_.:-]{1,80}$/;

const DROPPED = 'agent-event-duplicate-dropped';
const RECEIVED = 'agent-event-received';
const STOP_APPLIED = 'agent-event-stop-applied';
const DIVERGENCE = 'detection-divergence';
const DIVERGENCE_RESOLVED = 'detection-divergence-resolved';

interface Drop {
  time: number;
  target: string;
  event: string;
  /** null on a line written before #3311 (no interval to judge by). */
  sinceLastMs: number | null;
}

export interface HookObservationSamples {
  drops: Drop[];
  /** target → times an applied turn-activity event was logged. */
  turnActivity: Map<string, number[]>;
  /** target → times an applied `stop` was logged. */
  stops: Map<string, number[]>;
  divergenceLines: number;
  divergenceDurations: number[];
}

export function createHookObservationSamples(): HookObservationSamples {
  return { drops: [], turnActivity: new Map(), stops: new Map(), divergenceLines: 0, divergenceDurations: [] };
}

function eventOf(name: string): string {
  return name.slice(name.indexOf(' ') + 1);
}

function dataOf(line: ParsedLogLine): Record<string, unknown> | null {
  if (line.data === null) return null;
  try {
    const json: unknown = JSON.parse(line.data);
    return typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Worktree, tool and instance — the unit one dedup window belongs to. A line
 * with no `instanceId` is the tool's primary instance, as the receiver reads it.
 */
function targetOf(data: Record<string, unknown>, toolField: 'tool' | 'cliToolId'): string | null {
  const worktreeId = str(data.worktreeId);
  const tool = str(data[toolField]);
  if (worktreeId === null || tool === null) return null;
  return `${worktreeId}\u0000${tool}\u0000${str(data.instanceId) ?? tool}`;
}

function push(map: Map<string, number[]>, key: string, time: number): void {
  const list = map.get(key);
  if (list) list.push(time);
  else map.set(key, [time]);
}

/** Take one in-window line; lines this module does not read are ignored. */
export function addHookObservationLine(samples: HookObservationSamples, line: ParsedLogLine): void {
  const event = eventOf(line.name);
  if (event === DIVERGENCE) {
    samples.divergenceLines++;
    return;
  }
  if (event !== DROPPED && event !== RECEIVED && event !== STOP_APPLIED && event !== DIVERGENCE_RESOLVED) return;
  const data = dataOf(line);
  if (data === null) return;
  if (event === DIVERGENCE_RESOLVED) {
    const duration = finiteNumber(data.durationMs);
    if (duration !== null) samples.divergenceDurations.push(duration);
    return;
  }
  const target = targetOf(data, 'tool');
  if (target === null) return;
  if (event === STOP_APPLIED) {
    push(samples.stops, target, line.time);
    return;
  }
  const agentEvent = str(data.event);
  if (agentEvent === null) return;
  if (event === RECEIVED) {
    if (TURN_ACTIVITY_EVENTS.has(agentEvent)) push(samples.turnActivity, target, line.time);
    return;
  }
  samples.drops.push({ time: line.time, target, event: agentEvent, sinceLastMs: finiteNumber(data.sinceLastMs) });
}

/**
 * THE rule for "this drop was not a copy" (Issue #3311), and the only one:
 *
 *   On the same worktree, tool and instance, the other side of a turn boundary
 *   was applied after the delivery the drop repeats (its time minus
 *   `sinceLastMs`) and no later than the drop. For a dropped `stop` the other
 *   side is an applied turn-activity event (`agent-event-received` of
 *   `user_prompt_submit` / `pre_tool_use` / `post_tool_use`); for a dropped
 *   turn-activity event it is an applied `stop` (`agent-event-stop-applied`).
 *
 * A turn ended or began between the two deliveries, so the second one belongs
 * to another turn — #3289 (`stop`, a start 140 ms later, a `stop` dropped
 * 1.4 s after the first) and #3301 (a start, its `stop`, the next start
 * dropped 22 ms after that `stop`). A copy a few ms behind has nothing between.
 * The interval alone cannot decide it: a late re-delivery can exceed 100 ms.
 *
 * Not counted either way: drops of other events (`notification`,
 * `session_start`, …), which have no turn boundary to look for, and lines from
 * before #3311 with no `sinceLastMs` (counted as `duplicateDroppedUncorrelated`).
 *
 * Known limit: a boundary is matched by its log line's time, and a `stop` is
 * logged once its task bookkeeping is done, a few ms after it was received. A
 * `stop` received just before the applied start but logged after it would be
 * read as between the start and its copy.
 */
export function isNotCopy(drop: Drop, samples: HookObservationSamples): boolean {
  if (drop.sinceLastMs === null) return false;
  const boundaries =
    drop.event === 'stop'
      ? samples.turnActivity.get(drop.target)
      : TURN_ACTIVITY_EVENTS.has(drop.event)
        ? samples.stops.get(drop.target)
        : undefined;
  if (!boundaries) return false;
  const previous = drop.time - drop.sinceLastMs;
  return boundaries.some((time) => time > previous && time <= drop.time);
}

/** Nearest-rank percentile, rounded to whole ms (the same as `metrics-perf.ts`). */
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
}

export function measureHookObservation(samples: HookObservationSamples): Extract<MetricMeasurement, { status: 'ok' }> {
  let correlated = 0;
  const notCopyByEvent: Record<string, number> = {};
  for (const drop of samples.drops) {
    if (drop.sinceLastMs === null) continue;
    correlated++;
    if (!isNotCopy(drop, samples)) continue;
    const name = SAFE_EVENT.test(drop.event) ? drop.event : '(other)';
    notCopyByEvent[name] = (notCopyByEvent[name] ?? 0) + 1;
  }
  const notCopy = Object.values(notCopyByEvent).reduce((sum, n) => sum + n, 0);
  const durations = samples.divergenceDurations;
  const stat = (p: number | 'max'): number | null =>
    durations.length === 0 ? null : p === 'max' ? Math.round(Math.max(...durations)) : percentile(durations, p);
  return {
    metricId: 'hook-observation',
    status: 'ok',
    value: notCopy,
    items: {
      duplicateDroppedNotCopy: notCopy,
      divergenceEpisodes: durations.length,
    },
    findings: {},
    details: {
      duplicateDropped: samples.drops.length,
      duplicateDroppedUncorrelated: samples.drops.length - correlated,
      duplicateDroppedCopy: correlated - notCopy,
      duplicateDroppedNotCopy: notCopy,
      duplicateDroppedNotCopyEvents: Object.entries(notCopyByEvent)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([event, count]) => `${event} ${count}`)
        .join(' / '),
      divergenceLines: samples.divergenceLines,
      divergenceEpisodes: durations.length,
      divergenceMedianMs: stat(50),
      divergenceP90Ms: stat(90),
      divergenceMaxMs: stat('max'),
    },
  };
}

/** One line for the report's `summary`. */
export function hookObservationSummary(details: Record<string, number | string | null> | undefined): string {
  const d = details ?? {};
  const ms = (value: number | string | null | undefined) => (typeof value === 'number' ? `${value.toLocaleString('en-US')}ms` : '-');
  return (
    `重複として捨てた hook ${d.duplicateDropped ?? 0} 件（写しでない ${d.duplicateDroppedNotCopy ?? 0}・写し ${d.duplicateDroppedCopy ?? 0}・` +
    `判定できない ${d.duplicateDroppedUncorrelated ?? 0}）、画面と申告の食い違い ${d.divergenceEpisodes ?? 0} 回` +
    `（中央値 ${ms(d.divergenceMedianMs)}・p90 ${ms(d.divergenceP90Ms)}・最大 ${ms(d.divergenceMaxMs)}、行 ${d.divergenceLines ?? 0}）`
  );
}
