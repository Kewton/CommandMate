/**
 * Issue #3821: the terminal push carries `autoYesDecision` straight through,
 * and a redraw whose only change is the decision — the screen the same,
 * `answering` -> `withheld` on the next tick — is pushed, so the PC answer
 * panel opens without waiting for the HTTP poll (Codex review T4).
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
import type { AutoYesDecisionPublished } from '@/types/auto-yes-decision';

type Payload = Awaited<ReturnType<typeof buildCurrentOutput>>;

const ANSWERING: AutoYesDecisionPublished = { state: 'answering', reason: null, observedAt: 1_000 };
const WITHHELD: AutoYesDecisionPublished = { state: 'withheld', reason: 'unclassified-frame', observedAt: 2_000 };

function payload(autoYesDecision: AutoYesDecisionPublished | undefined): Payload {
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
    ...(autoYesDecision === undefined ? {} : { autoYesDecision }),
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

describe('[#3821] terminal_snapshot.autoYesDecision', () => {
  it('carries the decision straight through', async () => {
    vi.mocked(buildCurrentOutput).mockResolvedValueOnce(payload(WITHHELD));
    await broadcastTerminalSnapshot('wt-1', 'claude');
    expect(lastSnapshot()).toMatchObject({ type: 'terminal_snapshot', autoYesDecision: WITHHELD });
  });

  it('is absent from the wire when the payload carries none (a session not running)', async () => {
    vi.mocked(buildCurrentOutput).mockResolvedValueOnce(payload(undefined));
    await broadcastTerminalSnapshot('wt-1', 'claude');
    const wire = JSON.parse(JSON.stringify(lastSnapshot())) as Record<string, unknown>;
    expect('autoYesDecision' in wire).toBe(false);
  });

  it('the body unchanged, answering -> withheld: pushed', async () => {
    vi.useFakeTimers();
    vi.mocked(buildCurrentOutput)
      .mockResolvedValueOnce(payload(ANSWERING))
      .mockResolvedValueOnce(payload(WITHHELD));

    const done = broadcastTerminalSnapshotAfterInteraction('wt-1', 'claude', undefined, [10]);
    await vi.advanceTimersByTimeAsync(20);
    await done;

    expect(vi.mocked(broadcast)).toHaveBeenCalledTimes(2);
    expect(lastSnapshot().autoYesDecision).toEqual(WITHHELD);
  });

  it('withheld for one reason -> withheld for another: pushed', async () => {
    vi.useFakeTimers();
    vi.mocked(buildCurrentOutput)
      .mockResolvedValueOnce(payload(WITHHELD))
      .mockResolvedValueOnce(payload({ ...WITHHELD, reason: 'server-poller-inactive' }));

    const done = broadcastTerminalSnapshotAfterInteraction('wt-1', 'claude', undefined, [10]);
    await vi.advanceTimersByTimeAsync(20);
    await done;

    expect(vi.mocked(broadcast)).toHaveBeenCalledTimes(2);
  });

  it('the same state about another confirmation (the body unchanged): pushed', async () => {
    vi.useFakeTimers();
    vi.mocked(buildCurrentOutput)
      .mockResolvedValueOnce(payload({ ...WITHHELD, confirmation: 'A' }))
      .mockResolvedValueOnce(payload({ ...WITHHELD, confirmation: 'B' }));

    const done = broadcastTerminalSnapshotAfterInteraction('wt-1', 'claude', undefined, [10]);
    await vi.advanceTimersByTimeAsync(20);
    await done;

    expect(vi.mocked(broadcast)).toHaveBeenCalledTimes(2);
    expect(lastSnapshot().autoYesDecision).toEqual({ ...WITHHELD, confirmation: 'B' });
  });

  it('control: only `observedAt` moved (every build moves it): not pushed again', async () => {
    vi.useFakeTimers();
    vi.mocked(buildCurrentOutput)
      .mockResolvedValueOnce(payload(WITHHELD))
      .mockResolvedValueOnce(payload({ ...WITHHELD, observedAt: 9_000 }));

    const done = broadcastTerminalSnapshotAfterInteraction('wt-1', 'claude', undefined, [10]);
    await vi.advanceTimersByTimeAsync(20);
    await done;

    expect(vi.mocked(broadcast)).toHaveBeenCalledTimes(1);
  });
});
