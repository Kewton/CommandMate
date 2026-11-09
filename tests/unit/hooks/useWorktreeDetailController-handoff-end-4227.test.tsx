/**
 * "End" chooses between the hand-off (G-4) and the plain confirmation (Issue #4227,
 * design `mem-ui-4227.md` §4.1, G-PR2): the hand-off on a branch set to be attended
 * (`features.popup`) with mode `on`; the plain confirmation for anything else — another
 * mode, unattended, a read that fails or never answers. Neither opening kills: only the
 * stop (`handleKillConfirm` / `stopForHandoff`, the same `stopSession`) reaches the
 * kill-session route, and only for the target snapshotted at the press.
 *
 * Positive controls: `openEnd` (the split's End) is new, and a mode read that never
 * answers left "end" with nothing open before this contract (no deadline).
 * Negative controls: every answer but `on` + `popup` opens the plain confirmation as before.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { SessionKillTarget } from '@/types/terminal-split-pane';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-a',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));
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
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => ({ worktrees: [], repositories: [], isLoading: false, error: null, refresh: vi.fn() }),
}));

import { END_MODE_READ_TIMEOUT_MS, useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';

const A = 'wt-a';
const B = 'wt-b';
const TARGET: SessionKillTarget = { cliToolId: 'codex', instanceId: 'codex-2', label: 'Review agent' };

type ModeAnswer = { status: number; body: unknown } | 'reject' | 'stall' | 'hold';

interface Server {
  mode: ModeAnswer;
  modeReads: string[];
  kills: string[];
  heldModes: Array<() => void>;
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ATTENDED = { status: 200, body: { ok: true, mode: 'on', features: { popup: true } } };

function install(mode: ModeAnswer): Server {
  const server: Server = { mode, modeReads: [], kills: [], heldModes: [] };
  global.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/mem/mode')) {
      server.modeReads.push(url);
      const answer = server.mode;
      if (answer === 'reject') return Promise.reject(new TypeError('Failed to fetch'));
      if (answer === 'stall') {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      if (answer === 'hold') {
        return new Promise<Response>((resolve) => server.heldModes.push(() => resolve(reply(ATTENDED.status, ATTENDED.body))));
      }
      return Promise.resolve(reply(answer.status, answer.body));
    }
    if (url.includes('/kill-session')) {
      server.kills.push(url);
      return Promise.resolve(reply(200, { success: true, message: 'ok' }));
    }
    if (url.includes('/current-output')) return Promise.resolve(reply(200, { isRunning: false }));
    if (url.includes('/messages')) return Promise.resolve(reply(200, []));
    if (url.includes('/auto-yes')) return Promise.resolve(reply(200, { instances: {} }));
    const detail = /\/api\/worktrees\/([^/?]+)$/.exec(url);
    if (detail) {
      return Promise.resolve(
        reply(200, { id: detail[1], name: detail[1], path: '/p', repositoryPath: '/r', repositoryName: 'R', sessionStatusByInstance: {} })
      );
    }
    return Promise.resolve(reply(404, {}));
  }) as unknown as typeof fetch;
  return server;
}

async function opened(mode: ModeAnswer) {
  const server = install(mode);
  const hook = renderHook(({ worktreeId }) => useWorktreeDetailController({ worktreeId }), {
    initialProps: { worktreeId: A },
  });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
  return { ...hook, server };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('[#4227 G-4] "end" opens the hand-off only on an attended branch with mode on', () => {
  it('on + popup: the hand-off for the snapshotted target, no plain confirmation, nothing killed', async () => {
    const hook = await opened(ATTENDED);
    await act(async () => {
      await hook.result.current.openEnd(TARGET);
    });
    expect(hook.server.modeReads).toEqual([`/api/worktrees/${A}/mem/mode`]);
    expect(hook.result.current.handoffTarget).toEqual(TARGET);
    expect(hook.result.current.killTarget).toBeNull();
    expect(hook.server.kills).toEqual([]);
  });

  it('openActiveEnd snapshots the active instance (the header / phone End)', async () => {
    const hook = await opened(ATTENDED);
    await act(async () => {
      await hook.result.current.openActiveEnd();
    });
    const target = hook.result.current.handoffTarget;
    expect(target).not.toBeNull();
    expect(target!.instanceId).toBe(hook.result.current.activeInstanceId);
    expect(hook.result.current.killTarget).toBeNull();
    expect(hook.server.kills).toEqual([]);
  });

  it.each([
    ['popup off (unattended)', { status: 200, body: { ok: true, mode: 'on', features: { popup: false } } }],
    ['popup missing', { status: 200, body: { ok: true, mode: 'on' } }],
    ['mode derived', { status: 200, body: { ok: true, mode: 'derived', features: { popup: true } } }],
    ['mode off', { status: 200, body: { ok: true, mode: 'off', features: { popup: true } } }],
    ['a 500', { status: 500, body: { ok: false } }],
    ['ok:false with on', { status: 200, body: { ok: false, mode: 'on', features: { popup: true } } }],
    ['no answer', 'reject'],
  ] as const)('%s: the plain confirmation as before (negative control)', async (_label, mode) => {
    const hook = await opened(mode as ModeAnswer);
    await act(async () => {
      await hook.result.current.openEnd(TARGET);
    });
    expect(hook.result.current.killTarget).toEqual(TARGET);
    expect(hook.result.current.handoffTarget).toBeNull();
    expect(hook.server.kills).toEqual([]);
  });

  it('a mode read that never answers: the plain confirmation after the deadline, so "end" never hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const hook = await opened('stall');
    let done = false;
    act(() => {
      void hook.result.current.openEnd(TARGET).then(() => {
        done = true;
      });
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(END_MODE_READ_TIMEOUT_MS - 100)));
    expect(hook.result.current.killTarget).toBeNull();
    await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
    await waitFor(() => expect(done).toBe(true));
    expect(hook.result.current.killTarget).toEqual(TARGET);
    expect(hook.result.current.handoffTarget).toBeNull();
  });

  it('the worktree changed while the mode was read: nothing opens on the other worktree', async () => {
    const hook = await opened('hold');
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.openEnd(TARGET);
    });
    await waitFor(() => expect(hook.server.heldModes).toHaveLength(1));
    hook.rerender({ worktreeId: B });
    await act(async () => {
      hook.server.heldModes[0]();
      await pending;
    });
    expect(hook.result.current.handoffTarget).toBeNull();
    expect(hook.result.current.killTarget).toBeNull();
  });
});

describe('[#4227 G-4] the stop is the existing stop, for the hand-off target only', () => {
  it('stopForHandoff kills the snapshotted target once; closeHandoff closes without a kill', async () => {
    const hook = await opened(ATTENDED);
    await act(async () => {
      await hook.result.current.openEnd(TARGET);
    });
    expect(hook.server.kills).toEqual([]);
    await act(async () => {
      await hook.result.current.stopForHandoff();
    });
    expect(hook.server.kills).toEqual([`/api/worktrees/${A}/kill-session?cliTool=codex&instance=codex-2`]);
    act(() => hook.result.current.closeHandoff());
    expect(hook.result.current.handoffTarget).toBeNull();
    expect(hook.server.kills).toHaveLength(1);
  });

  it('closing the hand-off kills nothing', async () => {
    const hook = await opened(ATTENDED);
    await act(async () => {
      await hook.result.current.openEnd(TARGET);
    });
    act(() => hook.result.current.closeHandoff());
    expect(hook.result.current.handoffTarget).toBeNull();
    expect(hook.server.kills).toEqual([]);
  });
});
