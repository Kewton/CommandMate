/**
 * Issue #3538: the `duplicate-prompt-skipped` log line is thinned to the first
 * duplicate tick of a run and then one in every
 * {@link DUPLICATE_PROMPT_SKIP_LOG_TICK_INTERVAL} ticks, like
 * `duplicate-response-skipped` (#3519).
 *
 * This suite pins the counter in `prompt-dedup`: when it says "log", what it
 * reports as suppressed, and that it ends at exactly the moments the prompt
 * hash does (a new prompt, `clearPromptHashCache`, a rename).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DUPLICATE_PROMPT_SKIP_LOG_TICK_INTERVAL,
  claimDuplicatePromptSkipLog,
  clearPromptHashCache,
  isDuplicatePrompt,
  renamePromptHashCacheKey,
} from '@/lib/polling/prompt-dedup';
import { DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL } from '@/lib/polling/response-dedup';

const KEY = 'wt-3538:copilot';
const OTHER = 'wt-3538-renamed:copilot';
const N = DUPLICATE_PROMPT_SKIP_LOG_TICK_INTERVAL;

/** Run `ticks` duplicate ticks and return the 1-based tick numbers that logged. */
function loggedTicks(key: string, ticks: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= ticks; i++) {
    if (claimDuplicatePromptSkipLog(key).log) out.push(i);
  }
  return out;
}

beforeEach(() => {
  clearPromptHashCache(KEY);
  clearPromptHashCache(OTHER);
});

describe('Issue #3538: duplicate-prompt-skipped is thinned', () => {
  it('uses the same interval as duplicate-response-skipped (#3519)', () => {
    expect(N).toBe(DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL);
  });

  it('the first duplicate tick logs, with nothing suppressed', () => {
    expect(claimDuplicatePromptSkipLog(KEY)).toEqual({ log: true, consecutive: 1, suppressed: 0 });
  });

  it('the ticks in between do not log', () => {
    claimDuplicatePromptSkipLog(KEY);
    for (let i = 2; i <= N; i++) {
      expect(claimDuplicatePromptSkipLog(KEY).log).toBe(false);
    }
  });

  it('the tick N after the first logs again, carrying the run length and the suppressed count', () => {
    for (let i = 1; i <= N; i++) claimDuplicatePromptSkipLog(KEY);
    expect(claimDuplicatePromptSkipLog(KEY)).toEqual({
      log: true,
      consecutive: N + 1,
      suppressed: N - 1,
    });
  });

  it('a 900-tick wait logs ceil(900 / N) lines, not 900', () => {
    const logged = loggedTicks(KEY, 900);
    expect(logged).toHaveLength(Math.ceil(900 / N));
    expect(logged[0]).toBe(1);
    expect(logged[1]).toBe(N + 1);
  });

  it('a new prompt (a different hash) restarts the count', () => {
    expect(isDuplicatePrompt(KEY, 'prompt A')).toBe(false);
    loggedTicks(KEY, 5);

    expect(isDuplicatePrompt(KEY, 'prompt B')).toBe(false);
    expect(claimDuplicatePromptSkipLog(KEY)).toEqual({ log: true, consecutive: 1, suppressed: 0 });
  });

  it('a duplicate prompt does not restart the count', () => {
    expect(isDuplicatePrompt(KEY, 'prompt A')).toBe(false);
    loggedTicks(KEY, 5);

    expect(isDuplicatePrompt(KEY, 'prompt A')).toBe(true);
    expect(claimDuplicatePromptSkipLog(KEY).consecutive).toBe(6);
  });

  it('clearPromptHashCache (what stopPolling and session cleanup call) ends the count with the hash', () => {
    isDuplicatePrompt(KEY, 'prompt A');
    loggedTicks(KEY, 5);

    clearPromptHashCache(KEY);

    expect(isDuplicatePrompt(KEY, 'prompt A')).toBe(false);
    expect(claimDuplicatePromptSkipLog(KEY)).toEqual({ log: true, consecutive: 1, suppressed: 0 });
  });

  it('a rename moves the count with the hash', () => {
    isDuplicatePrompt(KEY, 'prompt A');
    loggedTicks(KEY, 5);

    renamePromptHashCacheKey(KEY, OTHER);

    expect(isDuplicatePrompt(OTHER, 'prompt A')).toBe(true);
    expect(claimDuplicatePromptSkipLog(OTHER).consecutive).toBe(6);
    expect(claimDuplicatePromptSkipLog(KEY).consecutive).toBe(1);
  });

  it('counts are per pollerKey', () => {
    loggedTicks(KEY, 5);
    expect(claimDuplicatePromptSkipLog(OTHER).consecutive).toBe(1);
  });
});
