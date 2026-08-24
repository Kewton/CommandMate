/**
 * Send a push notification when an agent starts waiting, and one reminder if it
 * is still waiting later (Issue #1790).
 *
 * ## Why this subscribes rather than detects
 *
 * The prompt notification used to be raised from one line inside the response
 * poller, which made it inherit every one of that poller's boundaries: it only
 * runs when a send-family API or Auto-Yes started it, it stops itself on the
 * first prompt of a turn, it gives up after `MAX_POLLING_DURATION`, and it can
 * only see waits the screen scraper classified as `isPrompt`. A wait that began
 * after a `tmux` keystroke, a second prompt in the same turn, a wait that only
 * the agent's own hook events reported, and a selection list were all silently
 * unnotifiable.
 *
 * #1786 made the waiting edge observable exactly once, in
 * `waiting-episode-state`, and #1788 already subscribes to it for the WebSocket
 * frame. This module is the same subscription for push — it captures no pane,
 * runs no detector, and keeps no "was it waiting last time?" of its own.
 *
 * ## The poller still notifies, and that is deliberate
 *
 * Contrary to the Issue's premise, the edge is *not* observed by a background
 * process: `observeWaitingEdge`'s only caller is `worktree-status-helper`, on
 * the worktree list / detail API probe. So the edge fires when a client is
 * looking, and moving push onto it *alone* would have swapped one blind spot
 * (no poller) for a worse one (nobody has the app open — the very situation a
 * phone notification is for). The poller therefore keeps its call, and
 * `response-checker` opens the same episode through `observeWaitingEdge` so both
 * producers name the wait identically; `shouldSendWaitingPush` then collapses
 * them to one notification. See the commit message for the measurement.
 *
 * ## Escalation
 *
 * There is no existing server-side sweep over waiting sessions to ride on, so
 * this keeps a small interval of its own. It exists only while some wait is
 * outstanding — created on the first open episode, cleared when the last one
 * closes — so an install with nothing waiting has no timer, and one that never
 * configured VAPID never even gets that far.
 *
 * Everything here is advisory: a failure must not disturb the status read that
 * observed the edge (`emit` contains listener throws) nor the poller.
 *
 * @module lib/push/waiting-push-notifier
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { createLogger } from '@/lib/logger';
import {
  getWaitingEpisode,
  onWaitingTransition,
  type WaitingTransition,
} from '@/lib/session/waiting-episode-state';
import type { WaitingKind } from '@/lib/session/waiting-kind';
import { getPushEscalationSettings } from './escalation-settings';
import { isPromptPushSuppressed } from './prompt-push-gate';
import { notifyPushSubscribers } from './push-sender';
import { notifyPromptResolved } from './resolution-push-notifier';
import { isPushConfigured } from './vapid';

const logger = createLogger('push/waiting-notifier');

/** How often outstanding waits are re-checked. Minute granularity is enough. */
export const ESCALATION_TICK_MS = 60_000;

/** A wait that has been notified once and may still earn its reminder. */
interface PendingWait {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string | undefined;
  since: number;
  kind: WaitingKind | null;
}

/**
 * Reached through `globalThis` for the reason #1736 documented: under
 * `next dev` a module-scoped value is per-bundle, so a second copy of this
 * module would register a second listener and every wait would notify twice.
 */
declare global {
  // eslint-disable-next-line no-var
  var __waitingPushUnsubscribe: (() => void) | undefined;
  // eslint-disable-next-line no-var
  var __waitingPushPending: Map<string, PendingWait> | undefined;
  // eslint-disable-next-line no-var
  var __waitingPushEscalationTimer: ReturnType<typeof setInterval> | undefined;
}

const pending = globalThis.__waitingPushPending ??
  (globalThis.__waitingPushPending = new Map<string, PendingWait>());

/**
 * The worktree's display name, for the notification title.
 *
 * Falls back to the id rather than dropping the notification: a database that
 * cannot answer is a reason to send a less readable title, not a reason to
 * leave the user waiting in silence.
 */
function resolveWorktreeName(worktreeId: string): string {
  try {
    return getWorktreeById(getDbInstance(), worktreeId)?.name ?? worktreeId;
  } catch {
    return worktreeId;
  }
}

