/**
 * Issue #4604 (設計書 §3.4.1): the one fail-closed road to `<draftKey>:retarget`, on the page's
 * `localStorage` with its faults.
 *
 * - `readRetargetStore` reads five shapes: absent · list · unknown · junk · throws
 * - `writeRetarget`: (3) the value → (4) the short "unknown" when that throws → (5) this page's mark
 *   when that throws too; a release takes neither 4 nor 5. A store that cannot be read is never
 *   written over with a list (V2-A, N-10): it becomes "unknown"
 * - this page's mark goes only when its generation went into the store, or a release saw it (N-1)
 * - `readRetargetTags` / `readRetargetTagState` read the new shape as they read junk (unchanged)
 * - `returnRetargetedText`: a tag that went in only as "unknown" still hands the text back; nothing
 *   stored hands nothing back and marks nothing; a text write that throws rolls nothing back (N-9)
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { vi } from 'vitest';
import {
  getDraftValueKey,
  getRetargetTagKey,
  getSplitDraftKey,
  readRetargetStore,
  readRetargetTagState,
  readRetargetTags,
  readRetargetUnstorable,
  returnRetargetedText,
  subscribeRetargetedText,
  writeRetarget,
  type RetargetTag,
} from '@/lib/drafts/message-draft';
import { installStoreFaults, isDraftTextKey, isDraftValueKey, isRetargetKey, rawStore, shortValueLength, storedDraft } from '@tests/helpers/draft-store-fault-4604';

const KEY = getSplitDraftKey('wt-4604-road', 0);
const TAG_KEY = getRetargetTagKey(KEY);
const X = { instanceId: 'codex-2', cliToolId: 'codex' };
const T1: RetargetTag = { id: 't-1', original: X };
const T2: RetargetTag = { id: 't-2', original: X };

/** Let go of this page's mark for KEY (a release that saw it), so tests do not leak it to each other. */
function clearPageMark() {
  const generation = readRetargetUnstorable(KEY);
  if (generation !== null) writeRetarget(KEY, { kind: 'release', ids: [], seen: [generation] }, { storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } });
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  clearPageMark();
  window.localStorage.clear();
});

describe('[#4604] readRetargetStore: five shapes', () => {
  it('absent, list, unknown, junk, throws', () => {
    expect(readRetargetStore(KEY)).toEqual({ kind: 'absent' });
    window.localStorage.setItem(TAG_KEY, JSON.stringify([T1]));
    expect(readRetargetStore(KEY)).toEqual({ kind: 'list', tags: [T1] });
    window.localStorage.setItem(TAG_KEY, JSON.stringify({ unknown: 'g-1', tags: [T2] }));
    expect(readRetargetStore(KEY)).toEqual({ kind: 'unknown', generation: 'g-1', tags: [T2] });
    for (const junk of ['{not json', '{"id":"t"}', JSON.stringify([{ id: 1 }]), JSON.stringify({ unknown: '', tags: [] }), JSON.stringify({ unknown: 'g', tags: [{}] })]) {
      window.localStorage.setItem(TAG_KEY, junk);
      expect(readRetargetStore(KEY)).toEqual({ kind: 'junk' });
    }
    installStoreFaults([{ method: 'getItem', key: isRetargetKey }]);
    expect(readRetargetStore(KEY)).toEqual({ kind: 'throws' });
  });

  it('the older readers read the "unknown" shape as they read junk (unchanged)', () => {
    window.localStorage.setItem(TAG_KEY, JSON.stringify({ unknown: 'g-1', tags: [T1] }));
    expect(readRetargetTags(KEY)).toEqual([]);
    expect(readRetargetTagState(KEY)).toEqual({ tags: [], known: false });
  });
});

