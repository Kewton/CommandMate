/**
 * Tests for useMobileSelectedAgents hook (Issue #837, #851)
 *
 * Issue #851: the mobile Agent tab can now select ALL CLI tools (up to
 * MOBILE_MAX_AGENTS=6) independently from the PC selection. The mobile
 * preference is resolved against CLI_TOOL_IDS (all agents), not the DB
 * `selectedAgents`. The initial default (no stored preference) is the first
 * MOBILE_DEFAULT_AGENTS of CLI_TOOL_IDS.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useMobileSelectedAgents,
  resolveMobileAgents,
  mobileSelectedAgentsKey,
  MOBILE_MAX_AGENTS,
  MOBILE_DEFAULT_AGENTS,
} from '@/hooks/useMobileSelectedAgents';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';

const WORKTREE_ID = 'wt-851';

describe('MOBILE_MAX_AGENTS / MOBILE_DEFAULT_AGENTS', () => {
  it('allows selecting all CLI tools (max = full agent count)', () => {
    expect(MOBILE_MAX_AGENTS).toBe(CLI_TOOL_IDS.length);
  });

  it('keeps a small initial default that does not exceed the max', () => {
    expect(MOBILE_DEFAULT_AGENTS).toBeGreaterThanOrEqual(1);
    expect(MOBILE_DEFAULT_AGENTS).toBeLessThanOrEqual(MOBILE_MAX_AGENTS);
  });
});

describe('resolveMobileAgents (pure)', () => {
  it('defaults to the first MOBILE_DEFAULT_AGENTS of CLI_TOOL_IDS when raw is null', () => {
    expect(resolveMobileAgents(null)).toEqual(['claude', 'codex']);
  });

  it('keeps stored agents the PC has NOT selected (independent from PC)', () => {
    // 'gemini'/'vibe-local'/'copilot' need not be in any DB selection.
    expect(resolveMobileAgents(['gemini', 'vibe-local', 'copilot'])).toEqual([
      'gemini',
      'vibe-local',
      'copilot',
    ]);
  });

  it('preserves the stored order', () => {
    expect(resolveMobileAgents(['copilot', 'claude'])).toEqual(['copilot', 'claude']);
  });

  it('drops entries that are not valid CLI tools', () => {
    expect(
      resolveMobileAgents(['bogus' as CLIToolType, 'gemini'])
    ).toEqual(['gemini']);
  });

  it('dedupes repeated entries', () => {
    expect(resolveMobileAgents(['claude', 'claude', 'codex'])).toEqual(['claude', 'codex']);
  });

  it('allows selecting all 6 agents (caps at MOBILE_MAX_AGENTS)', () => {
    const result = resolveMobileAgents([...CLI_TOOL_IDS]);
    expect(result).toHaveLength(MOBILE_MAX_AGENTS);
    expect(result).toEqual([...CLI_TOOL_IDS]);
  });

  it('caps the result at MOBILE_MAX_AGENTS even with extra duplicates', () => {
    const overflowing: CLIToolType[] = [...CLI_TOOL_IDS, 'claude', 'codex'];
    expect(resolveMobileAgents(overflowing)).toHaveLength(MOBILE_MAX_AGENTS);
  });

  it('falls back to the default when the stored preference is empty/invalid', () => {
    expect(resolveMobileAgents([])).toEqual(['claude', 'codex']);
    expect(resolveMobileAgents(['nope' as CLIToolType])).toEqual(['claude', 'codex']);
  });
});

describe('useMobileSelectedAgents', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('initializes to the first MOBILE_DEFAULT_AGENTS agents when no preference is stored', () => {
    const { result } = renderHook(() =>
      useMobileSelectedAgents({ worktreeId: WORKTREE_ID })
    );
    expect(result.current.mobileSelectedAgents).toEqual(['claude', 'codex']);
  });

  it('persists the selection to localStorage without touching the DB', () => {
    const { result } = renderHook(() =>
      useMobileSelectedAgents({ worktreeId: WORKTREE_ID })
    );

    act(() => {
      result.current.setMobileSelectedAgents(['gemini', 'opencode', 'copilot']);
    });

    expect(result.current.mobileSelectedAgents).toEqual(['gemini', 'opencode', 'copilot']);
    const stored = window.localStorage.getItem(mobileSelectedAgentsKey(WORKTREE_ID));
    expect(stored).toBe(JSON.stringify(['gemini', 'opencode', 'copilot']));
  });

  it('lets mobile select agents the PC never selected (independence)', () => {
    const { result } = renderHook(() =>
      useMobileSelectedAgents({ worktreeId: WORKTREE_ID })
    );
    act(() => {
      result.current.setMobileSelectedAgents(['vibe-local']);
    });
    expect(result.current.mobileSelectedAgents).toEqual(['vibe-local']);
  });

  it('restores the stored preference on mount', () => {
    window.localStorage.setItem(
      mobileSelectedAgentsKey(WORKTREE_ID),
      JSON.stringify(['gemini', 'opencode', 'copilot'])
    );
    const { result } = renderHook(() =>
      useMobileSelectedAgents({ worktreeId: WORKTREE_ID })
    );
    expect(result.current.mobileSelectedAgents).toEqual(['gemini', 'opencode', 'copilot']);
  });

  it('ignores malformed stored values and falls back to the default', () => {
    window.localStorage.setItem(mobileSelectedAgentsKey(WORKTREE_ID), '{not json');
    const { result } = renderHook(() =>
      useMobileSelectedAgents({ worktreeId: WORKTREE_ID })
    );
    expect(result.current.mobileSelectedAgents).toEqual(['claude', 'codex']);
  });

  it('caps writes to MOBILE_MAX_AGENTS items', () => {
    const { result } = renderHook(() =>
      useMobileSelectedAgents({ worktreeId: WORKTREE_ID })
    );
    act(() => {
      result.current.setMobileSelectedAgents([...CLI_TOOL_IDS, 'claude'] as CLIToolType[]);
    });
    const stored = JSON.parse(
      window.localStorage.getItem(mobileSelectedAgentsKey(WORKTREE_ID)) ?? '[]'
    );
    expect(stored).toHaveLength(MOBILE_MAX_AGENTS);
    expect(stored).toEqual([...CLI_TOOL_IDS]);
  });
});
