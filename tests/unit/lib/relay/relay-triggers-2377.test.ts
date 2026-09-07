/**
 * Where the relay subsystem is woken up (Issue #2377).
 *
 * Two things are asserted, and the second is the one that would rot silently:
 *
 *  - the waiting edge reaches the relay ONLY as an opening `prompt` crossing. A
 *    `menu` is a pager or a model picker and nobody is being asked anything; an
 *    `unclassified` frame is one the detectors failed on, which is not something
 *    to describe to another session as a question. A closing edge is the dialog
 *    going away.
 *  - `startWaitingStatusBroadcast` arms it and `stopWaitingStatusBroadcast`
 *    disarms it, so the subscription's lifetime is the SERVER's — a suite that
 *    stands a server up and tears it down must not leave an interval ticking
 *    against a database it has closed.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notifyRelayPromptWaiting = vi.fn();
const notifyRelayTurnCompleted = vi.fn(async () => {});
const runRelayMaintenanceTick = vi.fn(async () => {});

vi.mock('@/lib/relay/relay-delivery', () => ({
  notifyRelayPromptWaiting: (...a: unknown[]) => notifyRelayPromptWaiting(...(a as [])),
  notifyRelayTurnCompleted: (...a: unknown[]) => notifyRelayTurnCompleted(...(a as [])),
  runRelayMaintenanceTick: () => runRelayMaintenanceTick(),
}));

import {
  areRelayTriggersActive,
  onRelayPromptWaiting,
  onRelayTurnCompleted,
  runRelayMaintenance,
  startRelayTriggers,
  stopRelayTriggers,
} from '@/lib/relay/relay-triggers';
import { RELAY_PUMP_INTERVAL_MS } from '@/lib/relay/relay-policy';
import { clearWaitingEpisodes, observeWaitingEdge } from '@/lib/session/waiting-episode-state';
import {
  startWaitingStatusBroadcast,
  stopWaitingStatusBroadcast,
} from '@/lib/realtime/waiting-broadcast';

/** Let the fire-and-forget dynamic import inside a trigger finish. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Cross the waiting edge for one instance.
 *
 * Through `observeWaitingEdge` — the single writer of the edge (#1786) — rather
 * than through a hand-built event, so the subscription is exercised against the
 * shape the poller really produces.
 */
function crossWaitingEdge(
  waiting: boolean,
  kind: 'prompt' | 'menu' | 'unclassified' | null = 'prompt',
  instanceId = 'codex',
): void {
  observeWaitingEdge({ worktreeId: 'wt-b', cliToolId: 'codex', instanceId, waiting, kind });
}

/** Forget what the prompt notifier has been told so far. */
function clearRelayCalls(): void {
  notifyRelayPromptWaiting.mockClear();
}

beforeEach(() => {
  vi.clearAllMocks();
  clearWaitingEpisodes();
  stopRelayTriggers();
});

afterEach(() => {
  stopRelayTriggers();
  vi.useRealTimers();
});

describe('onRelayTurnCompleted', () => {
  it('forwards the resolved worker and the settled flag', async () => {
    onRelayTurnCompleted('wt-b', 'codex', 'codex-2', true);
    await flush();

    expect(notifyRelayTurnCompleted).toHaveBeenCalledWith(
      { worktreeId: 'wt-b', cliToolId: 'codex', instanceId: 'codex-2' },
      { settled: true }
    );
  });

  it('resolves an omitted instance to the primary one', async () => {
    onRelayTurnCompleted('wt-b', 'codex', undefined, false);
    await flush();

    expect(notifyRelayTurnCompleted).toHaveBeenCalledWith(
      { worktreeId: 'wt-b', cliToolId: 'codex', instanceId: 'codex' },
      { settled: false }
    );
  });

  it('never throws at its caller', async () => {
    notifyRelayTurnCompleted.mockRejectedValueOnce(new Error('ledger down'));

    expect(() => onRelayTurnCompleted('wt-b', 'codex', 'codex', true)).not.toThrow();
    await flush();
  });
});

describe('the waiting edge subscription', () => {
  it('is not armed until it is started', () => {
    expect(areRelayTriggersActive()).toBe(false);
  });

  it('forwards an opening prompt edge', async () => {
    startRelayTriggers();

    crossWaitingEdge(true);
    await flush();

    expect(notifyRelayPromptWaiting).toHaveBeenCalledWith({
      worktreeId: 'wt-b',
      cliToolId: 'codex',
      instanceId: 'codex',
    });
  });

  it('ignores a closing edge', async () => {
    startRelayTriggers();

    // Opened first, so the closing edge below is a real crossing rather than a
    // no-op on an instance that was never waiting. Flushed before the counter is
    // cleared, because the opening edge's own notification is asynchronous.
    crossWaitingEdge(true);
    await flush();
    clearRelayCalls();
    crossWaitingEdge(false, null);
    await flush();

    expect(notifyRelayPromptWaiting).not.toHaveBeenCalled();
  });

  it('ignores a menu and an unclassified frame', async () => {
    startRelayTriggers();

    crossWaitingEdge(true, 'menu', 'codex');
    crossWaitingEdge(true, 'unclassified', 'codex-2');
    await flush();

    expect(notifyRelayPromptWaiting).not.toHaveBeenCalled();
  });

  it('replaces rather than stacks when started twice', async () => {
    startRelayTriggers();
    startRelayTriggers();

    crossWaitingEdge(true);
    await flush();

    expect(notifyRelayPromptWaiting).toHaveBeenCalledTimes(1);
  });

  it('stops listening once stopped', async () => {
    startRelayTriggers();
    stopRelayTriggers();

    expect(areRelayTriggersActive()).toBe(false);
    crossWaitingEdge(true);
    await flush();

    expect(notifyRelayPromptWaiting).not.toHaveBeenCalled();
  });
});

describe('the maintenance loop', () => {
  it('ticks on the pump interval', async () => {
    vi.useFakeTimers();
    startRelayTriggers();

    await vi.advanceTimersByTimeAsync(RELAY_PUMP_INTERVAL_MS * 2 + 100);

    expect(runRelayMaintenanceTick).toHaveBeenCalledTimes(2);
  });

  it('stops ticking once stopped', async () => {
    vi.useFakeTimers();
    startRelayTriggers();
    await vi.advanceTimersByTimeAsync(RELAY_PUMP_INTERVAL_MS + 100);
    stopRelayTriggers();
    await vi.advanceTimersByTimeAsync(RELAY_PUMP_INTERVAL_MS * 3);

    expect(runRelayMaintenanceTick).toHaveBeenCalledTimes(1);
  });

  it('contains a failing tick', async () => {
    runRelayMaintenanceTick.mockRejectedValueOnce(new Error('db closed'));

    await expect(runRelayMaintenance()).resolves.toBeUndefined();
  });
});

describe('arming from the server lifecycle', () => {
  afterEach(() => stopWaitingStatusBroadcast());

  it('startWaitingStatusBroadcast arms the relay triggers', () => {
    startWaitingStatusBroadcast(() => {});

    expect(areRelayTriggersActive()).toBe(true);
  });

  it('stopWaitingStatusBroadcast disarms them', () => {
    startWaitingStatusBroadcast(() => {});
    stopWaitingStatusBroadcast();

    expect(areRelayTriggersActive()).toBe(false);
  });
});

describe('onRelayPromptWaiting', () => {
  it('never throws at its caller', async () => {
    notifyRelayPromptWaiting.mockImplementationOnce(() => {
      throw new Error('ledger down');
    });

    expect(() => onRelayPromptWaiting('wt-b', 'codex', 'codex')).not.toThrow();
    await flush();
  });
});
