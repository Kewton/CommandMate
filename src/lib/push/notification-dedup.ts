/**
 * Notification debounce/dedup (Issue #1125).
 *
 * Prevents the same agent event from fanning out repeated push notifications.
 * Prompt detection is already deduped upstream (prompt-dedup.ts), but this adds
 * a second, notification-specific guard: an identical (worktree, kind, content)
 * event within a short window is suppressed. Content differs between distinct
 * completions/prompts, so genuinely new events are never dropped.
 *
 * In-memory only; a process restart may allow one duplicate (acceptable —
 * notifications are advisory, and losing dedup state never blocks a real event).
 */

import { createHash } from 'crypto';

export interface DedupEvent {
  worktreeId: string;
  /**
   * Kept as a literal union rather than imported from `push-subscriptions-db`:
   * this module is a leaf with one dependency (`crypto`), and the DB module
   * pulls in better-sqlite3. Issue #2000 added `failure`; the failure path
   * passes its episode signature as {@link content}, so the hash keys off the
   * incident's identity instead of its prose.
   */
  kind: 'prompt' | 'completion' | 'failure';
  content?: string;
}

/** Default suppression window: repeats of identical content within this are dropped. */
export const DEFAULT_DEDUP_WINDOW_MS = 30_000;

const lastSent = new Map<string, { hash: string; at: number }>();

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Returns true if a notification for this event should be sent, and records it.
 * `now` is injectable for deterministic testing.
 */
export function shouldSendNotification(
  event: DedupEvent,
  now: number = Date.now(),
  windowMs: number = DEFAULT_DEDUP_WINDOW_MS
): boolean {
  const key = `${event.worktreeId}:${event.kind}`;
  const hash = contentHash(event.content ?? '');
  const prev = lastSent.get(key);

  if (prev && prev.hash === hash && now - prev.at < windowMs) {
    return false;
  }

  lastSent.set(key, { hash, at: now });
  return true;
}

/** Clear all dedup state (for tests). */
export function resetNotificationDedup(): void {
  lastSent.clear();
}

// ============================================================================
// Episode-scoped dedup for the waiting path (Issue #1790)
// ============================================================================

/**
 * Reached through `globalThis` rather than module scope for the reason #1736
 * documented at length in `agent-event-state`: under `next dev` each route
 * handler is bundled separately, and a module-scoped Map would give the API
 * route that observes the edge and the poller that also reports it one map each
 * — the exact failure this guard exists to prevent, with no error to show for it.
 */
declare global {
  // eslint-disable-next-line no-var
  var __waitingPushDedup: Map<string, WaitingPushRecord> | undefined;
}

interface WaitingPushRecord {
  /** The episode this instance was last notified about (`WaitingEpisode.since`). */
  since: number;
  /** Whether the one permitted escalation for that episode has been sent. */
  escalated: boolean;
}

const waitingSent = globalThis.__waitingPushDedup ??
  (globalThis.__waitingPushDedup = new Map<string, WaitingPushRecord>());

/** One waiting notification, identified by the episode it belongs to. */
export interface WaitingDedupEvent {
  worktreeId: string;
  /** Instance id, normalized to the CLI tool id for the primary instance. */
  instanceId: string;
  /** The episode's `waitingSince` — its identity, not merely its age. */
  since: number;
  /** True for the escalation re-notification, which is allowed once per episode. */
  escalated?: boolean;
}

/**
 * Whether this waiting notification should be sent, recording it if so.
 *
 * Replaces the content hash for the waiting path (Issue #1790). Content was
 * never the right key here: two identical `Do you want to proceed?` prompts
 * seconds apart are two separate waits a human has to answer twice, and the
 * 30 s window dropped the second one — while a single wait that outlives the
 * window could be notified again for the same question. The episode's `since`
 * is the wait's identity, so "one notification per wait" becomes exact:
 *
 *  - first notification of an episode → sent, recorded;
 *  - any repeat for the same `since` → suppressed, however it arrived (the
 *    poller and the edge listener both report the same wait);
 *  - the escalation → allowed exactly once per episode;
 *  - a new episode (the wait ended and another began) → sent again, even if the
 *    prompt text and the elapsed time are identical.
 */
export function shouldSendWaitingPush(event: WaitingDedupEvent): boolean {
  const key = `${event.worktreeId}::${event.instanceId}`;
  const escalated = event.escalated === true;
  const prev = waitingSent.get(key);

  if (prev && prev.since === event.since && (prev.escalated || !escalated)) {
    return false;
  }

  waitingSent.set(key, { since: event.since, escalated });
  return true;
}

/** Clear the episode-scoped state (for tests). */
export function resetWaitingPushDedup(): void {
  waitingSent.clear();
}
