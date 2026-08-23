/**
 * Clear the notification a resolved wait left on the reader's *other* devices
 * (Issue #2001).
 *
 * A prompt notification fans out to every subscribed device, and each device's
 * copy is its own object: the `tag` (`<worktreeId>:prompt`) collapses cards
 * *within* one device, and `notificationclick`'s `close()` closes the card on
 * the phone that was tapped. FCM and APNs hold no cross-device state. So a
 * reader with an iPhone and an Android answers on one and the other keeps a
 * card that is now a lie — and the longer Epic #2002 succeeds at only notifying
 * when something needs doing, the more misleading a stale "needs doing" card is.
 *
 * The only channel that reaches the other device is another push. This module
 * decides whether to spend one.
 *
 * ## Why the resolution *shows* a notification instead of only closing one
 *
 * The Issue proposed a silent push whose Service Worker calls
 * `getNotifications({tag})` → `close()` and never calls `showNotification`, and
 * asked whether iOS permits it. Measured against the specs and the three engine
 * implementations, the answer is that **no engine permits it** — this is not an
 * iOS restriction. Every subscription in this app is created with
 * `userVisibleOnly: true` (`NotificationsSettings`), which is the only value
 * Chrome, Firefox and Safari accept from a web page, and it is a promise that
 * each delivered push leaves a notification on screen. Chrome answers a push
 * event that ends with nothing displayed by showing its own "This site has been
 * updated in the background" card; Firefox charges it to a per-subscription
 * silent-push quota and drops the subscription when that runs out; WebKit
 * revokes the push subscription outright. The full citation list, the rejected
 * alternatives and the numbers are in
 * `docs/design/cross-device-notification-dismissal.md`.
 *
 * So the resolution is a real notification that *replaces* the stale one: same
 * `tag`, silent, `renotify: false`, and a body that says the wait is over. The
 * card count on the device does not go up, the phone does not make a sound, and
 * the contract is kept on every engine rather than gambled with on three.
 *
 * ## Why it does not undo #1999 and #2000
 *
 * An extra push per resolved wait would give back a slice of what those two
 * Issues removed, so three conditions have to hold before one is spent, and
 * each is a reason code in the log:
 *
 *  - **A card was actually fanned out** (`prompt-card-state`). A wait Auto-Yes
 *    answered never rang anybody (#1999), so there is nothing to clear and
 *    nothing is sent. This is the condition that keeps #1999's saving intact.
 *  - **Nothing in the worktree is still waiting.** The card is per worktree, so
 *    a second instance still waiting means it is still true.
 *  - **At least {@link MIN_DEVICES_FOR_CROSS_DEVICE_CLEAR} devices are
 *    subscribed.** With one device the problem this Issue describes cannot
 *    exist, so a single-device install sends exactly as many pushes as it did
 *    before this module was written — zero extra.
 *
 * `completion` and `failure` cards are deliberately left alone; the reasoning
 * for each is in the design note under "which kinds are cleared".
 *
 * Everything here is advisory. It is called from the waiting edge, which runs
 * inside the status probe and inside the poller, and neither may be disturbed
 * by a push that failed.
 *
 * @module lib/push/resolution-push-notifier
 */

import { getDbInstance } from '@/lib/db/db-instance';
import { countPushSubscriptionsForKind } from '@/lib/db/push-subscriptions-db';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { createLogger } from '@/lib/logger';
import { hasOpenWaitingEpisode } from '@/lib/session/waiting-episode-state';
import { clearPromptCard, hasPromptCard } from './prompt-card-state';
import { notifyPushSubscribers } from './push-sender';
import { isPushConfigured } from './vapid';

const logger = createLogger('push/resolution');

/**
 * How many devices must be subscribed to the acting bucket before clearing is
 * worth a push.
 *
 * Two, because two is the smallest fleet in which the defect can occur: with
 * one subscription the device that answered is the device that holds the card,
 * and it either closed it by being tapped or is in the reader's hand. Sending
 * anyway would spend a push to replace a card on the one screen that already
 * knows — measurable cost, no information. This bound is also what makes the
 * Issue's "with one device nothing changes" criterion true by construction
 * rather than by inspection.
 */
export const MIN_DEVICES_FOR_CROSS_DEVICE_CLEAR = 2;

/** Why {@link decidePromptResolution} decided as it did. Goes into the log. */
export type ResolutionPushReason =
  /** No VAPID keys: nothing was ever sent, so nothing can be stale. */
  | 'push-unconfigured'
  /** No prompt notification was fanned out for this worktree — #1999's case. */
  | 'no-card'
  /** Another instance in this worktree is still waiting; the card is still true. */
  | 'still-waiting'
  /** Fewer than {@link MIN_DEVICES_FOR_CROSS_DEVICE_CLEAR} devices subscribed. */
  | 'single-device'
  /** A stale card is out on at least one other device: replace it. */
  | 'cross-device-clear';

