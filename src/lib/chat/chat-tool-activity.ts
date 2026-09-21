/**
 * Whether the chat surface is showing tool activity, remembered per browser
 * (Issue #2284).
 *
 * ## What "tool activity" means here
 *
 * Three folded things on one surface: the trailing `Tool calls (N)` section
 * (#2234, folded by `splitToolLog`), the `Thinking` section (#2272, folded by
 * `splitChatThinking`) and the run of approval dialogs (#2245,
 * `ChatToolApprovalGroup`). They are all the same KIND of thing — a subordinate
 * log the reader may want and does not want first — so they answer to ONE
 * control rather than to three, and that control's position is what this module
 * stores.
 *
 * ## Why localStorage and not `app_settings`
 *
 * This is a reading preference belonging to a pair of eyes, not to a worktree
 * or to the server: the same account reading from a phone and from a desktop
 * wants different answers, and a round trip would make the first paint of every
 * transcript wait on a fetch. `commandmate:showArchived` (#168) and
 * `commandmate:historyUserOnly` (#725) are stored the same way for the same
 * reason, down to the `'true'` / `'false'` representation.
 *
 * Every access is wrapped: a browser with site data blocked throws on the
 * property access itself, and a transcript that cannot remember a chevron must
 * still render.
 *
 * ## One value for every reader on the page (Issue #2821)
 *
 * The answer used to be read ONCE per transcript, at mount. That was fine while
 * the only control sat inside the transcript it governed, and it stopped being
 * fine twice over: the PC can show up to four transcripts side by side, and the
 * phone's control lives in the surface pill (`MobileTerminalTab`) rather than
 * in the transcript at all. {@link useChatToolActivityPreference} is the one
 * reader now — every mounted transcript and the pill subscribe to the same
 * value, so moving any one control moves all of them in the same render, and a
 * change made in another tab arrives through the `storage` event.
 */

import { useSyncExternalStore } from 'react';

/** localStorage key for the chat surface's tool-activity toggle. */
export const CHAT_TOOL_ACTIVITY_STORAGE_KEY = 'commandmate:chatShowToolActivity';

/**
 * What the reader last chose, or the default.
 *
 * Default **folded**: the Issue's whole point is that a reply is what a row
 * opens with, and any value other than the literal `'true'` — a missing key, a
 * legacy `'1'`, a half-written value — means folded rather than throwing.
 */
export function readChatToolActivityPreference(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Remember the reader's choice. Silently a no-op where storage is unavailable. */
export function writeChatToolActivityPreference(showAll: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY, String(showAll));
  } catch {
    /* storage unavailable — the toggle still works for this mount */
  }
}

// ============================================================================
// The page-wide store behind the hook (Issue #2821)
// ============================================================================

/**
 * The page's copy of the answer, or `null` before anything has read it.
 *
 * Kept here rather than re-read from localStorage on every snapshot, because a
 * browser that refuses storage must still be able to flip the toggle: the write
 * is a no-op there, and a snapshot that re-read storage would snap straight
 * back to folded. Dropped when the last subscriber leaves, so the next mount
 * starts again from what is stored.
 */
let currentPreference: boolean | null = null;

/** Every mounted reader, notified after each change. */
const subscribers = new Set<() => void>();

function notifySubscribers(): void {
  for (const listener of Array.from(subscribers)) listener();
}

function getPreferenceSnapshot(): boolean {
  if (currentPreference === null) currentPreference = readChatToolActivityPreference();
  return currentPreference;
}

/** The server has no storage; folded is the default the client starts from too. */
function getServerPreferenceSnapshot(): boolean {
  return false;
}

/** Another tab wrote the key (or cleared storage, which reports `key === null`). */
function handleStorageEvent(event: StorageEvent): void {
  if (event.key !== null && event.key !== CHAT_TOOL_ACTIVITY_STORAGE_KEY) return;
  currentPreference = readChatToolActivityPreference();
  notifySubscribers();
}

function subscribeToPreference(listener: () => void): () => void {
  subscribers.add(listener);
  if (subscribers.size === 1) window.addEventListener('storage', handleStorageEvent);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) {
      window.removeEventListener('storage', handleStorageEvent);
      currentPreference = null;
    }
  };
}

/** Flip the page's answer, remember it, and tell every reader. */
function toggleChatToolActivityPreference(): void {
  const next = !getPreferenceSnapshot();
  currentPreference = next;
  writeChatToolActivityPreference(next);
  notifySubscribers();
}

/**
 * The tool-activity answer, shared by every reader on the page (Issue #2821).
 *
 * Returns `[showAll, toggle]`. The first read happens during render — not in an
 * effect — for the reason `ChatTranscript` gives: an effect would paint every
 * chip closed and then open them. `toggle` is a stable module function, so it
 * is safe in a dependency list and never re-renders a memoised child.
 */
export function useChatToolActivityPreference(): readonly [boolean, () => void] {
  const showAll = useSyncExternalStore(
    subscribeToPreference,
    getPreferenceSnapshot,
    getServerPreferenceSnapshot,
  );
  return [showAll, toggleChatToolActivityPreference];
}
