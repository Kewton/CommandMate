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
  kind: 'prompt' | 'completion';
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
