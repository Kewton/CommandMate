/**
 * Issue #3553: a worktree-ID batch rename whose keys overlap keeps every
 * key's dedup state.
 *
 * `migrateResponsePollerWorktreeIds` stops every timer before restarting any so
 * a swap cannot self-collide, but the dedup maps used to be re-keyed one pair
 * at a time inside that loop. After A→B the state of B was already A's, and the
 * following B→A carried A's state back to A and left B empty. These tests drive
 * the real migrate function with `response-checker` stubbed (the poller only
 * has to be registered for the migration to see it, as in the #1695 suite) and
 * read the dedup maps straight off `globalThis`.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/polling/response-checker', () => ({
  checkForResponse: vi.fn(async () => false),
  flushPendingScrapedResponse: vi.fn(() => false),
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));

import {
  startPolling,
  stopAllPolling,
  migrateResponsePollerWorktreeIds,
} from '@/lib/polling/response-poller-core';
import {
  isDuplicateResponse,
  claimDuplicateResponseSkipLog,
  markStructuredHistoryRecheckPending,
  claimStructuredHistoryRecheck,
  clearResponseHashCache,
  renameResponseHashCacheKey,
  renameResponseHashCacheKeys,
} from '@/lib/polling/response-dedup';
import {
  isDuplicatePrompt,
  claimDuplicatePromptSkipLog,
  clearPromptHashCache,
  renamePromptHashCacheKeys,
} from '@/lib/polling/prompt-dedup';
import {
  recordPromptDedupSkip,
  getPromptDedupSkips,
  clearPromptDedupSkips,
} from '@/lib/polling/prompt-dedup-state';

type Globals = {
  __responseHashCache?: Map<string, string>;
  __structuredHistoryRecheckCache?: Map<string, number>;
  __duplicateResponseSkipStreak?: Map<string, number>;
  __promptHashCache?: Map<string, string>;
  __duplicatePromptSkipStreak?: Map<string, number>;
  __responsePollerCoordinator?: { pausedOnPrompt: Set<string> };
};
const g = globalThis as Globals;

const WT = { a: 'wt-3553-a', b: 'wt-3553-b', c: 'wt-3553-c', d: 'wt-3553-d' };
const key = (wt: string): string => `${wt}:claude`;
const ALL_KEYS = Object.values(WT).map(key);

/** Everything the dedup layer holds under one poller key. */
function responseState(pollerKey: string) {
  return {
    hash: g.__responseHashCache?.get(pollerKey),
    streak: g.__duplicateResponseSkipStreak?.get(pollerKey),
    recheck: g.__structuredHistoryRecheckCache?.get(pollerKey),
  };
}

function promptState(pollerKey: string) {
  return {
    hash: g.__promptHashCache?.get(pollerKey),
    streak: g.__duplicatePromptSkipStreak?.get(pollerKey),
  };
}

/**
 * Seed a distinct, recognisable state under `pollerKey`: a response hash for
 * `label`, `streak` duplicate ticks, a recheck claimed once (countdown left at
 * INTERVAL-1), and a prompt hash with `streak` prompt skip ticks.
 */
function seed(pollerKey: string, label: string, streak: number): void {
  isDuplicateResponse(pollerKey, `reply ${label}`);
  for (let i = 0; i < streak; i++) claimDuplicateResponseSkipLog(pollerKey);
  markStructuredHistoryRecheckPending(pollerKey);
  if (streak % 2 === 1) claimStructuredHistoryRecheck(pollerKey);
  isDuplicatePrompt(pollerKey, `prompt ${label}`);
  for (let i = 0; i < streak; i++) claimDuplicatePromptSkipLog(pollerKey);
}

function snapshot(pollerKey: string) {
  return { response: responseState(pollerKey), prompt: promptState(pollerKey) };
}

const EMPTY = {
  response: { hash: undefined, streak: undefined, recheck: undefined },
  prompt: { hash: undefined, streak: undefined },
};

function clearAll(): void {
  for (const k of ALL_KEYS) {
    clearResponseHashCache(k);
    clearPromptHashCache(k);
  }
  clearPromptDedupSkips();
}

beforeEach(() => {
  stopAllPolling();
  clearAll();
});

