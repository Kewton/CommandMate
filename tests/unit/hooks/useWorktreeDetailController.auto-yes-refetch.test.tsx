/**
 * Regression tests for Issue #902 — Auto-Yes display reset on branch navigation.
 *
 * Bug: navigating away from a worktree and back made Auto-Yes appear reset (OFF),
 * most severely for ALIAS instances (e.g. `claude-2`) which had NO re-seed path
 * and stayed stuck OFF, while the primary merely flickered. Root cause: the only
 * UI re-seed path was the `current-output` poll, whose PC variant re-seeds only
 * the primary instance.
 *
 * Fix (案1 + 案2):
 *  - 案1: on worktreeId change OR rosterReady, fetch GET /api/worktrees/:id/auto-yes
 *         (no cliToolId) and reflect the full `instances` map into autoYesStateMap.
 *  - 案2: clear autoYesStateMap on worktreeId change so a previous worktree's
 *         values cannot bleed onto the new worktree's same-named keys.
 *  - Latest-request guard so a slow reply for A cannot pollute B during A→B→A.
 *
 * These tests intentionally make the `current-output` mock return NO `autoYes`
 * field, so the ONLY thing that can populate autoYesStateMap is the 案1 bulk GET.
 * An assertion that primary/alias is ON after return therefore proves the fix
 * (under the old code the map would never be seeded for these instances).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { Worktree } from '@/types/models';
import type { AgentInstance } from '@/lib/cli-tools/types';
import type { UseWorktreesCacheReturn } from '@/hooks/useWorktreesCache';

// ---------------------------------------------------------------------------
// Provider-dependent hook mocks (same shape as the cache-priming test) so the
// controller runs under renderHook without the full app provider tree.
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-a',
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

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const ROSTER: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2', order: 1 },
];

type AutoYesEntry = { enabled: boolean; expiresAt: number | null };

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-a',
    name: 'feature/a',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    agentInstances: ROSTER,
    ...overrides,
  } as Worktree;
}

function okJson(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
}

/** Parse the worktreeId out of an /api/worktrees/:id... URL. */
function parseWorktreeId(url: string): string {
  const m = url.match(/\/api\/worktrees\/([^/?]+)/);
  return m ? decodeURIComponent(m[1]) : 'wt-a';
}

const mockFetch = vi.fn();

interface DetailControllerResult {
  autoYesStateMap: Map<string, AutoYesEntry>;
  autoYesEnabled: boolean;
  activeInstanceId: string;
}

