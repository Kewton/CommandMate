/**
 * `lastStopEventAt` — the hook's second opinion (Issue #1549).
 *
 * Phase 3-2 exposes the timestamp and changes no decision. The assertion that
 * matters most is therefore a negative one: recording a stop event must leave
 * `sessionStatus`, `isComplete` and every other field of the payload byte-for-
 * byte identical, so the string-analysis fallback is provably still in charge.
 * A test that only checked the new field would pass just as happily if the hook
 * had quietly started overriding the detector.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: (...args: unknown[]) => isRunning(...args) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1:claude'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import {
  AGENT_EVENT_DEDUP_WINDOW_MS,
  clearAgentStopEvents,
  getLastAgentEvent,
  getLastStopEventAt,
  getRecentEventKeyCount,
  isDuplicateAgentEvent,
  recordAgentEvent,
  recordAgentStopEvent,
} from '@/lib/session/agent-event-state';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';

const db = {} as Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  isRunning.mockResolvedValue(true);
  vi.mocked(captureSessionOutput).mockResolvedValue('some agent output\n> ');
});

describe('agent-event-state', () => {
  it('returns null until an event is recorded', () => {
    expect(getLastStopEventAt('wt-1', 'claude')).toBeNull();

    recordAgentStopEvent('wt-1', 'claude', 'claude', 1_700_000_000_000);

    expect(getLastStopEventAt('wt-1', 'claude')).toBe(1_700_000_000_000);
  });

  it('treats an omitted instance id and the tool id as the same instance', () => {
    recordAgentStopEvent('wt-1', 'claude', undefined, 111);

    expect(getLastStopEventAt('wt-1', 'claude', 'claude')).toBe(111);
    expect(getLastStopEventAt('wt-1', 'claude')).toBe(111);
  });

  it('keeps alias instances and other worktrees separate', () => {
    recordAgentStopEvent('wt-1', 'codex', 'codex-2', 222);

    expect(getLastStopEventAt('wt-1', 'codex', 'codex-2')).toBe(222);
    expect(getLastStopEventAt('wt-1', 'codex')).toBeNull();
    expect(getLastStopEventAt('wt-2', 'codex', 'codex-2')).toBeNull();
  });

  it('keeps only the most recent event', () => {
    recordAgentStopEvent('wt-1', 'claude', 'claude', 100);
    recordAgentStopEvent('wt-1', 'claude', 'claude', 200);

    expect(getLastStopEventAt('wt-1', 'claude')).toBe(200);
  });
});

describe('buildCurrentOutput exposure', () => {
  it('is null for a session whose agent has no hook wired up', async () => {
    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload).toHaveProperty('lastStopEventAt');
    expect(payload.lastStopEventAt).toBeNull();
  });

  it('surfaces the timestamp without disturbing anything else in the payload', async () => {
    const before = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    recordAgentStopEvent('wt-1', 'claude', 'claude', 1_700_000_000_000);
    const after = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(after.lastStopEventAt).toBe(1_700_000_000_000);
    // The detector's verdict is untouched: same frame in, same verdict out.
    expect({ ...after, lastStopEventAt: null }).toEqual({ ...before, lastStopEventAt: null });
    expect(after.sessionStatus).toBe(before.sessionStatus);
    expect(after.isComplete).toBe(before.isComplete);
  });

  it('surfaces the timestamp for a session that is no longer running', async () => {
    // The stopped-session early return is a separate construction of the
    // payload, and the field has to exist there too or a consumer reading it
    // sees `undefined` exactly when the agent has finished.
    isRunning.mockResolvedValue(false);
    recordAgentStopEvent('wt-1', 'claude', 'claude', 1_700_000_000_001);

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.isRunning).toBe(false);
    expect(payload.lastStopEventAt).toBe(1_700_000_000_001);
  });
});

describe('structured events of any kind (Issue #1722)', () => {
  it('returns null until something is recorded, then the latest record', () => {
    expect(getLastAgentEvent('wt-1', 'claude')).toBeNull();

    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'user_prompt_submit',
      at: 100,
      detail: null,
      sessionId: 'sess-1',
    });
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'notification',
      at: 200,
      detail: 'idle_prompt',
      sessionId: 'sess-1',
    });

    expect(getLastAgentEvent('wt-1', 'claude')).toEqual({
      event: 'notification',
      at: 200,
      detail: 'idle_prompt',
      sessionId: 'sess-1',
    });
  });

  it('keeps instances apart', () => {
    recordAgentEvent('wt-1', 'claude', 'claude-2', {
      event: 'stop',
      at: 300,
      detail: null,
      sessionId: null,
    });

    expect(getLastAgentEvent('wt-1', 'claude', 'claude-2')?.event).toBe('stop');
    expect(getLastAgentEvent('wt-1', 'claude')).toBeNull();
  });

  it('does not write lastStopEventAt, which belongs to the stop path', () => {
    // Two writers to one timestamp is how it starts disagreeing with the task
    // transition it is supposed to accompany.
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'stop',
      at: 400,
      detail: null,
      sessionId: null,
    });

    expect(getLastStopEventAt('wt-1', 'claude')).toBeNull();
  });
});

describe('duplicate suppression (Issue #1722)', () => {
  const dup = (session: string | null, at: number, event: AgentEventType = 'stop') =>
    isDuplicateAgentEvent('wt-1', 'claude', 'claude', event, session, at);

  it('suppresses the second delivery of one turn inside the window', () => {
    expect(dup('sess-1', 1000)).toBe(false);
    expect(dup('sess-1', 1000 + AGENT_EVENT_DEDUP_WINDOW_MS - 1)).toBe(true);
  });

  it('lets the same session through again once the window has passed', () => {
    expect(dup('sess-1', 1000)).toBe(false);
    expect(dup('sess-1', 1000 + AGENT_EVENT_DEDUP_WINDOW_MS)).toBe(false);
  });

  it('never suppresses an event with no session id', () => {
    expect(dup(null, 1000)).toBe(false);
    expect(dup(null, 1000)).toBe(false);
  });

  it('separates events, instances and worktrees', () => {
    expect(dup('sess-1', 1000)).toBe(false);
    expect(dup('sess-1', 1000, 'user_prompt_submit')).toBe(false);
    expect(isDuplicateAgentEvent('wt-1', 'claude', 'claude-2', 'stop', 'sess-1', 1000)).toBe(false);
    expect(isDuplicateAgentEvent('wt-2', 'claude', 'claude', 'stop', 'sess-1', 1000)).toBe(false);
  });

  it('is cleared with the rest of the state', () => {
    expect(dup('sess-1', 1000)).toBe(false);
    clearAgentStopEvents();
    expect(dup('sess-1', 1000)).toBe(false);
  });

  it('does not grow without bound as sessions come and go', () => {
    // Each turn of each session would otherwise leave a key behind forever.
    for (let i = 0; i < 2000; i++) {
      isDuplicateAgentEvent('wt-1', 'claude', 'claude', 'stop', `sess-${i}`, 1000 + i);
    }
    expect(getRecentEventKeyCount()).toBeLessThanOrEqual(600);
  });
});

describe('structuredEvents exposure (Issue #1722)', () => {
  /**
   * The source block Issue #1924 publishes alongside the event fields.
   *
   * Read from the registry rather than transcribed: `capabilities.test.ts` is
   * what pins the values, and a second transcription here would be a second
   * place for the 6x5 table to be wrong. What these two cases assert is the
   * shape — that `structuredEvents` carries the block, on a session that has
   * reported nothing as much as on one that has.
   */
  const claudeSource = {
    cliToolId: 'claude',
    capabilities: getAgentEventSource('claude').capabilities,
  };

  it('is all nulls for a session whose agent has reported nothing', async () => {
    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.structuredEvents).toEqual({
      lastEventType: null,
      lastEventAt: null,
      lastEventDetail: null,
      promptWaitingSince: null,
      promptWaitingSource: null,
      // Issue #1902: claude sends `tool_input` as an object, so nothing here is
      // ever rewritten. The key is present and null rather than absent.
      toolInputNormalization: null,
      source: claudeSource,
    });
  });

  it('surfaces the last event without disturbing anything else in the payload', async () => {
    const before = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    // A `Notification` whose type this server has never observed. #1722's
    // observation-only guarantee is asserted on one of those on purpose: the
    // two types that DO carry a verdict were promoted by #1723
    // (`idle_prompt` -> ready) and #1725 (`permission_prompt` -> a dialog is
    // open), so pinning the guarantee to them would be pinning behaviour two
    // later Issues deliberately changed.
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'notification',
      at: 1_700_000_000_002,
      detail: 'some_future_type',
      sessionId: 'sess-9',
    });
    const after = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(after.structuredEvents).toEqual({
      lastEventType: 'notification',
      lastEventAt: 1_700_000_000_002,
      lastEventDetail: 'some_future_type',
      promptWaitingSince: null,
      promptWaitingSource: null,
      // Issue #1902: claude sends `tool_input` as an object, so nothing here is
      // ever rewritten. The key is present and null rather than absent.
      toolInputNormalization: null,
      source: claudeSource,
    });
    expect({ ...after, structuredEvents: null }).toEqual({ ...before, structuredEvents: null });
  });

  it('surfaces the last event for a session that is no longer running', async () => {
    isRunning.mockResolvedValue(false);
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'session_end',
      at: 1_700_000_000_003,
      detail: 'clear',
      sessionId: 'sess-9',
    });

    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');

    expect(payload.isRunning).toBe(false);
    expect(payload.structuredEvents.lastEventType).toBe('session_end');
    expect(payload.structuredEvents.lastEventDetail).toBe('clear');
  });
});
