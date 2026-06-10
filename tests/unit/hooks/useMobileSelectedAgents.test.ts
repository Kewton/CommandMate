/**
 * Tests for useMobileSelectedAgents hook (Issue #837)
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useMobileSelectedAgents,
  resolveMobileAgents,
  mobileSelectedAgentsKey,
  MOBILE_MAX_AGENTS,
} from '@/hooks/useMobileSelectedAgents';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WORKTREE_ID = 'wt-837';
const DB_5: CLIToolType[] = ['claude', 'codex', 'gemini', 'opencode', 'copilot'];

describe('resolveMobileAgents (pure)', () => {
  it('defaults to the first MOBILE_MAX_AGENTS of the DB selection when raw is null', () => {
    expect(resolveMobileAgents(null, DB_5)).toEqual(['claude', 'codex']);
  });

  it('keeps stored agents that are still in the DB selection', () => {
    expect(resolveMobileAgents(['gemini', 'copilot'], DB_5)).toEqual(['gemini', 'copilot']);
  });

  it('drops stored agents no longer in the DB selection and tops up from DB order', () => {
    // 'vibe-local' is not in DB_5 -> dropped; topped up from DB order (claude first)
    expect(resolveMobileAgents(['vibe-local', 'gemini'], DB_5)).toEqual(['gemini', 'claude']);
  });

  it('caps the result at MOBILE_MAX_AGENTS', () => {
    const result = resolveMobileAgents(['claude', 'codex', 'gemini'], DB_5);
    expect(result).toHaveLength(MOBILE_MAX_AGENTS);
    expect(result).toEqual(['claude', 'codex']);
  });

  it('returns fewer than MOBILE_MAX_AGENTS when the DB selection is smaller', () => {
    expect(resolveMobileAgents(null, ['claude'])).toEqual(['claude']);
  });
});

describe('useMobileSelectedAgents', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('initializes to the first 2 DB agents when no preference is stored', () => {
    const { result } = renderHook(() =>
      useMobileSelectedAgents({ worktreeId: WORKTREE_ID, dbSelectedAgents: DB_5 })
    );
    expect(result.current.mobileSelectedAgents).toEqual(['claude', 'codex']);
  });

  it('persists the selection to localStorage (capped at 2) without touching the DB', () => {
    const { result } = renderHook(() =>
      useMobileSelectedAgents({ worktreeId: WORKTREE_ID, dbSelectedAgents: DB_5 })
    );

    act(() => {
      result.current.setMobileSelectedAgents(['gemini', 'copilot']);
    });

    expect(result.current.mobileSelectedAgents).toEqual(['gemini', 'copilot']);
    const stored = window.localStorage.getItem(mobileSelectedAgentsKey(WORKTREE_ID));
    expect(stored).toBe(JSON.stringify(['gemini', 'copilot']));
  });

  it('restores the stored preference on mount', () => {
    window.localStorage.setItem(
      mobileSelectedAgentsKey(WORKTREE_ID),
      JSON.stringify(['gemini', 'opencode'])
    );
    const { result } = renderHook(() =>
      useMobileSelectedAgents({ worktreeId: WORKTREE_ID, dbSelectedAgents: DB_5 })
    );
    expect(result.current.mobileSelectedAgents).toEqual(['gemini', 'opencode']);
  });

  it('ignores malformed stored values and falls back to the DB default', () => {
    window.localStorage.setItem(mobileSelectedAgentsKey(WORKTREE_ID), '{not json');
    const { result } = renderHook(() =>
      useMobileSelectedAgents({ worktreeId: WORKTREE_ID, dbSelectedAgents: DB_5 })
    );
    expect(result.current.mobileSelectedAgents).toEqual(['claude', 'codex']);
  });

  it('caps writes to MOBILE_MAX_AGENTS items', () => {
    const { result } = renderHook(() =>
      useMobileSelectedAgents({ worktreeId: WORKTREE_ID, dbSelectedAgents: DB_5 })
    );
    act(() => {
      result.current.setMobileSelectedAgents(['claude', 'codex', 'gemini']);
    });
    const stored = JSON.parse(
      window.localStorage.getItem(mobileSelectedAgentsKey(WORKTREE_ID)) ?? '[]'
    );
    expect(stored).toEqual(['claude', 'codex']);
  });
});
