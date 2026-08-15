/**
 * @vitest-environment jsdom
 *
 * The cross-screen waiting toast (Issue #1788).
 *
 * Three rules are acceptance criteria rather than polish, and each has its own
 * failure mode if it regresses:
 *
 *  - fires for a worktree you are NOT looking at (the whole feature), and never
 *    for the one you are (that screen already draws a PromptPanel);
 *  - once per episode, keyed on `waitingSince` — a second toast for the same
 *    block is the fastest way to teach someone to ignore toasts;
 *  - silent when the in-app toggle is off.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';

const pathnameMock = vi.hoisted(() => ({ current: '/' }));
const routerPush = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock.current,
  useRouter: () => ({ push: routerPush }),
}));

const realtimeMock = vi.hoisted(() => {
  const listeners: Array<(e: unknown) => void> = [];
  return {
    listeners,
    emit: (event: unknown) => {
      for (const l of [...listeners]) l(event);
    },
    useRealtime: () => ({
      status: 'connected' as const,
      connected: true,
      subscribe: () => {},
      unsubscribe: () => {},
      addListener: (l: (e: unknown) => void) => {
        listeners.push(l);
        return () => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    }),
  };
});
vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: realtimeMock.useRealtime,
}));

const cacheMock = vi.hoisted(() => ({ worktrees: [] as Worktree[] }));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => ({
    worktrees: cacheMock.worktrees,
    repositories: [],
    isLoading: false,
    error: null,
    refresh: async () => {},
  }),
}));

// Real dictionary: proves `notifications.inApp.waitingToast` exists and that the
// {name} placeholder is actually interpolated (the global setup mock would echo
// the key and pass either way).
const intlLocale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => intlLocale.current);
});

import { ToastProvider } from '@/components/common/Toast';
import { WaitingToastListener, episodeKey, worktreeIdFromPathname } from '@/components/notifications/WaitingToastListener';
import { INAPP_WAITING_TOAST_STORAGE_KEY } from '@/hooks/useInAppNotificationPrefs';

const SINCE = 1_760_000_000_000;

function frame(overrides: Record<string, unknown> = {}) {
  return {
    type: 'session_status_changed',
    worktreeId: 'wt-other',
    cliTool: 'claude',
    instance: 'claude',
    isWaitingForResponse: true,
    waitingKind: 'prompt',
    waitingSince: SINCE,
    ...overrides,
  };
}

function mount() {
  return render(
    <ToastProvider>
      <WaitingToastListener />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  realtimeMock.listeners.length = 0;
  pathnameMock.current = '/';
  intlLocale.current = 'en';
  localStorage.clear();
  cacheMock.worktrees = [
    {
      id: 'wt-other',
      name: 'feature/other',
      path: '/o',
      repositoryPath: '/r',
      repositoryName: 'R',
    },
  ];
});

describe('WaitingToastListener (Issue #1788)', () => {
  it('toasts, naming the worktree, when another branch starts waiting', async () => {
    mount();
    act(() => realtimeMock.emit(frame()));

    await waitFor(() =>
      expect(screen.getByText('feature/other is waiting for your input')).toBeDefined(),
    );
  });

  it('falls back to the id when the list cache does not know the worktree', async () => {
    cacheMock.worktrees = [];
    mount();
    act(() => realtimeMock.emit(frame()));

    await waitFor(() => expect(screen.getByText('wt-other is waiting for your input')).toBeDefined());
  });

  it('stays silent for the worktree currently on screen', async () => {
    pathnameMock.current = '/worktrees/wt-other';
    mount();
    act(() => realtimeMock.emit(frame()));

    await Promise.resolve();
    expect(screen.queryByTestId('toast-container')?.textContent ?? '').not.toContain('waiting');
  });

  it('stays silent on a sub-route of that worktree too', async () => {
    pathnameMock.current = '/worktrees/wt-other/files/src/index.ts';
    mount();
    act(() => realtimeMock.emit(frame()));

    await Promise.resolve();
    expect(screen.queryByTestId('toast-action-button')).toBeNull();
  });

  it('still toasts while a DIFFERENT worktree is on screen', async () => {
    pathnameMock.current = '/worktrees/wt-mine';
    mount();
    act(() => realtimeMock.emit(frame()));

    await waitFor(() => expect(screen.getByTestId('toast-action-button')).toBeDefined());
  });

  it('fires once per episode however many frames repeat it', async () => {
    mount();
    act(() => {
      realtimeMock.emit(frame());
      realtimeMock.emit(frame());
      realtimeMock.emit(frame({ waitingKind: 'menu' }));
    });

    await waitFor(() => expect(screen.getAllByTestId('toast-action-button')).toHaveLength(1));
  });

  it('fires again for a NEW episode (a different waitingSince)', async () => {
    mount();
    act(() => realtimeMock.emit(frame()));
    await waitFor(() => expect(screen.getAllByTestId('toast-action-button')).toHaveLength(1));

    act(() => realtimeMock.emit(frame({ waitingSince: SINCE + 60_000 })));
    await waitFor(() => expect(screen.getAllByTestId('toast-action-button')).toHaveLength(2));
  });

  it('treats each agent instance as its own episode', async () => {
    mount();
    act(() => {
      realtimeMock.emit(frame());
      realtimeMock.emit(frame({ instance: 'codex-2', cliTool: 'codex' }));
    });

    await waitFor(() => expect(screen.getAllByTestId('toast-action-button')).toHaveLength(2));
  });

  it('says nothing when the wait ends', async () => {
    mount();
    act(() =>
      realtimeMock.emit(frame({ isWaitingForResponse: false, waitingSince: null, waitingKind: null })),
    );

    await Promise.resolve();
    expect(screen.queryByTestId('toast-action-button')).toBeNull();
  });

  it('is silent when the in-app toggle is off', async () => {
    localStorage.setItem(INAPP_WAITING_TOAST_STORAGE_KEY, 'false');
    mount();
    act(() => realtimeMock.emit(frame()));

    await Promise.resolve();
    expect(screen.queryByTestId('toast-action-button')).toBeNull();
  });

  it('ignores running/stopped frames, which carry no waiting verdict', async () => {
    mount();
    act(() =>
      realtimeMock.emit({ type: 'session_status_changed', worktreeId: 'wt-other', isRunning: true }),
    );

    await Promise.resolve();
    expect(screen.queryByTestId('toast-action-button')).toBeNull();
  });

  it('navigates to the worktree when the toast body is activated', async () => {
    mount();
    act(() => realtimeMock.emit(frame()));
    const button = await screen.findByTestId('toast-action-button');

    // A real <button>: reachable by keyboard and by touch, unlike a hover-only
    // affordance, which is dead on the phone this toast most needs to work on.
    expect(button.tagName).toBe('BUTTON');
    act(() => {
      button.click();
    });

    expect(routerPush).toHaveBeenCalledWith('/worktrees/wt-other');
  });

  it('renders the Japanese wording from the ja dictionary', async () => {
    intlLocale.current = 'ja';
    mount();
    act(() => realtimeMock.emit(frame()));

    await waitFor(() => expect(screen.getByText('feature/other が入力待ちです')).toBeDefined());
  });
});

describe('WaitingToastListener helpers (Issue #1788)', () => {
  it('reads the worktree id out of the pathname', () => {
    expect(worktreeIdFromPathname('/worktrees/feature-x')).toBe('feature-x');
    expect(worktreeIdFromPathname('/worktrees/feature-x/files/a.ts')).toBe('feature-x');
    expect(worktreeIdFromPathname('/worktrees/feature%2Fx')).toBe('feature/x');
    expect(worktreeIdFromPathname('/review')).toBeNull();
    expect(worktreeIdFromPathname(null)).toBeNull();
  });

  it('keys an episode on worktree + instance + since', () => {
    expect(episodeKey('a', 'claude', 1)).toBe('a|claude|1');
    expect(episodeKey('a', null, null)).toBe('a|-|no-since');
    expect(episodeKey('a', 'claude', 1)).not.toBe(episodeKey('a', 'claude', 2));
  });
});
