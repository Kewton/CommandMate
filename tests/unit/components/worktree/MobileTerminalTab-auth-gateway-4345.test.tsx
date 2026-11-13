/**
 * Issue #4345 1c 再指示 1 (指摘 1・2): the phone's model picker (`MobileTerminalTab`'s session row)
 * sends `/model` directly (`worktreeApi.sendMessage`) when no chat send is offered. That send is the
 * page's: its 401 reaches the gateway (expired, the host draws nothing; the detail read's success
 * brings it back), and it is not sent once a 401 was taken. Drawn beside the one host (see
 * `page-owner-harness`).
 *
 * Positive controls are red before 再指示 1; the negative controls are green before and after.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-a',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => true, MOBILE_BREAKPOINT: 768 }));
vi.mock('@/components/worktree/TerminalDisplay', () => ({ TerminalDisplay: () => <div data-testid="terminal-display" /> }));
vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: () => <div data-testid="chat-transcript"><div data-testid="chat-transcript-scroll-container" /></div>,
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => ({
    worktrees: [{ id: 'wt-a', name: 'a', sessionStatusByInstance: {
      claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false, model: 'claude-opus-5' },
      opencode: { isRunning: true, isWaitingForResponse: false, isProcessing: false, model: 'claude-sonnet-4.6' },
    } }],
    refresh: () => Promise.resolve(),
  }),
  useWorktreesCacheContext: () => null,
  WorktreesCacheProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: () => ({
    terminal: {
      output: '', realtimeSnippet: '', isRunning: true, isThinking: false, sessionStatus: 'ready',
      isSelectionListActive: false, isPagerActive: false, isUnclassifiedActive: false, composerText: '', attaching: false, autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(), setPromptAnswering: vi.fn(), clearPrompt: vi.fn(), refresh: vi.fn(() => Promise.resolve()),
  }),
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: vi.fn() }),
}));

import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';
import { resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import { beginHandoffPageRequest, reportHandoffPageResponse, resetHandoffRegistryForTests } from '@/lib/handoff/page-registration';
import { describeEntryCases, json, PAGE_WORKTREE as A, PageTree, standInPage, type EntryCase } from '../../lib/handoff/page-owner-harness';

beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  window.localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

const tab = () => <MobileTerminalTab worktreeId={A} cliToolId="claude" />;
const opencodeTab = () => <MobileTerminalTab worktreeId={A} cliToolId="opencode" />;
const pick = () => fireEvent.click(screen.getByTestId('mobile-session-model'));

const CASES: Record<string, EntryCase> = {
  'model picker send (MobileTerminalTab → worktreeApi.sendMessage)': {
    matches: (url, method) => url === `/api/worktrees/${A}/send` && method === 'POST',
    ok: () => json(201, { id: 'm1', role: 'user', content: '/model', timestamp: '2026-11-14T00:00:00.000Z' }),
    ui: tab,
    trigger: pick,
    operation: true,
  },
  // 再指示 2 (review-1cb P2-2): OpenCode's branch sends a chord through /special-keys — gated alike.
  'model picker chord (MobileTerminalTab, OpenCode → useSpecialKeys)': {
    matches: (url, method) => url === `/api/worktrees/${A}/special-keys` && method === 'POST',
    operation: true,
    ok: () => json(200, {}),
    ui: opencodeTab,
    trigger: pick,
  },
};
describeEntryCases('the phone’s model picker', CASES, () => json(200, {}));

describe('[#4345 1c 再指示 1] the model picker sends nothing once a 401 was taken', () => {
  let sends: number;
  beforeEach(() => {
    sends = 0;
    global.fetch = vi.fn(async (input: unknown) => {
      if (String(input).endsWith('/send')) sends += 1;
      return json(201, {});
    }) as unknown as typeof fetch;
  });

  it('pressed after another entry’s 401: nothing sent', async () => {
    const page = standInPage();
    render(<PageTree owner={page.owner}>{tab()}</PageTree>);
    act(() => {
      reportHandoffPageResponse(beginHandoffPageRequest(page.registration), { status: 401 });
    });
    pick();
    await act(async () => new Promise((done) => setTimeout(done, 20)));
    expect(sends).toBe(0);
  });

  it('(negative control) no 401: sent once', async () => {
    const page = standInPage();
    render(<PageTree owner={page.owner}>{tab()}</PageTree>);
    pick();
    await act(async () => new Promise((done) => setTimeout(done, 20)));
    expect(sends).toBe(1);
  });
});