/** Fan one waiting notification out. Never throws. */
async function sendWaitingPush(
  wait: PendingWait,
  escalated: boolean,
  now: number
): Promise<void> {
  const instanceId = wait.instanceId ?? wait.cliToolId;
  try {
    await notifyPushSubscribers(
      {
        worktreeId: wait.worktreeId,
        worktreeName: resolveWorktreeName(wait.worktreeId),
        kind: 'prompt',
        agentName: instanceId,
        instanceId,
        waitingKind: wait.kind,
        waitingSince: wait.since,
        escalated,
      },
      // The deciding tick's clock, not a fresh reading: the reminder's body
      // quotes the elapsed time this call was made on.
      now
    );
  } catch (error) {
    logger.warn('waiting-push-failed', {
      worktreeId: wait.worktreeId,
      instanceId,
      escalated,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function startEscalationTimer(): void {
  if (globalThis.__waitingPushEscalationTimer !== undefined) return;

  const timer = setInterval(() => {
    runEscalationTick();
  }, ESCALATION_TICK_MS);
  // Never hold the process open for a reminder; the server exiting is a far
  // stronger signal than "someone might still be waiting".
  (timer as { unref?: () => void }).unref?.();

  globalThis.__waitingPushEscalationTimer = timer;
}

function stopEscalationTimerIfIdle(): void {
  if (pending.size > 0) return;
  const timer = globalThis.__waitingPushEscalationTimer;
  if (timer !== undefined) {
    clearInterval(timer);
    globalThis.__waitingPushEscalationTimer = undefined;
  }
}

/**
 * Handle one crossing of the waiting edge.
 *
 * Exported for tests, which drive it directly rather than through the
 * subscription so a failure points at this function and not at #1786's store.
 */
export function handleWaitingTransition(transition: WaitingTransition): void {
  // Nothing downstream can do anything without VAPID keys, so an install
  // without push does not track waits, does not read the database and does not
  // start a timer — it is inert rather than merely quiet.
  if (!isPushConfigured()) return;

  const key = buildCompositeKey(transition.worktreeId, transition.cliToolId, transition.instanceId);

  if (!transition.waiting || transition.since === null) {
    pending.delete(key);
    stopEscalationTimerIfIdle();
    // Issue #2001: this is the moment the notification on every *other* device
    // stopped being true. It is the only edge that sees it — the poller closes
    // the episode here (`response-checker`) and so does the status probe
    // (`worktree-status-helper`), so hooking the edge covers both producers the
    // way #1790 already does for the opening one. Fire-and-forget: the notifier
    // never rejects, and the `void` keeps the synchronous listener contract
    // `emit` relies on.
    void notifyPromptResolved({
      worktreeId: transition.worktreeId,
      agentName: transition.instanceId ?? transition.cliToolId,
      at: transition.at,
    });
    return;
  }

  const wait: PendingWait = {
    worktreeId: transition.worktreeId,
    cliToolId: transition.cliToolId,
    instanceId: transition.instanceId,
    since: transition.since,
    kind: transition.kind,
  };

  // Issue #1999: the wait is tracked and the reminder armed either way — only
  // the notification is gated. Dropping the wait from `pending` instead would
  // discard the escalation that makes the suppression safe, and the gate has to
  // run before `sendWaitingPush` because `shouldSendWaitingPush` records the
  // episode at the moment it decides to send.
  pending.set(key, wait);
  startEscalationTimer();

  if (
    isPromptPushSuppressed({
      worktreeId: wait.worktreeId,
      cliToolId: wait.cliToolId,
      instanceId: wait.instanceId,
      waitingSince: wait.since,
    })
  ) {
    return;
  }

  void sendWaitingPush(wait, false, transition.at);
}

/**
 * Re-notify every wait that has outlived the threshold, once each.
 *
 * Exported so tests can advance a fake clock instead of a real minute.
 */
export function runEscalationTick(now: number = Date.now()): void {
  if (pending.size === 0) {
    stopEscalationTimerIfIdle();
    return;
  }

  const settings = getPushEscalationSettings();
  const thresholdMs = settings.thresholdMinutes * 60_000;

  for (const [key, wait] of Array.from(pending)) {
    // The episode store, not this map, is the authority on whether the wait is
    // still going: it is written by the status probe, so an answer given in
    // another tab — or a wait whose closing edge this module never saw — is
    // caught here even when `pending` still lists it.
    const episode = getWaitingEpisode(wait.worktreeId, wait.cliToolId, wait.instanceId);
    if (episode === null || episode.since !== wait.since) {
      pending.delete(key);
      continue;
    }

    if (!settings.enabled) continue;
    if (now - wait.since < thresholdMs) continue;

    // Issue #1999: the same gate, asked with `escalated`. It never suppresses a
    // reminder — the episode check above has already proved Auto-Yes did not
    // resolve this wait — but routing the reminder through it keeps the rule in
    // one place and puts the decision in the log next to the opening edge's.
    // The wait is left in `pending` if it ever does suppress, so a later tick
    // can reconsider rather than losing the reminder outright.
    if (
      isPromptPushSuppressed({
        worktreeId: wait.worktreeId,
        cliToolId: wait.cliToolId,
        instanceId: wait.instanceId,
        waitingSince: wait.since,
        escalated: true,
      })
    ) {
      continue;
    }

    // Dropped before sending, not after: the reminder is once per episode, and
    // an in-flight fan-out must not be able to earn a second one.
    pending.delete(key);
    void sendWaitingPush({ ...wait, kind: episode.kind ?? wait.kind }, true, now);
  }

  stopEscalationTimerIfIdle();
}

/**
 * Subscribe to the waiting edge.
 *
 * Idempotent by replacement, like #1788's broadcast: calling it again drops the
 * previous subscription rather than adding a second one, so a module evaluated
 * twice cannot double-notify.
 *
 * @returns The unsubscribe function (also reachable as
 *   {@link stopWaitingPushNotifier}).
 */
export function startWaitingPushNotifier(): () => void {
  stopWaitingPushNotifier();

  const unsubscribe = onWaitingTransition((transition) => {
    handleWaitingTransition(transition);
  });

  globalThis.__waitingPushUnsubscribe = unsubscribe;
  return unsubscribe;
}

/**
 * Drop the subscription, the outstanding waits and the timer. Safe when none is
 * active, and the seam a test uses to leave no interval behind (CI runs the
 * whole suite in one process).
 */
export function stopWaitingPushNotifier(): void {
  const existing = globalThis.__waitingPushUnsubscribe;
  if (existing) {
    existing();
    globalThis.__waitingPushUnsubscribe = undefined;
  }
  pending.clear();
  stopEscalationTimerIfIdle();
}

/** Whether a subscription is currently active. Test seam. */
export function isWaitingPushNotifierActive(): boolean {
  return globalThis.__waitingPushUnsubscribe !== undefined;
}

/** How many waits are awaiting their reminder. Test seam. */
export function pendingEscalationCount(): number {
  return pending.size;
}