export interface ResolutionPushDecision {
  /** True only for `reason: 'cross-device-clear'`. */
  send: boolean;
  reason: ResolutionPushReason;
  /**
   * How many devices are subscribed to the acting bucket. Log context, and the
   * number the `single-device` reason is about. Absent when the decision was
   * made before the count was needed.
   */
  deviceCount?: number;
}

/**
 * Whether this worktree's resolved wait is worth a clearing push.
 *
 * Pure: reads the card state, the episode store and the subscription count and
 * writes none of them, so a test can assert the reason without the fan-out and
 * {@link notifyPromptResolved} can log the same decision it acts on.
 */
export function decidePromptResolution(worktreeId: string): ResolutionPushDecision {
  if (!isPushConfigured()) {
    return { send: false, reason: 'push-unconfigured' };
  }

  if (!hasPromptCard(worktreeId)) {
    return { send: false, reason: 'no-card' };
  }

  if (hasOpenWaitingEpisode(worktreeId)) {
    return { send: false, reason: 'still-waiting' };
  }

  // A database that cannot answer is treated as a single-device install: the
  // conservative direction here is *not* sending, because the cost of a missed
  // clear is a stale card and the cost of a wrong send is a push to every
  // device plus a card where there was none.
  let deviceCount: number;
  try {
    deviceCount = countPushSubscriptionsForKind(getDbInstance(), 'prompt');
  } catch {
    return { send: false, reason: 'single-device', deviceCount: 0 };
  }

  if (deviceCount < MIN_DEVICES_FOR_CROSS_DEVICE_CLEAR) {
    return { send: false, reason: 'single-device', deviceCount };
  }

  return { send: true, reason: 'cross-device-clear', deviceCount };
}

/**
 * The worktree's display name, for the title of the replacement card.
 *
 * The same fallback `waiting-push-notifier` uses, and duplicated rather than
 * shared because that module imports this one — sharing it the other way round
 * would be an import cycle for four lines. Falling back to the id keeps the
 * replacement happening with a less readable title instead of leaving the lie
 * on screen.
 */
function resolveWorktreeName(worktreeId: string): string {
  try {
    return getWorktreeById(getDbInstance(), worktreeId)?.name ?? worktreeId;
  } catch {
    return worktreeId;
  }
}

export interface PromptResolvedInput {
  worktreeId: string;
  /**
   * The instance whose wait just ended, for the title. It makes the replacement
   * card read as the same card updated (`feature-x (claude)`) rather than as a
   * new one from somewhere else.
   */
  agentName?: string;
  /** Epoch ms the closing edge was observed. */
  at?: number;
}

/**
 * Replace this worktree's stale prompt card on every subscribed device.
 *
 * Never throws and never rejects: it is called with `void` from the waiting
 * edge, which runs inside the status API probe and inside the response poller.
 *
 * The card mark is dropped for every terminal decision — including the ones
 * that send nothing — because the wait is over either way and a mark left
 * behind would make the *next* worktree-level question answer about a card that
 * no longer exists. `still-waiting` is the one reason that keeps it: that card
 * is still on screen and still accurate.
 */
export async function notifyPromptResolved(input: PromptResolvedInput): Promise<void> {
  const { worktreeId, agentName, at = Date.now() } = input;
  const decision = decidePromptResolution(worktreeId);
  const context = {
    worktreeId,
    instanceId: agentName,
    reason: decision.reason,
    ...(decision.deviceCount !== undefined ? { deviceCount: decision.deviceCount } : {}),
  };

  if (decision.reason !== 'still-waiting') {
    clearPromptCard(worktreeId);
  }

  if (!decision.send) {
    // `single-device` is logged at info because it is the reason that explains
    // the symptom a reader would report ("my other phone still shows it") in an
    // install that has since added a second device but not re-subscribed it.
    // `no-card` and `still-waiting` are the structural defaults — the first is
    // every Auto-Yes-answered wait — so they stay at debug, exactly as #2000
    // kept its `no-fault` out of the operator's way.
    if (decision.reason === 'single-device') logger.info('resolution-push-skipped', context);
    else logger.debug('resolution-push-skipped', context);
    return;
  }

  try {
    await notifyPushSubscribers(
      {
        worktreeId,
        worktreeName: resolveWorktreeName(worktreeId),
        kind: 'prompt',
        agentName,
        resolved: true,
      },
      at
    );
    logger.info('resolution-push-sent', context);
  } catch (error) {
    logger.warn('resolution-push-failed', {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
