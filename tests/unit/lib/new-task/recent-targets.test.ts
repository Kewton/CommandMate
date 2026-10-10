/**
 * The last three New task destinations (Issue #3511).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MAX_RECENT_TARGETS,
  RECENT_TARGETS_STORAGE_KEY,
  pushRecentTarget,
  readRecentTargets,
} from '@/lib/new-task/recent-targets';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('[#3511] recent New task targets', () => {
  it('is empty before anything was sent', () => {
    expect(readRecentTargets()).toEqual([]);
  });

  it('keeps the newest first, without duplicates, at most three', () => {
    pushRecentTarget({ worktreeId: 'a', instanceId: 'claude' });
    pushRecentTarget({ worktreeId: 'b', instanceId: 'codex' });
    pushRecentTarget({ worktreeId: 'a', instanceId: 'claude' });
    pushRecentTarget({ worktreeId: 'c', instanceId: 'codex-2' });
    pushRecentTarget({ worktreeId: 'd', instanceId: 'gemini' });

    expect(readRecentTargets()).toEqual([
      { worktreeId: 'd', instanceId: 'gemini' },
      { worktreeId: 'c', instanceId: 'codex-2' },
      { worktreeId: 'a', instanceId: 'claude' },
    ]);
    expect(readRecentTargets()).toHaveLength(MAX_RECENT_TARGETS);
  });

  it('keys on worktree + instance, so two instances of one branch are two entries', () => {
    pushRecentTarget({ worktreeId: 'a', instanceId: 'codex' });
    pushRecentTarget({ worktreeId: 'a', instanceId: 'codex-2' });
    expect(readRecentTargets()).toHaveLength(2);
  });

  it('drops malformed storage instead of throwing', () => {
    window.localStorage.setItem(RECENT_TARGETS_STORAGE_KEY, '{not json');
    expect(readRecentTargets()).toEqual([]);
    window.localStorage.setItem(
      RECENT_TARGETS_STORAGE_KEY,
      JSON.stringify([{ worktreeId: 'a' }, { worktreeId: 'b', instanceId: 'codex' }, 'x']),
    );
    expect(readRecentTargets()).toEqual([{ worktreeId: 'b', instanceId: 'codex' }]);
  });

  it('works when the storage refuses reads and writes', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(readRecentTargets()).toEqual([]);
    expect(pushRecentTarget({ worktreeId: 'a', instanceId: 'claude' })).toEqual([
      { worktreeId: 'a', instanceId: 'claude' },
    ]);
  });
});
