/**
 * Where a composer's draft (the text typed but not sent) is kept in `localStorage`.
 *
 * - **Split scope** (the worktree screen, PC and phone; Issue #728):
 *   `commandmate:draft-message:<worktreeId>:<splitIndex>` — the draft follows the pane.
 * - **Instance scope** (the `/sessions` tile; Issue #4419):
 *   `commandmate:draft-message:<worktreeId>:instance:<instanceId>` — the draft follows the
 *   instance the tile shows, so what is typed for one instance of a worktree never shows in
 *   another instance's composer (the tile switches instances in place).
 * - **Retarget holds** (Issue #4535): `commandmate:draft-message:<worktreeId>:retarget-hold` —
 *   texts the send fence handed back, with the target they were going to (see {@link RetargetHold}).
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

/**
 * Issue #4535 (段 2 §3.2, S2-Q5 (b)): a text the send fence (#4534, 409 `SEND_TARGET_CHANGED`
 * `not_sent`) handed back to the composer on screen, with the target it was going to. While a
 * composer's To is not that target (its instance or its tool), the composer asks before sending a
 * draft that holds this text: one press must not send it to the target that replaced the original.
 */
export interface RetargetHold {
  text: string;
  instanceId: string;
  cliToolId: string;
}

/** At most this many holds are kept per worktree (the oldest goes first). */
const RETARGET_HOLD_LIMIT = 20;

/** Issue #4535: where a worktree's {@link RetargetHold}s are kept (every composer of it reads them). */
export function getRetargetHoldKey(worktreeId: string): string {
  return `${DRAFT_STORAGE_KEY_PREFIX}${worktreeId}:retarget-hold`;
}

/** Issue #4535: the worktree's holds. Best effort — `localStorage` may be unavailable or hold junk. */
export function readRetargetHolds(worktreeId: string): RetargetHold[] {
  try {
    const raw = window.localStorage.getItem(getRetargetHoldKey(worktreeId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (hold): hold is RetargetHold =>
        typeof hold === 'object' &&
        hold !== null &&
        typeof (hold as RetargetHold).text === 'string' &&
        (hold as RetargetHold).text !== '' &&
        typeof (hold as RetargetHold).instanceId === 'string' &&
        typeof (hold as RetargetHold).cliToolId === 'string',
    );
  } catch {
    return [];
  }
}

function writeRetargetHolds(worktreeId: string, holds: RetargetHold[]): boolean {
  try {
    if (holds.length === 0) window.localStorage.removeItem(getRetargetHoldKey(worktreeId));
    else window.localStorage.setItem(getRetargetHoldKey(worktreeId), JSON.stringify(holds.slice(-RETARGET_HOLD_LIMIT)));
    return true;
  } catch {
    /* localStorage unavailable */
    return false;
  }
}

/**
 * Issue #4535: remember a handed-back text and its original target (a hold of the same text is
 * replaced). Returns whether the hold was kept — false when `localStorage` cannot take it; then the
 * caller must not hand the text back (review H4: fail-closed, a composer without the hold would
 * send it to a changed To on one press).
 */
export function holdRetargetedText(worktreeId: string, hold: RetargetHold): boolean {
  if (!hold.text) return false;
  if (!writeRetargetHolds(worktreeId, [...readRetargetHolds(worktreeId).filter((h) => h.text !== hold.text), hold])) {
    return false;
  }
  return readRetargetHolds(worktreeId).some(
    (h) => h.text === hold.text && h.instanceId === hold.instanceId && h.cliToolId === hold.cliToolId,
  );
}

/** Issue #4535: the holds a draft about to be sent carries — those whose text is the draft (whole). */
export function findRetargetHolds(worktreeId: string, draft: string): RetargetHold[] {
  return readRetargetHolds(worktreeId).filter((hold) => hold.text === draft);
}

/** Issue #4535: a draft was sent — the holds it carried go (it reached the target it was sent to). */
export function releaseRetargetHolds(worktreeId: string, draft: string): void {
  const holds = readRetargetHolds(worktreeId);
  const left = holds.filter((hold) => hold.text !== draft);
  if (left.length !== holds.length) writeRetargetHolds(worktreeId, left);
}
