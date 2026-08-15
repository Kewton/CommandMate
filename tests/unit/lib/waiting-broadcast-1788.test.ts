/**
 * The waiting edge on the wire (Issue #1788).
 *
 * Two layers are covered, and the split matters:
 *
 *  - **the subscription** — that a `false→true` / `true→false` crossing observed
 *    by #1786's single edge observer turns into exactly one `session_status_changed`
 *    frame, and that the polls in between produce none;
 *  - **the wiring** — that `setupWebSocket` actually registers it and
 *    `closeWebSocket` actually removes it, delivered through the real room map,
 *    so a client that never subscribed never hears about a worktree.
 *
 * The second layer is the one that would otherwise be a green test over dead
 * code: the translation function can be perfect while nothing ever calls it.
 *
 * CI runs `fileParallelism: false`, so both the episode map and the listener set
 * are shared with every other file in the process — hence the paired clears.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'http';
import type { WebSocket } from 'ws';
import {
  buildWaitingStatusEvent,
  isWaitingStatusBroadcastActive,
  startWaitingStatusBroadcast,
  stopWaitingStatusBroadcast,
} from '@/lib/realtime/waiting-broadcast';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  observeWaitingEdge,
} from '@/lib/session/waiting-episode-state';

const WT = 'feature-1788';
const NOW = 1_760_000_000_000;

interface Published {
  worktreeId: string;
  data: Record<string, unknown>;
}

function collector() {
  const published: Published[] = [];
  const publish = (worktreeId: string, data: unknown) => {
    published.push({ worktreeId, data: data as Record<string, unknown> });
  };
  return { published, publish };
}

beforeEach(() => {
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  stopWaitingStatusBroadcast();
});

afterEach(() => {
  stopWaitingStatusBroadcast();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
});

describe('waiting edge → session_status_changed (Issue #1788)', () => {
  it('broadcasts the extended frame when a wait begins', () => {
    const { published, publish } = collector();
    startWaitingStatusBroadcast(publish);

    observeWaitingEdge({
      worktreeId: WT,
      cliToolId: 'claude',
      waiting: true,
      kind: 'prompt',
      now: NOW,
    });

    expect(published).toHaveLength(1);
    expect(published[0].worktreeId).toBe(WT);
    expect(published[0].data).toEqual({
      type: 'session_status_changed',
      worktreeId: WT,
      cliTool: 'claude',
      instance: 'claude',
      isWaitingForResponse: true,
      waitingKind: 'prompt',
      waitingSince: NOW,
    });
  });

  it('does NOT re-send while the same wait continues', () => {
    const { published, publish } = collector();
    startWaitingStatusBroadcast(publish);

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, now: NOW });
    for (let i = 1; i <= 20; i++) {
      observeWaitingEdge({
        worktreeId: WT,
        cliToolId: 'claude',
        waiting: true,
        kind: 'prompt',
        now: NOW + i * 5_000,
      });
    }

    // 21 polls, one frame: the edge is the event, the level is not.
    expect(published).toHaveLength(1);
    expect(published[0].data.isWaitingForResponse).toBe(true);
  });

  it('broadcasts once more when the wait ends, with no since/kind', () => {
    const { published, publish } = collector();
    startWaitingStatusBroadcast(publish);

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, now: NOW });
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: false, now: NOW + 9_000 });
    // Repeated not-waiting polls are not edges either.
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: false, now: NOW + 14_000 });

    expect(published).toHaveLength(2);
    expect(published[1].data).toMatchObject({
      isWaitingForResponse: false,
      waitingKind: null,
      waitingSince: null,
    });
  });

  it('never claims a session-existence verdict it does not have', () => {
    // `isRunning` is absent on both edges. A `waiting:false` crossing also fires
    // when the session died, so publishing `true` would resurrect a killed
    // session in the sidebar and `false` would kill a live one.
    const { published, publish } = collector();
    startWaitingStatusBroadcast(publish);

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, now: NOW });
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: false, now: NOW + 1 });

    for (const frame of published) {
      expect(frame.data).not.toHaveProperty('isRunning');
    }
  });

  it('fires for a hooks-only wait, carrying the structured start (no response poller involved)', () => {
    // The composed verdict is what #1786 records, so a dialog only the agent's
    // own events could see opens an episode — and therefore broadcasts — exactly
    // like one the screen scraper read.
    const { published, publish } = collector();
    startWaitingStatusBroadcast(publish);

    const structuredSince = NOW - 4_000;
    observeWaitingEdge({
      worktreeId: WT,
      cliToolId: 'codex',
      instanceId: 'codex-2',
      waiting: true,
      kind: 'unclassified',
      structuredSince,
      now: NOW,
    });

    expect(published).toHaveLength(1);
    expect(published[0].data).toMatchObject({
      cliTool: 'codex',
      instance: 'codex-2',
      waitingKind: 'unclassified',
      waitingSince: structuredSince,
    });
  });

  it('reports each agent instance separately', () => {
    const { published, publish } = collector();
    startWaitingStatusBroadcast(publish);

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, now: NOW });
    observeWaitingEdge({
      worktreeId: WT,
      cliToolId: 'codex',
      instanceId: 'codex-2',
      waiting: true,
      now: NOW,
    });

    expect(published.map((p) => p.data.instance)).toEqual(['claude', 'codex-2']);
  });

  it('normalizes the primary instance to its CLI tool id', () => {
    expect(
      buildWaitingStatusEvent({
        worktreeId: WT,
        cliToolId: 'gemini',
        instanceId: undefined,
        waiting: true,
        since: NOW,
        kind: 'menu',
        at: NOW,
      }).instance,
    ).toBe('gemini');
  });
});

describe('subscription lifecycle (Issue #1788)', () => {
  it('replaces rather than stacks when started twice', () => {
    const first = collector();
    const second = collector();
    startWaitingStatusBroadcast(first.publish);
    startWaitingStatusBroadcast(second.publish);

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, now: NOW });

    expect(first.published).toHaveLength(0);
    expect(second.published).toHaveLength(1);
  });

  it('stops publishing once stopped', () => {
    const { published, publish } = collector();
    startWaitingStatusBroadcast(publish);
    stopWaitingStatusBroadcast();

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, now: NOW });

    expect(published).toHaveLength(0);
    expect(isWaitingStatusBroadcastActive()).toBe(false);
  });

  it('cannot take the status read down with it when the publisher throws', () => {
    // `emit` contains listener failures on purpose — this store sits on the list
    // API's hot path.
    startWaitingStatusBroadcast(() => {
      throw new Error('room broadcast exploded');
    });

    expect(() =>
      observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, now: NOW }),
    ).not.toThrow();
  });
});

describe('ws-server wiring (Issue #1788)', () => {
  let server: Server;

  beforeEach(async () => {
    const { __internal } = await import('@/lib/ws-server');
    __internal.resetStateForTest();
    server = createServer();
  });

  afterEach(async () => {
    const { closeWebSocket } = await import('@/lib/ws-server');
    closeWebSocket();
    server.close();
  });

  it('setupWebSocket registers the subscription and closeWebSocket removes it', async () => {
    const { setupWebSocket, closeWebSocket } = await import('@/lib/ws-server');

    expect(isWaitingStatusBroadcastActive()).toBe(false);
    setupWebSocket(server);
    expect(isWaitingStatusBroadcastActive()).toBe(true);
    closeWebSocket();
    expect(isWaitingStatusBroadcastActive()).toBe(false);
  });

  it('delivers the edge to a subscribed client, and only to a subscribed one', async () => {
    const { setupWebSocket, __internal } = await import('@/lib/ws-server');
    setupWebSocket(server);

    const subscribedSend = vi.fn();
    const subscribed = { readyState: 1, send: subscribedSend, close: vi.fn() } as unknown as WebSocket;
    const strangerSend = vi.fn();
    const stranger = { readyState: 1, send: strangerSend, close: vi.fn() } as unknown as WebSocket;

    __internal.registerClientForTest(subscribed);
    __internal.registerClientForTest(stranger);
    // Room membership is only reachable through the subscribe path, which the
    // authenticated upgrade guards (#331/#332). Nothing here bypasses it.
    __internal.handleMessage(subscribed, { type: 'subscribe', worktreeId: WT });
    __internal.handleMessage(stranger, { type: 'subscribe', worktreeId: 'some-other-worktree' });

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: NOW });

    expect(strangerSend).not.toHaveBeenCalled();
    expect(subscribedSend).toHaveBeenCalledTimes(1);
    const envelope = JSON.parse(subscribedSend.mock.calls[0][0] as string);
    expect(envelope).toMatchObject({
      type: 'broadcast',
      worktreeId: WT,
      data: {
        type: 'session_status_changed',
        worktreeId: WT,
        isWaitingForResponse: true,
        waitingKind: 'prompt',
        waitingSince: NOW,
      },
    });
  });
});
