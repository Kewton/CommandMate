/**
 * Issue #3552: the counter half of the fix in `response-dedup`.
 *
 * - `resetDuplicateResponseSkipStreak` ends the run of duplicate ticks without
 *   touching the hash (the response-side twin of #3538's prompt reset);
 * - a rename that replaces the hash under the new key replaces its count too,
 *   so a count left from the hash that was there before does not survive.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  claimDuplicateResponseSkipLog,
  clearResponseHashCache,
  isDuplicateResponse,
  renameResponseHashCacheKey,
  resetDuplicateResponseSkipStreak,
} from '@/lib/polling/response-dedup';

const KEY = 'wt-3552:claude';
const OTHER = 'wt-3552-renamed:claude';

beforeEach(() => {
  clearResponseHashCache(KEY);
  clearResponseHashCache(OTHER);
});

describe('Issue #3552: resetDuplicateResponseSkipStreak', () => {
  it('ends the run but keeps the hash', () => {
    isDuplicateResponse(KEY, 'reply A');
    for (let i = 0; i < 5; i++) claimDuplicateResponseSkipLog(KEY);

    resetDuplicateResponseSkipStreak(KEY);

    // The reply is still a duplicate (#1268) …
    expect(isDuplicateResponse(KEY, 'reply A')).toBe(true);
    // … and its next skip is the first of a new run.
    expect(claimDuplicateResponseSkipLog(KEY)).toEqual({ log: true, consecutive: 1, suppressed: 0 });
  });

  it('only touches its own key', () => {
    for (let i = 0; i < 5; i++) claimDuplicateResponseSkipLog(OTHER);
    resetDuplicateResponseSkipStreak(KEY);
    expect(claimDuplicateResponseSkipLog(OTHER).consecutive).toBe(6);
  });
});

describe('Issue #3552: a rename replaces the count with the hash', () => {
  it('a source with a hash but no count clears the stale count at the destination', () => {
    isDuplicateResponse(OTHER, 'old reply');
    for (let i = 0; i < 7; i++) claimDuplicateResponseSkipLog(OTHER);
    isDuplicateResponse(KEY, 'reply A');

    renameResponseHashCacheKey(KEY, OTHER);

    expect(isDuplicateResponse(OTHER, 'reply A')).toBe(true);
    expect(claimDuplicateResponseSkipLog(OTHER)).toEqual({ log: true, consecutive: 1, suppressed: 0 });
  });

  it('a source with a count overwrites the destination count', () => {
    isDuplicateResponse(OTHER, 'old reply');
    for (let i = 0; i < 7; i++) claimDuplicateResponseSkipLog(OTHER);
    isDuplicateResponse(KEY, 'reply A');
    for (let i = 0; i < 2; i++) claimDuplicateResponseSkipLog(KEY);

    renameResponseHashCacheKey(KEY, OTHER);

    expect(claimDuplicateResponseSkipLog(OTHER).consecutive).toBe(3);
  });

  it('a source with no hash leaves the destination as it was', () => {
    isDuplicateResponse(OTHER, 'old reply');
    for (let i = 0; i < 7; i++) claimDuplicateResponseSkipLog(OTHER);

    renameResponseHashCacheKey(KEY, OTHER);

    expect(isDuplicateResponse(OTHER, 'old reply')).toBe(true);
    expect(claimDuplicateResponseSkipLog(OTHER).consecutive).toBe(8);
  });
});
