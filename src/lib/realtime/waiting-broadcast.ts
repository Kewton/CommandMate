/**
 * Push the waiting edge to every subscriber of a worktree room (Issue #1788).
 *
 * ## Why this file exists rather than a detector
 *
 * Issue #1786 made the false→true / true→false crossing observable exactly once,
 * in `waiting-episode-state`, and handed out `onWaitingTransition` for the
 * surfaces that need the instant rather than the level. This module is that
 * subscription and nothing more: it translates a {@link WaitingTransition} into
 * a {@link SessionStatusEvent} and publishes it. It does not capture a pane, does
 * not read the structured events, and does not keep a "was it waiting last
 * time?" of its own — three surfaces each keeping their own answer to that is
 * precisely what #1786 exists to prevent.
 *
 * Because it subscribes to the edge and not to the response poller, a wait that
 * only the agent's own hook events could see (#1725) broadcasts exactly like one
 * the screen scraper read, and a wait that lasts twenty minutes broadcasts once.
 *
 * ## Why `publish` is injected
 *
 * `ws-server` owns the rooms and starts this subscription from
 * `setupWebSocket`, so importing `broadcast` here would close an import cycle
 * (ws-server → waiting-broadcast → ws-server). Taking the publisher as an
 * argument also makes the translation testable without standing up a server.
 *
 * ## Authorization
 *
 * None is bypassed. The publisher is the room broadcaster, and a socket only
 * joins a room through the authenticated `subscribe` path (#331/#332): a client
 * that never subscribed to a worktree still never hears about it.
 *
 * @module lib/realtime/waiting-broadcast
 */

import type { SessionStatusEvent } from '@/lib/realtime/types';
import {
  onWaitingTransition,
  type WaitingTransition,
} from '@/lib/session/waiting-episode-state';

/** Signature of the room broadcaster this module publishes through. */
export type WaitingBroadcastPublisher = (worktreeId: string, data: unknown) => void;

/**
 * Reached through `globalThis` for the reason spelled out in `agent-event-state`
 * and repeated by #1736: under `next dev` a module-scoped variable is per-bundle,
 * so a second `setupWebSocket` in another bundle would register a second
 * listener and every client would get each waiting edge twice.
 */
declare global {
  // eslint-disable-next-line no-var
  var __waitingStatusBroadcastUnsubscribe: (() => void) | undefined;
}

/**
 * Translate a waiting crossing into the frame clients receive.
 *
 * `isRunning` is deliberately omitted — see the field's doc on
 * {@link SessionStatusEvent}. `instance` is normalized to the instance id the
 * per-instance status map is keyed by (the CLI tool id for the primary), so a
 * client can look the entry up without re-deriving the convention.
 */
export function buildWaitingStatusEvent(transition: WaitingTransition): SessionStatusEvent {
  return {
    type: 'session_status_changed',
    worktreeId: transition.worktreeId,
    cliTool: transition.cliToolId,
    instance: transition.instanceId ?? transition.cliToolId,
    isWaitingForResponse: transition.waiting,
    waitingKind: transition.kind ?? null,
    waitingSince: transition.since,
  };
}

/**
 * Subscribe to the waiting edge and publish it to the worktree's room.
 *
 * Idempotent: calling it again replaces the previous subscription rather than
 * adding a second one, so a re-entered `setupWebSocket` cannot double-send.
 *
 * @param publish - Room broadcaster, normally `ws-server`'s internal one.
 * @returns The unsubscribe function (also reachable as
 *   {@link stopWaitingStatusBroadcast}).
 */
export function startWaitingStatusBroadcast(publish: WaitingBroadcastPublisher): () => void {
  stopWaitingStatusBroadcast();

  const unsubscribe = onWaitingTransition((transition) => {
    publish(transition.worktreeId, buildWaitingStatusEvent(transition));
  });

  globalThis.__waitingStatusBroadcastUnsubscribe = unsubscribe;
  return unsubscribe;
}

/**
 * Drop the subscription, if any. Safe to call when none is active — and called
 * from `closeWebSocket`, so a suite that stands a server up and tears it down
 * does not leave a listener pointed at a dead room map.
 */
export function stopWaitingStatusBroadcast(): void {
  const existing = globalThis.__waitingStatusBroadcastUnsubscribe;
  if (existing) {
    existing();
    globalThis.__waitingStatusBroadcastUnsubscribe = undefined;
  }
}

/** Whether a subscription is currently active. Test seam. */
export function isWaitingStatusBroadcastActive(): boolean {
  return globalThis.__waitingStatusBroadcastUnsubscribe !== undefined;
}
