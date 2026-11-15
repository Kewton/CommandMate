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

/**
 * Issue #4419: put text back into a draft that is not on screen (its composer shows another
 * instance), the way the composer takes an insert: appended after a blank line, or the whole
 * draft when it is empty. Best effort — `localStorage` may be unavailable.
 */
export function appendToStoredDraft(key: string, text: string): void {
  if (!text) return;
  try {
    const current = window.localStorage.getItem(key) ?? '';
    window.localStorage.setItem(key, current.trim() === '' ? text : `${current}\n\n${text}`);
  } catch {
    /* localStorage unavailable */
  }
}
