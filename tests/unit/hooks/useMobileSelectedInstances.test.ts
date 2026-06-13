/**
 * Tests for useMobileSelectedInstances hook (Issue #874)
 *
 * 折衷案: the agent instance roster (id/alias/cliTool) lives in the DB and is
 * shared with PC. This hook owns ONLY the per-device "which instances to show
 * as tabs on THIS device" preference, persisted to localStorage (never the DB),
 * preserving the #837/#851 independence intent.
 *
 * Resolution is against the DB roster passed in:
 *   - no stored preference  -> show ALL roster instances (roster order)
 *   - stored subset         -> roster-ordered filter to the stored ids
 *   - stale ids (removed from roster) are dropped
 *   - at least one instance is always visible (MIN_VISIBLE_INSTANCES = 1)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useMobileSelectedInstances,
  resolveVisibleInstances,
  mobileSelectedInstancesKey,
  MIN_VISIBLE_INSTANCES,
} from '@/hooks/useMobileSelectedInstances';
import type { AgentInstance } from '@/lib/cli-tools/types';

const WORKTREE_ID = 'wt-874';

const ROSTER: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'claude-2', cliTool: 'claude', alias: 'Claude (review)', order: 1 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 2 },
];

const ids = (instances: AgentInstance[]): string[] => instances.map((i) => i.id);

describe('MIN_VISIBLE_INSTANCES', () => {
  it('requires at least one visible instance', () => {
    expect(MIN_VISIBLE_INSTANCES).toBe(1);
  });
});

describe('resolveVisibleInstances (pure)', () => {
  it('shows ALL roster instances when there is no stored preference', () => {
    expect(ids(resolveVisibleInstances(null, ROSTER))).toEqual(['claude', 'claude-2', 'codex']);
  });

  it('filters to the stored subset, preserving roster order', () => {
    // stored out of order -> still returned in roster order
    expect(ids(resolveVisibleInstances(['codex', 'claude'], ROSTER))).toEqual(['claude', 'codex']);
  });

  it('drops stored ids that are no longer in the roster', () => {
    expect(ids(resolveVisibleInstances(['claude-2', 'ghost'], ROSTER))).toEqual(['claude-2']);
  });

  it('dedupes repeated stored ids', () => {
    expect(ids(resolveVisibleInstances(['codex', 'codex'], ROSTER))).toEqual(['codex']);
  });

  it('falls back to ALL roster instances when the subset filters to empty', () => {
    expect(ids(resolveVisibleInstances([], ROSTER))).toEqual(['claude', 'claude-2', 'codex']);
    expect(ids(resolveVisibleInstances(['ghost'], ROSTER))).toEqual(['claude', 'claude-2', 'codex']);
  });

  it('returns an empty list when the roster is empty', () => {
    expect(resolveVisibleInstances(null, [])).toEqual([]);
    expect(resolveVisibleInstances(['claude'], [])).toEqual([]);
  });
});

describe('useMobileSelectedInstances', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to showing all roster instances when no preference is stored', () => {
    const { result } = renderHook(() =>
      useMobileSelectedInstances({ worktreeId: WORKTREE_ID, roster: ROSTER })
    );
    expect(ids(result.current.visibleInstances)).toEqual(['claude', 'claude-2', 'codex']);
    expect(result.current.hasStoredPreference).toBe(false);
  });

  it('toggling an instance off persists an explicit subset to localStorage (never the DB)', () => {
    const { result } = renderHook(() =>
      useMobileSelectedInstances({ worktreeId: WORKTREE_ID, roster: ROSTER })
    );

    act(() => {
      result.current.toggleInstanceVisible('claude-2');
    });

    expect(ids(result.current.visibleInstances)).toEqual(['claude', 'codex']);
    const stored = JSON.parse(
      window.localStorage.getItem(mobileSelectedInstancesKey(WORKTREE_ID)) ?? 'null'
    );
    expect(stored).toEqual(['claude', 'codex']);
  });

  it('does not allow hiding the last visible instance (MIN=1)', () => {
    window.localStorage.setItem(
      mobileSelectedInstancesKey(WORKTREE_ID),
      JSON.stringify(['codex'])
    );
    const { result } = renderHook(() =>
      useMobileSelectedInstances({ worktreeId: WORKTREE_ID, roster: ROSTER })
    );
    expect(ids(result.current.visibleInstances)).toEqual(['codex']);

    act(() => {
      result.current.toggleInstanceVisible('codex');
    });

    // Still visible — cannot hide the last one.
    expect(ids(result.current.visibleInstances)).toEqual(['codex']);
  });

  it('toggling a hidden instance back on re-inserts it in roster order', () => {
    window.localStorage.setItem(
      mobileSelectedInstancesKey(WORKTREE_ID),
      JSON.stringify(['codex'])
    );
    const { result } = renderHook(() =>
      useMobileSelectedInstances({ worktreeId: WORKTREE_ID, roster: ROSTER })
    );

    act(() => {
      result.current.toggleInstanceVisible('claude-2');
    });

    expect(ids(result.current.visibleInstances)).toEqual(['claude-2', 'codex']);
  });

  it('restores the stored preference on mount', () => {
    window.localStorage.setItem(
      mobileSelectedInstancesKey(WORKTREE_ID),
      JSON.stringify(['claude'])
    );
    const { result } = renderHook(() =>
      useMobileSelectedInstances({ worktreeId: WORKTREE_ID, roster: ROSTER })
    );
    expect(ids(result.current.visibleInstances)).toEqual(['claude']);
    expect(result.current.hasStoredPreference).toBe(true);
  });

  it('ignores malformed stored values and shows all roster instances', () => {
    window.localStorage.setItem(mobileSelectedInstancesKey(WORKTREE_ID), '{not json');
    const { result } = renderHook(() =>
      useMobileSelectedInstances({ worktreeId: WORKTREE_ID, roster: ROSTER })
    );
    expect(ids(result.current.visibleInstances)).toEqual(['claude', 'claude-2', 'codex']);
  });

  it('showInstances makes newly-added instances visible in explicit mode', () => {
    window.localStorage.setItem(
      mobileSelectedInstancesKey(WORKTREE_ID),
      JSON.stringify(['claude'])
    );
    const { result } = renderHook(() =>
      useMobileSelectedInstances({ worktreeId: WORKTREE_ID, roster: ROSTER })
    );
    expect(ids(result.current.visibleInstances)).toEqual(['claude']);

    act(() => {
      result.current.showInstances(['claude-2']);
    });

    expect(ids(result.current.visibleInstances)).toEqual(['claude', 'claude-2']);
  });

  it('reflects roster reordering in the visible order', () => {
    const reordered: AgentInstance[] = [
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 1 },
      { id: 'claude-2', cliTool: 'claude', alias: 'Claude (review)', order: 2 },
    ];
    const { result, rerender } = renderHook(
      ({ roster }) => useMobileSelectedInstances({ worktreeId: WORKTREE_ID, roster }),
      { initialProps: { roster: ROSTER } }
    );
    expect(ids(result.current.visibleInstances)).toEqual(['claude', 'claude-2', 'codex']);

    rerender({ roster: reordered });
    expect(ids(result.current.visibleInstances)).toEqual(['codex', 'claude', 'claude-2']);
  });
});
