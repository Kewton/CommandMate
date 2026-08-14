/**
 * Remembering which model an instance is on (Issue #1783).
 *
 * `lastAgentEvent` holds one record and is replaced wholesale on every delivery.
 * claude reports its model on `SessionStart` and on nothing else, so
 * `getLastAgentEvent()?.model` is null for all but the first few hundred
 * milliseconds of a session — the display would show the model, then lose it the
 * instant anybody typed. {@link getLastKnownAgentModel} exists because of that,
 * and this suite is the proof that it actually latches rather than merely
 * compiling.
 *
 * The state here lives on `globalThis` and CI runs with `fileParallelism:
 * false`, so every suite in the repo shares this process. `clearAgentStopEvents`
 * runs before AND after each test: a model latched here and read by an unrelated
 * suite would be a failure that only reproduces in CI, in file order.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginAgentEventGeneration,
  clearAgentStopEvents,
  discardAgentEventState,
  getLastAgentEvent,
  getLastKnownAgentModel,
  recordAgentEvent,
} from '@/lib/session/agent-event-state';
import { MAX_EVENT_DETAIL_LENGTH } from '@/lib/hooks/agent-event-types';

const WT = 'wt-1783';
const NOW = 1_800_000_000_000;

beforeEach(() => {
  clearAgentStopEvents();
});

afterEach(() => {
  clearAgentStopEvents();
});

/** One delivery, with only the fields these assertions turn on. */
function deliver(
  event: Parameters<typeof recordAgentEvent>[3]['event'],
  model: string | null,
  at: number,
  instanceId = 'claude'
): void {
  recordAgentEvent(WT, 'claude', instanceId, {
    event,
    at,
    detail: null,
    sessionId: 'ses-1',
    model,
  });
}

describe('the latch', () => {
  it('answers null before anything has been reported', () => {
    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toBeNull();
  });

  it('survives the claude sequence that has no model after the first event', () => {
    // The exact列 named in the Issue's acceptance criteria: claude sends the
    // model on SessionStart and then goes quiet about it forever.
    deliver('session_start', 'claude-opus-5[1m]', NOW);
    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toBe('claude-opus-5[1m]');

    deliver('user_prompt_submit', null, NOW + 1_000);
    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toBe('claude-opus-5[1m]');

    deliver('stop', null, NOW + 2_000);
    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toBe('claude-opus-5[1m]');

    // …while the record itself has moved on, which is exactly why a separate
    // map was needed. Reading the model off the newest event answers null here.
    expect(getLastAgentEvent(WT, 'claude', 'claude')?.event).toBe('stop');
    expect(getLastAgentEvent(WT, 'claude', 'claude')?.model ?? null).toBeNull();
  });

  it('takes the newest non-null value when the agent switches model', () => {
    deliver('session_start', 'claude-opus-5[1m]', NOW);
    deliver('session_start', 'claude-sonnet-5', NOW + 5_000);
    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toBe('claude-sonnet-5');
  });

  it('treats an omitted field and an empty string the same as null', () => {
    deliver('session_start', 'codex-model', NOW);
    recordAgentEvent(WT, 'claude', 'claude', {
      event: 'stop',
      at: NOW + 1,
      detail: null,
      sessionId: 'ses-1',
    });
    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toBe('codex-model');

    deliver('stop', '', NOW + 2);
    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toBe('codex-model');
  });

  it('bounds what it stores, independently of the extraction layer', () => {
    // The normaliser already bounds it, but `recordAgentEvent` is a public
    // entry point that a caller could reach with anything.
    deliver('session_start', 'm'.repeat(4096), NOW);
    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toHaveLength(MAX_EVENT_DETAIL_LENGTH);
  });
});

describe('scoping', () => {
  it('keys by (worktree, tool, instance) like everything else in this module', () => {
    deliver('session_start', 'model-primary', NOW, 'claude');
    deliver('session_start', 'model-alias', NOW, 'claude-2');

    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toBe('model-primary');
    expect(getLastKnownAgentModel(WT, 'claude', 'claude-2')).toBe('model-alias');
    expect(getLastKnownAgentModel('other-wt', 'claude', 'claude')).toBeNull();
    expect(getLastKnownAgentModel(WT, 'codex', 'codex')).toBeNull();
  });

  it('defaults to the primary instance when instanceId is omitted', () => {
    deliver('session_start', 'model-primary', NOW, 'claude');
    expect(getLastKnownAgentModel(WT, 'claude')).toBe('model-primary');
  });
});

describe('when the value is dropped', () => {
  it('keeps the model across a /clear, which is session_end + session_start', () => {
    // `/clear` ends the agent session and opens a new one in the same pane
    // (#1721 §1.1). It reaches this module as two ordinary events, never as a
    // generation call — so the model must ride through the gap between them.
    deliver('session_start', 'claude-opus-5[1m]', NOW);
    deliver('session_end', null, NOW + 1_000);
    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toBe('claude-opus-5[1m]');

    deliver('session_start', 'claude-opus-5[1m]', NOW + 1_100);
    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toBe('claude-opus-5[1m]');
  });

  it('drops it when a new generation opens — that is a different process', () => {
    deliver('session_start', 'claude-opus-5[1m]', NOW);
    beginAgentEventGeneration(WT, 'claude', 'claude', NOW + 10_000);
    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toBeNull();
  });

  it('drops it when the session is discarded', () => {
    deliver('session_start', 'claude-opus-5[1m]', NOW);
    discardAgentEventState(WT, 'claude', 'claude');
    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toBeNull();
  });

  it('is cleared by the test seam, so nothing leaks between suites', () => {
    deliver('session_start', 'claude-opus-5[1m]', NOW);
    clearAgentStopEvents();
    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toBeNull();
  });

  it('is NOT expired by age, unlike the status verdict', () => {
    // Deliberate: `STRUCTURED_STATE_MAX_AGE_MS` bounds a claim about *right
    // now* that a lost `Stop` could leave stuck. An eight-hour turn is on the
    // same model at the end as at the start, so expiring here would blank the
    // display on precisely the sessions this is most useful for.
    deliver('session_start', 'claude-opus-5[1m]', NOW - 24 * 60 * 60 * 1000);
    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toBe('claude-opus-5[1m]');
  });
});

describe('the module is reached through globalThis (#1736)', () => {
  it('writes into the shared map rather than a per-bundle module-scoped one', async () => {
    // The silent failure #1736 documents: under `next dev` each route handler is
    // bundled separately, so a bare `const … = new Map()` is one map per bundle
    // and the reader looks in a different one than the writer wrote to. Nothing
    // errors; the field is simply always null.
    deliver('session_start', 'claude-opus-5[1m]', NOW);
    expect(globalThis.__agentEventLastModel).toBeInstanceOf(Map);
    expect([...(globalThis.__agentEventLastModel?.values() ?? [])]).toContain(
      'claude-opus-5[1m]'
    );

    const reimported = await import('@/lib/session/agent-event-state');
    expect(reimported.getLastKnownAgentModel(WT, 'claude', 'claude')).toBe('claude-opus-5[1m]');
  });
});
