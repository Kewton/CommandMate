/**
 * Issue #3397: the terminal push carries `autoYes.lastEnterFallback` the way it
 * carries `promptAnswerable` (#2887) — straight through, absent when the
 * payload has none — and a redraw whose only change is that record is pushed.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ws-server', () => ({
  broadcast: vi.fn(),
  hasRoomSubscribers: vi.fn(() => true),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        getSessionName: (worktreeId: string, instanceId?: string) =>
          `mcbd-${cliToolId}-${worktreeId}-${instanceId ?? cliToolId}`,
      }),
    }),
  },
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/realtime/terminal-session-ownership', () => ({
  findTerminalSessionRefusal: vi.fn(async () => null),
}));
vi.mock('@/lib/session/current-output-builder', () => ({ buildCurrentOutput: vi.fn() }));

import { broadcast } from '@/lib/ws-server';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import {
  broadcastTerminalSnapshot,
  broadcastTerminalSnapshotAfterInteraction,
  __resetTerminalBroadcastState,
} from '@/lib/realtime/terminal-broadcast';
import type { AutoYesEnterFallbackPublished } from '@/lib/polling/auto-yes-enter-fallback';

type Payload = Awaited<ReturnType<typeof buildCurrentOutput>>;

const SENT: AutoYesEnterFallbackPublished = {
  outcome: 'sent',
  promptType: 'multiple_choice',
  refusalReason: 'unsupported_dialog_layout',
  sentAt: 1_000,
  at: 1_000,
  currentPrompt: true,
};

function payload(lastEnterFallback: AutoYesEnterFallbackPublished | null | undefined): Payload {
  return {
    isRunning: true,
    cliToolId: 'claude',
    sessionStatus: 'waiting',
    content: '',
    fullOutput: 'same frame',
    lineCount: 1,
    isPromptWaiting: true,
    promptData: null,
    promptAnswerable: false,
    isSelectionListActive: false,
    isPagerActive: false,
    isUnclassifiedActive: false,
    ...(lastEnterFallback === undefined
      ? {}
      : { autoYes: { enabled: true, expiresAt: null, lastSuppression: null, lastEnterFallback } }),
  } as unknown as Payload;
}

function lastSnapshot(): Record<string, unknown> {
  const calls = vi.mocked(broadcast).mock.calls;
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetTerminalBroadcastState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('[#3397] terminal_snapshot.autoYesEnterFallback', () => {
  it('carries the record straight through', async () => {
    vi.mocked(buildCurrentOutput).mockResolvedValueOnce(payload(SENT));
    await broadcastTerminalSnapshot('wt-1', 'claude');
    expect(lastSnapshot()).toMatchObject({ type: 'terminal_snapshot', autoYesEnterFallback: SENT });
  });

  it('carries null as null (Auto-Yes never sent its Enter)', async () => {
    vi.mocked(buildCurrentOutput).mockResolvedValueOnce(payload(null));
    await broadcastTerminalSnapshot('wt-1', 'claude');
    expect(lastSnapshot().autoYesEnterFallback).toBeNull();
  });

  it('is absent from the wire when the payload carries no autoYes', async () => {
    vi.mocked(buildCurrentOutput).mockResolvedValueOnce(payload(undefined));
    await broadcastTerminalSnapshot('wt-1', 'claude');
    const wire = JSON.parse(JSON.stringify(lastSnapshot())) as Record<string, unknown>;
    expect('autoYesEnterFallback' in wire).toBe(false);
  });

  it('a redraw whose only change is the record is pushed', async () => {
    vi.useFakeTimers();
    vi.mocked(buildCurrentOutput)
      .mockResolvedValueOnce(payload(null))
      .mockResolvedValueOnce(payload(SENT));

    const done = broadcastTerminalSnapshotAfterInteraction('wt-1', 'claude', undefined, [10]);
    await vi.advanceTimersByTimeAsync(20);
    await done;

    expect(vi.mocked(broadcast)).toHaveBeenCalledTimes(2);
    expect(lastSnapshot().autoYesEnterFallback).toEqual(SENT);
  });
});
