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
 * Issue #4535 r7 (INV-V2b): a composer sent its draft — the tags it held when it sent go from the store.
 * Only those (by id): a tag stored meanwhile, or another composer's, stays.
 * Issue #4604 (N-7・N-11): and the "unknown" generations its yes saw (`seen`, none when it was not
 * asked) — called even with no ids, so an asked send of a draft holding no tag lets them go too.
 */
export function releaseRetargetTags(draftKey: string, ids: readonly string[], seen: readonly string[] | null = null): void {
  if (ids.length === 0 && (seen === null || seen.length === 0)) return;
  writeRetarget(draftKey, { kind: 'release', ids, seen });
}

/*
 * ---------------------------------------------------------------------------------------------
 * Issue #4604 (設計書 §3.4.1): the one fail-closed road to `<draftKey>:retarget`.
 *
 * The store keeps its shape — an array of tags — and gains one: "unknown", `{"unknown":"<generation>",
 * "tags":[…]}`, written only when tags could not be kept as a list (the store could not be read, or
 * the list could not be written). It is not an array, so `readRetargetTagState` reads it `known:
 * false` and every send of that draft asks; `readRetargetTags` reads it as no tags (both unchanged).
 * When not even the short "unknown" goes in, this page keeps it (`unstorable`, the key and its
 * generation — no tag, no text): its composers ask too. A generation is what a yes covers: a yes
 * lets go only the generations its question saw (案 A').
 * ---------------------------------------------------------------------------------------------
 */

/** Issue #4604: what `<draftKey>:retarget` holds, as the one road reads it. */
export type RetargetStoreRead =
  | { kind: 'absent' }
  | { kind: 'list'; tags: RetargetTag[] }
  | { kind: 'unknown'; generation: string; tags: RetargetTag[] }
  | { kind: 'junk' }
  | { kind: 'throws' };

/** Issue #4604: a value the road writes (`absent` removes the key). */
export type RetargetStoreValue = Extract<RetargetStoreRead, { kind: 'absent' | 'list' | 'unknown' }>;

/** Issue #4604: what the road is asked to do. */
export type RetargetOp =
  /** A tag for a text handed back, or the awaited road's 409 (`keepRetargetTag`). */
  | { kind: 'add'; tags: readonly RetargetTag[] }
  /** A composer writes back the tags it holds (the switch, `storage`, the debounced save). */
  | { kind: 'writeBack'; tags: readonly RetargetTag[] }
  /** A composer's own send went: the ids it held, the generations its question saw (null: not asked). */
  | { kind: 'release'; ids: readonly string[]; seen: readonly string[] | null }
  /** Q2: a draft moved here from another key — what that key held, and its unstorable mark. */
  | { kind: 'moveIn'; from: RetargetStoreRead; fromUnstorable: string | null }
  /** Q2: the `from` side of a move — only its text goes; its marks stay (nothing is written here). */
  | { kind: 'moveOut' };

/** Issue #4604: what {@link nextRetarget} decides. */
export interface RetargetTransition {
  /** The value to write; null: write nothing. */
  next: RetargetStoreValue | null;
  /** After the write went in (or with nothing to write): whether this page's unstorable mark goes. */
  clearUnstorable: boolean;
  /** Whether a write that throws leaves the short "unknown" (and then this page's mark). */
  failClosed: boolean;
}

const RETARGET_UNKNOWN_FIELD = 'unknown';

let retargetGenerationSeq = 0;

