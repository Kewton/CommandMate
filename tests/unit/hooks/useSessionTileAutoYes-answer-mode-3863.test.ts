/**
 * useSessionTileAutoYes and the answer mode a Sessions tile's confirm dialog
 * picks (Issue #3863).
 *
 * The tile's toggle is the same `AutoYesToggle`, so its dialog offers the two
 * modes. Enabling always names the mode — the default too — because the route
 * reads an omitted mode on an instance that is already on as "keep the current
 * one", and a tile can still read OFF after another tab turned it on in
 * 慎重. The mode the tile shows comes from the route's answer (held until the
 * list agrees) and from the list row's `autoYesAnswerModeByInstance`, so a
 * re-read restores it; a row that names none (an older server) shows none.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Worktree } from '@/types/models';
import type { AutoYesAnswerMode } from '@/types/auto-yes-answer-mode';

const cache = vi.hoisted(() => ({ refresh: vi.fn(() => Promise.resolve()) }));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => cache,
}));

import {
  isTileAutoYesOverrideReleased,
  readTileAutoYes,
  useSessionTileAutoYes,
} from '@/hooks/useSessionTileAutoYes';

const EXPIRES = 1_900_000_000_000;

function row(
  autoYesByInstance: Worktree['autoYesByInstance'] = {},
  autoYesAnswerModeByInstance?: Worktree['autoYesAnswerModeByInstance'],
): Worktree {
  return {
    id: 'wt-1',
    name: 'wt-1',
    path: '/tmp/wt-1',
    repositoryPath: '/tmp/repo',
    repositoryName: 'repo',
    autoYesByInstance,
    ...(autoYesAnswerModeByInstance ? { autoYesAnswerModeByInstance } : {}),
  } as Worktree;
}

function postedBody(): Record<string, unknown> {
  const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
  return JSON.parse(init.body) as Record<string, unknown>;
}

/**
 * A fake route that follows the server's rule (`setAutoYesEnabled`): a named
 * mode wins; an omitted one keeps the current mode while it is on, and starts
 * at `recommended` from off.
 */
function fakeServer(current: { enabled: boolean; mode: AutoYesAnswerMode | null }) {
  global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.enabled) {
      current.mode = body.answerMode ?? (current.enabled && current.mode ? current.mode : 'recommended');
      current.enabled = true;
    } else {
      current.enabled = false;
      current.mode = null;
    }
    return {
      ok: true,
      json: async () => ({
        enabled: current.enabled,
        expiresAt: current.enabled ? EXPIRES : null,
        ...(current.enabled ? { answerMode: current.mode } : {}),
      }),
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  cache.refresh.mockReset();
  cache.refresh.mockImplementation(() => Promise.resolve());
  fakeServer({ enabled: false, mode: null });
});

