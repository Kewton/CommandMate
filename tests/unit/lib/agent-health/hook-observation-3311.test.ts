/**
 * Issue #3311: hook observation from the production log. The inputs replay the
 * kinds and intervals of the lines the 2026-10-02〜10-05 log had — #3289's
 * swallowed `stop`, #3301's swallowed turn start, and the `user_prompt_submit`
 * copies a few ms apart — in the format the receiver writes since this Issue.
 * Nothing else from those lines (ids, paths) is reproduced.
 */

import { describe, expect, it } from 'vitest';
import { addLogLine, createLogAggregate } from '@/lib/agent-health/metrics-perf';
import { hookObservationSummary, measureHookObservation } from '@/lib/agent-health/hook-observation';
import { evaluateMetric } from '@/lib/agent-health/metrics-rules';

const NOW = new Date('2026-10-05T21:30:00.000Z');
/** A base time inside the 24-hour window; every case offsets from it in ms. */
const BASE = NOW.getTime() - 2 * 60 * 60 * 1000;
const ROUTE = 'api/hooks-agent-event';
const WT = 'wt-secret-3311';
const SESSION_TAG = 'a1b2c3d4';

function line(afterMs: number, tag: string, event: string, data: Record<string, unknown>): string {
  return `[${new Date(BASE + afterMs).toISOString()}] [INFO] [${tag}] ${event} ${JSON.stringify(data)}`;
}

const received = (afterMs: number, event: string, instanceId = 'claude') =>
  line(afterMs, ROUTE, 'agent-event-received', { worktreeId: WT, tool: 'claude', instanceId, event, detail: null });
const stopApplied = (afterMs: number, instanceId = 'claude') =>
  line(afterMs, ROUTE, 'agent-event-stop-applied', { worktreeId: WT, tool: 'claude', instanceId, taskId: null });
const dropped = (afterMs: number, event: string, sinceLastMs: number | null, instanceId = 'claude') =>
  line(afterMs, ROUTE, 'agent-event-duplicate-dropped', {
    worktreeId: WT,
    tool: 'claude',
    instanceId,
    event,
    detail: null,
    session: SESSION_TAG,
    sinceLastMs,
  });

function measure(lines: readonly string[]) {
  const agg = createLogAggregate(NOW);
  for (const raw of lines) addLogLine(agg, raw);
  return measureHookObservation(agg.hook);
}

/** #3289: `stop` applied → `user_prompt_submit` 140 ms later → `stop` dropped 1.4 s after that. */
const SEQUENCE_3289 = [stopApplied(0), received(140, 'user_prompt_submit'), dropped(1540, 'stop', 1540)];

/** #3301: a turn start, its `stop` 2624 ms later, the next start dropped 22 ms after the `stop`. */
const SEQUENCE_3301 = [
  received(10_000, 'user_prompt_submit'),
  stopApplied(12_624),
  dropped(12_646, 'user_prompt_submit', 2646),
];

/** Copies: a `user_prompt_submit` delivered again 4-10 ms after it was applied. */
const COPIES = [
  received(20_000, 'user_prompt_submit'),
  dropped(20_004, 'user_prompt_submit', 4),
  dropped(20_009, 'user_prompt_submit', 9),
  received(30_000, 'user_prompt_submit'),
  dropped(30_010, 'user_prompt_submit', 10),
];

