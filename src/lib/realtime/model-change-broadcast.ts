/**
 * What happens when an agent instance changes model (Issue #2357).
 *
 * ## The edge, and its three receivers
 *
 * `agent-event-state` judges the model edge — the merged hook/frame value moving
 * from one model to another, with the first sighting, the value going quiet
 * and a spelling change all ruled out there — and hands it out through
 * `onAgentModelChange`. This module is that subscription, and it is the ONE
 * subscription: the three things the Issue asks for on the receiving side are
 * fanned out from here, in the order that leaves the most durable trace first.
 *
 *  1. **The history row.** One assistant row in `chat_messages`, in the
 *     readers' language, so the chat transcript and the History tab both keep
 *     "the model changed from A to B" where the conversation is. Written
 *     first, because it is the receiver that survives a phone being off.
 *  2. **The room frames.** The row is pushed as a `message` frame — the same
 *     frame `sendUserMessage` publishes — so a transcript that is open shows
 *     the line without waiting for its poll; then the `model_changed` frame
 *     itself, which is what the phone's session row turns amber on.
 *  3. **The push.** `notifyModelChangePush`, fire-and-forget; it has its own
 *     dedup and its own logging.
 *
 * Each receiver is wrapped separately: a database that cannot be written must
 * not cost the reader the socket frame, and a socket with no owner must not
 * cost them the push.
 *
 * ## Why `publish` is injected, and who arms this
 *
 * The same shape as `waiting-broadcast`, and armed by it: `ws-server` owns the
 * rooms and calls `startWaitingStatusBroadcast(handleBroadcast)` from
 * `setupWebSocket`, which is the one place in the process that knows which
 * bundle's `rooms` a frame has to reach. That call now arms this subscription
 * too, with the same publisher, and `stopWaitingStatusBroadcast` (from
 * `closeWebSocket`) disarms both — so the listener's lifetime is the server's,
 * and a suite that stands a server up and tears it down leaves nothing pointed
 * at a dead room map.
 *
 * ## Authorization
 *
 * None is bypassed: the publisher is the room broadcaster, and a socket only
 * joins a room through the authenticated `subscribe` path.
 *
 * @module lib/realtime/model-change-broadcast
 */

import { getDbInstance } from '@/lib/db/db-instance';
import { createModelChangeMessage } from '@/lib/db/chat-db';
import { createLogger } from '@/lib/logger';
import {
  buildModelChangedSentence,
  notifyModelChangePush,
  resolveReadersLocale,
} from '@/lib/push/model-change-push-notifier';
import { MODEL_CHANGED_EVENT_TYPE, type ModelChangedEvent } from '@/lib/realtime/types';
import { onAgentModelChange, type AgentModelChange } from '@/lib/session/agent-event-state';

const logger = createLogger('model-change-broadcast');

/** Signature of the room broadcaster this module publishes through. */
export type ModelChangeBroadcastPublisher = (worktreeId: string, data: unknown) => void;

/**
 * Reached through `globalThis` for the reason `waiting-broadcast` gives: under
 * `next dev` a module-scoped variable is per-bundle, and a second
 * `setupWebSocket` in another bundle would register a second listener and
 * every change would be written and pushed twice.
 */
declare global {
  // eslint-disable-next-line no-var
  var __modelChangeBroadcastUnsubscribe: (() => void) | undefined;
}

/**
 * Translate a model edge into the frame clients receive.
 *
 * Field for field the producer's record; `instance` is already resolved there
 * (`instanceId ?? cliToolId`), so a client can match it against its own pane
 * without re-deriving the convention.
 */
export function buildModelChangedEvent(change: AgentModelChange): ModelChangedEvent {
  return {
    type: MODEL_CHANGED_EVENT_TYPE,
    worktreeId: change.worktreeId,
    cliTool: change.cliToolId,
    instance: change.instanceId,
    from: change.from,
    to: change.to,
    source: change.source,
    at: change.at,
  };
}

/**
 * Write the history row and hand back the `message` frame for it, or null
 * when the database could not take it.
 *
 * Never throws. The sentence is localized once, for the readers' registered
 * language (`resolveReadersLocale`) — a stored row cannot be re-rendered per
 * viewer the way the push body is.
 */
function recordModelChangeHistory(change: AgentModelChange): Record<string, unknown> | null {
  try {
    const db = getDbInstance();
    const locale = resolveReadersLocale(db);
    const message = createModelChangeMessage(db, {
      worktreeId: change.worktreeId,
      cliToolId: change.cliToolId,
      instanceId: change.instanceId,
      content: buildModelChangedSentence(locale, change.from, change.to),
      at: change.at,
    });
    return { type: 'message', worktreeId: change.worktreeId, message };
  } catch (error) {
    logger.warn('model-change-history-failed', {
      worktreeId: change.worktreeId,
      instanceId: change.instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Deliver one edge to all three receivers. Exported so a suite can drive the
 * fan-out without a live subscription; never throws.
 */
export function handleAgentModelChange(
  change: AgentModelChange,
  publish: ModelChangeBroadcastPublisher
): void {
  logger.info('model-changed', {
    worktreeId: change.worktreeId,
    cliToolId: change.cliToolId,
    instanceId: change.instanceId,
    from: change.from,
    to: change.to,
    source: change.source,
  });

  const messageFrame = recordModelChangeHistory(change);

  try {
    if (messageFrame) publish(change.worktreeId, messageFrame);
    publish(change.worktreeId, buildModelChangedEvent(change));
  } catch (error) {
    logger.warn('model-change-broadcast-failed', {
      worktreeId: change.worktreeId,
      instanceId: change.instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Fire-and-forget: `notifyModelChangePush` contains its own failures and
  // logs its own decision, and nothing here has anything to do with the result.
  void notifyModelChangePush(change);
}

/**
 * Subscribe to the model edge and fan it out.
 *
 * Idempotent: calling it again replaces the previous subscription rather than
 * adding a second one, so a re-entered `setupWebSocket` cannot double-send.
 *
 * @param publish - Room broadcaster, normally `ws-server`'s internal one.
 * @returns The unsubscribe function (also reachable as
 *   {@link stopModelChangeBroadcast}).
 */
export function startModelChangeBroadcast(publish: ModelChangeBroadcastPublisher): () => void {
  stopModelChangeBroadcast();

  const unsubscribe = onAgentModelChange((change) => {
    handleAgentModelChange(change, publish);
  });

  globalThis.__modelChangeBroadcastUnsubscribe = unsubscribe;
  return unsubscribe;
}

/**
 * Drop the subscription, if any. Safe to call when none is active — and called
 * from `stopWaitingStatusBroadcast`, i.e. from `closeWebSocket`.
 */
export function stopModelChangeBroadcast(): void {
  const existing = globalThis.__modelChangeBroadcastUnsubscribe;
  if (existing) {
    existing();
    globalThis.__modelChangeBroadcastUnsubscribe = undefined;
  }
}

/** Whether a subscription is currently active. Test seam. */
export function isModelChangeBroadcastActive(): boolean {
  return globalThis.__modelChangeBroadcastUnsubscribe !== undefined;
}
