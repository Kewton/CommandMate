/**
 * The worktree detail controller seeds its tabs from the configured default
 * (Issue #2065).
 *
 * Four `useState` initializers read the fallback — `selectedAgents`,
 * `agentInstances`, `activeCliTab`, `activeInstanceId` — and all four ran off
 * the compiled-in constant before this Issue. The client store starts AT that
 * constant, so the only way to tell "reads the store" from "reads the constant"
 * is to seed the store with a value that differs from it in membership and
 * order, and then mount.
 *
 * Every assertion here is made in the synchronous window before the detail
 * fetch resolves (`fetch` returns a promise that never settles), because that
 * window IS the thing under test: what the terminal header renders in the
 * moment before the worktree payload lands.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import React from 'react';
import type { UseWorktreesCacheReturn } from '@/hooks/useWorktreesCache';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-2065',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true,
    width: 288,
    isMobileDrawerOpen: false,
    toggle: vi.fn(),
    setWidth: vi.fn(),
    openMobileDrawer: vi.fn(),
    closeMobileDrawer: vi.fn(),
  }),
}));

vi.mock('@/hooks/useUpdateCheck', () => ({
  useUpdateCheck: () => ({ data: null, loading: false, error: null }),
}));

const mockCache: { current: UseWorktreesCacheReturn | null } = { current: null };
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => mockCache.current,
}));

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';
import {
  resetClientDefaultSelectedAgents,
  setClientDefaultSelectedAgents,
} from '@/config/default-agents';

const mockFetch = vi.fn();

function mount() {
  return renderHook(() => useWorktreeDetailController({ worktreeId: 'wt-2065' })).result;
}

/**
 * Every render's tab pair, oldest first.
 *
 * `renderHook` only exposes the LATEST render, and the reconcile effect
 * (`activeCliTab` follows the active instance's CLI tool) repairs a wrong
 * `activeCliTab` immediately after the first paint — so the latest snapshot
 * cannot distinguish "the initializer read the store" from "the initializer was
 * wrong and the effect fixed it a frame later". Snapshot `[0]` is the initial
 * render, which is the frame the initializer actually owns.
 */
function renderSnapshots(): Array<{ cliTab: string; instanceId: string }> {
  const seen: Array<{ cliTab: string; instanceId: string }> = [];
  function Probe() {
    const controller = useWorktreeDetailController({ worktreeId: 'wt-2065' });
    seen.push({
      cliTab: controller.activeCliTab,
      instanceId: controller.activeInstanceId,
    });
    return null;
  }
  render(React.createElement(Probe));
  return seen;
}

beforeEach(() => {
  mockCache.current = null;
  mockFetch.mockReset();
  // Never settles: freezes the hook in its initial state, which is the state
  // the four initializers produce.
  mockFetch.mockImplementation(() => new Promise(() => {}));
  global.fetch = mockFetch as unknown as typeof fetch;
  // `activeCliTab` / `activeInstanceId` consult localStorage BEFORE the
  // fallback, so a leftover key from another suite would mask the seed.
  window.localStorage.clear();
  resetClientDefaultSelectedAgents();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetClientDefaultSelectedAgents();
});

describe('useWorktreeDetailController seeds from the configured default (Issue #2065)', () => {
  it('starts on the compiled-in constant when nothing has been seeded', () => {
    const result = mount();

    expect(result.current.selectedAgents).toEqual(['claude', 'codex', 'antigravity']);
    expect(result.current.activeCliTab).toBe('claude');
    expect(result.current.activeInstanceId).toBe('claude');
  });

  it('seeds selectedAgents from the store, in the configured order', () => {
    setClientDefaultSelectedAgents(['codex', 'claude']);

    const result = mount();

    expect(result.current.selectedAgents).toEqual(['codex', 'claude']);
    expect(result.current.selectedAgents).not.toContain('antigravity');
  });

  it('derives the seed roster from the store, so the tabs open in that order', () => {
    setClientDefaultSelectedAgents(['codex', 'claude']);

    const result = mount();

    expect(result.current.agentInstances.map((i) => i.cliTool)).toEqual(['codex', 'claude']);
    expect(result.current.agentInstances.map((i) => i.id)).toEqual(['codex', 'claude']);
  });

  it('opens on the configured PRIMARY, not on claude', () => {
    setClientDefaultSelectedAgents(['codex', 'claude']);

    const result = mount();

    // The two separate `getClientDefaultSelectedAgents()[0]` reads: the CLI tab
    // and the instance tab. They are distinct initializers and can rot apart.
    expect(result.current.activeCliTab).toBe('codex');
    expect(result.current.activeInstanceId).toBe('codex');
  });

  /**
   * The `activeCliTab` initializer specifically, on the frame it owns.
   *
   * Reverting that one line to the constant is invisible to every assertion
   * above: `activeInstanceId` still seeds to `codex`, and the reconcile effect
   * then drags `activeCliTab` to `codex` before `renderHook` reports anything.
   * What it actually costs is one render in which the CLI-tab-keyed concerns
   * (auto-yes, status, kill) point at a different agent than the instance tab —
   * so that render is what gets asserted.
   */
  it('never paints a frame where the CLI tab disagrees with the instance tab', () => {
    setClientDefaultSelectedAgents(['codex', 'claude']);

    const snapshots = renderSnapshots();

    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]).toEqual({ cliTab: 'codex', instanceId: 'codex' });
    for (const [i, snapshot] of snapshots.entries()) {
      expect(snapshot.cliTab, `render #${i}`).toBe(snapshot.instanceId);
    }
  });

  /**
   * The fallback is the LAST resort in these two initializers: seeding the
   * store must not start overriding the tab the user last had open.
   *
   * The persisted value has to be one the seeded roster contains — the
   * reconcile effect legitimately evicts a tab that is not in the roster, so
   * persisting `gemini` here would assert the reconciler, not the fallback.
   */
  it('still lets a persisted tab choice win over the configured primary', () => {
    window.localStorage.setItem('activeCliTab-wt-2065', 'claude');
    setClientDefaultSelectedAgents(['codex', 'claude']);

    const result = mount();

    expect(result.current.activeCliTab).toBe('claude');
    expect(result.current.activeInstanceId).toBe('claude');
  });
});
