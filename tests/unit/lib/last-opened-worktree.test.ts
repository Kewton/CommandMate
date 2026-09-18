/**
 * @vitest-environment jsdom
 *
 * Issue #2643: 最後に開いたブランチの記録と `/` の行き先。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LAST_OPENED_WORKTREE_STORAGE_KEY,
  HOME_FALLBACK_PATH,
  readLastOpenedWorktreeId,
  writeLastOpenedWorktreeId,
  resolveHomeRedirect,
} from '@/lib/last-opened-worktree';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveHomeRedirect', () => {
  it('記録が一覧にあればそのブランチの URL を返す', () => {
    expect(resolveHomeRedirect({ lastOpenedId: 'wt-1', worktreeIds: ['wt-0', 'wt-1'] })).toBe(
      '/worktrees/wt-1'
    );
  });

  it('ID を URL エンコードする', () => {
    expect(resolveHomeRedirect({ lastOpenedId: 'a b/c', worktreeIds: ['a b/c'] })).toBe(
      '/worktrees/a%20b%2Fc'
    );
  });

  it.each([
    ['記録なし', null, ['wt-1']],
    ['空文字', '', ['wt-1']],
    ['一覧に無い', 'wt-9', ['wt-1']],
    ['一覧が空', 'wt-1', []],
  ] as const)('%s なら /sessions を返す', (_label, lastOpenedId, worktreeIds) => {
    expect(resolveHomeRedirect({ lastOpenedId, worktreeIds })).toBe('/sessions');
    expect(HOME_FALLBACK_PATH).toBe('/sessions');
  });
});

describe('readLastOpenedWorktreeId / writeLastOpenedWorktreeId', () => {
  it('キーは commandmate.lastOpenedWorktreeId', () => {
    expect(LAST_OPENED_WORKTREE_STORAGE_KEY).toBe('commandmate.lastOpenedWorktreeId');
  });

  it('書いた ID を読める', () => {
    writeLastOpenedWorktreeId('wt-42');
    expect(localStorage.getItem(LAST_OPENED_WORKTREE_STORAGE_KEY)).toBe('wt-42');
    expect(readLastOpenedWorktreeId()).toBe('wt-42');
  });

  it('記録が無ければ null', () => {
    expect(readLastOpenedWorktreeId()).toBeNull();
  });

  it('空文字は書かない', () => {
    writeLastOpenedWorktreeId('');
    expect(localStorage.getItem(LAST_OPENED_WORKTREE_STORAGE_KEY)).toBeNull();
  });

  it('getItem が例外を投げても null を返す', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readLastOpenedWorktreeId()).toBeNull();
  });

  it('setItem が例外を投げても例外を外に出さない', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => writeLastOpenedWorktreeId('wt-1')).not.toThrow();
  });
});
