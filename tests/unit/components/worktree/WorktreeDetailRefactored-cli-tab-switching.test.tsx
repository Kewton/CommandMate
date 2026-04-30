/**
 * @vitest-environment jsdom
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

vi.mock('@/components/worktree/WorktreeDesktopLayout', () => ({
  WorktreeDesktopLayout: ({ leftPane, rightPane }: { leftPane: React.ReactNode; rightPane: React.ReactNode }) => (
    <div data-testid="desktop-layout">
      <div data-testid="left-pane">{leftPane}</div>
      <div data-testid="right-pane">{rightPane}</div>
    </div>
  ),
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
      <div data-testid="file-panel-header">{terminalHeader}</div>
      <div data-testid="file-panel-terminal">{terminal}</div>
    </div>
  ),
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

vi.mock('@/components/worktree/LeftPaneTabSwitcher', () => ({
  LeftPaneTabSwitcher: ({ activeTab, onTabChange }: { activeTab: string; onTabChange: (tab: string) => void }) => (
    <div data-testid="left-pane-tab-switcher">
      <button onClick={() => onTabChange('history')} data-active={activeTab === 'history'}>History</button>
      <button onClick={() => onTabChange('files')} data-active={activeTab === 'files'}>Files</button>
    </div>
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

describe('WorktreeDetailRefactored CLI tab switching', () => {
  let messageQueue: Record<'claude' | 'copilot', Array<Promise<MockFetchResponse>>>;
  let currentOutputQueue: Record<'claude' | 'copilot', Array<Promise<MockFetchResponse>>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile.mockReturnValue(false);
    mockUseUpdateCheck.mockReturnValue({ data: null, loading: false, error: null });

    messageQueue = { claude: [], copilot: [] };
    currentOutputQueue = { claude: [], copilot: [] };

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
        return currentOutputQueue[cliTool].shift() ?? okJson(defaultCurrentOutput[cliTool]);
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

  it('keeps Copilot messages when an older Claude messages response arrives later', async () => {
    render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Copilot/i })).toBeInTheDocument();
      expect(screen.getByTestId('history-messages')).toHaveTextContent('Claude reply');
    });

    const staleClaudeMessages = createDeferred<MockFetchResponse>();
    messageQueue.claude.push(staleClaudeMessages.promise);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: /Copilot/i }));

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

  it('keeps Copilot terminal state when an older Claude current-output response arrives later', async () => {
    render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Copilot/i })).toBeInTheDocument();
      expect(screen.getByTestId('terminal-output')).toHaveTextContent('Claude terminal output');
      expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument();
    });

    const staleClaudeOutput = createDeferred<MockFetchResponse>();
    currentOutputQueue.claude.push(staleClaudeOutput.promise);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: /Copilot/i }));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-output')).toHaveTextContent('Copilot terminal output');
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });

    await act(async () => {
      staleClaudeOutput.resolve(await okJson(defaultCurrentOutput.claude));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-output')).toHaveTextContent('Copilot terminal output');
      expect(screen.getByTestId('terminal-output')).not.toHaveTextContent('Claude terminal output');
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });
  });
});
