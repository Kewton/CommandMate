/**
 * Where a composer's draft (the text typed but not sent) is kept in `localStorage`.
 *
 * - **Split scope** (the worktree screen, PC and phone; Issue #728):
 *   `commandmate:draft-message:<worktreeId>:<splitIndex>` — the draft follows the pane.
 * - **Instance scope** (the `/sessions` tile; Issue #4419):
 *   `commandmate:draft-message:<worktreeId>:instance:<instanceId>` — the draft follows the
 *   instance the tile shows, so what is typed for one instance of a worktree never shows in
 *   another instance's composer (the tile switches instances in place).
 * - **Retarget tags** (Issue #4535 r7): `<draftKey>:retarget` — next to a draft, the tags of the texts
 *   the send fence handed back into it, each naming the target its text was going to (see
 *   {@link RetargetTag}). They belong to that draft alone: no table is shared by the worktree.
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

/** Issue #4535: a send's target — its instance and its tool (段 2 §3.2: both are compared). */
export interface RetargetTarget {
  instanceId: string;
  cliToolId: string;
}

/**
 * Issue #4535 r7 (INV-V2a, 設計書 §3.4.1): the tag of one text the send fence (#4534, 409
 * `SEND_TARGET_CHANGED` `not_sent`) handed back — made when it is handed back, naming the target the
 * text was going to. The composer the text goes into keeps it (state, and next to its draft); while
 * that composer's To is not `original`, it asks before sending (INV-V2c), whatever the draft holds;
 * only its own send lets the tag go (INV-V2b).
 */
export interface RetargetTag {
  id: string;
  original: RetargetTarget;
}

/** Issue #4535 r7 (INV-V2a): a fence's text and its tag — handed back as one value, never apart. */
export interface RetargetedText {
  text: string;
  tag: RetargetTag;
}

let retargetTagSeq = 0;

/** Issue #4535 r7: a new tag for a text handed back now (`crypto.randomUUID` is not on plain http). */
export function newRetargetTag(original: RetargetTarget): RetargetTag {
  retargetTagSeq += 1;
  const id = `${Date.now().toString(36)}-${retargetTagSeq.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return { id, original: { instanceId: original.instanceId, cliToolId: original.cliToolId } };
}

/** Issue #4535 r7: where a draft's {@link RetargetTag}s are kept — next to it. */
export function getRetargetTagKey(draftKey: string): string {
  return `${draftKey}:retarget`;
}

function isRetargetTag(value: unknown): value is RetargetTag {
  if (typeof value !== 'object' || value === null) return false;
  const { id, original } = value as { id?: unknown; original?: unknown };
  if (typeof id !== 'string' || id === '' || typeof original !== 'object' || original === null) return false;
  const { instanceId, cliToolId } = original as { instanceId?: unknown; cliToolId?: unknown };
  return typeof instanceId === 'string' && typeof cliToolId === 'string';
}

/** Issue #4535 r7: a draft's stored tags. Best effort — `localStorage` may be unavailable or hold junk. */
export function readRetargetTags(draftKey: string): RetargetTag[] {
  try {
    const raw = window.localStorage.getItem(getRetargetTagKey(draftKey));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isRetargetTag) : [];
  } catch {
    return [];
  }
}

/** Issue #4607: a draft's stored tags, and whether the store could be read at all. */
export interface RetargetTagState {
  tags: RetargetTag[];
  /** False when the store could not be read (it threw, or holds what is not a list of tags). */
  known: boolean;
}

/**
 * Issue #4607 (INV-V2c'): the stored tags for the send's check. Unlike {@link readRetargetTags}
 * (junk reads as no tags), a store that throws or holds junk — broken JSON, not an array, an element
 * of another shape — is `known: false`, so the send asks. No key is no tags, known.
 */
export function readRetargetTagState(draftKey: string): RetargetTagState {
  try {
    const raw = window.localStorage.getItem(getRetargetTagKey(draftKey));
    if (raw === null) return { tags: [], known: true };
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isRetargetTag)) return { tags: [], known: false };
    return { tags: parsed, known: true };
  } catch {
    return { tags: [], known: false };
  }
}

/** `a` with the tags of `b` it does not have yet (by id), in order. */
export function mergeRetargetTags(a: readonly RetargetTag[], b: readonly RetargetTag[]): RetargetTag[] {
  const ids = new Set(a.map((tag) => tag.id));
  return [...a, ...b.filter((tag) => !ids.has(tag.id))];
}

/**
 * Issue #4535 r7: store a draft's tags (none removes the key). Returns whether they were stored.
 * No limit on how many: a tag goes only with its composer's own send (INV-V2b).
 */
export function writeRetargetTags(draftKey: string, tags: readonly RetargetTag[]): boolean {
  try {
    if (tags.length === 0) window.localStorage.removeItem(getRetargetTagKey(draftKey));
    else window.localStorage.setItem(getRetargetTagKey(draftKey), JSON.stringify(tags));
    return true;
  } catch {
    /* localStorage unavailable */
    return false;
  }
}

/**
 * Issue #4535 r7 (INV-V2b): a composer sent its draft — the tags it held when it sent go from the store.
 * Only those (by id): a tag stored meanwhile, or another composer's, stays.
 */
export function releaseRetargetTags(draftKey: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const gone = new Set(ids);
  const stored = readRetargetTags(draftKey);
  const left = stored.filter((tag) => !gone.has(tag.id));
  if (left.length !== stored.length) writeRetargetTags(draftKey, left);
}

type RetargetedTextListener = (returned: RetargetedText) => void;
const retargetedTextListeners = new Map<string, Set<RetargetedTextListener>>();

/**
 * Issue #4535 r7: a mounted composer showing `draftKey` hears a fence's text handed back into its
 * draft, with its tag (see {@link returnRetargetedText}). Returns the unsubscribe.
 */
export function subscribeRetargetedText(draftKey: string, listener: RetargetedTextListener): () => void {
  let listeners = retargetedTextListeners.get(draftKey);
  if (!listeners) {
    listeners = new Set();
    retargetedTextListeners.set(draftKey, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = retargetedTextListeners.get(draftKey);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) retargetedTextListeners.delete(draftKey);
  };
}

/**
 * Issue #4535 r7 (INV-V2a, 設計書 §3.4.1): hand a text the send fence stopped back into the draft
 * `draftKey`, bound to its tag — the one road a fence's text takes into a composer (the optimistic
 * send's answer, the row's discard; the awaited send keeps its text in its own composer). The tag is
 * stored first, next to the draft: a tag that cannot be stored hands nothing back (review H4:
 * fail-closed — a reload would bring the text back without it). Then the text is appended to the
 * stored draft, and a composer showing that draft takes both. Returns whether it was handed back.
 */
export function returnRetargetedText(draftKey: string, returned: RetargetedText): boolean {
  const { text, tag } = returned;
  if (!text) return false;
  const stored = readRetargetTags(draftKey);
  if (!writeRetargetTags(draftKey, mergeRetargetTags(stored, [tag]))) return false;
  if (!readRetargetTags(draftKey).some((t) => t.id === tag.id)) return false;
  const listeners = retargetedTextListeners.get(draftKey);
  try {
    const current = window.localStorage.getItem(draftKey) ?? '';
    window.localStorage.setItem(draftKey, current.trim() === '' ? text : `${current}\n\n${text}`);
  } catch {
    // The text is not stored: only a composer showing the draft can take it now.
    if (!listeners || listeners.size === 0) {
      writeRetargetTags(draftKey, stored);
      return false;
    }
  }
  listeners?.forEach((listener) => listener({ text, tag }));
  return true;
}
