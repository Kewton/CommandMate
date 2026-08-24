/**
 * Which worktrees currently have a prompt notification card sitting on a
 * subscriber's phone (Issue #2001, made restart-durable in Issue #2057).
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
 * ## Why the mark outlives the process (Issue #2057)
 *
 * A card on a lock screen is not a live-session fact. Every other store in this
 * directory describes a tmux pane and *must* die with the server that watched
 * it; this one describes something that is still on a device the server cannot
 * see, and a restart does not take it off that device. #2001 shipped it as an
 * in-memory map anyway, and the hole that leaves is narrower than it looks but
 * real — the measurement is in the commit that added this section, and in
 * `docs/design/cross-device-notification-dismissal.md` §6.2:
 *
 *  - A plain restart does **not** lose the mark's effect. The status probe
 *    re-observes the still-open wait, `waiting-episode-state` reports that as a
 *    fresh opening edge, and the prompt push that follows re-marks the card. So
 *    the closing edge still decides `cross-device-clear`.
 *  - It is lost when that re-opening push is itself **gated**. Auto-Yes running
 *    at the moment the wait is re-observed makes `prompt-push-gate` suppress it
 *    (#1999), nothing re-marks, and the resolution then decides `no-card` — the
 *    card #2001 exists to replace stays on the other phone for good.
 *
 * So the mark is written through to `app_settings` and read back from there
 * when this process has no memory of it. The in-memory map is kept in front as
 * the process-local answer — it is on the closing edge of every wait — and both
 * layers carry the same timestamp, so the DB is a backing store and never a
 * second opinion.
 *
 * ## Why `app_settings`, and why the SQL is here
 *
 * Same trade `escalation-settings` made two files over, for the same reasons:
 * `app_settings` (migration v27) is the generic key-value table, so this adds
 * **no migration**, and the accessor lives beside its only consumer rather than
 * becoming a fourth reader of that table in `db/app-settings-db` with no shared
 * logic to gain. One row per worktree that has an outstanding card, keyed
 * {@link PROMPT_CARD_KEY_PREFIX}`<worktreeId>` — per row rather than one JSON
 * map, so marking and clearing are single statements with no read-modify-write
 * between two processes that share the database file.
 *
 * Every database call here is total: an unopenable database, a missing table or
 * a malformed value all resolve to the in-memory answer rather than throwing.
 * The callers are a push fan-out and a status probe, and neither may be
 * disturbed by storage.
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
 * Durability also does not buy the case where **no closing edge is observed at
 * all**: `observeWaitingEdge` emits nothing for a `waiting: false` poll on an
 * instance it has no episode for, so a wait that ended while the server was
 * down — or before any probe re-opened it — never reaches
 * `resolution-push-notifier` in the first place. Closing that would mean making
 * the waiting episode itself durable, which is `lib/session`'s call and not
 * this module's; it is written up as a remaining limitation in §6.2 of the
 * design note and pinned by `tests/unit/push/restart-card-state-2057.test.ts`.
 *
 * @module lib/push/prompt-card-state
 */

import { getDbInstance } from '@/lib/db/db-instance';
import { createLogger } from '@/lib/logger';

const logger = createLogger('push/prompt-card-state');

/**
 * `app_settings.key` prefix for one worktree's outstanding card.
 *
 * Safe as a prefix because `buildCompositeKey`'s precondition already holds for
 * every worktree id in this table: `isValidWorktreeId` restricts them to
 * alphanumerics, hyphens and underscores, so none can contain `:` and no id can
 * spell another id's key.
 */
export const PROMPT_CARD_KEY_PREFIX = 'push_prompt_card:';

