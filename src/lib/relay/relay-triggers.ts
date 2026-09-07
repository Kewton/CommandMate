/**
 * Where a relay is woken up (Issue #2377).
 *
 * Three edges matter, and this module is the seam each of them calls into. It
 * exists as a seam rather than as three direct calls for one concrete reason:
 * the delivery reaches `sendUserMessage`, which reaches `response-poller`, which
 * reaches `response-checker` — one of the callers below. A static import would
 * close that cycle, so every entry point here loads `relay-delivery` lazily and
 * the poller's module graph stays what it was. It is the same move
 * `stop-history-capture` makes for the transcript readers, and for the same
 * reason.
 *
 * The three edges:
 *
 *  1. **A turn ended.** {@link onRelayTurnCompleted}, called from the two places
 *     that record a finished reply — the structured-history gate (the agent's
 *     own transcript; both the Stop hook and the poller reach it) and the
 *     poller's own scrape, for the tools that keep no transcript.
 *  2. **A session stopped on a dialog.** The waiting edge, subscribed to here
 *     rather than polled: `waiting-episode-state` already makes the crossing
 *     observable exactly once, and a fourth surface keeping its own "was it
 *     waiting last time?" is precisely what #1786 exists to prevent.
 *  3. **Time passed.** The maintenance tick — expire the deadlines, retry the
 *     deliveries a busy composer refused.
 *
 * Armed by `startWaitingStatusBroadcast`, which `ws-server` calls from
 * `setupWebSocket`; disarmed with it. That is where #2357 put the model-change
 * subscription for the same reason: it is the one place in the process that
 * knows the server is up, and a suite that stands a server up and tears it down
 * leaves nothing running.
 *
 * @module lib/relay/relay-triggers
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { onWaitingTransition } from '@/lib/session/waiting-episode-state';
import { RELAY_PUMP_INTERVAL_MS } from '@/lib/relay/relay-policy';
import { createLogger } from '@/lib/logger';

const logger = createLogger('relay-triggers');

declare global {
  // eslint-disable-next-line no-var
  var __relayTriggersUnsubscribe: (() => void) | undefined;
  // eslint-disable-next-line no-var
  var __relayMaintenanceTimer: ReturnType<typeof setInterval> | undefined;
}

/**
 * Tell the relays that this instance finished a turn.
 *
 * `settled` distinguishes the two producers: `true` for a turn the agent's own
 * transcript says is closed, `false` for one judged from the screen — which is
 * what makes the quiet window in `relay-delivery` apply to exactly the tools
 * that need it.
 *
 * Fire-and-forget and never throws: this is called from inside the poller's save
 * path and from a hook receiver, and in both a relay failure must not cost the
 * turn that was just recorded.
 */
export function onRelayTurnCompleted(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  settled: boolean
): void {
  const worker = { worktreeId, cliToolId, instanceId: instanceId ?? cliToolId };
  void (async () => {
    try {
      const { notifyRelayTurnCompleted } = await import('@/lib/relay/relay-delivery');
      await notifyRelayTurnCompleted(worker, { settled });
    } catch (error) {
      logger.warn('relay-turn-trigger-failed', {
        worktreeId,
        cliToolId,
        instanceId: worker.instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}

/** Tell the relays that this instance is blocked on a confirmation. */
export function onRelayPromptWaiting(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined
): void {
  const worker = { worktreeId, cliToolId, instanceId: instanceId ?? cliToolId };
  void (async () => {
    try {
      const { notifyRelayPromptWaiting } = await import('@/lib/relay/relay-delivery');
      notifyRelayPromptWaiting(worker);
    } catch (error) {
      logger.warn('relay-prompt-trigger-failed', {
        worktreeId,
        cliToolId,
        instanceId: worker.instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}

/** Run one maintenance tick now. Exported for the suite and for the timer. */
export async function runRelayMaintenance(): Promise<void> {
  try {
    const { runRelayMaintenanceTick } = await import('@/lib/relay/relay-delivery');
    await runRelayMaintenanceTick();
  } catch (error) {
    logger.warn('relay-maintenance-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Subscribe to the waiting edge and start the maintenance loop.
 *
 * Idempotent: calling it again replaces what is already armed rather than
 * adding a second copy, so a re-entered `setupWebSocket` cannot notify twice or
 * leave two timers running.
 */
export function startRelayTriggers(): void {
  stopRelayTriggers();

  globalThis.__relayTriggersUnsubscribe = onWaitingTransition((transition) => {
    // Only the OPENING edge, and only a real dialog. `menu` is a pager or a
    // model picker — nobody is being asked anything — and `unclassified` is a
    // frame the detectors failed on, which is not something to describe to
    // another session as a question it might report to a human.
    if (!transition.waiting || transition.kind !== 'prompt') return;
    onRelayPromptWaiting(
      transition.worktreeId,
      transition.cliToolId,
      transition.instanceId
    );
  });

  const timer = setInterval(() => void runRelayMaintenance(), RELAY_PUMP_INTERVAL_MS);
  // The loop must not be the reason a process stays alive: a CLI that imported
  // this graph for one call would otherwise never exit.
  timer.unref?.();
  globalThis.__relayMaintenanceTimer = timer;
}

/** Drop the subscription and the timer. Safe when nothing is armed. */
export function stopRelayTriggers(): void {
  const unsubscribe = globalThis.__relayTriggersUnsubscribe;
  if (unsubscribe) {
    unsubscribe();
    globalThis.__relayTriggersUnsubscribe = undefined;
  }
  if (globalThis.__relayMaintenanceTimer) {
    clearInterval(globalThis.__relayMaintenanceTimer);
    globalThis.__relayMaintenanceTimer = undefined;
  }
}

/** Whether the triggers are armed. Test seam. */
export function areRelayTriggersActive(): boolean {
  return globalThis.__relayTriggersUnsubscribe !== undefined;
}
