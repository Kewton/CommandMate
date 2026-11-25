/**
 * Issue #4607 (INV-V2c', 設計書 §3.4.1): `readRetargetTagState` — a draft's stored tags, and whether
 * the store could be read at all. The send's check reads it: a store it cannot read asks (`known:
 * false`), where `readRetargetTags` (unchanged) reads junk as no tags.
 *
 * | stored `<draftKey>:retarget` | tags | known |
 * |---|---|---|
 * | no key | [] | true |
 * | a well-formed array | the tags | true |
 * | `getItem` throws | [] | false |
 * | broken JSON | [] | false |
 * | not an array | [] | false |
 * | an element of another shape | [] | false |
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getRetargetTagKey,
  getSplitDraftKey,
  readRetargetTagState,
  readRetargetTags,
  type RetargetTag,
} from '@/lib/drafts/message-draft';

const KEY = getSplitDraftKey('wt-4607-state', 0);
const TAG_KEY = getRetargetTagKey(KEY);
const TAG: RetargetTag = { id: 't-1', original: { instanceId: 'codex-2', cliToolId: 'codex' } };

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('[#4607] readRetargetTagState: the stored tags and whether they could be read', () => {
  it('no key: no tags, known', () => {
    expect(readRetargetTagState(KEY)).toEqual({ tags: [], known: true });
  });

  it('a well-formed array: its tags, known', () => {
    const other: RetargetTag = { id: 't-2', original: { instanceId: 'claude', cliToolId: 'claude' } };
    window.localStorage.setItem(TAG_KEY, JSON.stringify([TAG, other]));
    expect(readRetargetTagState(KEY)).toEqual({ tags: [TAG, other], known: true });
  });

  it('an empty array: no tags, known', () => {
    window.localStorage.setItem(TAG_KEY, '[]');
    expect(readRetargetTagState(KEY)).toEqual({ tags: [], known: true });
  });

  it('getItem throws: not known', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(readRetargetTagState(KEY)).toEqual({ tags: [], known: false });
  });

  it.each([
    ['broken JSON', '[{"id":'],
    ['not an array', JSON.stringify({ id: 't-1', original: { instanceId: 'codex-2', cliToolId: 'codex' } })],
    ['an element of another shape', JSON.stringify([TAG, { id: 't-3', original: { instanceId: 7 } }])],
    ['a string element', JSON.stringify(['t-1'])],
  ])('%s: not known', (_name, raw) => {
    window.localStorage.setItem(TAG_KEY, raw);
    expect(readRetargetTagState(KEY)).toEqual({ tags: [], known: false });
  });
});

describe('[#4607] readRetargetTags is unchanged: junk reads as no tags', () => {
  it.each([
    ['broken JSON', '[{"id":'],
    ['not an array', '{"id":"t-1"}'],
  ])('%s: []', (_name, raw) => {
    window.localStorage.setItem(TAG_KEY, raw);
    expect(readRetargetTags(KEY)).toEqual([]);
  });

  it('an element of another shape is dropped, the rest kept', () => {
    window.localStorage.setItem(TAG_KEY, JSON.stringify([TAG, { id: 't-3' }]));
    expect(readRetargetTags(KEY)).toEqual([TAG]);
  });

  it('getItem throws: []', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(readRetargetTags(KEY)).toEqual([]);
  });
});