/**
 * How long a persisted mark is believed.
 *
 * The Issue offered two existing lifetimes to copy, and **both are measurably
 * wrong here**, in opposite directions:
 *
 *  - `STRUCTURED_STATE_MAX_AGE_MS` (30 min) bounds how long a *structured claim
 *    about the present* is trusted. `provisional-turn` states in as many words
 *    that a turn running past 30 minutes is ordinary, and #1790's reminder
 *    exists precisely because waits outlive that — its threshold can be set to
 *    60 minutes from the settings screen. Copying it would expire the mark
 *    exactly for the long waits whose stale card is the most misleading.
 *  - The waiting episode has **no clock lifetime at all**:
 *    `waiting-episode-state` removes an episode only at the closing edge. So
 *    "match the episode's lifetime" resolves to "never expire", which lets a
 *    mark left by a wait that ended while the server was down ring a resolution
 *    weeks later.
 *
 * A day is the one bound this repository already commits to for "how long a
 * wait may still legitimately be open": `MAX_ESCALATION_THRESHOLD_MINUTES` is
 * 1440, i.e. an install is already allowed to say "remind me about this wait in
 * 24 hours". Past that the server is guessing about a lock screen it has not
 * been able to see for a day.
 *
 * The two failure modes are not symmetric, which is what settles the direction
 * of the rounding: too short brings the defect back (a card that lies stays on
 * the phone), while too long costs at most one silent, *accurate* "handled"
 * card, and only on an install with at least
 * {@link resolution-push-notifier!MIN_DEVICES_FOR_CROSS_DEVICE_CLEAR} devices.
 */
export const PROMPT_CARD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Reached through `globalThis` and not module scope, for the reason #1736
 * documented at length in `agent-event-state`: under `next dev` each route
 * handler is bundled separately, and a module-scoped Map would give the fan-out
 * that marks the card and the notifier that reads it one map each. That is no
 * longer silently fatal now that both bundles share the `app_settings` row, but
 * it would still make every read a database round trip on the status probe's
 * hot path, so the map stays where the rest of this directory keeps its state.
 */
declare global {
  // eslint-disable-next-line no-var
  var __promptPushCards: Map<string, number> | undefined;
}

/** worktreeId -> epoch ms the most recent prompt card was fanned out. */
const cards = globalThis.__promptPushCards ??
  (globalThis.__promptPushCards = new Map<string, number>());

function keyFor(worktreeId: string): string {
  return `${PROMPT_CARD_KEY_PREFIX}${worktreeId}`;
}

function isExpired(at: number, now: number): boolean {
  return now - at >= PROMPT_CARD_MAX_AGE_MS;
}

