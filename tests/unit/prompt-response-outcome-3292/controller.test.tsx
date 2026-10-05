/**
 * The detail screen controller's column of the shared table (Issue #3292) —
 * see `./cases`.
 *
 * `useWorktreeDetailController`'s `handlePromptRespond` is what the phone's
 * sheet calls for a prompt read off the screen (`/prompt-response`).
 *
 * Once the answer has been posted every `/current-output` is answered 503:
 * the fetch is counted, and it moves nothing (`fetchCurrentOutput` returns on a
 * non-ok reply). So the card can only move if the handler moves it, and "it
 * stayed" cannot be the re-fetch putting it back.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { Worktree } from '@/types/models';
import {
  PROMPT_RESPONSE_ROWS,
  jsonReply,
  promptResponseToast,
  replyOf,
  type PromptResponseCase,
  type PromptResponseObserved,
} from './cases';

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
  usePathname: () => '/worktrees/wt-3292',
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

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => null,
}));

const showToast = vi.fn();
vi.mock('@/components/common/Toast', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useToast: () => ({ showToast }) };
});

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';

const WORKTREE_ID = 'wt-3292';

const WORKTREE = {
  id: WORKTREE_ID,
  name: 'fix/3292',
  path: '/path/to/wt',
  repositoryPath: '/path/to/repo',
  repositoryName: 'MyRepo',
} as Worktree;

/** What `/current-output` says while the approval is open. */
const PROMPT_PAYLOAD = {
  isRunning: true,
  isPromptWaiting: true,
  promptData: {
    type: 'multiple_choice',
    question: 'Do you want to proceed?',
    status: 'pending',
    options: [
      { number: 1, label: 'Yes', isDefault: true },
      { number: 2, label: 'No', isDefault: false },
    ],
  },
};

/** Answer the card on a screen whose POST gets `testCase.reply`; report what the user was left with. */
async function observe(testCase: PromptResponseCase): Promise<PromptResponseObserved> {
  let answered = false;
  let refetchesAfterAnswer = 0;
  const posted: string[] = [];
  global.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posted.push(url);
      answered = true;
      return replyOf(testCase);
    }
    if (url.includes('/current-output')) {
      if (!answered) return Promise.resolve(jsonReply(200, PROMPT_PAYLOAD));
      refetchesAfterAnswer += 1;
      return Promise.resolve(jsonReply(503, {}));
    }
    if (url.includes('/messages')) return Promise.resolve(jsonReply(200, []));
    if (url.includes('/auto-yes')) return Promise.resolve(jsonReply(200, { instances: {} }));
    if (url.includes('/api/worktrees/')) return Promise.resolve(jsonReply(200, WORKTREE));
    return Promise.resolve(jsonReply(404, {}));
  }) as unknown as typeof fetch;

  const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));
  await waitFor(() => {
    expect(result.current.state.prompt.visible).toBe(true);
  });

  await act(async () => {
    await result.current.handlePromptRespond('1');
  });
  expect(posted).toEqual([`/api/worktrees/${WORKTREE_ID}/prompt-response`]);
  // Not stuck "answering": the card can be pressed again.
  expect(result.current.state.prompt.answering).toBe(false);

  return {
    toast: promptResponseToast(showToast),
    cardKept: result.current.state.prompt.visible,
    refetched: refetchesAfterAnswer > 0,
  };
}

describe('[#3292] an answer through useWorktreeDetailController', () => {
  beforeEach(() => {
    showToast.mockClear();
    // The handler logs a request that got no reply; that line is not the result.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(PROMPT_RESPONSE_ROWS)('%s', async (_name, testCase) => {
    expect(await observe(testCase)).toEqual(testCase.expected);
  });
});