describe('useWorktreeDetailController — Issue #902 Auto-Yes refetch on navigation', () => {
  beforeEach(() => {
    mockCache.current = null;
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Build a fetch impl where GET /auto-yes returns the per-worktree instances
   * map from `byWorktree`. `current-output` deliberately omits `autoYes`.
   */
  function installImmediateFetch(byWorktree: Record<string, Record<string, AutoYesEntry>>) {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (/\/auto-yes(\?|$)/.test(url) && method === 'GET') {
        const wtId = parseWorktreeId(url);
        return okJson({ enabled: false, expiresAt: null, agents: {}, instances: byWorktree[wtId] ?? {} });
      }
      if (url.includes('/messages')) return okJson([]);
      if (url.includes('/current-output')) return okJson({ isRunning: false });
      if (url.includes('/api/worktrees/')) {
        return okJson(makeWorktree({ id: parseWorktreeId(url) }));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
  }

  it('案1+案2: alias instance ON → navigate away → return keeps it ON', async () => {
    installImmediateFetch({
      'wt-a': {
        claude: { enabled: true, expiresAt: null },
        'claude-2': { enabled: true, expiresAt: 1234 },
      },
      'wt-b': {}, // worktree B has no auto-yes state
    });

    const { result, rerender } = renderHook(
      (props: { worktreeId: string }) =>
        useWorktreeDetailController(props) as unknown as DetailControllerResult,
      { initialProps: { worktreeId: 'wt-a' } },
    );

    // On wt-a the alias (claude-2) is restored ON by the bulk GET.
    await waitFor(() => {
      expect(result.current.autoYesStateMap.get('claude-2')?.enabled).toBe(true);
    });
    expect(result.current.autoYesStateMap.get('claude-2')?.expiresAt).toBe(1234);

    // Navigate to wt-b: 案2 clears the map, 案1 repopulates from B (empty).
    rerender({ worktreeId: 'wt-b' });
    await waitFor(() => {
      expect(result.current.autoYesStateMap.get('claude-2')?.enabled ?? false).toBe(false);
    });

    // Return to wt-a: alias must come back ON (not stuck OFF).
    rerender({ worktreeId: 'wt-a' });
    await waitFor(() => {
      expect(result.current.autoYesStateMap.get('claude-2')?.enabled).toBe(true);
    });
  });

  it('primary instance is restored ON after return (no flicker / poll-independent)', async () => {
    installImmediateFetch({
      'wt-a': { claude: { enabled: true, expiresAt: null } },
      'wt-b': {},
    });

    const { result, rerender } = renderHook(
      (props: { worktreeId: string }) =>
        useWorktreeDetailController(props) as unknown as DetailControllerResult,
      { initialProps: { worktreeId: 'wt-a' } },
    );

    // activeInstanceId defaults to the primary ('claude'); the bulk GET seeds it.
    await waitFor(() => {
      expect(result.current.activeInstanceId).toBe('claude');
      expect(result.current.autoYesEnabled).toBe(true);
    });

    rerender({ worktreeId: 'wt-b' });
    await waitFor(() => {
      expect(result.current.autoYesEnabled).toBe(false);
    });

    rerender({ worktreeId: 'wt-a' });
    // Primary returns ON immediately via the bulk GET — current-output carries no
    // autoYes here, so this can only be the 案1 refetch (proves the flicker fix).
    await waitFor(() => {
      expect(result.current.autoYesStateMap.get('claude')?.enabled).toBe(true);
      expect(result.current.autoYesEnabled).toBe(true);
    });
  });

  it('latest-request guard: a stale A reply cannot pollute the new map (fast A→B→A)', async () => {
    // Deferred auto-yes GETs so we control resolution order. Worktrees here have
    // NO agentInstances, so rosterReady never flips and exactly one auto-yes GET
    // fires per worktreeId change (mount, →b, →a) — three deferreds total.
    const autoYesCalls: Array<{ worktreeId: string; resolve: (instances: Record<string, AutoYesEntry>) => void }> = [];

    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (/\/auto-yes(\?|$)/.test(url) && method === 'GET') {
        const wtId = parseWorktreeId(url);
        return new Promise((resolve) => {
          autoYesCalls.push({
            worktreeId: wtId,
            resolve: (instances) =>
              resolve({ ok: true, json: () => Promise.resolve({ instances }) }),
          });
        });
      }
      if (url.includes('/messages')) return okJson([]);
      if (url.includes('/current-output')) return okJson({ isRunning: false });
      if (url.includes('/api/worktrees/')) {
        // Omit agentInstances → rosterReady stays false → one GET per navigation.
        return okJson({ id: parseWorktreeId(url), name: 'x', path: '/p', repositoryPath: '/r', repositoryName: 'R' });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const { result, rerender } = renderHook(
      (props: { worktreeId: string }) =>
        useWorktreeDetailController(props) as unknown as DetailControllerResult,
      { initialProps: { worktreeId: 'wt-a' } },
    );

    // Wait for the mount GET (wt-a, request #1) to be issued.
    await waitFor(() => expect(autoYesCalls.length).toBe(1));

    // A→B→A in quick succession (none resolved yet).
    rerender({ worktreeId: 'wt-b' });
    await waitFor(() => expect(autoYesCalls.length).toBe(2));
    rerender({ worktreeId: 'wt-a' });
    await waitFor(() => expect(autoYesCalls.length).toBe(3));

    const [firstA, , thirdA] = autoYesCalls;
    expect(firstA.worktreeId).toBe('wt-a');
    expect(thirdA.worktreeId).toBe('wt-a');

    // Newest reply (request #3) lands first with the correct ON state.
    await act(async () => {
      thirdA.resolve({ claude: { enabled: true, expiresAt: null } });
    });
    await waitFor(() => {
      expect(result.current.autoYesStateMap.get('claude')?.enabled).toBe(true);
    });

    // The STALE first-A reply arrives late with OFF — the guard must drop it.
    await act(async () => {
      firstA.resolve({ claude: { enabled: false, expiresAt: null } });
    });
    // The stale OFF must NOT have polluted the map.
    expect(result.current.autoYesStateMap.get('claude')?.enabled).toBe(true);
  });
});