afterEach(() => {
  stopAllPolling();
  clearAll();
});

describe('Issue #3553: batch migrate with overlapping keys', () => {
  it('A↔B swap keeps each key\'s hash, skip count and recheck', () => {
    startPolling(WT.a, 'claude');
    startPolling(WT.b, 'claude');
    seed(key(WT.a), 'A', 3);
    seed(key(WT.b), 'B', 4);
    const before = { a: snapshot(key(WT.a)), b: snapshot(key(WT.b)) };
    // Premise: the two states differ in every field.
    expect(before.a.response.hash).not.toBe(before.b.response.hash);
    expect(before.a.response.recheck).not.toBe(before.b.response.recheck);
    recordPromptDedupSkip(WT.a, 'claude', undefined, 1_000);
    recordPromptDedupSkip(WT.b, 'claude', undefined, 2_000);
    recordPromptDedupSkip(WT.b, 'claude', undefined, 3_000);

    const moved = migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.a },
      ],
      () => 'claude'
    );

    expect(moved).toHaveLength(2);
    expect(snapshot(key(WT.b))).toEqual(before.a);
    expect(snapshot(key(WT.a))).toEqual(before.b);
    expect(getPromptDedupSkips(WT.b, 'claude')).toEqual({ skippedCount: 1, lastSkippedAt: 1_000 });
    expect(getPromptDedupSkips(WT.a, 'claude')).toEqual({ skippedCount: 2, lastSkippedAt: 3_000 });
  });

  it('A→B→C chain moves each state one step and leaves A empty', () => {
    startPolling(WT.a, 'claude');
    startPolling(WT.b, 'claude');
    seed(key(WT.a), 'A', 3);
    seed(key(WT.b), 'B', 4);
    const before = { a: snapshot(key(WT.a)), b: snapshot(key(WT.b)) };
    recordPromptDedupSkip(WT.b, 'claude', undefined, 4_000);

    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.c },
      ],
      () => 'claude'
    );

    expect(snapshot(key(WT.b))).toEqual(before.a);
    expect(snapshot(key(WT.c))).toEqual(before.b);
    expect(snapshot(key(WT.a))).toEqual(EMPTY);
    expect(getPromptDedupSkips(WT.c, 'claude')).toEqual({ skippedCount: 1, lastSkippedAt: 4_000 });
    expect(getPromptDedupSkips(WT.b, 'claude').skippedCount).toBe(0);
  });

  it('a running poller and a paused chain swap without losing either state', () => {
    startPolling(WT.a, 'claude');
    seed(key(WT.a), 'A', 3);
    // B is paused on a prompt: no timer, but it holds the response state of
    // the turn it paused on (#2230).
    g.__responsePollerCoordinator!.pausedOnPrompt.add(key(WT.b));
    isDuplicateResponse(key(WT.b), 'reply B');
    claimDuplicateResponseSkipLog(key(WT.b));
    claimDuplicateResponseSkipLog(key(WT.b));
    markStructuredHistoryRecheckPending(key(WT.b));
    const before = { a: responseState(key(WT.a)), b: responseState(key(WT.b)) };

    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.a },
      ],
      () => 'claude'
    );

    expect(responseState(key(WT.b))).toEqual(before.a);
    expect(responseState(key(WT.a))).toEqual(before.b);
    expect(g.__responsePollerCoordinator!.pausedOnPrompt.has(key(WT.a))).toBe(true);
  });

  it('two paused chains swapped keep their own state', () => {
    const paused = g.__responsePollerCoordinator!.pausedOnPrompt;
    paused.add(key(WT.a));
    paused.add(key(WT.b));
    isDuplicateResponse(key(WT.a), 'reply A');
    isDuplicateResponse(key(WT.b), 'reply B');
    claimDuplicateResponseSkipLog(key(WT.b));
    const before = { a: responseState(key(WT.a)), b: responseState(key(WT.b)) };

    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.a },
      ],
      () => 'claude'
    );

    expect(responseState(key(WT.b))).toEqual(before.a);
    expect(responseState(key(WT.a))).toEqual(before.b);
    expect(paused.has(key(WT.a))).toBe(true);
    expect(paused.has(key(WT.b))).toBe(true);
  });

  it('a recheck with no hash (lineCountIsCursor path) moves and leaves the old key', () => {
    startPolling(WT.a, 'claude');
    markStructuredHistoryRecheckPending(key(WT.a));
    claimStructuredHistoryRecheck(key(WT.a));
    expect(responseState(key(WT.a))).toEqual({ hash: undefined, streak: undefined, recheck: 2 });

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.d }], () => 'claude');

    expect(responseState(key(WT.d)).recheck).toBe(2);
    expect(responseState(key(WT.a)).recheck).toBeUndefined();
  });

  it('a recheck with no hash moves in a swap too', () => {
    startPolling(WT.a, 'claude');
    startPolling(WT.b, 'claude');
    markStructuredHistoryRecheckPending(key(WT.a));
    claimStructuredHistoryRecheck(key(WT.a));

    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.a },
      ],
      () => 'claude'
    );

    expect(responseState(key(WT.b)).recheck).toBe(2);
    expect(responseState(key(WT.a)).recheck).toBeUndefined();
  });
});

