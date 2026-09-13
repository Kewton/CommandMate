/**
 * useSessionTileAutoYes (Issue #2512): reading a tile's Auto-Yes from the list
 * row, and the override that bridges a toggle to the list catching up.
 *
 * The tile-level suite (`tests/unit/sessions/session-tile-auto-yes-2512`) pins
 * what a user sees; this one pins the two rules underneath — what a row entry
 * reads as, and exactly when a toggle's answer stops being shown.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Worktree } from '@/types/models';

const cache = vi.hoisted(() => ({ refresh: vi.fn(() => Promise.resolve()) }));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => cache,
}));

import {
  AUTO_YES_OFF,
  isTileAutoYesOverrideReleased,
  readTileAutoYes,
  useSessionTileAutoYes,
  type TileAutoYesOverride,
} from '@/hooks/useSessionTileAutoYes';

const EXPIRES = 1_900_000_000_000;

function row(autoYesByInstance?: Worktree['autoYesByInstance']): Worktree {
  return {
    id: 'wt-1',
    name: 'wt-1',
    path: '/tmp/wt-1',
    repositoryPath: '/tmp/repo',
    repositoryName: 'repo',
    autoYesByInstance,
  } as Worktree;
}

beforeEach(() => {
  cache.refresh.mockReset();
  cache.refresh.mockImplementation(() => Promise.resolve());
  global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    return {
      ok: true,
      json: async () => ({ enabled: body.enabled, expiresAt: body.enabled ? EXPIRES : null }),
    };
  }) as unknown as typeof fetch;
});

describe('readTileAutoYes', () => {
  it('reads an enabled entry', () => {
    expect(readTileAutoYes(row({ codex: { enabled: true, expiresAt: EXPIRES } }), 'codex')).toEqual({
      enabled: true,
      expiresAt: EXPIRES,
    });
  });

  it.each([
    ['no map (a server older than #2512)', row(undefined)],
    ['an empty map', row({})],
    ['another instance only', row({ 'codex-2': { enabled: true, expiresAt: EXPIRES } })],
    ['a disabled entry', row({ codex: { enabled: false, expiresAt: null } })],
    ['a malformed entry', row({ codex: { enabled: 'true', expiresAt: EXPIRES } as never })],
  ])('reads %s as off', (_label, worktree) => {
    expect(readTileAutoYes(worktree, 'codex')).toBe(AUTO_YES_OFF);
  });
});

describe('isTileAutoYesOverrideReleased', () => {
  const on = { enabled: true, expiresAt: EXPIRES };
  const base = row({});

  function override(settledRow: Worktree | null): TileAutoYesOverride {
    return { instanceId: 'codex', value: on, settledRow };
  }

  it('holds while the list has not caught up and the refresh is outstanding', () => {
    expect(isTileAutoYesOverrideReleased(override(null), AUTO_YES_OFF, row({}))).toBe(false);
  });

  it('releases once the row reads what the route answered', () => {
    expect(isTileAutoYesOverrideReleased(override(null), on, base)).toBe(true);
  });

  it('does not count a different countdown as landed', () => {
    expect(
      isTileAutoYesOverrideReleased(override(null), { enabled: true, expiresAt: EXPIRES + 1 }, base),
    ).toBe(false);
  });

  it('holds on the row that was on screen when the refresh resolved', () => {
    expect(isTileAutoYesOverrideReleased(override(base), AUTO_YES_OFF, base)).toBe(false);
  });

  it('releases on the first row after that, whatever it says', () => {
    expect(isTileAutoYesOverrideReleased(override(base), AUTO_YES_OFF, row({}))).toBe(true);
  });
});

describe('useSessionTileAutoYes', () => {
  it('posts the toggle for its (cliToolId, instanceId) and re-reads the list', async () => {
    // One row object for every render, as the list cache provides between polls:
    // a new object IS the signal that the list has moved.
    const worktree = row({});
    const { result } = renderHook(() =>
      useSessionTileAutoYes({ worktree, cliToolId: 'codex', instanceId: 'codex-2' }),
    );

    await act(async () => {
      await result.current.toggle({ enabled: true, duration: 3_600_000 });
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/worktrees/wt-1/auto-yes');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      enabled: true,
      cliToolId: 'codex',
      instanceId: 'codex-2',
      duration: 3_600_000,
    });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ enabled: true, expiresAt: EXPIRES });
  });

  it('never shows one instance’s answer on another', async () => {
    const worktree = row({});
    const { result, rerender } = renderHook(
      ({ instanceId }) => useSessionTileAutoYes({ worktree, cliToolId: 'codex', instanceId }),
      { initialProps: { instanceId: 'codex' } },
    );
    await act(async () => {
      await result.current.toggle({ enabled: true });
    });
    expect(result.current.enabled).toBe(true);

    rerender({ instanceId: 'codex-2' });
    expect(result.current.enabled).toBe(false);

    // …and the override is gone, not merely hidden.
    rerender({ instanceId: 'codex' });
    expect(result.current.enabled).toBe(false);
  });

  it('holds nothing and re-reads nothing when the route refuses', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    const { result } = renderHook(() =>
      useSessionTileAutoYes({
        worktree: row({ codex: { enabled: true, expiresAt: EXPIRES } }),
        cliToolId: 'codex',
        instanceId: 'codex',
      }),
    );

    await act(async () => {
      await result.current.toggle({ enabled: false });
    });

    expect(result.current.enabled).toBe(true);
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  it('does not reject when the network does', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const worktree = row({});
    const { result } = renderHook(() =>
      useSessionTileAutoYes({ worktree, cliToolId: 'codex', instanceId: 'codex' }),
    );

    await act(async () => {
      await expect(result.current.toggle({ enabled: true })).resolves.toBeUndefined();
    });
    expect(result.current.enabled).toBe(false);
  });
});
