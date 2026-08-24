/**
 * Which worktrees currently have a prompt notification card sitting on a
 * subscriber's phone (Issue #2001).
 *
 * ## Why this has to exist at all
 *
 * The cross-device dismissal costs one extra push per resolved wait, and Epic
 * #2002 exists to make the phone quieter — #1999 removed the Auto-Yes prompts
 * and #2000 narrowed the default kinds. A resolution push sent for a wait that
 * never rang would hand a chunk of that back for nothing. So the resolution is
 * conditional on a card actually being out there, and something has to know.
 *
 * Nothing already did. `notification-dedup` remembers which *episode* was
 * notified, keyed per instance, and it never forgets — it is a "have I said
 * this already" store, not a "is it still on screen" one. The card is a
 * different object: it is keyed by **worktree**, because that is the shape of
 * the Service Worker `tag` (`<worktreeId>:prompt`, built in `push-sender`), so
 * two instances waiting in one worktree leave exactly one card, and the second
 * instance's notification replaces the first one's rather than stacking.
 *
 * ## Where it is written
 *
 * Marked in `notifyPushSubscribers`, past the point where the fan-out knows a
 * payload is really going to at least one device — so a dedup drop, a missing
 * VAPID config or an empty subscription table records nothing, and the
 * resolution for that wait is correctly skipped. Cleared by
 * `resolution-push-notifier` when the wait closes, whether or not it decided to
 * send. There is exactly one writer per direction.
 *
 * ## Accuracy, and what it deliberately does not model
 *
 * This tracks what the *server* sent, not what each device still displays. A
 * reader who taps or swipes the card away on one phone has closed it there and
 * the server cannot know. That is the residual imprecision documented in
 * `docs/design/cross-device-notification-dismissal.md`: on such a device the
 * resolution arrives as a new (silent, accurate) card instead of replacing one.
 * Modelling per-device state would need the devices to report back, which is a
 * round trip per notification for a card that costs nothing to replace.
 *
 * In-memory via `globalThis`, like every other live-session store here (see the
 * note in `agent-event-state` for the `next dev` bundling reason). One entry
 * per worktree that has an outstanding card, so the map is bounded by the
 * number of worktrees, and each entry is removed when its wait closes.
 *
 * @module lib/push/prompt-card-state
 */

/**
 * Reached through `globalThis` and not module scope, for the reason #1736
 * documented at length in `agent-event-state`: under `next dev` each route
 * handler is bundled separately, and a module-scoped Map would give the fan-out
 * that marks the card and the notifier that reads it one map each — so every
 * resolution would decide `no-card` and the feature would be silently inert.
 */
declare global {
  // eslint-disable-next-line no-var
  var __promptPushCards: Map<string, number> | undefined;
}

/** worktreeId -> epoch ms the most recent prompt card was fanned out. */
const cards = globalThis.__promptPushCards ??
  (globalThis.__promptPushCards = new Map<string, number>());

/**
 * Record that a prompt notification for this worktree has left the server.
 *
 * Idempotent by overwrite: a second prompt in the same worktree (another
 * instance, or the #1790 reminder) replaces the same card on the device, so it
 * refreshes the timestamp rather than adding an entry.
 */
export function markPromptCardShown(worktreeId: string, at: number = Date.now()): void {
  cards.set(worktreeId, at);
}

/** Whether a prompt card for this worktree was fanned out and not yet cleared. */
export function hasPromptCard(worktreeId: string): boolean {
  return cards.has(worktreeId);
}

/**
 * Forget this worktree's card.
 *
 * @returns True when there was one to forget — the caller uses it to tell "the
 *   wait is over and we cleared it" from "the wait is over and it never rang".
 */
export function clearPromptCard(worktreeId: string): boolean {
  return cards.delete(worktreeId);
}

/**
 * Drop every remembered card. Test seam.
 *
 * CI runs with `fileParallelism: false`, so one process holds this map for the
 * whole suite: a card left behind would make the next file's first resolution
 * decide `cross-device-clear` when its own fixture never sent a prompt.
 */
export function clearAllPromptCards(): void {
  cards.clear();
}

/** How many worktrees have an outstanding card. Test seam. */
export function promptCardCount(): number {
  return cards.size;
}
