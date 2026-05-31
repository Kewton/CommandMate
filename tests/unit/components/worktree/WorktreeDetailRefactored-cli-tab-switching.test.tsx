/**
 * @vitest-environment jsdom
 *
 * Issue #736 (R3-010) rewrite rationale:
 *   Pre-#736 these tests rendered the real `useTerminalPanePolling` hook plus a
 *   `/current-output` fetch mock and relied on the (now removed)
 *   terminal reducer slice for the split-0 terminal display.
 *
 *   The terminal reducer slice has been deleted. Both the PC split panes (#728)
 *   and the mobile terminal tab (#736) now source terminal output from
 *   `useTerminalPanePolling`, which owns its own per-(worktreeId, cliToolId)
 *   stale-response guard. So the invariant under test moves:
 *     - "stale CLI output never overwrites the active CLI" is now the HOOK's
 *       responsibility (covered by the hook's own unit tests).
 *     - At the WorktreeDetailRefactored level we instead verify the WIRING:
 *       switching split-0's CLI re-keys the hook with the new cliToolId
 *       (poller restart) and the rendered terminal output follows the active CLI.
 *
 *   `useTerminalPanePolling` is therefore mocked here and returns output keyed
 *   off the `cliToolId` it receives, so the test asserts on the wiring directly.
 *
 *   The message-history stale-guard (test 1) is a PARENT-level concern
 *   (`fetchMessages` + activeCliTabRef) untouched by #736 and is kept as-is.
 *
 *   All tests run on the PC path (mockIsMobile=false).
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktree/test-worktree-123',
  useSearchParams: () => new URLSearchParams(),
}));

const mockIsMobile = vi.fn(() => false);
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile(),
  MOBILE_BREAKPOINT: 768,
}));

// Issue #736 (R3-010): mock the per-split polling hook. It returns terminal
// output derived from the cliToolId it is called with, so we can assert that
// switching split-0's CLI re-keys the hook (the post-#728/#736 "poller restart").
const { useTerminalPanePollingMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  ACTIVE_POLLING_INTERVAL_MS: 2000,
  IDLE_POLLING_INTERVAL_MS: 5000,
  useTerminalPanePolling: useTerminalPanePollingMock,
}));

const mockOpenMobileDrawer = vi.fn();
const mockToggle = vi.fn();
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true,
    width: 288,
    isMobileDrawerOpen: false,
    toggle: mockToggle,
    setWidth: vi.fn(),
    openMobileDrawer: mockOpenMobileDrawer,
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
  }),
}));

const mockUseUpdateCheck = vi.fn();
vi.mock('@/hooks/useUpdateCheck', () => ({
  useUpdateCheck: () => mockUseUpdateCheck(),
}));

// Issue #730: 2-column layout; history moved into TerminalContainer.
vi.mock('@/components/worktree/WorktreeDesktopLayout', () => ({
  WorktreeDesktopLayout: ({
    activityPane,
    rightPane,
  }: {
    activityPane: React.ReactNode;
    rightPane: React.ReactNode;
  }) => (
    <div data-testid="desktop-layout">
      <div data-testid="activity-pane-slot">{activityPane}</div>
      <div data-testid="right-pane">{rightPane}</div>
    </div>
  ),
}));

vi.mock('@/components/worktree/TerminalContainer', () => ({
  TerminalContainer: ({
    history,
    terminal,
  }: {
    history: React.ReactNode;
    terminal: React.ReactNode;
  }) => (
    <div data-testid="terminal-container">
      <div data-testid="history-pane-slot">{history}</div>
      <div data-testid="terminal-slot">{terminal}</div>
    </div>
  ),
  HISTORY_PANE_ID: 'worktree-history-pane',
}));

vi.mock('@/components/worktree/FilePanelSplit', () => ({
  FilePanelSplit: ({
    terminal,
    terminalHeader,
  }: {
    terminal: React.ReactNode;
    terminalHeader?: React.ReactNode;
  }) => (
    <div data-testid="file-panel-split">
      <div data-testid="file-panel-header">{terminalHeader ?? null}</div>
      <div data-testid="file-panel-terminal">{terminal}</div>
    </div>
  ),
}));

// Issue #728: MessageInput is no longer relevant to this test but is rendered
// inside each split. Lightweight mock so we don't trigger SlashCommandSelector
// / useSlashCommands paths in this test file's mock environment.
vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: () => <div data-testid="message-input-mock" />,
}));

vi.mock('@/components/worktree/NavigationButtons', () => ({
  NavigationButtons: () => <div data-testid="navigation-buttons-mock" />,
}));

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: ({ output, isThinking }: { output: string; isThinking: boolean }) => (
    <div data-testid="terminal-display">
      <span data-testid="terminal-output">{output}</span>
      {isThinking && <span data-testid="thinking-indicator">Thinking</span>}
    </div>
  ),
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: ({ messages }: { messages: Array<{ content: string }> }) => (
    <div data-testid="history-pane">
      <span data-testid="message-count">{messages.length}</span>
      <span data-testid="history-messages">{messages.map((message) => message.content).join('|')}</span>
    </div>
  ),
}));

vi.mock('@/components/worktree/PromptPanel', () => ({
  PromptPanel: () => null,
}));

vi.mock('@/components/mobile/MobileHeader', () => ({
  MobileHeader: () => <header data-testid="mobile-header" />,
}));

vi.mock('@/components/mobile/MobileTabBar', () => ({
  MobileTabBar: () => <nav data-testid="mobile-tab-bar" />,
}));

vi.mock('@/components/mobile/MobilePromptSheet', () => ({
  MobilePromptSheet: () => null,
}));

vi.mock('@/components/error/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/worktree/FileTreeView', () => ({
  FileTreeView: () => <div data-testid="file-tree-view" />,
}));

// Issue #727: ActivityBar replaces LeftPaneTabSwitcher
vi.mock('@/components/worktree/ActivityBar', () => ({
  ActivityBar: ({ active, onToggle }: { active: string | null; onToggle: (id: string) => void }) => (
    <div data-testid="activity-bar">
      <button onClick={() => onToggle('files')} data-active={active === 'files'}>Files</button>
    </div>
  ),
}));

vi.mock('@/components/worktree/ActivityPane', () => ({
  ActivityPane: ({ active, activities }: { active: string | null; activities: Record<string, React.ReactNode> }) => (
    <div data-testid="activity-pane">{active && activities[active] ? activities[active] : null}</div>
  ),
}));

vi.mock('@/components/worktree/FileViewer', () => ({
  FileViewer: () => null,
}));

vi.mock('@/components/worktree/AutoYesToggle', () => ({
  AutoYesToggle: () => <div data-testid="auto-yes-toggle" />,
}));

// Issue #683: tuple form [state, actions]
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
  MAX_FILE_TABS: 10,
}));

type MockFetchResponse = {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mockFetch = vi.fn<(input: string | URL | Request) => Promise<MockFetchResponse>>();
global.fetch = mockFetch as unknown as typeof fetch;

const mockWorktree = {
  id: 'test-worktree-123',
  name: 'feature/test-branch',
  path: '/path/to/worktree',
  repositoryPath: '/path/to/repo',
  repositoryName: 'TestRepo',
  selectedAgents: ['claude', 'copilot'],
  sessionStatusByCli: {
    claude: { isRunning: true },
    copilot: { isRunning: true },
  },
};

const defaultMessages = {
  claude: [
    {
      id: 'msg-claude',
      worktreeId: 'test-worktree-123',
      role: 'assistant',
      content: 'Claude reply',
      timestamp: '2024-01-01T10:00:00.000Z',
      messageType: 'normal',
      cliToolId: 'claude',
    },
  ],
  copilot: [
    {
      id: 'msg-copilot',
      worktreeId: 'test-worktree-123',
      role: 'assistant',
      content: 'Copilot reply',
      timestamp: '2024-01-01T10:01:00.000Z',
      messageType: 'normal',
      cliToolId: 'copilot',
    },
  ],
} as const;

const defaultCurrentOutput = {
  claude: {
    isRunning: true,
    cliToolId: 'claude',
    fullOutput: 'Claude terminal output',
    realtimeSnippet: 'Claude terminal output',
    thinking: true,
    isPromptWaiting: false,
    autoYes: { enabled: false, expiresAt: null },
    isSelectionListActive: false,
    lastServerResponseTimestamp: null,
    serverPollerActive: false,
  },
  copilot: {
    isRunning: true,
    cliToolId: 'copilot',
    fullOutput: 'Copilot terminal output',
    realtimeSnippet: 'Copilot terminal output',
    thinking: false,
    isPromptWaiting: false,
    autoYes: { enabled: false, expiresAt: null },
    isSelectionListActive: false,
    lastServerResponseTimestamp: null,
    serverPollerActive: false,
  },
} as const;

function okJson(data: unknown): Promise<MockFetchResponse> {
  return Promise.resolve({
    ok: true,
    json: async () => data,
  });
}

function getUrlString(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

/**
 * Issue #736: deterministic mock for useTerminalPanePolling. Terminal output is
 * derived from the cliToolId passed to the hook, so split-0 reflects whichever
 * CLI is currently active. `thinking` is true only for claude (mirrors the
 * legacy fixture) so the thinking-indicator can be asserted to clear on switch.
 */
