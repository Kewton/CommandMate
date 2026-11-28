/**
 * Where a composer's draft (the text typed but not sent) is kept in `localStorage`.
 *
 * - **Split scope** (the worktree screen, PC and phone; Issue #728):
 *   `commandmate:draft-message:<worktreeId>:<splitIndex>` — the draft follows the pane.
 * - **Instance scope** (the `/sessions` tile; Issue #4419):
 *   `commandmate:draft-message:<worktreeId>:instance:<instanceId>` — the draft follows the
 *   instance the tile shows, so what is typed for one instance of a worktree never shows in
 *   another instance's composer (the tile switches instances in place).
 * - **Retarget tags** (Issue #4535 r7): the tags of the texts the send fence handed back into a draft,
 *   each naming the target its text was going to (see {@link RetargetTag}). They belong to that draft
 *   alone: no table is shared by the worktree.
 * - **One value** (Issue #4604 S13): a draft is kept as one value under one key, `<draftKey>:value` —
 *   `{"v":1,"text","tags","unknown","sendMark"}`: its text, its tags, its "unknown" and its #4503 mark
 *   change together with one `setItem` / `removeItem` ({@link writeRetarget}), so the store never holds
 *   a text without its marks. The keys of before (`<draftKey>` the text, `<draftKey>:retarget` the tags,
 *   `<draftKey>:send-unknown` the #4503 mark) are read while no value is stored, and folded into the
 *   value by the first write (the migration — the one exception to "one write on one key").
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
  // Issue #4604 S13: one write of the draft's value (its marks stay with it).
  writeRetarget(key, { kind: 'append', text, tags: [] });
  draftAppendListeners.get(key)?.forEach((listener) => listener(text));
}

/** Issue #4419: text added to a draft — the whole draft when it is empty, else after a blank line. */
export function appendDraftText(draft: string, text: string): string {
  return draft.trim() === '' ? text : `${draft}\n\n${text}`;
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

/**
 * Issue #4535 r7: where a draft's {@link RetargetTag}s were kept before the one value (Issue #4604 S13) —
 * read while no value is stored, folded into the value by the first write.
 */
export function getRetargetTagKey(draftKey: string): string {
  return `${draftKey}:retarget`;
}

/** Issue #4604 S13: where a draft is kept — its text and its marks, one value under one key. */
export function getDraftValueKey(draftKey: string): string {
  return `${draftKey}:value`;
}

/** Issue #4503 (review P2-5): where a draft's send-unknown mark was kept before the one value. */
export function getSendUnknownMarkKey(draftKey: string): string {
  return `${draftKey}:send-unknown`;
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
  // Issue #4604 S13: from the draft's value (an "unknown", junk or a store that throws reads as no tags).
  const marks = readRetargetStore(draftKey);
  if (marks.kind === 'list') return marks.tags;
  if (marks.kind !== 'junk') return [];
  // A list of before with an element of another shape: the rest are its tags (as it always read).
  try {
    if (window.localStorage.getItem(getDraftValueKey(draftKey)) !== null) return [];
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
  // Issue #4604 S13: from the draft's value — the same answers as the `:retarget` key gave.
  const marks = readRetargetStore(draftKey);
  if (marks.kind === 'absent') return { tags: [], known: true };
  if (marks.kind === 'list') return { tags: marks.tags, known: true };
  return { tags: [], known: false };
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
 * Issue #4604 (設計書 §3.4.1): the one fail-closed road to a draft's store.
 *
 * Issue #4604 S13: the store of a draft is one value under `<draftKey>:value` — its text, its tags, its
 * "unknown" (the generation, or null) and its #4503 mark — written with one `setItem` / `removeItem`.
 * The marks part reads in the five shapes of {@link RetargetStoreRead}: "unknown" is kept only when the
 * tags could not be kept as a list (the store could not be read, or the value with the tags could not be
 * written); `readRetargetTagState` reads it `known: false` and every send of that draft asks;
 * `readRetargetTags` reads it as no tags. When not even the short value (the text, no tag, "unknown")
 * goes in, this page keeps it (`unstorable`, the key and its generation — no tag, no text): its composers
 * ask too. A generation is what a yes covers: a yes lets go only the generations its question saw (案 A').
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
  /**
   * Q2: a draft moved here from another key — what that key held, and its unstorable mark. S13: `text`,
   * the moved text (appended to this draft's, in the same write).
   */
  | { kind: 'moveIn'; from: RetargetStoreRead; fromUnstorable: string | null; text?: string }
  /** Q2: the `from` side of a move — only its text goes; its marks stay. */
  | { kind: 'moveOut' };

/** Issue #4503: an awaited send of a draft whose outcome is unknown — its text and the target it went to. */
export interface SendUnknownMark {
  text: string;
  target: string;
}

/**
 * Issue #4604 S13: what {@link writeRetarget} is asked to do to a draft's one value — an op on its marks
 * ({@link RetargetOp}), or one of the composer's and the lib's writes of the whole value.
 */
export type DraftOp =
  | RetargetOp
  /**
   * A composer writes its draft (the debounced save, the switch): its text (null: the stored text stays),
   * and the marks it holds — its tags and the "unknown" generation it holds (they go in with the text).
   * `seen`: the composer read this draft (its restore did) — its text may go over a value that cannot be
   * read now, as "unknown"; without it, a value that cannot be read is not written over (it was not seen).
   */
  | { kind: 'save'; text: string | null; tags: readonly RetargetTag[]; unknown: string | null; seen?: boolean }
  /** A composer sent its draft: the text and the #4503 mark go; the marks its send lets go (as `release`). */
  | { kind: 'sent'; ids: readonly string[]; seen: readonly string[] | null }
  /** A text appended to the draft (a fence's handed-back text with its tags, or the tile's 409 text). */
  | { kind: 'append'; text: string; tags: readonly RetargetTag[] }
  /** Issue #4503: the draft's send-unknown mark (null: it goes). */
  | { kind: 'sendMark'; mark: SendUnknownMark | null }
  /** The composer's restore: nothing changes — the keys of before are folded into the value, if any. */
  | { kind: 'restore' };

/** Issue #4604: what {@link nextRetarget} decides. */
export interface RetargetTransition {
  /** The value to write; null: write nothing. */
  next: RetargetStoreValue | null;
  /** After the write went in (or with nothing to write): whether this page's unstorable mark goes. */
  clearUnstorable: boolean;
  /** Whether a write that throws leaves the short "unknown" (and then this page's mark). */
  failClosed: boolean;
}


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
  /**
   * Issue #4604 accept r1 (F2): called when the value could not be written and only the short "unknown"
   * went in (step 4) — the tags asked for are not in the store as asked (every reader asks, but the
   * person is told: `retargetPartiallyStored`). The return value stays `'unknown-stored'`.
   */
  onShortUnknown?: () => void;
  /**
   * Issue #4604 S13: filled by {@link writeRetarget} — `written`: the value now holds what was asked (its
   * text included; the short value counts, a write that threw and left the value as it was does not).
   */
  outcome?: { written: boolean };
}

/** Issue #4604: this page's unstorable mark for `draftKey` (its generation), if any. */
export function readRetargetUnstorable(draftKey: string, env: RetargetEnv = {}): string | null {
  return (env.unstorable ?? unstorableRetarget).get(draftKey) ?? null;
}

/** Issue #4604: read a draft's marks in their five shapes (S13: the marks part of its one value). */
export function readRetargetStore(draftKey: string, env: RetargetEnv = {}): RetargetStoreRead {
  return readDraft(draftKey, env).marks;
}

/** Issue #4604 S13: what the store holds for a draft, read once. */
export interface DraftRead {
  /** The draft's text ('' when none, or when it could not be read). */
  text: string;
  /** False when the store could not be read (it threw): the text is not known. */
  textKnown: boolean;
  /** Its marks, in the five shapes. */
  marks: RetargetStoreRead;
  /** Its #4503 mark. */
  sendMark: SendUnknownMark | null;
  /** Whether the one value is stored (or a value that cannot be read). */
  value: boolean;
  /** The keys of before that hold something (read only while no value is stored; the next write folds them). */
  legacy: string[];
}

interface DraftValue {
  text: string;
  tags: RetargetTag[];
  unknown: string | null;
  sendMark: SendUnknownMark | null;
}

const EMPTY_VALUE: DraftValue = { text: '', tags: [], unknown: null, sendMark: null };

function parseSendUnknownMark(value: unknown): SendUnknownMark | null {
  if (typeof value !== 'object' || value === null) return null;
  const { text, target } = value as { text?: unknown; target?: unknown };
  return typeof text === 'string' && typeof target === 'string' ? { text, target } : null;
}

/** Issue #4604 S13: a raw `<draftKey>:value`, or null when it is not one (junk). */
function parseDraftValue(raw: string): DraftValue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { v, text, tags, unknown, sendMark } = parsed as { v?: unknown; text?: unknown; tags?: unknown; unknown?: unknown; sendMark?: unknown };
  if (v !== 1 || typeof text !== 'string' || !Array.isArray(tags) || !tags.every(isRetargetTag)) return null;
  if (unknown !== null && (typeof unknown !== 'string' || unknown === '')) return null;
  if (sendMark !== null && parseSendUnknownMark(sendMark) === null) return null;
  return { text, tags, unknown, sendMark: sendMark === null ? null : parseSendUnknownMark(sendMark) };
}

function marksOfValue(value: DraftValue): RetargetStoreRead {
  if (value.unknown !== null) return { kind: 'unknown', generation: value.unknown, tags: value.tags };
  return value.tags.length > 0 ? { kind: 'list', tags: value.tags } : { kind: 'absent' };
}

function encodeDraftValue(value: DraftValue): string {
  return JSON.stringify({ v: 1, text: value.text, tags: value.tags, unknown: value.unknown, sendMark: value.sendMark });
}

const isEmptyValue = (value: DraftValue): boolean =>
  value.text === '' && value.tags.length === 0 && value.unknown === null && value.sendMark === null;

/**
 * Issue #4604 S13 (accept r1c F1): the marks of a raw `<draftKey>:value` (a `StorageEvent`'s `newValue`:
 * null is `absent`, a value that is not one is `junk`).
 */
export function parseDraftValueMarks(raw: string | null): RetargetStoreRead {
  if (raw === null) return { kind: 'absent' };
  const value = parseDraftValue(raw);
  return value === null ? { kind: 'junk' } : marksOfValue(value);
}

function storageOf(env: RetargetEnv): RetargetStorage {
  try {
    return env.storage ?? window.localStorage;
  } catch {
    // No storage at all: every call throws (this page keeps what it must).
    const unavailable = (): never => {
      throw new Error('localStorage unavailable');
    };
    return { getItem: unavailable, setItem: unavailable, removeItem: unavailable };
  }
}

/**
 * Issue #4604 S13: read a draft once — its one value (one `getItem`), or, while none is stored, the keys
 * of before (its text, its `:retarget`, its `:send-unknown`) as one value would hold them.
 */
export function readDraft(draftKey: string, env: RetargetEnv = {}): DraftRead {
  const storage = storageOf(env);
  let raw: string | null;
  try {
    raw = storage.getItem(getDraftValueKey(draftKey));
  } catch {
    return { text: '', textKnown: false, marks: { kind: 'throws' }, sendMark: null, value: true, legacy: [] };
  }
  if (raw !== null) {
    const value = parseDraftValue(raw);
    if (value === null) return { text: '', textKnown: true, marks: { kind: 'junk' }, sendMark: null, value: true, legacy: [] };
    return { text: value.text, textKnown: true, marks: marksOfValue(value), sendMark: value.sendMark, value: true, legacy: [] };
  }
  const legacy: string[] = [];
  let text = '';
  let textKnown = true;
  try {
    const stored = storage.getItem(draftKey);
    if (stored !== null) {
      legacy.push(draftKey);
      text = stored;
    }
  } catch {
    textKnown = false;
  }
  let marks: RetargetStoreRead;
  const tagKey = getRetargetTagKey(draftKey);
  try {
    const stored = storage.getItem(tagKey);
    if (stored !== null) legacy.push(tagKey);
    marks = parseRetargetStore(stored);
  } catch {
    // Unreadable: it may be there — the next write folds it as "unknown" and lets the key go.
    marks = { kind: 'throws' };
    legacy.push(tagKey);
  }
  let sendMark: SendUnknownMark | null = null;
  const markKey = getSendUnknownMarkKey(draftKey);
  try {
    const stored = storage.getItem(markKey);
    if (stored !== null) {
      legacy.push(markKey);
      try {
        sendMark = parseSendUnknownMark(JSON.parse(stored));
      } catch {
        sendMark = null;
      }
    }
  } catch {
    /* no mark known */
  }
  return { text, textKnown, marks, sendMark, value: false, legacy };
}

/** Issue #4503: a draft's send-unknown mark (from its value). */
export function readSendUnknownMark(draftKey: string): SendUnknownMark | null {
  return readDraft(draftKey).sendMark;
}

/** Issue #4503: set (or let go, null) a draft's send-unknown mark — one write of its value. */
export function writeSendUnknownMark(draftKey: string, mark: SendUnknownMark | null): void {
  writeRetarget(draftKey, { kind: 'sendMark', mark });
}

/**
 * Issue #4604 accept r1c (F1): a raw `<draftKey>:retarget` value in the shapes {@link readRetargetStore}
 * reads (a `StorageEvent`'s `newValue`: null is `absent`).
 */
export function parseRetargetStore(raw: string | null): RetargetStoreRead {
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

/** Issue #4604 S13: the op on the marks part of a {@link DraftOp} (null: the marks stay as they are). */
function marksOpOf(op: DraftOp): RetargetOp | null {
  switch (op.kind) {
    case 'save':
      return { kind: 'writeBack', tags: op.tags };
    case 'sent':
      return { kind: 'release', ids: op.ids, seen: op.seen };
    case 'append':
      return { kind: 'add', tags: op.tags };
    case 'sendMark':
    case 'restore':
      return null;
    default:
      return op;
  }
}

/** The marks part of a value from what {@link nextRetarget} decided. */
function marksPart(next: RetargetStoreValue): Pick<DraftValue, 'tags' | 'unknown'> {
  if (next.kind === 'absent') return { tags: [], unknown: null };
  if (next.kind === 'list') return { tags: next.tags, unknown: null };
  return { tags: next.tags, unknown: next.generation };
}

/**
 * Issue #4604 (設計書 §3.4.1): the one road to a draft's store — nothing else calls `setItem` or
 * `removeItem` on it. Issue #4604 S13: the store is one value (`<draftKey>:value`), so every op is one
 * write: (1) read the value once, (2) the next value — its marks by {@link nextRetarget}, its text and its
 * #4503 mark by the op — (3) write it (an empty value removes the key; the same value writes nothing),
 * (4) if that throws and the marks were to change, the short value (the text and the #4503 mark kept, no
 * tag, "unknown": the store's generation when it says "unknown" already — #4616 —, else a new one), (5) if
 * that throws too, this page's mark (a new generation): `'unstored'` — another tab, or this page after a
 * reload, cannot know. A release or a move's `from` side does not take steps 4・5 (letting go never adds an
 * "ask"). What could not be read is never written over as known: it becomes "unknown".
 * While no value is stored, the keys of before are read and folded in: the value goes in first, then they
 * go (the migration — the one exception to one write; a remove that throws leaves them, the value is read).
 * `env.outcome.written` says whether the value now holds what was asked (the text included).
 */
export function writeRetarget(draftKey: string, op: DraftOp, env: RetargetEnv = {}): RetargetWriteResult {
  const unstorable = env.unstorable ?? unstorableRetarget;
  const newGeneration = env.newGeneration ?? newRetargetGeneration;
  const storage = storageOf(env);
  const outcome = env.outcome ?? { written: false };
  outcome.written = false;
  const prev = readDraft(draftKey, { storage });
  const valueKey = getDraftValueKey(draftKey);
  const marksOp = marksOpOf(op);
  const transition = marksOp === null ? null : nextRetarget(prev.marks, marksOp, unstorable.get(draftKey) ?? null, newGeneration);
  const unreadable = prev.marks.kind === 'junk' || prev.marks.kind === 'throws';
  const prevMarks = marksOfStore(prev.marks);
  let marks = transition !== null && transition.next !== null ? marksPart(transition.next) : prevMarks;
  // The composer's held "unknown" goes in with its text (another tab's send may have let it go).
  if (op.kind === 'save' && op.unknown !== null && marks.unknown === null) marks = { tags: marks.tags, unknown: op.unknown };
  const text =
    op.kind === 'sent' || op.kind === 'moveOut'
      ? ''
      : op.kind === 'save'
        ? op.text ?? prev.text
        : op.kind === 'append'
          ? appendDraftText(prev.text, op.text)
          : op.kind === 'moveIn' && op.text
            ? appendDraftText(prev.text, op.text)
            : prev.text;
  const sendMark = op.kind === 'sent' ? null : op.kind === 'sendMark' ? op.mark : prev.sendMark;
  // Whether anything is asked to change (a marks op whose table writes nothing, over what cannot be read
  // too, writes nothing: junk is never let go).
  const asked =
    (transition !== null && transition.next !== null) ||
    text !== prev.text ||
    JSON.stringify(sendMark) !== JSON.stringify(prev.sendMark) ||
    (op.kind === 'restore' && prev.legacy.length > 0);
  // What could not be read is not written over as known (V2-A・N-10): "unknown" of a new generation.
  if (asked && unreadable && marks.unknown === null) marks = { tags: marks.tags, unknown: newGeneration() };
  const next: DraftValue = { text, tags: marks.tags, unknown: marks.unknown, sendMark };
  const prevValue: DraftValue = { text: prev.text, tags: prevMarks.tags, unknown: prevMarks.unknown, sendMark: prev.sendMark };
  const marksChange = unreadable || JSON.stringify([next.tags, next.unknown]) !== JSON.stringify([prevValue.tags, prevValue.unknown]);
  const told = (): RetargetWriteResult => (next.unknown !== null || unstorable.has(draftKey) ? 'unknown-stored' : 'stored');
  /**
   * The migration: the keys of before go once the value holds what they held (`strict`: they are the
   * write itself — the value is empty and none is stored —, so one that cannot go is a write that failed).
   */
  const foldLegacy = (strict: boolean) => {
    const keep = (error: unknown) => {
      if (strict) throw error;
    };
    if (prev.legacy.includes(draftKey)) {
      try {
        storage.removeItem(draftKey);
      } catch (error) {
        keep(error);
      }
    }
    if (prev.legacy.includes(getRetargetTagKey(draftKey))) {
      try {
        storage.removeItem(getRetargetTagKey(draftKey));
      } catch (error) {
        keep(error);
      }
    }
    if (prev.legacy.includes(getSendUnknownMarkKey(draftKey))) {
      try {
        storage.removeItem(getSendUnknownMarkKey(draftKey));
      } catch (error) {
        keep(error);
      }
    }
  };
  const marksWrite = transition !== null && transition.next !== null;
  if (!asked || (!marksWrite && !unreadable && prev.legacy.length === 0 && encodeDraftValue(next) === encodeDraftValue(prev.value ? prevValue : EMPTY_VALUE))) {
    // Nothing changes: nothing is written.
    if (transition?.clearUnstorable) unstorable.delete(draftKey);
    outcome.written = true;
    return unreadable || prev.marks.kind === 'unknown' || unstorable.has(draftKey) ? 'unknown-stored' : 'stored';
  }
  if (!prev.textKnown && !(op.kind === 'save' && op.seen === true && op.text !== null)) {
    // The draft itself could not be read: nothing is written over it (its text would go unseen — a text
    // is never let go silently), but by the save of a composer that read it (its text is what it saw, and
    // more). An "ask" the op was to add stays on this page (step 5).
    if (marksWrite && transition !== null && transition.failClosed) {
      if (env.markPage !== false) unstorable.set(draftKey, newGeneration());
      return 'unstored';
    }
    return 'unknown-stored';
  }
  try {
    if (isEmptyValue(next)) {
      if (prev.value) storage.removeItem(valueKey);
      foldLegacy(!prev.value);
    } else {
      storage.setItem(valueKey, encodeDraftValue(next));
      foldLegacy(false);
    }
    if (transition?.clearUnstorable) unstorable.delete(draftKey);
    outcome.written = true;
    return told();
  } catch {
    // A text (or #4503 mark) that does not fit: the value stays as it was, its marks with it.
    if (!marksWrite && !marksChange) return unreadable || prev.marks.kind === 'unknown' || unstorable.has(draftKey) ? 'unknown-stored' : 'stored';
    if (transition !== null && transition.next !== null && !transition.failClosed) return 'unstored';
  }
  try {
    const generation = newGeneration();
    storage.setItem(valueKey, encodeDraftValue({ text, tags: [], unknown: generation, sendMark }));
    foldLegacy(false);
    outcome.written = true;
    env.onShortUnknown?.();
    return 'unknown-stored';
  } catch {
    if (env.markPage !== false) unstorable.set(draftKey, newGeneration());
    return 'unstored';
  }
}

/** The marks of a store read as a value holds them (what cannot be read holds none here: see the road). */
function marksOfStore(read: RetargetStoreRead): Pick<DraftValue, 'tags' | 'unknown'> {
  if (read.kind === 'list') return { tags: read.tags, unknown: null };
  if (read.kind === 'unknown') return { tags: read.tags, unknown: read.generation };
  return { tags: [], unknown: null };
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
 * r3 (P1-2): `heldUnknown` — the "unknown" generation the composer restored the text under and still
 * holds (another tab's send may have let it go from the store): it asks, as a held tag does.
 */
export function decideRetarget(
  stored: RetargetStoreRead,
  held: readonly RetargetTag[],
  unstorable: string | null,
  current: RetargetTarget,
  heldUnknown: string | null = null,
): RetargetDecision {
  const tags = mergeRetargetTags(held, tagsOf(stored));
  const changed = tags.find((tag) => tag.original.instanceId !== current.instanceId || tag.original.cliToolId !== current.cliToolId);
  const seen: string[] = [];
  if (stored.kind === 'unknown') seen.push(stored.generation);
  if (unstorable !== null && !seen.includes(unstorable)) seen.push(unstorable);
  if (heldUnknown !== null && !seen.includes(heldUnknown)) seen.push(heldUnknown);
  const unknown = stored.kind === 'throws' || stored.kind === 'junk' || stored.kind === 'unknown' || unstorable !== null || heldUnknown !== null;
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

/** Issue #4606 r3 (P1-6): what {@link moveDraft} did — moved, nothing to move, or could not move it. */
export type MoveDraftResult = 'moved' | 'nothing' | 'failed';

/**
 * Issue #4604 (Q2, 設計書 §3.6): move the draft `from` into `to` (the tile's instance went from the
 * roster and it fell back to another). Its marks (`moveIn`: an "unknown" moves as one) and its text —
 * appended to `to`'s, never over it — go into `to`'s value in one write (S13), and the composers showing
 * `to` hear it; then `from`'s text goes (`moveOut`: its marks stay). Nothing moves when `to` cannot take
 * it (§1.10 決め 4: `from` is let go only once `to` holds it).
 * r3 (P1-6): `'failed'` when there was a text and it could not be moved (it stays under `from`) — the
 * caller says so; `'nothing'` when there was no text to move.
 */
export function moveDraft(from: string, to: string): MoveDraftResult {
  if (from === to) return 'nothing';
  // Issue #4604 S13: one read of `from`; `to` takes the marks and the text in one write; `from`'s text goes
  // only once `to` holds it (its marks stay) — a `to` that cannot take it leaves `from` as it was.
  const source = readDraft(from);
  if (!source.textKnown) return 'failed';
  const text = source.text;
  if (text.trim() === '') return 'nothing';
  const outcome = { written: false };
  writeRetarget(to, { kind: 'moveIn', from: source.marks, fromUnstorable: readRetargetUnstorable(from), text }, { outcome });
  if (!outcome.written) return 'failed';
  draftAppendListeners.get(to)?.forEach((listener) => listener(text));
  writeRetarget(from, { kind: 'moveOut' });
  return 'moved';
}

/**
 * Issue #4604 accept r1 (F2): `takeShortUnknown()` — true, once for all the composers hearing it, when the
 * tag went into the store only as the short "unknown" (the one that takes it says so with
 * `retargetPartiallyStored`, so two composers of the draft do not both say it).
 */
type RetargetedTextListener = (returned: RetargetedText, info: { takeShortUnknown: () => boolean }) => void;
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
 * send's answer, the row's discard; the awaited send keeps its text in its own composer). The text is
 * appended to the stored draft with its tag, in one write of the draft's value (S13): a value that cannot
 * be stored hands nothing back (review H4: fail-closed — a reload would bring the text back without it).
 * A composer showing that draft takes both. Returns whether it was handed back.
 */
export function returnRetargetedText(draftKey: string, returned: RetargetedText): boolean {
  const { text, tag } = returned;
  if (!text) return false;
  // Issue #4604: through the one road — a tag that went in only as "unknown" still asks everywhere;
  // one that could not be stored at all hands nothing back (H4), so there is nothing for this page to
  // mark either (`markPage: false`: the text is nowhere). S13: the text and its tag are one write — a
  // value that went in holds both, one that did not leaves the store as it was.
  let shortUnknown = false;
  const onShortUnknown = () => {
    shortUnknown = true;
  };
  const outcome = { written: false };
  if (writeRetarget(draftKey, { kind: 'append', text, tags: [tag] }, { markPage: false, onShortUnknown, outcome }) === 'unstored' || !outcome.written) {
    return false;
  }
  const listeners = retargetedTextListeners.get(draftKey);
  const info = {
    takeShortUnknown: () => {
      const told = shortUnknown;
      shortUnknown = false;
      return told;
    },
  };
  listeners?.forEach((listener) => listener({ text, tag }, info));
  return true;
}
