/**
 * Issue #3519: the `duplicate-response-skipped` log line is thinned to the first
 * duplicate tick of a run and then one in every
 * {@link DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL} ticks.
 *
 * This suite pins the counter in `response-dedup`: when it says "log", what it
 * reports as suppressed, and that it ends at exactly the moments the response
 * hash does (a new response, `clearResponseHashCache`, a rename).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL,
  claimDuplicateResponseSkipLog,
  clearResponseHashCache,
  isDuplicateResponse,
  renameResponseHashCacheKey,
} from '@/lib/polling/response-dedup';

const KEY = 'wt-3519:claude';
const OTHER = 'wt-3519-renamed:claude';
const N = DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL;

/** Run `ticks` duplicate ticks and return the 1-based tick numbers that logged. */
function loggedTicks(key: string, ticks: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= ticks; i++) {
    if (claimDuplicateResponseSkipLog(key).log) out.push(i);
  }
  return out;
}

beforeEach(() => {
  clearResponseHashCache(KEY);
  clearResponseHashCache(OTHER);
});

describe('Issue #3519: duplicate-response-skipped is thinned', () => {
  it('the interval is about a minute of 2 s ticks', () => {
    expect(N).toBeGreaterThanOrEqual(20);
    expect(N).toBeLessThanOrEqual(40);
  });

  it('the first duplicate tick logs, with nothing suppressed', () => {
    expect(claimDuplicateResponseSkipLog(KEY)).toEqual({ log: true, consecutive: 1, suppressed: 0 });
  });

  it('the ticks in between do not log', () => {
    claimDuplicateResponseSkipLog(KEY);
    for (let i = 2; i <= N; i++) {
      expect(claimDuplicateResponseSkipLog(KEY).log).toBe(false);
    }
  });

  it('the tick N after the first logs again, carrying the run length and the suppressed count', () => {
    for (let i = 1; i <= N; i++) claimDuplicateResponseSkipLog(KEY);
    expect(claimDuplicateResponseSkipLog(KEY)).toEqual({
      log: true,
      consecutive: N + 1,
      suppressed: N - 1,
    });
  });

  it('a full 900-tick cycle logs ceil(900 / N) lines, not 900', () => {
    const logged = loggedTicks(KEY, 900);
    expect(logged).toHaveLength(Math.ceil(900 / N));
    expect(logged[0]).toBe(1);
    expect(logged[1]).toBe(N + 1);
  });

  it('a new (non-duplicate) response restarts the count', () => {
    expect(isDuplicateResponse(KEY, 'reply A')).toBe(false);
    loggedTicks(KEY, 5);

    expect(isDuplicateResponse(KEY, 'reply B')).toBe(false);
    expect(claimDuplicateResponseSkipLog(KEY)).toEqual({ log: true, consecutive: 1, suppressed: 0 });
  });

  it('a duplicate response does not restart the count', () => {
    expect(isDuplicateResponse(KEY, 'reply A')).toBe(false);
    loggedTicks(KEY, 5);

    expect(isDuplicateResponse(KEY, 'reply A')).toBe(true);
    expect(claimDuplicateResponseSkipLog(KEY).consecutive).toBe(6);
  });

  it('clearResponseHashCache (what stopPolling calls) ends the count with the hash', () => {
    isDuplicateResponse(KEY, 'reply A');
    loggedTicks(KEY, 5);

    clearResponseHashCache(KEY);

    expect(claimDuplicateResponseSkipLog(KEY)).toEqual({ log: true, consecutive: 1, suppressed: 0 });
  });

  it('a rename moves the count with the hash', () => {
    isDuplicateResponse(KEY, 'reply A');
    loggedTicks(KEY, 5);

    renameResponseHashCacheKey(KEY, OTHER);

    expect(isDuplicateResponse(OTHER, 'reply A')).toBe(true);
    expect(claimDuplicateResponseSkipLog(OTHER).consecutive).toBe(6);
    expect(claimDuplicateResponseSkipLog(KEY).consecutive).toBe(1);
  });

  it('counts are per pollerKey', () => {
    loggedTicks(KEY, 5);
    expect(claimDuplicateResponseSkipLog(OTHER).consecutive).toBe(1);
  });
});