describe('hook-observation: drops that were not copies (Issue #3311)', () => {
  it('counts the #3289 sequence as a drop that was not a copy', () => {
    expect(measure(SEQUENCE_3289).details).toMatchObject({
      duplicateDropped: 1,
      duplicateDroppedNotCopy: 1,
      duplicateDroppedCopy: 0,
      duplicateDroppedNotCopyEvents: 'stop 1',
    });
  });

  it('counts the #3301 sequence as a drop that was not a copy', () => {
    expect(measure(SEQUENCE_3301).details).toMatchObject({
      duplicateDropped: 1,
      duplicateDroppedNotCopy: 1,
      duplicateDroppedNotCopyEvents: 'user_prompt_submit 1',
    });
  });

  it('does not count copies a few ms behind (control)', () => {
    const m = measure(COPIES);
    expect(m.details).toMatchObject({ duplicateDropped: 3, duplicateDroppedNotCopy: 0, duplicateDroppedCopy: 3 });
    expect(m).toMatchObject({ value: 0 });
  });

  it('counts all three kinds side by side in one day of log', () => {
    const m = measure([...SEQUENCE_3289, ...SEQUENCE_3301, ...COPIES]);
    expect(m).toMatchObject({ status: 'ok', value: 2, findings: {} });
    expect(m.details).toMatchObject({ duplicateDropped: 5, duplicateDroppedNotCopy: 2, duplicateDroppedCopy: 3 });
  });

  it('does not take a boundary on another instance of the same worktree', () => {
    const m = measure([stopApplied(0), received(140, 'user_prompt_submit', 'cc-2'), dropped(1540, 'stop', 1540)]);
    expect(m.details).toMatchObject({ duplicateDroppedNotCopy: 0, duplicateDroppedCopy: 1 });
  });

  it('does not take a boundary from before the applied delivery', () => {
    // The start came before the first stop, so nothing lies between the two stops.
    const m = measure([received(0, 'user_prompt_submit'), stopApplied(100), dropped(1540, 'stop', 1440)]);
    expect(m.details).toMatchObject({ duplicateDroppedNotCopy: 0, duplicateDroppedCopy: 1 });
  });

  it('cannot judge a line written before #3311 and says so', () => {
    const old = line(1540, ROUTE, 'agent-event-duplicate-dropped', { worktreeId: WT, tool: 'claude', event: 'stop' });
    const m = measure([stopApplied(0), received(140, 'user_prompt_submit'), old]);
    expect(m.details).toMatchObject({ duplicateDropped: 1, duplicateDroppedUncorrelated: 1, duplicateDroppedNotCopy: 0, duplicateDroppedCopy: 0 });
  });
});

describe('hook-observation: how long the screen and the agent disagreed (Issue #3311)', () => {
  const divergence = (afterMs: number) =>
    line(afterMs, 'current-output-builder', 'detection-divergence', { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' });
  const resolved = (afterMs: number, durationMs: number) =>
    line(afterMs, 'current-output-builder', 'detection-divergence-resolved', {
      worktreeId: WT,
      cliToolId: 'claude',
      instanceId: 'claude',
      durationMs,
      polls: 3,
    });

  it('reports the count and the median / p90 / maximum of the lengths', () => {
    const durations = [100, 200, 300, 400, 500, 600, 700, 800, 900, 10_000];
    const m = measure([divergence(0), divergence(1), ...durations.map((d, i) => resolved(i * 1000, d))]);
    expect(m.details).toMatchObject({
      divergenceLines: 2,
      divergenceEpisodes: 10,
      divergenceMedianMs: 500,
      divergenceP90Ms: 900,
      divergenceMaxMs: 10_000,
    });
  });

  it('leaves the distribution empty on a day with no disagreement', () => {
    expect(measure([]).details).toMatchObject({
      divergenceEpisodes: 0,
      divergenceMedianMs: null,
      divergenceP90Ms: null,
      divergenceMaxMs: null,
    });
  });
});

describe('hook-observation: observation only (Issue #3311)', () => {
  it('is never a candidate and never fails', () => {
    const m = measure([...SEQUENCE_3289, ...SEQUENCE_3301]);
    const result = evaluateMetric(m, null);
    expect(result).toMatchObject({ metricId: 'hook-observation', category: 'process', status: 'pass', candidates: [] });
    expect(result.outstanding).toBeUndefined();
    expect(result.summary).toBe(hookObservationSummary(m.details));
    expect(evaluateMetric(m, { measuredAt: NOW.toISOString(), value: 0, items: {} }).candidates).toEqual([]);
  });

  it('publishes no id from the lines it read', () => {
    const m = measure([...SEQUENCE_3289, ...SEQUENCE_3301, ...COPIES]);
    const text = JSON.stringify(evaluateMetric(m, null));
    expect(text).not.toContain(WT);
    expect(text).not.toContain(SESSION_TAG);
  });
});