describe('Issue #3553: negative controls', () => {
  it('a batch does not attach a recheck already at the destination to the moved hash', () => {
    // C holds a recheck owed for another turn; A arrives with a hash and none.
    isDuplicateResponse(key(WT.a), 'reply A');
    markStructuredHistoryRecheckPending(key(WT.c));

    renameResponseHashCacheKeys([{ oldKey: key(WT.a), newKey: key(WT.c) }]);

    expect(responseState(key(WT.c)).hash).toBeDefined();
    expect(responseState(key(WT.c)).recheck).toBeUndefined();
    expect(responseState(key(WT.a))).toEqual(EMPTY.response);
  });

  it('a batch leaves the destination alone when the source holds nothing', () => {
    seed(key(WT.c), 'C', 3);
    const before = snapshot(key(WT.c));

    renameResponseHashCacheKeys([{ oldKey: key(WT.a), newKey: key(WT.c) }]);
    renamePromptHashCacheKeys([{ oldKey: key(WT.a), newKey: key(WT.c) }]);

    expect(snapshot(key(WT.c))).toEqual(before);
  });

  it('a batch ignores a rename onto the same key', () => {
    seed(key(WT.a), 'A', 3);
    const before = snapshot(key(WT.a));

    renameResponseHashCacheKeys([{ oldKey: key(WT.a), newKey: key(WT.a) }]);
    renamePromptHashCacheKeys([{ oldKey: key(WT.a), newKey: key(WT.a) }]);

    expect(snapshot(key(WT.a))).toEqual(before);
  });

  it('migrate ignores renames onto the same ID and keys with no state', () => {
    startPolling(WT.a, 'claude');
    seed(key(WT.a), 'A', 3);
    const before = snapshot(key(WT.a));

    const moved = migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.a }], () => 'claude');
    expect(moved).toEqual([]);
    expect(snapshot(key(WT.a))).toEqual(before);

    migrateResponsePollerWorktreeIds([{ oldId: WT.c, newId: WT.d }], () => 'claude');
    expect(snapshot(key(WT.d))).toEqual(EMPTY);
    expect(snapshot(key(WT.a))).toEqual(before);
  });

  it('the single rename keeps its earlier behaviour: a recheck at the destination stays', () => {
    isDuplicateResponse(key(WT.a), 'reply A');
    markStructuredHistoryRecheckPending(key(WT.c));

    renameResponseHashCacheKey(key(WT.a), key(WT.c));

    expect(responseState(key(WT.c)).hash).toBeDefined();
    expect(responseState(key(WT.c)).recheck).toBe(0);
    expect(responseState(key(WT.a))).toEqual(EMPTY.response);
  });

  it('a single-pair migrate moves everything off the old key', () => {
    startPolling(WT.a, 'claude');
    seed(key(WT.a), 'A', 3);
    const before = snapshot(key(WT.a));

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.d }], () => 'claude');

    expect(snapshot(key(WT.d))).toEqual(before);
    expect(snapshot(key(WT.a))).toEqual(EMPTY);
  });
});