describe('[#3863] useSessionTileAutoYes posts the answer mode', () => {
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

  it('names the default when the dialog chose おまかせ', async () => {
    const worktree = row();
    const { result } = renderHook(() =>
      useSessionTileAutoYes({ worktree, cliToolId: 'codex', instanceId: 'codex' }),
    );

    await act(async () => {
      await result.current.toggle({ enabled: true, duration: 3_600_000 });
    });

    expect(postedBody()).toEqual({
      enabled: true,
      cliToolId: 'codex',
      instanceId: 'codex',
      duration: 3_600_000,
      answerMode: 'recommended',
    });
  });

  it('おまかせ replaces a careful another tab turned on while the tile still read OFF', async () => {
    // The server is already on in 慎重; the tile's row is from before that.
    const server = { enabled: true, mode: 'careful' as AutoYesAnswerMode | null };
    fakeServer(server);
    const worktree = row();
    const { result } = renderHook(() =>
      useSessionTileAutoYes({ worktree, cliToolId: 'codex', instanceId: 'codex' }),
    );
    expect(result.current.enabled).toBe(false);

    await act(async () => {
      await result.current.toggle({ enabled: true, duration: 3_600_000 });
    });

    expect(server.mode).toBe('recommended');
    expect(result.current.answerMode).toBe('recommended');
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

describe('[#3863] useSessionTileAutoYes exposes the answer mode', () => {
  it('shows the mode the route answered, at once', async () => {
    const worktree = row();
    const { result } = renderHook(() =>
      useSessionTileAutoYes({ worktree, cliToolId: 'codex', instanceId: 'codex' }),
    );
    expect(result.current.answerMode).toBeUndefined();

    await act(async () => {
      await result.current.toggle({ enabled: true, duration: 3_600_000, answerMode: 'careful' });
    });

    expect(result.current).toMatchObject({ enabled: true, answerMode: 'careful' });
  });

  it('restores the mode from the list row (a reload, another tab)', () => {
    const { result, rerender } = renderHook(
      ({ worktree }) => useSessionTileAutoYes({ worktree, cliToolId: 'codex', instanceId: 'codex' }),
      { initialProps: { worktree: row({ codex: { enabled: true, expiresAt: EXPIRES } }, { codex: 'careful' }) } },
    );
    expect(result.current.answerMode).toBe('careful');

    rerender({ worktree: row({ codex: { enabled: true, expiresAt: EXPIRES } }, { codex: 'recommended' }) });
    expect(result.current.answerMode).toBe('recommended');
  });

  it('shows no mode for a row that names none (an older server): not assumed おまかせ', () => {
    const { result } = renderHook(() =>
      useSessionTileAutoYes({
        worktree: row({ codex: { enabled: true, expiresAt: EXPIRES } }),
        cliToolId: 'codex',
        instanceId: 'codex',
      }),
    );

    expect(result.current.enabled).toBe(true);
    expect(result.current.answerMode).toBeUndefined();
  });

  it('shows no mode for an answer that names none (an older server)', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ enabled: true, expiresAt: EXPIRES }),
    })) as unknown as typeof fetch;
    const worktree = row();
    const { result } = renderHook(() =>
      useSessionTileAutoYes({ worktree, cliToolId: 'codex', instanceId: 'codex' }),
    );

    await act(async () => {
      await result.current.toggle({ enabled: true, duration: 3_600_000 });
    });

    expect(result.current.enabled).toBe(true);
    expect(result.current.answerMode).toBeUndefined();
  });

  it('drops the mode while OFF, even if the row map still names one', () => {
    const { result } = renderHook(() =>
      useSessionTileAutoYes({ worktree: row({}, { codex: 'careful' }), cliToolId: 'codex', instanceId: 'codex' }),
    );

    expect(result.current.enabled).toBe(false);
    expect(result.current.answerMode).toBeUndefined();
  });
});

describe('[#3863] readTileAutoYes / isTileAutoYesOverrideReleased and the mode', () => {
  it('reads the row’s mode for an enabled instance, and ignores a value that is not a mode', () => {
    const on = { codex: { enabled: true, expiresAt: EXPIRES } };
    expect(readTileAutoYes(row(on, { codex: 'careful' }), 'codex')).toEqual({
      enabled: true,
      expiresAt: EXPIRES,
      answerMode: 'careful',
    });
    expect(readTileAutoYes(row(on, { codex: 'bogus' as never }), 'codex')).toEqual({
      enabled: true,
      expiresAt: EXPIRES,
    });
    expect(readTileAutoYes(row(on, { 'codex-2': 'careful' }), 'codex')).toEqual({
      enabled: true,
      expiresAt: EXPIRES,
    });
  });

  it('holds a careful answer until the row names careful too', () => {
    const answered = { enabled: true, expiresAt: EXPIRES, answerMode: 'careful' as const };
    const override = { instanceId: 'codex', value: answered, settledRow: null };
    const base = row();

    expect(
      isTileAutoYesOverrideReleased(override, { enabled: true, expiresAt: EXPIRES, answerMode: 'recommended' }, base),
    ).toBe(false);
    expect(isTileAutoYesOverrideReleased(override, answered, base)).toBe(true);
  });
});