describe('[#4604] writeRetarget: the steps', () => {
  it('a readable store takes the tags as a list (merged, by id)', () => {
    expect(writeRetarget(KEY, { kind: 'add', tags: [T1] })).toBe('stored');
    expect(writeRetarget(KEY, { kind: 'writeBack', tags: [T1, T2] })).toBe('stored');
    // Issue #4604 S13: the marks are read from the draft's one value.
    expect(readRetargetStore(KEY)).toEqual({ kind: 'list', tags: [T1, T2] });
  });

  it('V2-A: a store whose getItem throws is not written over with a list — it becomes "unknown" with the new tag', () => {
    rawStore().set(TAG_KEY, JSON.stringify([T2]));
    const faults = installStoreFaults([{ method: 'getItem', key: isRetargetKey }]);
    expect(writeRetarget(KEY, { kind: 'add', tags: [T1] })).toBe('unknown-stored');
    faults.restore();
    const read = readRetargetStore(KEY);
    expect(read.kind).toBe('unknown');
    expect(read.kind === 'unknown' && read.tags).toEqual([T1]);
    expect(readRetargetTagState(KEY).known).toBe(false);
  });

  it('N-10: a write-back over junk is "unknown" too (never a list over what could not be read)', () => {
    window.localStorage.setItem(TAG_KEY, '{not json');
    expect(writeRetarget(KEY, { kind: 'writeBack', tags: [T1] })).toBe('unknown-stored');
    expect(readRetargetTagState(KEY).known).toBe(false);
  });

  it('a list that cannot be written (a full store) leaves the short "unknown"', () => {
    // Issue #4604 S13: a full store refuses the draft's value with the tag; its short value fits.
    installStoreFaults([{ method: 'setItem', key: isDraftValueKey, overBytes: shortValueLength('') }]);
    expect(writeRetarget(KEY, { kind: 'add', tags: [T1] })).toBe('unknown-stored');
    const read = readRetargetStore(KEY);
    expect(read.kind === 'unknown' && read.tags).toEqual([]);
    expect(read.kind === 'unknown' && typeof read.generation).toBe('string');
    expect(readRetargetUnstorable(KEY)).toBeNull();
  });

  it('nothing goes in: this page keeps the mark (a generation, no tag), and its sends ask', () => {
    installStoreFaults([{ method: 'setItem', key: isDraftValueKey }]);
    expect(writeRetarget(KEY, { kind: 'add', tags: [T1] })).toBe('unstored');
    expect(rawStore().get(getDraftValueKey(KEY))).toBeNull();
    expect(readRetargetUnstorable(KEY)).toEqual(expect.any(String));
  });

  it('N-1: a later list write that goes in does not drop the mark — it goes in as that generation\'s "unknown"', () => {
    const faults = installStoreFaults([{ method: 'setItem', key: isDraftValueKey }]);
    writeRetarget(KEY, { kind: 'add', tags: [T1] });
    const generation = readRetargetUnstorable(KEY);
    faults.restore();
    expect(writeRetarget(KEY, { kind: 'add', tags: [T2] })).toBe('unknown-stored');
    expect(readRetargetStore(KEY)).toEqual({ kind: 'unknown', generation, tags: [T2] });
    // The mark moved into the store (the same generation): this page drops its copy.
    expect(readRetargetUnstorable(KEY)).toBeNull();
  });

  it('a release takes neither the short "unknown" nor the page mark', () => {
    rawStore().set(TAG_KEY, JSON.stringify([T1]));
    installStoreFaults([{ method: 'removeItem', key: isRetargetKey }, { method: 'setItem', key: isRetargetKey }]);
    expect(writeRetarget(KEY, { kind: 'release', ids: [T1.id], seen: null })).toBe('unstored');
    expect(JSON.parse(rawStore().get(TAG_KEY)!)).toEqual([T1]);
    expect(readRetargetUnstorable(KEY)).toBeNull();
  });
});

