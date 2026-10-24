/**
 * useSessionTileAutoYes posts the answer mode chosen in a Sessions tile's
 * confirm dialog (Issue #3863).
 *
 * The tile's toggle is the same `AutoYesToggle`, so its dialog offers the two
 * modes; a non-default choice reaches `POST .../auto-yes` as `answerMode`. The
 * default is omitted — the body `useSessionTileAutoYes-2512` pins — and the
 * server resolves an omitted mode on an OFF instance to `recommended`. The list
 * row carries no mode, so the tile exposes none (nothing to show as "unknown").
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

import { useSessionTileAutoYes } from '@/hooks/useSessionTileAutoYes';

const EXPIRES = 1_900_000_000_000;

function row(): Worktree {
  return {
    id: 'wt-1',
    name: 'wt-1',
    path: '/tmp/wt-1',
    repositoryPath: '/tmp/repo',
    repositoryName: 'repo',
    autoYesByInstance: {},
  } as Worktree;
}

function postedBody(): Record<string, unknown> {
  const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
  return JSON.parse(init.body) as Record<string, unknown>;
}

beforeEach(() => {
  cache.refresh.mockReset();
  cache.refresh.mockImplementation(() => Promise.resolve());
  global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    return {
      ok: true,
      json: async () => ({
        enabled: body.enabled,
        expiresAt: body.enabled ? EXPIRES : null,
        ...(body.enabled ? { answerMode: body.answerMode ?? 'recommended' } : {}),
      }),
    };
  }) as unknown as typeof fetch;
});

describe('[#3863] useSessionTileAutoYes answer mode', () => {
  it('posts careful when the dialog chose it', async () => {
    const worktree = row();
    const { result } = renderHook(() =>
      useSessionTileAutoYes({ worktree, cliToolId: 'codex', instanceId: 'codex-2' }),
    );

    await act(async () => {
      await result.current.toggle({ enabled: true, duration: 3_600_000, answerMode: 'careful' });
    });

    expect(postedBody()).toEqual({
      enabled: true,
      cliToolId: 'codex',
      instanceId: 'codex-2',
      duration: 3_600_000,
      answerMode: 'careful',
    });
  });

  it('leaves the mode out for the default (negative control)', async () => {
    const worktree = row();
    const { result } = renderHook(() =>
      useSessionTileAutoYes({ worktree, cliToolId: 'codex', instanceId: 'codex' }),
    );

    await act(async () => {
      await result.current.toggle({ enabled: true, duration: 3_600_000 });
    });

    expect(postedBody()).not.toHaveProperty('answerMode');
  });

  it('never sends a mode when turning it off', async () => {
    const worktree = row();
    const { result } = renderHook(() =>
      useSessionTileAutoYes({ worktree, cliToolId: 'codex', instanceId: 'codex' }),
    );

    await act(async () => {
      await result.current.toggle({ enabled: false, answerMode: 'careful' });
    });

    expect(postedBody()).toEqual({ enabled: false, cliToolId: 'codex', instanceId: 'codex' });
  });
});