/** The persisted mark for one worktree, or null. Never throws. */
function readRow(worktreeId: string): number | null {
  try {
    const row = getDbInstance()
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(keyFor(worktreeId)) as { value: string } | undefined;

    if (!row) return null;
    const at = Number.parseInt(row.value, 10);
    // A value nobody can read is treated as no card: it fails towards *not*
    // spending a push, the same direction `decidePromptResolution` chose for a
    // database that cannot answer.
    return Number.isFinite(at) ? at : null;
  } catch (error) {
    logger.debug('prompt-card-read-failed', {
      worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Every persisted mark, as `[worktreeId, at]`. Never throws. */
function readAllRows(): Array<[string, number]> {
  try {
    // GLOB rather than LIKE: the prefix contains `_`, which LIKE would treat as
    // a single-character wildcard and match neighbouring keys with.
    const rows = getDbInstance()
      .prepare('SELECT key, value FROM app_settings WHERE key GLOB ?')
      .all(`${PROMPT_CARD_KEY_PREFIX}*`) as Array<{ key: string; value: string }>;

    const out: Array<[string, number]> = [];
    for (const row of rows) {
      const at = Number.parseInt(row.value, 10);
      if (Number.isFinite(at)) out.push([row.key.slice(PROMPT_CARD_KEY_PREFIX.length), at]);
    }
    return out;
  } catch (error) {
    logger.debug('prompt-card-scan-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** Write one worktree's mark through to storage. Never throws. */
function writeRow(worktreeId: string, at: number): void {
  try {
    getDbInstance()
      .prepare(`
        INSERT INTO app_settings (key, value, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .run(keyFor(worktreeId), String(at), at, at);
  } catch (error) {
    logger.debug('prompt-card-write-failed', {
      worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** @returns True when a row was actually removed. Never throws. */
function deleteRow(worktreeId: string): boolean {
  try {
    return (
      getDbInstance().prepare('DELETE FROM app_settings WHERE key = ?').run(keyFor(worktreeId))
        .changes > 0
    );
  } catch (error) {
    logger.debug('prompt-card-delete-failed', {
      worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Record that a prompt notification for this worktree has left the server.
 *
 * Idempotent by overwrite: a second prompt in the same worktree (another
 * instance, or the #1790 reminder) replaces the same card on the device, so it
 * refreshes the timestamp rather than adding an entry.
 */
export function markPromptCardShown(worktreeId: string, at: number = Date.now()): void {
  cards.set(worktreeId, at);
  writeRow(worktreeId, at);
}

/**
 * Whether a prompt card for this worktree was fanned out and not yet cleared.
 *
 * Answers from memory when this process marked it, and from `app_settings` when
 * it did not — which after a restart is every outstanding card. A mark read
 * back from storage is adopted into the map, so the next question (the second
 * closing edge for the same wait, which both producers raise) is answered
 * without a second query.
 *
 * @param now Epoch ms, overridable so a test can exercise
 *   {@link PROMPT_CARD_MAX_AGE_MS} without a fake clock.
 */
export function hasPromptCard(worktreeId: string, now: number = Date.now()): boolean {
  const at = cards.get(worktreeId) ?? readRow(worktreeId);
  if (at === null || at === undefined) return false;

  if (isExpired(at, now)) {
    // Dropped as it is read rather than by a sweep: this is the only question
    // asked about a given worktree's card, so the read is the moment the
    // expiry becomes observable, and there is nothing a background pass would
    // catch earlier.
    cards.delete(worktreeId);
    deleteRow(worktreeId);
    return false;
  }

  cards.set(worktreeId, at);
  return true;
}

/**
 * Forget this worktree's card, in memory and in storage.
 *
 * @returns True when there was one to forget — the caller uses it to tell "the
 *   wait is over and we cleared it" from "the wait is over and it never rang".
 *   True if *either* layer held one, so a mark this process only ever read back
 *   from `app_settings` still reports as cleared.
 */
export function clearPromptCard(worktreeId: string): boolean {
  const wasInMemory = cards.delete(worktreeId);
  const wasPersisted = deleteRow(worktreeId);
  return wasInMemory || wasPersisted;
}

/**
 * Drop every remembered card, from both layers. Test seam.
 *
 * CI runs with `fileParallelism: false`, so one process holds this map for the
 * whole suite: a card left behind would make the next file's first resolution
 * decide `cross-device-clear` when its own fixture never sent a prompt.
 */
export function clearAllPromptCards(): void {
  cards.clear();
  try {
    getDbInstance()
      .prepare('DELETE FROM app_settings WHERE key GLOB ?')
      .run(`${PROMPT_CARD_KEY_PREFIX}*`);
  } catch (error) {
    logger.debug('prompt-card-clear-all-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Drop only this process's memory of the cards, keeping the persisted rows.
 *
 * Test seam, and the only honest way to write down what a restart does: the
 * server comes back with every `globalThis` store empty and the database file
 * exactly as it was. `tests/unit/push/restart-card-state-2057.test.ts` uses it
 * for that and for nothing else — production code has no reason to forget a
 * mark without also clearing it.
 */
export function forgetPromptCardMemory(): void {
  cards.clear();
}

/**
 * How many worktrees have an outstanding, unexpired card. Test seam.
 *
 * Counts the union of both layers, so it reports the same number before and
 * after a restart rather than dropping to zero with the map.
 */
export function promptCardCount(now: number = Date.now()): number {
  const live = new Set<string>();
  for (const [worktreeId, at] of cards) {
    if (!isExpired(at, now)) live.add(worktreeId);
  }
  for (const [worktreeId, at] of readAllRows()) {
    if (!isExpired(at, now)) live.add(worktreeId);
  }
  return live.size;
}