describe('[#4604] release: only what the question saw (N-7・N-11)', () => {
  it('an "unknown" the question saw goes with the send; the tags left stay a list', () => {
    rawStore().set(TAG_KEY, JSON.stringify({ unknown: 'g-1', tags: [T1, T2] }));
    writeRetarget(KEY, { kind: 'release', ids: [T1.id], seen: ['g-1'] });
    expect(readRetargetStore(KEY)).toEqual({ kind: 'list', tags: [T2] });
  });

  it('an "unknown" born after the question stays', () => {
    rawStore().set(TAG_KEY, JSON.stringify({ unknown: 'g-2', tags: [T1] }));
    writeRetarget(KEY, { kind: 'release', ids: [T1.id], seen: ['g-1'] });
    expect(readRetargetStore(KEY)).toEqual({ kind: 'unknown', generation: 'g-2', tags: [] });
    writeRetarget(KEY, { kind: 'release', ids: [], seen: null });
    expect(readRetargetStore(KEY).kind).toBe('unknown');
  });

  it('junk is never let go', () => {
    rawStore().set(TAG_KEY, '{not json');
    writeRetarget(KEY, { kind: 'release', ids: [T1.id], seen: ['g-1'] });
    expect(rawStore().get(TAG_KEY)).toBe('{not json');
  });

  it('N-11: a release with no ids lets go of the page mark its question saw (and only that generation)', () => {
    const faults = installStoreFaults([{ method: 'setItem', key: isDraftValueKey }]);
    writeRetarget(KEY, { kind: 'add', tags: [T1] });
    faults.restore();
    const generation = readRetargetUnstorable(KEY)!;
    writeRetarget(KEY, { kind: 'release', ids: [], seen: ['another'] });
    expect(readRetargetUnstorable(KEY)).toBe(generation);
    writeRetarget(KEY, { kind: 'release', ids: [], seen: [generation] });
    expect(readRetargetUnstorable(KEY)).toBeNull();
  });
});

describe('[#4604] returnRetargetedText through the road', () => {
  it('a tag stored only as "unknown" (a full store) still hands the text back — every send of it asks', () => {
    installStoreFaults([{ method: 'setItem', key: isDraftValueKey, overBytes: shortValueLength('please look') }]);
    const heard = vi.fn();
    const off = subscribeRetargetedText(KEY, heard);
    expect(returnRetargetedText(KEY, { text: 'please look', tag: T1 })).toBe(true);
    off();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(storedDraft(KEY).text).toBe('please look');
    expect(readRetargetTagState(KEY).known).toBe(false);
  });

  it('nothing stored: nothing handed back, and nothing marked on the page (there is no text)', () => {
    installStoreFaults([{ method: 'setItem', key: isDraftValueKey }]);
    expect(returnRetargetedText(KEY, { text: 'please look', tag: T1 })).toBe(false);
    expect(rawStore().get(getDraftValueKey(KEY))).toBeNull();
    expect(readRetargetUnstorable(KEY)).toBeNull();
  });

  it('N-9: the text write throws with nobody showing the draft — not handed back, and the tag stays (no roll-back)', () => {
    rawStore().set(TAG_KEY, JSON.stringify([T2]));
    installStoreFaults([{ method: 'setItem', key: isDraftTextKey }]);
    expect(returnRetargetedText(KEY, { text: 'please look', tag: T1 })).toBe(false);
    // Issue #4604 S13 (ウ): the text and its tag are one write — the store keeps what it held (the tag
    // already there), and the new tag does not go in without its text.
    expect(readRetargetStore(KEY)).toEqual({ kind: 'list', tags: [T2] });
  });

  it('(negative control) a working store: the tag as a list, the text appended — as before', () => {
    rawStore().set(KEY, 'typed');
    expect(returnRetargetedText(KEY, { text: 'please look', tag: T1 })).toBe(true);
    expect(readRetargetTags(KEY)).toEqual([T1]);
    expect(storedDraft(KEY).text).toBe('typed\n\nplease look');
  });
});
