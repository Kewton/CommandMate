/**
 * Issue #4535 r7 (INV-V2a・V2b, 設計書 §3.4.1): a text the send fence handed back travels with its
 * tag (`RetargetTag = { id, original }`) as one value, into one draft — never as a bare string, never
 * into a table shared by the worktree.
 *
 * - V2a (types): the road that hands a fence's text back takes `{ text, tag }`; a text without its
 *   tag, or a bare string, does not compile (`// @ts-expect-error`, checked by `npx tsc --noEmit`)
 * - V2a (runtime): the tag is stored next to the draft it goes into (`<draftKey>:retarget`) and the
 *   composer showing that draft hears both together; a tag that cannot be stored hands nothing back
 *   (fail-closed)
 * - V2b: one draft's tags are not another's, and how many come back does not push any out
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach, expectTypeOf } from 'vitest';
import {
  getDraftValueKey,
  getRetargetTagKey,
  getSplitDraftKey,
  newRetargetTag,
  readDraft,
  readRetargetTags,
  returnRetargetedText,
  subscribeRetargetedText,
  type RetargetedText,
} from '@/lib/drafts/message-draft';
import type { useSendRefusalNotice } from '@/hooks/useSendRefusalNotice';

const WT = 'wt-4535-tag';
const KEY = getSplitDraftKey(WT, 0);
const OTHER = getSplitDraftKey(WT, 1);
const X = { instanceId: 'codex-2', cliToolId: 'codex' };

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('[#4535 r7 INV-V2a] the types: no fence text without its tag', () => {
  it('the hand-back road takes { text, tag } only', () => {
    // Never run: these are for the type checker.
    const neverRun = (): void => {
      // @ts-expect-error a text without its tag cannot be handed back
      returnRetargetedText(KEY, { text: 'x' });
      // @ts-expect-error nor a bare string
      returnRetargetedText(KEY, 'x');
      // @ts-expect-error a string insert cannot stand in for the tagged road
      const road: NonNullable<Parameters<typeof useSendRefusalNotice>[1]> = (content: string) => content !== '';
      void road;
    };
    void neverRun;
    expectTypeOf<RetargetedText['tag']>().not.toBeNullable();
    expectTypeOf<NonNullable<Parameters<typeof useSendRefusalNotice>[1]>>().parameter(0).toEqualTypeOf<RetargetedText>();
    expectTypeOf(returnRetargetedText).parameter(1).toEqualTypeOf<RetargetedText>();
  });
});

describe('[#4535 r7 INV-V2a] returnRetargetedText: the text and its tag go together', () => {
  it('the tag is stored next to the draft, the text is appended, the composer showing it hears both', () => {
    window.localStorage.setItem(KEY, 'already typed');
    const heard: RetargetedText[] = [];
    const off = subscribeRetargetedText(KEY, (returned) => heard.push(returned));
    const tag = newRetargetTag(X);
    expect(returnRetargetedText(KEY, { text: 'please look', tag })).toBe(true);
    off();
    expect(readRetargetTags(KEY)).toEqual([tag]);
    // Issue #4604 S13: the tag and the text are in the draft's one value, next to nothing else.
    expect(window.localStorage.getItem(getDraftValueKey(KEY))).not.toBeNull();
    expect(readDraft(KEY).text).toBe('already typed\n\nplease look');
    expect(heard).toEqual([{ text: 'please look', tag }]);
    // Nothing is written for the worktree as a whole.
    expect(window.localStorage.getItem(`commandmate:draft-message:${WT}:retarget-hold`)).toBeNull();
  });

  it('each hand-back has its own id', () => {
    expect(newRetargetTag(X).id).not.toBe(newRetargetTag(X).id);
  });

  it('fail-closed: a tag that cannot be stored hands nothing back', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const heard = vi.fn();
    const off = subscribeRetargetedText(KEY, heard);
    expect(returnRetargetedText(KEY, { text: 'please look', tag: newRetargetTag(X) })).toBe(false);
    off();
    expect(heard).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('(negative control) an empty text hands nothing back', () => {
    expect(returnRetargetedText(KEY, { text: '', tag: newRetargetTag(X) })).toBe(false);
    expect(readRetargetTags(KEY)).toEqual([]);
  });
});

describe('[#4535 r7 INV-V2b] one draft\'s tags, however many', () => {
  it('a draft\'s tags are not another draft\'s', () => {
    returnRetargetedText(KEY, { text: 'one', tag: newRetargetTag(X) });
    expect(readRetargetTags(OTHER)).toEqual([]);
  });

  it('25 texts back: 25 tags, none pushed out', () => {
    const tags = Array.from({ length: 25 }, () => newRetargetTag(X));
    tags.forEach((tag, n) => returnRetargetedText(KEY, { text: `text ${n}`, tag }));
    expect(readRetargetTags(KEY)).toEqual(tags);
  });

  it('junk in the store reads as no tags', () => {
    window.localStorage.setItem(getRetargetTagKey(KEY), '{not json');
    expect(readRetargetTags(KEY)).toEqual([]);
    window.localStorage.setItem(getRetargetTagKey(KEY), JSON.stringify([{ id: 1 }, { id: 'a', original: X }]));
    expect(readRetargetTags(KEY)).toEqual([{ id: 'a', original: X }]);
  });
});