/** Issue #4604: a new generation of the "unknown" mark (the same make as a tag's id). */
export function newRetargetGeneration(): string {
  retargetGenerationSeq += 1;
  return `g-${Date.now().toString(36)}-${retargetGenerationSeq.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Issue #4604: the storage the road uses (the page's `localStorage`, or a test's). */
export type RetargetStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Issue #4604: where this page keeps the keys whose "unknown" could not be stored (key → generation). */
const unstorableRetarget = new Map<string, string>();

/** Issue #4604: what the road works on — the defaults are the page's; a test gives its own. */
export interface RetargetEnv {
  storage?: RetargetStorage;
  unstorable?: Map<string, string>;
  newGeneration?: () => string;
  /**
   * Whether step 5 (this page's mark) is taken (default true). False for a road that, when nothing
   * could be stored, hands nothing back ({@link returnRetargetedText}): there is no text to mark.
   */
  markPage?: boolean;
}

/** Issue #4604: this page's unstorable mark for `draftKey` (its generation), if any. */
export function readRetargetUnstorable(draftKey: string, env: RetargetEnv = {}): string | null {
  return (env.unstorable ?? unstorableRetarget).get(draftKey) ?? null;
}

/** Issue #4604: read `<draftKey>:retarget` in its five shapes. */
export function readRetargetStore(draftKey: string, env: RetargetEnv = {}): RetargetStoreRead {
  let raw: string | null;
  try {
    raw = (env.storage ?? window.localStorage).getItem(getRetargetTagKey(draftKey));
  } catch {
    return { kind: 'throws' };
  }
  if (raw === null) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'junk' };
  }
  if (Array.isArray(parsed)) return parsed.every(isRetargetTag) ? { kind: 'list', tags: parsed } : { kind: 'junk' };
  if (typeof parsed === 'object' && parsed !== null) {
    const { unknown, tags } = parsed as { unknown?: unknown; tags?: unknown };
    if (typeof unknown === 'string' && unknown !== '' && Array.isArray(tags) && tags.every(isRetargetTag)) {
      return { kind: 'unknown', generation: unknown, tags };
    }
  }
  return { kind: 'junk' };
}

function encodeRetargetValue(value: Exclude<RetargetStoreValue, { kind: 'absent' }>): string {
  return value.kind === 'list'
    ? JSON.stringify(value.tags)
    : JSON.stringify({ [RETARGET_UNKNOWN_FIELD]: value.generation, tags: value.tags });
}

const tagsOf = (read: RetargetStoreRead): RetargetTag[] => (read.kind === 'list' || read.kind === 'unknown' ? read.tags : []);

/**
 * Issue #4604 (設計書 §3.4.1, the table): the next value of `<draftKey>:retarget` — a pure function.
 * `unstorable` is this page's mark for the key (its generation); `newGeneration` makes one when the
 * table says "a new generation" (called only then, in the table's order).
 *
 * "Ask" never turns into "do not ask" here except on a composer's own send that was asked (`release`
 * with the generations its question saw, and the ids it held): no other op, failure or order does.
 */
export function nextRetarget(
  prev: RetargetStoreRead,
  op: RetargetOp,
  unstorable: string | null,
  newGeneration: () => string,
): RetargetTransition {
  const keep = (next: RetargetStoreValue | null, clearUnstorable = false, failClosed = true): RetargetTransition => ({ next, clearUnstorable, failClosed });
  switch (op.kind) {
    case 'add':
    case 'writeBack': {
      if (op.tags.length === 0) return keep(null, false, false);
      if (prev.kind === 'absent' || prev.kind === 'list') {
        const tags = mergeRetargetTags(tagsOf(prev), op.tags);
        // N-1: while this page holds the key's unstorable mark, the tags go in as its "unknown".
        if (unstorable === null) return keep({ kind: 'list', tags });
        return keep({ kind: 'unknown', generation: unstorable, tags }, true);
      }
      if (prev.kind === 'unknown') {
        const tags = mergeRetargetTags(prev.tags, op.tags);
        if (unstorable !== null && unstorable !== prev.generation) {
          return keep({ kind: 'unknown', generation: newGeneration(), tags });
        }
        return keep({ kind: 'unknown', generation: prev.generation, tags }, unstorable === prev.generation);
      }
      // junk / throws (V2-A・N-10): what was there cannot be read — "unknown", never a list over it.
      return keep({ kind: 'unknown', generation: newGeneration(), tags: [...op.tags] });
    }
    case 'release': {
      const gone = new Set(op.ids);
      const seen = op.seen;
      const sawUnstorable = unstorable !== null && seen !== null && seen.includes(unstorable);
      if (prev.kind === 'list') {
        const left = prev.tags.filter((tag) => !gone.has(tag.id));
        return keep(left.length > 0 ? { kind: 'list', tags: left } : { kind: 'absent' }, sawUnstorable, false);
      }
      if (prev.kind === 'unknown') {
        const left = prev.tags.filter((tag) => !gone.has(tag.id));
        if (seen !== null && seen.includes(prev.generation)) {
          return keep(left.length > 0 ? { kind: 'list', tags: left } : { kind: 'absent' }, sawUnstorable, false);
        }
        // N-7: an "unknown" born after the question is not covered by its yes.
        return keep({ kind: 'unknown', generation: prev.generation, tags: left }, sawUnstorable, false);
      }
      if (prev.kind === 'absent') return keep(null, sawUnstorable, false);
      // junk / throws: what cannot be read is not let go (the next send asks again).
      return keep(null, false, false);
    }
    case 'moveIn': {
      const fromTags = tagsOf(op.from);
      if (op.from.kind === 'list' && op.fromUnstorable === null) {
        return nextRetarget(prev, { kind: 'add', tags: fromTags }, unstorable, newGeneration);
      }
      // N-4: "unknown" moves too (an unreadable, an "unknown", a draft with no list, or this page's mark).
      return keep({ kind: 'unknown', generation: newGeneration(), tags: mergeRetargetTags(tagsOf(prev), fromTags) });
    }
    case 'moveOut':
      // v4.3 (M-1): the text goes, the marks stay — a composer still showing the text may write it back.
      return keep(null, false, false);
  }
}

/** Issue #4604: what the road did — the value went in, an "unknown" went in, or only this page holds it. */
export type RetargetWriteResult = 'stored' | 'unknown-stored' | 'unstored';

/**
 * Issue #4604 (設計書 §3.4.1): the one road to `<draftKey>:retarget` — nothing else calls `setItem`
 * or `removeItem` on it. (1) read what is there, (2) {@link nextRetarget}, (3) write it, (4) if that
 * throws, the short "unknown" (`{"unknown":"<new>","tags":[]}`), (5) if that throws too, this page's
 * mark (a new generation): `'unstored'` — another tab, or this page after a reload, cannot know.
 * A release or a move's `from` side does not take steps 4・5 (letting go never adds an "ask").
 */
export function writeRetarget(draftKey: string, op: RetargetOp, env: RetargetEnv = {}): RetargetWriteResult {
  const unstorable = env.unstorable ?? unstorableRetarget;
  const newGeneration = env.newGeneration ?? newRetargetGeneration;
  let storage: RetargetStorage;
  try {
    storage = env.storage ?? window.localStorage;
  } catch {
    // No storage at all: this page keeps what it must (a write would throw at once).
    storage = { getItem: () => { throw new Error('localStorage unavailable'); }, setItem: () => { throw new Error('localStorage unavailable'); }, removeItem: () => { throw new Error('localStorage unavailable'); } };
  }
  const prev = readRetargetStore(draftKey, { storage });
  const transition = nextRetarget(prev, op, unstorable.get(draftKey) ?? null, newGeneration);
  const tagKey = getRetargetTagKey(draftKey);
  const { next } = transition;
  if (next === null) {
    if (transition.clearUnstorable) unstorable.delete(draftKey);
    return prev.kind === 'unknown' || prev.kind === 'junk' || prev.kind === 'throws' || unstorable.has(draftKey) ? 'unknown-stored' : 'stored';
  }
  try {
    if (next.kind === 'absent') storage.removeItem(tagKey);
    else storage.setItem(tagKey, encodeRetargetValue(next));
    if (transition.clearUnstorable) unstorable.delete(draftKey);
    return next.kind === 'unknown' ? 'unknown-stored' : 'stored';
  } catch {
    if (!transition.failClosed) return 'unstored';
  }
  try {
    storage.setItem(tagKey, encodeRetargetValue({ kind: 'unknown', generation: newGeneration(), tags: [] }));
    return 'unknown-stored';
  } catch {
    if (env.markPage !== false) unstorable.set(draftKey, newGeneration());
    return 'unstored';
  }
}

/** Issue #4604: what the send's check decides, and what its question saw (the yes covers only that). */
export interface RetargetDecision {
  /** Whether this send asks first. */
  ask: boolean;
  /** Whether the draft's tags are not known (unreadable, "unknown", this page's mark): its yes is for one send. */
  unknown: boolean;
  /** The first tag whose original target is not the To (null when none, or not known). */
  original: RetargetTarget | null;
  /** The ids of the tags looked at (this composer's ∪ the stored ones). */
  ids: string[];
  /** The generations of the "unknown" marks looked at (the store's, this page's). */
  seen: string[];
}

/**
 * Issue #4604 (設計書 §3.2「聞く」): whether a send of the draft whose store reads `stored` (and whose
 * composer holds `held`) to `current` asks — a store it cannot read, an "unknown", this page's mark
 * (`unstorable`), or a tag whose original target is not `current`.
 */
export function decideRetarget(
  stored: RetargetStoreRead,
  held: readonly RetargetTag[],
  unstorable: string | null,
  current: RetargetTarget,
): RetargetDecision {
  const tags = mergeRetargetTags(held, tagsOf(stored));
  const changed = tags.find((tag) => tag.original.instanceId !== current.instanceId || tag.original.cliToolId !== current.cliToolId);
  const seen: string[] = [];
  if (stored.kind === 'unknown') seen.push(stored.generation);
  if (unstorable !== null) seen.push(unstorable);
  const unknown = stored.kind === 'throws' || stored.kind === 'junk' || stored.kind === 'unknown' || unstorable !== null;
  return { ask: unknown || changed !== undefined, unknown, original: changed?.original ?? null, ids: tags.map((tag) => tag.id), seen };
}

/**
 * Issue #4604 r3 (P1-1, 案 A'): whether a yes — the ids and the "unknown" generations its question
 * showed — covers `decision` now: every id and every generation the check sees now was shown by that
 * question. A mark born after the question (a text handed back into the same generation, a new
 * generation) is not covered: the send asks again.
 */
export function retargetYesCovers(
  yes: { ids: readonly string[]; seen: readonly string[] },
  decision: Pick<RetargetDecision, 'ids' | 'seen'>,
): boolean {
  return decision.ids.every((id) => yes.ids.includes(id)) && decision.seen.every((generation) => yes.seen.includes(generation));
}

/**
 * Issue #4604 (Q2, 設計書 §3.6): move the draft `from` into `to` (the tile's instance went from the
 * roster and it fell back to another). Its marks first (`moveIn`: an "unknown" moves as one), then its
 * text — appended to `to`'s, never over it — and the composers showing `to` hear it; then `from`'s text
 * goes (`moveOut`: its marks stay). Nothing moves when `to` can take no mark. Returns whether it moved.
 */
export function moveDraft(from: string, to: string): boolean {
  if (from === to) return false;
  let text: string;
  try {
    text = window.localStorage.getItem(from) ?? '';
  } catch {
    return false;
  }
  if (text.trim() === '') return false;
  const result = writeRetarget(to, { kind: 'moveIn', from: readRetargetStore(from), fromUnstorable: readRetargetUnstorable(from) });
  if (result === 'unstored') return false;
  try {
    const current = window.localStorage.getItem(to) ?? '';
    window.localStorage.setItem(to, current.trim() === '' ? text : `${current}\n\n${text}`);
  } catch {
    return false;
  }
  draftAppendListeners.get(to)?.forEach((listener) => listener(text));
  try {
    window.localStorage.removeItem(from);
  } catch {
    /* the text stays under `from` too: its marks stayed with it */
  }
  return true;
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
  // Issue #4604: through the one road — a tag that went in only as "unknown" still asks everywhere;
  // one that could not be stored at all hands nothing back (H4), so there is nothing for this page to
  // mark either (`markPage: false`: the text is nowhere).
  if (writeRetarget(draftKey, { kind: 'add', tags: [tag] }, { markPage: false }) === 'unstored') return false;
  const listeners = retargetedTextListeners.get(draftKey);
  try {
    const current = window.localStorage.getItem(draftKey) ?? '';
    window.localStorage.setItem(draftKey, current.trim() === '' ? text : `${current}\n\n${text}`);
  } catch {
    // The text is not stored: only a composer showing the draft can take it now. Issue #4604 (N-9):
    // the tag stays (no roll-back) — it asks once more at most.
    if (!listeners || listeners.size === 0) return false;
  }
  listeners?.forEach((listener) => listener({ text, tag }));
  return true;
}
