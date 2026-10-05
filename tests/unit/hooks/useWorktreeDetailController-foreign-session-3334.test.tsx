/**
 * Issue #3334 — the worktree screen's parent poll drops what was waiting when
 * the session turns out to be another CommandMate server's.
 *
 * `useWorktreeDetailController` polls `/current-output` for the prompt (the
 * phone's MobilePromptSheet), the selection-list pad and the pane gate. It
 * returned on every non-2xx, so when the session under this worktree's name
 * changed hands (#2865: another server, same name) the last prompt sheet and
 * selection-list pad of the session that WAS ours stayed up, over a session the
 * routes refuse to answer. The 409 `session_owned_by_other_server` now clears
 * them, as the pane hook reads the same 409 as "not running". Any other
 * failure leaves them alone (a transient error must not blank a live prompt).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-3334-parent',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => true,
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

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => null,
}));

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';
import { FOREIGN_SESSION_ERROR_CODE } from '@/hooks/useTerminalPanePolling';
import { NO_SELECTION_LIST_READING } from '@/lib/session/selection-list-ops';

const WORKTREE_ID = 'wt-3334-parent';

/** A prompt waiting, with a numbered selection list on screen. */
const WAITING = {
  isRunning: true,
  isPromptWaiting: true,
  promptData: {
    type: 'multiple_choice',
    question: 'Do you want to proceed?',
    options: [
      { number: 1, label: 'Yes', isDefault: true },
      { number: 2, label: 'No', isDefault: false },
    ],
    status: 'pending',
  },
  isSelectionListActive: true,
  fullOutput: 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n',
  sessionStatus: 'waiting',
};

/** What `/current-output` answers next: a status and a body. */
let next: { status: number; body: unknown } = { status: 200, body: WAITING };

beforeEach(() => {
  window.localStorage.clear();
  next = { status: 200, body: WAITING };
  global.fetch = vi.fn((url: string) => {
    if (url.includes('/current-output')) {
      const { status, body } = next;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      });
    }
    if (url.includes('/messages')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          id: WORKTREE_ID,
          name: 'feature/3334',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
        }),
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Render, and wait until the waiting prompt and the selection list are up. */
async function renderWaiting() {
  const hook = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));
  await waitFor(() => {
    expect(hook.result.current.state.prompt.visible).toBe(true);
    expect(hook.result.current.isSelectionListActive).toBe(true);
  });
  expect(hook.result.current.selectionListReading).not.toBe(NO_SELECTION_LIST_READING);
  return hook;
}

describe('[#3334] useWorktreeDetailController and a session another server owns', () => {
  it('drops the prompt sheet and the selection-list pad on the ownership 409', async () => {
    const { result } = await renderWaiting();

    next = {
      status: 409,
      body: {
        error: 'tmux session "mcbd-claude-wt-3334-parent" belongs to another CommandMate server',
        code: FOREIGN_SESSION_ERROR_CODE,
        sessionName: 'mcbd-claude-wt-3334-parent',
        sessionPath: '/elsewhere',
      },
    };
    await act(async () => {
      await result.current.fetchCurrentOutput();
    });

    expect(result.current.state.prompt.visible).toBe(false);
    expect(result.current.isSelectionListActive).toBe(false);
    expect(result.current.selectionListReading).toBe(NO_SELECTION_LIST_READING);
  });

  it.each([
    ['another 409', { status: 409, body: { error: 'x', code: 'PROMPT_WAITING' } }],
    ['a 500', { status: 500, body: { error: 'Failed to get current output' } }],
  ])('keeps them on %s (control)', async (_label, response) => {
    const { result } = await renderWaiting();

    next = response;
    await act(async () => {
      await result.current.fetchCurrentOutput();
    });

    expect(result.current.state.prompt.visible).toBe(true);
    expect(result.current.isSelectionListActive).toBe(true);
  });
});