function makePaneState(cliToolId: string) {
  return {
    terminal: {
      output: `${cliToolId} terminal output`,
      realtimeSnippet: `${cliToolId} terminal output`,
      isRunning: true,
      isThinking: cliToolId === 'claude',
      isSelectionListActive: false,
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  };
}

describe('WorktreeDetailRefactored CLI tab switching (Issue #736)', () => {
  let messageQueue: Record<'claude' | 'copilot', Array<Promise<MockFetchResponse>>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile.mockReturnValue(false);
    mockUseUpdateCheck.mockReturnValue({ data: null, loading: false, error: null });
    useTerminalPanePollingMock.mockImplementation(
      ({ cliToolId }: { worktreeId: string; cliToolId: string }) => makePaneState(cliToolId)
    );

    // Issue #728: Reset terminal-splits / draft localStorage so test order
    // does not leak split CLI selection between tests.
    try {
      window.localStorage.clear();
    } catch { /* ignore */ }

    messageQueue = { claude: [], copilot: [] };

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    mockFetch.mockImplementation((input) => {
      const url = new URL(getUrlString(input), 'http://localhost');

      if (url.pathname.endsWith('/messages')) {
        const cliTool = (url.searchParams.get('cliTool') ?? 'claude') as 'claude' | 'copilot';
        return messageQueue[cliTool].shift() ?? okJson(defaultMessages[cliTool]);
      }

      if (url.pathname.endsWith('/current-output')) {
        const cliTool = (url.searchParams.get('cliTool') ?? 'claude') as 'claude' | 'copilot';
        return okJson(defaultCurrentOutput[cliTool]);
      }

      if (url.pathname === '/api/worktrees/test-worktree-123') {
        return okJson(mockWorktree);
      }

      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Not found' }),
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Issue #728: Drive activeCliTab swaps through split-0's CLI selector.
  function swapSplitZeroCliTo(value: 'copilot' | 'claude') {
    const select = screen.getByTestId('cli-selector-0') as HTMLSelectElement;
    fireEvent.change(select, { target: { value } });
  }

  it('keeps Copilot messages when an older Claude messages response arrives later (parent stale guard)', async () => {
    render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

    await waitFor(() => {
      expect(screen.getByTestId('cli-selector-0')).toBeInTheDocument();
      expect(screen.getByTestId('history-messages')).toHaveTextContent('Claude reply');
    });

    const staleClaudeMessages = createDeferred<MockFetchResponse>();
    messageQueue.claude.push(staleClaudeMessages.promise);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    swapSplitZeroCliTo('copilot');

    await waitFor(() => {
      expect(screen.getByTestId('history-messages')).toHaveTextContent('Copilot reply');
    });

    await act(async () => {
      staleClaudeMessages.resolve(await okJson(defaultMessages.claude));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('history-messages')).toHaveTextContent('Copilot reply');
      expect(screen.getByTestId('history-messages')).not.toHaveTextContent('Claude reply');
    });
  });

  it('re-keys useTerminalPanePolling with the new CLI and renders the active CLI terminal output on switch (R3-010 poller restart)', async () => {
    render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

    // Initial: split 0 is Claude → hook called with cliToolId 'claude',
    // so terminal output reflects claude + thinking indicator is shown.
    await waitFor(() => {
      expect(screen.getByTestId('cli-selector-0')).toBeInTheDocument();
      expect(screen.getByTestId('terminal-output')).toHaveTextContent('claude terminal output');
      expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument();
    });
    expect(useTerminalPanePollingMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'test-worktree-123', cliToolId: 'claude' })
    );

    swapSplitZeroCliTo('copilot');

    // After switch: hook re-keyed to cliToolId 'copilot' → copilot output, thinking cleared.
    await waitFor(() => {
      expect(screen.getByTestId('terminal-output')).toHaveTextContent('copilot terminal output');
      expect(screen.getByTestId('terminal-output')).not.toHaveTextContent('claude terminal output');
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });
    expect(useTerminalPanePollingMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'test-worktree-123', cliToolId: 'copilot' })
    );
  });
});
