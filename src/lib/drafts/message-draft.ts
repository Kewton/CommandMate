/**
 * Where a composer's draft (the text typed but not sent) is kept in `localStorage`.
 *
 * - **Split scope** (the worktree screen, PC and phone; Issue #728):
 *   `commandmate:draft-message:<worktreeId>:<splitIndex>` — the draft follows the pane.
 * - **Instance scope** (the `/sessions` tile; Issue #4419):
 *   `commandmate:draft-message:<worktreeId>:instance:<instanceId>` — the draft follows the
 *   instance the tile shows, so what is typed for one instance of a worktree never shows in
 *   another instance's composer (the tile switches instances in place).
 *
 * @module lib/drafts/message-draft
 */

/** localStorage key prefix for draft message persistence */
export const DRAFT_STORAGE_KEY_PREFIX = 'commandmate:draft-message:';

/** Which draft a composer keeps: its pane's (split) or its instance's. */
export type DraftScope = 'split' | 'instance';

/** Issue #728: Per-(worktree, split) draft key. */
export function getSplitDraftKey(worktreeId: string, splitIndex: number): string {
  return `${DRAFT_STORAGE_KEY_PREFIX}${worktreeId}:${splitIndex}`;
}

/** Issue #4419: Per-(worktree, instance) draft key. */
export function getInstanceDraftKey(worktreeId: string, instanceId: string): string {
  return `${DRAFT_STORAGE_KEY_PREFIX}${worktreeId}:instance:${instanceId}`;
}

type DraftAppendListener = (text: string) => void;
const draftAppendListeners = new Map<string, Set<DraftAppendListener>>();

/**
 * Issue #4419: a mounted composer showing `key` hears text appended to that draft from elsewhere
 * (another `/sessions` tile of the same worktree handing a 409's text back to this instance), so its
 * state takes it in instead of overwriting it with the next keystroke's save. A `storage` event
 * does not fire in the document that wrote, hence this in-page channel. Returns the unsubscribe.
 */
export function subscribeDraftAppend(key: string, listener: DraftAppendListener): () => void {
  let listeners = draftAppendListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    draftAppendListeners.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = draftAppendListeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) draftAppendListeners.delete(key);
  };
}

/**
 * Issue #4419: put text back into a draft that is not on screen in the caller's composer (it shows
 * another instance), the way the composer takes an insert: appended after a blank line, or the
 * whole draft when it is empty. Composers showing that draft are told (see
 * {@link subscribeDraftAppend}). Best effort — `localStorage` may be unavailable.
 */
export function appendToStoredDraft(key: string, text: string): void {
  if (!text) return;
  try {
    const current = window.localStorage.getItem(key) ?? '';
    window.localStorage.setItem(key, current.trim() === '' ? text : `${current}\n\n${text}`);
  } catch {
    /* localStorage unavailable */
  }
  draftAppendListeners.get(key)?.forEach((listener) => listener(text));
}
