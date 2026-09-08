/**
 * `buildCurrentOutput` publishes `running` while Command Code generates
 * (Issue #2429).
 *
 * The unit above this one (`stale-hook-stop-2429.test.ts`) pins the precedence
 * table. This one pins that the payload actually reaches it: the merge's new
 * input is a database read, and a read that is never made looks exactly like a
 * rule that never fires.
 *
 * Two things are asserted that the pure test cannot see:
 *
 *  - the published `sessionStatus` — the field `commandmate wait` reads for "is
 *    at its composer" and the UI reads for its status pill — flips to `running`
 *    for the whole of a turn the structured layer has said nothing about;
 *  - the ledger is **not** read on the polls where it could not matter. It is
 *    one query per poll of every watched session otherwise, and the gate that
 *    prevents it is the merge's own first three conjuncts.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null), createMessage: vi.fn() }));

const getLastUserMessageForInstance = vi.fn();
vi.mock('@/lib/db/chat-db', () => ({
  getLastUserMessageForInstance: (...args: unknown[]) => getLastUserMessageForInstance(...args),
}));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ isRunning: (...args: unknown[]) => isRunning(...args) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1:command-code'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import type { CLIToolType } from '@/lib/cli-tools/types';

const LIVE_FIXTURES = path.resolve(__dirname, '../../../fixtures/command-code-live-2250');

/** The live capture whose status row reads `esc to interrupt`. */
const GENERATING_FRAME = readFileSync(
  path.join(LIVE_FIXTURES, 'turn-shell-running-1490.txt'),
  'utf-8',
);

/** The same session a moment later: the composer, nothing in flight. */
const IDLE_FRAME = readFileSync(path.join(LIVE_FIXTURES, 'turn-done-1490.txt'), 'utf-8');

const db = {} as Database.Database;

/** A `role: 'user'` ledger row stamped at `at`, as `chat-db` returns one. */
function promptRowAt(at: number): { role: string; timestamp: Date } {
  return { role: 'user', timestamp: new Date(at) };
}

async function payloadFor(tool: CLIToolType = 'command-code') {
  return buildCurrentOutput(db, 'wt-1', tool, tool);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  isRunning.mockResolvedValue(true);
  getLastUserMessageForInstance.mockReturnValue(null);
  vi.mocked(captureSessionOutput).mockResolvedValue(GENERATING_FRAME);
});

describe('[#2429] a Stop older than the newest prompt stops deciding the status', () => {
  it('publishes running/thinking_indicator for the generating frame', async () => {
    const stoppedAt = Date.now() - 8_000;
    recordAgentEvent('wt-1', 'command-code', 'command-code', {
      event: 'stop',
      at: stoppedAt,
      detail: null,
      sessionId: 'sess-1',
    });

    // Without the ledger the payload is the defect: `ready / hook_stop` over a
    // pane that says `esc to interrupt`.
    const stale = await payloadFor();
    expect(stale.sessionStatus).toBe('ready');
    expect(stale.sessionStatusReason).toBe('hook_stop');

    getLastUserMessageForInstance.mockReturnValue(promptRowAt(stoppedAt + 2_000));

    const fixed = await payloadFor();
    expect(fixed.sessionStatus).toBe('running');
    expect(fixed.sessionStatusReason).toBe('thinking_indicator');
    expect(fixed.isGenerating).toBe(true);
  });

  it('scopes the ledger read to the (worktree, tool, instance) being polled', async () => {
    // A prompt sent to `claude` must not decide a poll of `command-code`; the
    // scoping is the query's, and this pins the arguments it is given.
    recordAgentEvent('wt-1', 'command-code', 'command-code-2', {
      event: 'stop',
      at: Date.now() - 8_000,
      detail: null,
      sessionId: 'sess-1',
    });

    await buildCurrentOutput(db, 'wt-1', 'command-code', 'command-code-2');

    expect(getLastUserMessageForInstance).toHaveBeenCalledWith(
      db,
      'wt-1',
      'command-code',
      'command-code-2',
    );
  });

  it('keeps ready/hook_stop when the agent answered the newest prompt', async () => {
    const stoppedAt = Date.now() - 8_000;
    recordAgentEvent('wt-1', 'command-code', 'command-code', {
      event: 'stop',
      at: stoppedAt,
      detail: null,
      sessionId: 'sess-1',
    });
    getLastUserMessageForInstance.mockReturnValue(promptRowAt(stoppedAt - 30_000));

    const payload = await payloadFor();

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe('hook_stop');
  });

  it('keeps ready/hook_stop when the ledger throws', async () => {
    const stoppedAt = Date.now() - 8_000;
    recordAgentEvent('wt-1', 'command-code', 'command-code', {
      event: 'stop',
      at: stoppedAt,
      detail: null,
      sessionId: 'sess-1',
    });
    getLastUserMessageForInstance.mockImplementation(() => {
      throw new Error('database is locked');
    });

    const payload = await payloadFor();

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe('hook_stop');
  });
});

describe('[#2429] the ledger is read only where it could change the verdict', () => {
  it('is not read on a poll with no structured events at all', async () => {
    await payloadFor();
    expect(getLastUserMessageForInstance).not.toHaveBeenCalled();
  });

  it('is not read while the agent has an open turn', async () => {
    recordAgentEvent('wt-1', 'command-code', 'command-code', {
      event: 'pre_tool_use',
      at: Date.now() - 1_000,
      detail: null,
      sessionId: 'sess-1',
    });

    const payload = await payloadFor();

    expect(payload.sessionStatus).toBe('running');
    expect(getLastUserMessageForInstance).not.toHaveBeenCalled();
  });

  it('is not read on an idle composer frame', async () => {
    // #1975's case, and the one a shorter hold would have broken: the frame is
    // not positively generating, so the structured `ready` is the only verdict
    // anybody has and it stands.
    vi.mocked(captureSessionOutput).mockResolvedValue(IDLE_FRAME);
    recordAgentEvent('wt-1', 'command-code', 'command-code', {
      event: 'stop',
      at: Date.now() - 8_000,
      detail: null,
      sessionId: 'sess-1',
    });

    const payload = await payloadFor();

    expect(payload.sessionStatus).toBe('ready');
    expect(getLastUserMessageForInstance).not.toHaveBeenCalled();
  });
});
