/**
 * The phone's header dot reads an unreadable frame as "cannot tell"
 * (Issue #2810), the way the PC header has since #2775.
 *
 * Same harness as `WorktreeDetailRefactored-unclassified-2775.test.tsx`: the
 * real screen and the real `MobileHeader`, with the worktree payload as the
 * only input varied. The dot is `deriveWorktreeStatus` of the active tab's
 * per-CLI entry, so the fixture publishes `sessionStatusByCli` — the entry the
 * header reads — beside the per-instance one the agent tab reads.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-2810',
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
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [],
    filteredGroups: [],
    allCommands: [],
    loading: false,
    error: null,
    filter: '',
    setFilter: vi.fn(),
    refresh: vi.fn(),
    isCatalogStale: false,
  }),
}));

vi.mock('@/hooks/useFileTabs', () => ({
  useFileTabs: () => [
    { tabs: [], activeIndex: null },
    {
      dispatch: vi.fn(),
      openFile: vi.fn().mockReturnValue('opened'),
      closeTab: vi.fn(),
      activateTab: vi.fn(),
      onFileRenamed: vi.fn(),
      onFileDeleted: vi.fn(),
      moveToFront: vi.fn(),
    },
  ],
}));

vi.mock('@/components/error/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));

const { useTerminalPanePollingMock, useSplitMessagesMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
  SPLIT_MESSAGES_POLL_INTERVAL_MS: 5000,
}));

import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';
import { ToastProvider } from '@/components/common/Toast';
import { UNCLASSIFIED_STATUS_DOT_CLASS } from '@/components/sidebar/BranchStatusIndicator';

const WORKTREE_ID = 'wt-2810';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: `http://localhost/api/worktrees/${WORKTREE_ID}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function mockPaneState(): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'output',
      realtimeSnippet: 'output',
      isRunning: false,
      isThinking: false,
      sessionStatus: '',
      isSelectionListActive: false,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
}

/** The active tool's status entry is the only thing varied between cases. */
function stubFetch(claudeStatus: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/messages')) {
        return Promise.resolve(jsonResponse([]));
      }
      if (typeof url === 'string' && url.includes('/current-output')) {
        return Promise.resolve(jsonResponse({ isRunning: false, content: '', thinking: false }));
      }
      return Promise.resolve(
        jsonResponse({
          id: WORKTREE_ID,
          name: 'fix/2810',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
          sessionStatusByCli: { claude: claudeStatus },
          sessionStatusByInstance: { claude: claudeStatus },
        }),
      );
    }),
  );
}

const UNCLASSIFIED = {
  isRunning: true,
  isWaitingForResponse: false,
  isProcessing: false,
  statusEvidence: 'none',
  sessionStatusReason: 'default',
  isUnclassified: true,
};

const THINKING = {
  isRunning: true,
  isWaitingForResponse: false,
  isProcessing: true,
  statusEvidence: 'positive',
  sessionStatusReason: 'thinking_indicator',
};

const READY = {
  isRunning: true,
  isWaitingForResponse: false,
  isProcessing: false,
  statusEvidence: 'positive',
  sessionStatusReason: 'input_prompt',
};

async function renderPhone(): Promise<void> {
  render(
    <ToastProvider>
      <WorktreeDetailRefactored worktreeId={WORKTREE_ID} />
    </ToastProvider>,
  );
  await waitFor(() => {
    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
  });
}

/** The header's worktree dot, once the payload has reached it. */
async function headerDot(expectedLabel: string): Promise<HTMLElement> {
  const header = screen.getByTestId('mobile-header');
  await waitFor(() => {
    expect(header.querySelector('[data-testid="status-indicator"]')).toHaveAttribute(
      'aria-label',
      expectedLabel,
    );
  });
  return header.querySelector('[data-testid="status-indicator"]') as HTMLElement;
}

describe('[#2810] mobile header dot', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
    mockPaneState();
    useSplitMessagesMock.mockReturnValue({
      messages: [],
      isLoading: false,
      refresh: vi.fn(() => Promise.resolve()),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('is the "cannot tell" ring, labelled Unknown, for an unclassified session', async () => {
    stubFetch(UNCLASSIFIED);
    await renderPhone();

    const dot = await headerDot('Unknown');
    expect(dot).toHaveAttribute('data-unclassified', 'true');
    for (const cls of UNCLASSIFIED_STATUS_DOT_CLASS.split(' ')) {
      expect(dot.className).toContain(cls);
    }
    expect(dot.className).not.toMatch(/animate-status/);
    expect(dot.className).not.toContain('bg-success');
  });

  it('a positive running still glows, labelled Running', async () => {
    stubFetch(THINKING);
    await renderPhone();

    const dot = await headerDot('Running');
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.className).toMatch(/animate-status-glow/);
  });

  it('a ready that was actually read stays the green ready dot', async () => {
    stubFetch(READY);
    await renderPhone();

    const dot = await headerDot('Ready');
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.className).toContain('bg-success');
  });
});
