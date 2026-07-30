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
  clearAgentStopEvents,
  getLastStopEventAt,
  recordAgentStopEvent,
} from '@/lib/session/agent-event-state';

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
