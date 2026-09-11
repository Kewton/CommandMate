/**
 * The detail screen's answer that the route REFUSED keeps its card and says why
 * (Issue #2468) — `useWorktreeDetailController`'s half of
 * `tests/unit/components/worktree/TerminalSplitPaneContent-prompt-refused-2468.test.tsx`.
 *
 * `POST /prompt-response` answers `200 { success: false, reason:
 * 'prompt_no_longer_active' }` when the re-captured pane no longer reads as the
 * dialog. The handler looked only at `response.ok` and cleared the card on that
 * refusal, so the next poll put it straight back and nothing said why.
 *
 * Once the answer has been posted the pane is held still — every later
 * `/current-output` stays pending — so the card can only move if the handler
 * moves it, and "it stayed" cannot be the next poll putting it back.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { Worktree } from '@/types/models';
import type { UseWorktreesCacheReturn } from '@/hooks/useWorktreesCache';

// Provider-dependent hooks, mocked the way `useWorktreeDetailController.test.tsx`
// mocks them. next-intl is mocked globally in tests/setup.ts.
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-1',
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

const showToast = vi.fn();
vi.mock('@/components/common/Toast', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useToast: () => ({ showToast }) };
});

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';

const WORKTREE = {
  id: 'wt-1',
  name: 'feature/2468',
  path: '/path/to/wt',
  repositoryPath: '/path/to/repo',
  repositoryName: 'MyRepo',
} as Worktree;

/** JSON response shaped for both raw fetch and the api-client fetchApi wrapper. */
function apiResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: '',
    headers: {
      get: (h: string) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
  };
}

/** What `/current-output` says while the confirmation screen is open. */
const PROMPT_PAYLOAD = {
  isRunning: true,
  isPromptWaiting: true,
  promptData: {
    type: 'multiple_choice',
    question: 'Ready to submit your answers?',
    status: 'pending',
    options: [
      { number: 1, label: 'Submit answers', isDefault: true },
      { number: 2, label: 'Cancel', isDefault: false },
    ],
  },
};

const mockFetch = vi.fn();

/** Route every endpoint the controller touches; `/prompt-response` answers `result`. */
function arrange(result: Record<string, unknown>) {
  let answered = false;
  mockFetch.mockImplementation((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/prompt-response') && init?.method === 'POST') {
      answered = true;
      return Promise.resolve(apiResponse(200, result));
    }
    if (url.includes('/current-output')) {
      // Held still once the answer is out: only the handler can move the card now.
      return answered ? new Promise(() => {}) : Promise.resolve(apiResponse(200, PROMPT_PAYLOAD));
    }
    if (url.includes('/messages')) return Promise.resolve(apiResponse(200, []));
    if (url.includes('/auto-yes')) return Promise.resolve(apiResponse(200, { instances: {} }));
    if (url.includes('/api/worktrees/')) return Promise.resolve(apiResponse(200, WORKTREE));
    return Promise.resolve(apiResponse(404, {}));
  });
}

async function renderWithPromptCard() {
  const hook = renderHook(() => useWorktreeDetailController({ worktreeId: 'wt-1' }));
  await waitFor(() => {
    expect(hook.result.current.state.prompt.visible).toBe(true);
  });
  return hook;
}

describe('[#2468] useWorktreeDetailController — a refused prompt answer', () => {
  beforeEach(() => {
    mockCache.current = {
      worktrees: [WORKTREE],
      repositories: [],
      isLoading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    };
    showToast.mockClear();
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  it('keeps the card and tells the user why when the route answers success:false', async () => {
    arrange({ success: false, reason: 'prompt_no_longer_active', answer: '1' });
    const { result } = await renderWithPromptCard();

    await act(async () => {
      void result.current.handlePromptRespond('1');
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('worktree.promptResponse.refused', 'warning');
    });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/worktrees/wt-1/prompt-response',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.current.state.prompt.visible).toBe(true);
  });

  it('still clears the card when the route answered (the control)', async () => {
    arrange({ success: true });
    const { result } = await renderWithPromptCard();

    await act(async () => {
      void result.current.handlePromptRespond('1');
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.state.prompt.visible).toBe(false);
    });
    expect(showToast).not.toHaveBeenCalledWith('worktree.promptResponse.refused', expect.anything());
  });
});
