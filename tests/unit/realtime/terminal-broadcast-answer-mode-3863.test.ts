/**
 * Issue #3863: the terminal push carries `autoYesAnswerMode` straight through,
 * and a redraw whose only change is the answer mode is pushed (whether a
 * question waits for a human depends on it). Harness from
 * `terminal-broadcast-auto-yes-decision-3821.test.ts`.
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

type Payload = Awaited<ReturnType<typeof buildCurrentOutput>>;

function payload(autoYesAnswerMode: 'recommended' | 'careful' | undefined): Payload {
  return {
    isRunning: true,
    cliToolId: 'claude',
    sessionStatus: 'waiting',
    content: '',
    fullOutput: 'same frame',
    lineCount: 1,
    isPromptWaiting: true,
    promptData: null,
    isSelectionListActive: false,
    isPagerActive: false,
    isUnclassifiedActive: false,
    ...(autoYesAnswerMode === undefined ? {} : { autoYesAnswerMode }),
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

describe('[#3863] terminal_snapshot.autoYesAnswerMode', () => {
  it('carries the mode straight through', async () => {
    vi.mocked(buildCurrentOutput).mockResolvedValueOnce(payload('careful'));
    await broadcastTerminalSnapshot('wt-1', 'claude');
    expect(lastSnapshot()).toMatchObject({ type: 'terminal_snapshot', autoYesAnswerMode: 'careful' });
  });

  it('is absent from the event while Auto-Yes is off (the payload carries none)', async () => {
    vi.mocked(buildCurrentOutput).mockResolvedValueOnce(payload(undefined));
    await broadcastTerminalSnapshot('wt-1', 'claude');
    expect('autoYesAnswerMode' in lastSnapshot()).toBe(false);
  });

  it('the body unchanged, recommended -> careful: pushed', async () => {
    vi.useFakeTimers();
    vi.mocked(buildCurrentOutput)
      .mockResolvedValueOnce(payload('recommended'))
      .mockResolvedValueOnce(payload('careful'));

    const done = broadcastTerminalSnapshotAfterInteraction('wt-1', 'claude', undefined, [10]);
    await vi.advanceTimersByTimeAsync(20);
    await done;

    expect(vi.mocked(broadcast)).toHaveBeenCalledTimes(2);
    expect(lastSnapshot().autoYesAnswerMode).toBe('careful');
  });

  it('control: nothing changed: not pushed again', async () => {
    vi.useFakeTimers();
    vi.mocked(buildCurrentOutput)
      .mockResolvedValueOnce(payload('careful'))
      .mockResolvedValueOnce(payload('careful'));

    const done = broadcastTerminalSnapshotAfterInteraction('wt-1', 'claude', undefined, [10]);
    await vi.advanceTimersByTimeAsync(20);
    await done;

    expect(vi.mocked(broadcast)).toHaveBeenCalledTimes(1);
  });
});
