/**
 * A 5h / 24h Auto-Yes grant behaves like a 1h one, only longer (Issue #3913).
 *
 * - The setter takes every 1〜24h value and refuses any other at run time,
 *   leaving the state as it was (the type is not proof: a cast gets past it).
 * - Expiry: 1 ms before 24h the grant is live and the poller's tick goes on;
 *   at 24h exactly and after, it is expired, the tick stops the poller and the
 *   PermissionRequest hook makes no decision.
 * - A 24h grant does not delay the other ways it ends: manual OFF, the stop
 *   pattern and the session ending act at once.
 * - Module reload and a graceful restart keep `expiresAt` (the restart turns
 *   it into an OFF notice with `server-restart`); a record written with the old
 *   1/3/8h values is still read.
 *
 * Only `child_process.execFile` (tmux) and the session-ownership probe are
 * stood in for (harness from `auto-yes-poller-stop-reason-3730.test.ts`);
 * the clock is fake. Record files live under a `fs.mkdtempSync` directory in
 * `os.tmpdir()`, removed after each test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logged: Array<{ module: string; action: string; data?: Record<string, unknown> }> = [];
vi.mock('@/lib/logger', () => {
  const make = (module: string) => {
    const record = (action: string, data?: Record<string, unknown>) => {
      logged.push({ module, action, data });
    };
    const logger = { debug: record, info: record, warn: record, error: record, withContext: () => logger };
    return logger;
  };
  return { createLogger: make, generateRequestId: () => 'req' };
});

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/polling/response-poller', () => ({
  startPolling: vi.fn(),
  stopPolling: vi.fn(),
  clearPromptHashCache: vi.fn(),
}));
vi.mock('@/lib/schedule-manager', () => ({
  stopScheduleForWorktree: vi.fn(),
  getScheduleWorktreeIds: vi.fn(() => []),
}));
vi.mock('@/lib/timer-manager', () => ({
  stopTimersForWorktree: vi.fn(),
  getTimerWorktreeIds: vi.fn(() => []),
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: (id: string) => `claude-${id}`, name: 'Claude' }),
    }),
  },
}));
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => ({
    prepare: () => ({ get: () => undefined, run: () => undefined, all: () => [] }),
  }),
}));

vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (_db: unknown, message: Record<string, unknown>) => ({ id: 'msg-1', ...message }),
}));
vi.mock('@/lib/polling/auto-yes-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/polling/auto-yes-policy')>()),
  getSessionAutoYesPolicy: () => null,
}));

import { execFile } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCompositeKey,
  checkStopCondition,
  clearAllAutoYesStates,
  getAutoYesState,
  resetAutoYesShutdownForTesting,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';
import {
  clearAllPollerStates,
  isPollerActive,
  startAutoYesPolling,
  validatePollingContext,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { releaseAutoYes } from '@/lib/auto-yes-lifecycle';
import { resetCacheForTesting } from '@/lib/tmux/tmux-capture-cache';
import { recordAutoYesShutdown, restoreAutoYesShutdownRecord } from '@/lib/auto-yes-shutdown-record';
import { decidePermissionRequest } from '@/lib/hooks/permission-decision-service';
import { parsePermissionRequestPayload } from '@/lib/hooks/permission-request-payload';
import { formatTimeRemaining, type AutoYesDuration } from '@/config/auto-yes-config';

const WT = 'wt-3913-duration';
const KEY = buildCompositeKey(WT, 'claude');
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const H5 = 18_000_000 as const;
const H24 = 86_400_000 as const;

function arm(duration: AutoYesDuration, stopPattern?: string): AutoYesPollerState {
  setAutoYesEnabled(WT, 'claude', true, duration, stopPattern);
  expect(startAutoYesPolling(WT, 'claude').started).toBe(true);
  const state = globalThis.__autoYesPollerStates?.get(KEY);
  expect(state).toBeDefined();
  return state!;
}

function bashRequest() {
  const parsed = parsePermissionRequestPayload({
    session_id: 's-3913',
    transcript_path: '/nonexistent/transcript.jsonl',
    cwd: '/nonexistent',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'git status', description: 'status' },
  });
  if (!parsed) throw new Error('payload failed to parse');
  return parsed;
}

const SESSION = { worktreeId: WT, cliToolId: 'claude' as const, instanceId: 'claude' };

let tmp: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  clearAllAutoYesStates();
  clearAllPollerStates();
  resetCacheForTesting();
  resetAutoYesShutdownForTesting();
  vi.mocked(execFile).mockReset();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-auto-yes-3913-'));
});

afterEach(() => {
  clearAllPollerStates();
  clearAllAutoYesStates();
  resetAutoYesShutdownForTesting();
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('[#3913] setAutoYesEnabled', () => {
  it.each([[5, H5], [24, H24]] as const)('takes %ih and sets expiresAt = now + duration', (_hours, duration) => {
    const state = setAutoYesEnabled(WT, 'claude', true, duration);
    expect(state).toMatchObject({ enabled: true, enabledAt: NOW, expiresAt: NOW + duration });
    expect(formatTimeRemaining(state.expiresAt)).toBe(`${duration / HOUR}:00:00`);
  });

  it.each([0, -HOUR, 25 * HOUR, 1.5 * HOUR, HOUR + 1, NaN, Infinity, -Infinity])(
    'refuses %s and writes nothing',
    (bad) => {
      expect(() => setAutoYesEnabled(WT, 'claude', true, bad as AutoYesDuration)).toThrow(RangeError);
      expect(getAutoYesState(WT, 'claude')).toBeNull();
    },
  );

  it('refuses an invalid value over a live grant and leaves the grant as it was', () => {
    setAutoYesEnabled(WT, 'claude', true, H5);
    const before = getAutoYesState(WT, 'claude');

    expect(() => setAutoYesEnabled(WT, 'claude', true, '3600000' as unknown as AutoYesDuration)).toThrow(RangeError);
    expect(getAutoYesState(WT, 'claude')).toEqual(before);
  });

  it('still defaults to 1h and still disables regardless of duration (negative controls)', () => {
    expect(setAutoYesEnabled(WT, 'claude', true).expiresAt).toBe(NOW + HOUR);
    expect(setAutoYesEnabled(WT, 'claude', false, 25 * HOUR as AutoYesDuration).enabled).toBe(false);
  });
});

describe('[#3913] a 24h grant expires at 24h, not before', () => {
  it('is live 1 ms before 24h and expired at 24h exactly', () => {
    const pollerState = arm(H24);

    vi.setSystemTime(NOW + H24 - 1);
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(true);
    expect(validatePollingContext(KEY, pollerState)).toBe('valid');
    expect(decidePermissionRequest(SESSION, bashRequest())).toMatchObject({ behavior: 'allow' });

    vi.setSystemTime(NOW + H24);
    expect(decidePermissionRequest(SESSION, bashRequest())).toMatchObject({ behavior: null, reason: 'auto-yes-disabled' });
    expect(validatePollingContext(KEY, pollerState)).toBe('expired');
    expect(isPollerActive(KEY)).toBe(false);
    expect(getAutoYesState(WT, 'claude')).toMatchObject({ enabled: false, stopReason: 'expired' });
  });

  it('stays expired after 24h', () => {
    arm(H24);
    vi.setSystemTime(NOW + H24 + 1);
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(false);
    expect(decidePermissionRequest(SESSION, bashRequest())).toMatchObject({ behavior: null, reason: 'auto-yes-disabled' });
  });
});

describe('[#3913] the other ways a 24h grant ends do not wait', () => {
  it('manual OFF', () => {
    arm(H24);
    vi.setSystemTime(NOW + HOUR);
    setAutoYesEnabled(WT, 'claude', false);
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(false);
    expect(decidePermissionRequest(SESSION, bashRequest())).toMatchObject({ behavior: null });
  });

  it('the stop pattern', () => {
    arm(H24, 'FATAL');
    vi.setSystemTime(NOW + HOUR);
    expect(checkStopCondition(KEY, 'FATAL: boom')).toBe(true);
    expect(getAutoYesState(WT, 'claude')).toMatchObject({ enabled: false, stopReason: 'stop_pattern_matched' });
  });

  it('the session ending', () => {
    arm(H24);
    vi.setSystemTime(NOW + HOUR);
    releaseAutoYes('session-killed', { scope: 'instance', worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' });
    expect(isPollerActive(KEY)).toBe(false);
    expect(getAutoYesState(WT, 'claude')?.enabled ?? false).toBe(false);
  });
});

describe('[#3913] reload and restart keep the 5h / 24h deadline', () => {
  it.each([H5, H24])('module reload keeps expiresAt for %i ms', async (duration) => {
    setAutoYesEnabled(WT, 'claude', true, duration);
    vi.resetModules();
    const reloaded = await import('@/lib/auto-yes-state');
    expect(reloaded.getAutoYesState(WT, 'claude')).toMatchObject({ enabled: true, expiresAt: NOW + duration });
  });

  it.each([H5, H24])('a graceful restart turns a %i ms grant OFF with server-restart and its own deadline', (duration) => {
    const recordPath = path.join(tmp, 'cm.db.auto-yes-shutdown.json');
    setAutoYesEnabled(WT, 'claude', true, duration);
    vi.setSystemTime(NOW + HOUR);
    expect(recordAutoYesShutdown({ path: recordPath }).recorded).toBe(1);

    // The next process: empty memory, the record on disk.
    clearAllAutoYesStates();
    resetAutoYesShutdownForTesting();
    expect(restoreAutoYesShutdownRecord({ path: recordPath }).seeded).toBe(1);
    expect(getAutoYesState(WT, 'claude')).toMatchObject({
      enabled: false,
      expiresAt: NOW + duration,
      stopReason: 'server-restart',
    });
  });

  it.each([1, 3, 8])('a record written with the old %ih value is still read', (hours) => {
    const recordPath = path.join(tmp, 'cm.db.auto-yes-shutdown.json');
    setAutoYesEnabled(WT, 'claude', true, (hours * HOUR) as AutoYesDuration);
    expect(recordAutoYesShutdown({ path: recordPath }).recorded).toBe(1);

    clearAllAutoYesStates();
    resetAutoYesShutdownForTesting();
    expect(restoreAutoYesShutdownRecord({ path: recordPath }).seeded).toBe(1);
    expect(getAutoYesState(WT, 'claude')).toMatchObject({ expiresAt: NOW + hours * HOUR, stopReason: 'server-restart' });
  });
});
