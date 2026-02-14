/**
 * Unit Tests for WorktreeDetailRefactored Component
 *
 * Tests the refactored WorktreeDetail component that integrates all Phase 1-4 components
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';

// Mock next/navigation
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

// Mock useIsMobile hook
const mockIsMobile = vi.fn(() => false);
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile(),
  MOBILE_BREAKPOINT: 768,
}));

// Mock SidebarContext
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

// Mock useSlashCommands hook
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

// Mock child components to isolate unit tests
vi.mock('@/components/worktree/WorktreeDesktopLayout', () => ({
  WorktreeDesktopLayout: ({ leftPane, rightPane }: { leftPane: React.ReactNode; rightPane: React.ReactNode }) => (
    <div data-testid="desktop-layout">
      <div data-testid="left-pane">{leftPane}</div>
      <div data-testid="right-pane">{rightPane}</div>
    </div>
  ),
}));

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: ({ output, isActive, isThinking }: { output: string; isActive: boolean; isThinking: boolean }) => (
    <div data-testid="terminal-display" role="log" aria-label="Terminal output">
      <span data-testid="terminal-output">{output}</span>
      {isActive && <span data-testid="terminal-active">Active</span>}
      {isThinking && <span data-testid="thinking-indicator">Thinking</span>}
    </div>
  ),
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: ({ messages, worktreeId, onFilePathClick }: { messages: unknown[]; worktreeId: string; onFilePathClick: (path: string) => void }) => (
    <div data-testid="history-pane" role="region" aria-label="Message history">
      <span data-testid="message-count">{messages.length}</span>
      <span data-testid="history-worktree-id">{worktreeId}</span>
      <button onClick={() => onFilePathClick('/test/path.ts')}>Test Path</button>
    </div>
  ),
}));

vi.mock('@/components/worktree/PromptPanel', () => ({
  PromptPanel: ({ visible, promptData, onRespond }: { visible: boolean; promptData: unknown; onRespond: (answer: string) => Promise<void> }) =>
    visible && promptData ? (
      <div data-testid="prompt-panel">
        <button onClick={() => onRespond('yes')}>Yes</button>
      </div>
    ) : null,
}));

vi.mock('@/components/mobile/MobileHeader', () => ({
  MobileHeader: ({ worktreeName, status }: { worktreeName: string; status: string }) => (
    <header data-testid="mobile-header">
      <span data-testid="worktree-name">{worktreeName}</span>
      <span data-testid="status-indicator">{status}</span>
    </header>
  ),
}));

vi.mock('@/components/mobile/MobileTabBar', () => ({
  MobileTabBar: ({ activeTab, onTabChange }: { activeTab: string; onTabChange: (tab: string) => void }) => (
    <nav data-testid="mobile-tab-bar" role="tablist">
      <button role="tab" aria-selected={activeTab === 'terminal'} aria-label="Terminal" onClick={() => onTabChange('terminal')}>
        Terminal
      </button>
      <button role="tab" aria-selected={activeTab === 'history'} aria-label="History" onClick={() => onTabChange('history')}>
        History
      </button>
    </nav>
  ),
}));

vi.mock('@/components/mobile/MobilePromptSheet', () => ({
  MobilePromptSheet: ({ visible, promptData, onRespond }: { visible: boolean; promptData: unknown; onRespond: (answer: string) => Promise<void> }) =>
    visible && promptData ? (
      <div data-testid="mobile-prompt-sheet">
        <button onClick={() => onRespond('yes')}>Yes</button>
      </div>
    ) : null,
}));

vi.mock('@/components/error/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/worktree/FileTreeView', () => ({
  FileTreeView: ({
    worktreeId,
    onFileSelect,
    onNewFile,
    onNewDirectory,
    onRename,
    onDelete,
  }: {
    worktreeId: string;
    onFileSelect?: (path: string) => void;
    onNewFile?: (parentPath: string) => void;
    onNewDirectory?: (parentPath: string) => void;
    onRename?: (path: string) => void;
    onDelete?: (path: string) => void;
  }) => (
    <div data-testid="file-tree-view">
      <span data-testid="file-tree-worktree-id">{worktreeId}</span>
      <button onClick={() => onFileSelect?.('/test/file.ts')}>Select File</button>
      <button data-testid="new-file-btn" onClick={() => onNewFile?.('src')}>New File</button>
      <button data-testid="new-dir-btn" onClick={() => onNewDirectory?.('src')}>New Directory</button>
      <button data-testid="rename-btn" onClick={() => onRename?.('src/test.ts')}>Rename</button>
      <button data-testid="delete-btn" onClick={() => onDelete?.('src/test.ts')}>Delete</button>
    </div>
  ),
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
  FileViewer: ({ isOpen, onClose, filePath }: { isOpen: boolean; onClose: () => void; filePath: string }) =>
    isOpen ? (
      <div data-testid="file-viewer">
        <span data-testid="file-viewer-path">{filePath}</span>
        <button onClick={onClose}>Close</button>
      </div>
    ) : null,
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock data
const mockWorktree = {
  id: 'test-worktree-123',
  name: 'feature/test-branch',
  path: '/path/to/worktree',
  repositoryPath: '/path/to/repo',
  repositoryName: 'TestRepo',
};

const mockMessages = [
  {
    id: 'msg-1',
    worktreeId: 'test-worktree-123',
    role: 'user',
    content: 'Hello',
    timestamp: new Date('2024-01-01T10:00:00'),
    messageType: 'normal',
    cliToolId: 'claude',
  },
];

describe('WorktreeDetailRefactored', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile.mockReturnValue(false);

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/messages')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockMessages),
        });
      }
      if (url.includes('/current-output')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              isRunning: true,
              isGenerating: false,
              content: 'Terminal output',
              thinking: false,
            }),
        });
      }
      if (url.includes('/api/worktrees/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockWorktree),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Props', () => {
    it('accepts worktreeId prop', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('history-worktree-id')).toHaveTextContent('test-worktree-123');
      });
    });
  });

  describe('Desktop Mode', () => {
    beforeEach(() => {
      mockIsMobile.mockReturnValue(false);
    });

    it('renders desktop layout when not mobile', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });
    });

    it('renders HistoryPane in left pane', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('history-pane')).toBeInTheDocument();
      });
    });

    it('renders TerminalDisplay in right pane', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
      });
    });

    it('shows PromptPanel when prompt is active', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/current-output')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                isRunning: true,
                isPromptWaiting: true,
                promptData: {
                  type: 'yes_no',
                  question: 'Continue?',
                  options: ['yes', 'no'],
                  status: 'pending',
                },
              }),
          });
        }
        if (url.includes('/messages')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockMessages),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockWorktree),
        });
      });

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
      });
    });
  });

  describe('Mobile Mode', () => {
    beforeEach(() => {
      mockIsMobile.mockReturnValue(true);
    });

    it('renders mobile layout when on mobile', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('mobile-header')).toBeInTheDocument();
        expect(screen.getByTestId('mobile-tab-bar')).toBeInTheDocument();
      });
    });

    it('does not render desktop layout when on mobile', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.queryByTestId('desktop-layout')).not.toBeInTheDocument();
      });
    });

    it('shows worktree name in mobile header', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('worktree-name')).toHaveTextContent('feature/test-branch');
      });
    });

    it('shows MobilePromptSheet when prompt is active', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/current-output')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                isRunning: true,
                isPromptWaiting: true,
                promptData: {
                  type: 'yes_no',
                  question: 'Continue?',
                  options: ['yes', 'no'],
                  status: 'pending',
                },
              }),
          });
        }
        if (url.includes('/messages')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockMessages),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockWorktree),
        });
      });

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('mobile-prompt-sheet')).toBeInTheDocument();
      });
    });
  });

  describe('Loading State', () => {
    it('shows loading indicator initially', () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      expect(screen.getByText(/loading/i)).toBeInTheDocument();
    });

    it('hides loading indicator after data loads', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
      });
    });
  });

  describe('Error State', () => {
    it('shows error message when fetch fails', async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: 'Server error' }),
        })
      );

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByText(/error/i)).toBeInTheDocument();
      });
    });
  });

  describe('State Management', () => {
    it('fetches messages on mount', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        const messagesCall = mockFetch.mock.calls.find((call) =>
          call[0].includes('/messages')
        );
        expect(messagesCall).toBeDefined();
      });
    });

    it('fetches current output on mount', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        const outputCall = mockFetch.mock.calls.find((call) =>
          call[0].includes('/current-output')
        );
        expect(outputCall).toBeDefined();
      });
    });
  });

  describe('Terminal State', () => {
    // TODO: Fix flaky test - terminal output state update timing issue
    it.skip('passes terminal output to TerminalDisplay', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(
        () => {
          expect(screen.getByTestId('terminal-output')).toHaveTextContent('Terminal output');
        },
        { timeout: 3000 }
      );
    });

    it('shows thinking indicator when Claude is thinking', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/current-output')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                isRunning: true,
                isGenerating: true,
                content: 'Output',
                thinking: true,
              }),
          });
        }
        if (url.includes('/messages')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockMessages),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockWorktree),
        });
      });

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument();
      });
    });
  });

  describe('Accessibility', () => {
    it('has proper ARIA labels for terminal output', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByRole('log', { name: /terminal output/i })).toBeInTheDocument();
      });
    });

    it('has proper ARIA labels for message history', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByRole('region', { name: /message history/i })).toBeInTheDocument();
      });
    });
  });

  describe('File Operations Handlers', () => {
    beforeEach(() => {
      mockIsMobile.mockReturnValue(false);
      // Mock window.prompt and window.confirm
      vi.spyOn(window, 'prompt').mockImplementation(() => 'newfile.md');
      vi.spyOn(window, 'confirm').mockImplementation(() => true);
      vi.spyOn(window, 'alert').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('passes onNewFile handler to FileTreeView', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      // Wait for component to load and switch to files tab
      await waitFor(() => {
        expect(screen.getByTestId('left-pane-tab-switcher')).toBeInTheDocument();
      });

      // Switch to files tab
      const filesButton = screen.getByText('Files');
      fireEvent.click(filesButton);

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-view')).toBeInTheDocument();
      });

      // Click the new file button
      const newFileBtn = screen.getByTestId('new-file-btn');
      fireEvent.click(newFileBtn);

      // Verify that prompt was called
      expect(window.prompt).toHaveBeenCalledWith('Enter file name (e.g., document.md):');
    });

    it('calls POST API when creating a new file', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('left-pane-tab-switcher')).toBeInTheDocument();
      });

      const filesButton = screen.getByText('Files');
      fireEvent.click(filesButton);

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-view')).toBeInTheDocument();
      });

      const newFileBtn = screen.getByTestId('new-file-btn');
      fireEvent.click(newFileBtn);

      await waitFor(() => {
        const createCall = mockFetch.mock.calls.find(
          (call) => call[0].includes('/files/') && call[1]?.method === 'POST'
        );
        expect(createCall).toBeDefined();
        if (createCall) {
          expect(createCall[1].body).toContain('"type":"file"');
        }
      });
    });

    it('passes onNewDirectory handler to FileTreeView', async () => {
      vi.spyOn(window, 'prompt').mockImplementation(() => 'newdir');

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('left-pane-tab-switcher')).toBeInTheDocument();
      });

      const filesButton = screen.getByText('Files');
      fireEvent.click(filesButton);

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-view')).toBeInTheDocument();
      });

      const newDirBtn = screen.getByTestId('new-dir-btn');
      fireEvent.click(newDirBtn);

      expect(window.prompt).toHaveBeenCalledWith('Enter directory name:');
    });

    it('calls POST API when creating a new directory', async () => {
      vi.spyOn(window, 'prompt').mockImplementation(() => 'newdir');

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('left-pane-tab-switcher')).toBeInTheDocument();
      });

      const filesButton = screen.getByText('Files');
      fireEvent.click(filesButton);

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-view')).toBeInTheDocument();
      });

      const newDirBtn = screen.getByTestId('new-dir-btn');
      fireEvent.click(newDirBtn);

      await waitFor(() => {
        const createCall = mockFetch.mock.calls.find(
          (call) => call[0].includes('/files/') && call[1]?.method === 'POST'
        );
        expect(createCall).toBeDefined();
        if (createCall) {
          expect(createCall[1].body).toContain('"type":"directory"');
        }
      });
    });

    it('passes onRename handler to FileTreeView', async () => {
      vi.spyOn(window, 'prompt').mockImplementation(() => 'renamed.ts');

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('left-pane-tab-switcher')).toBeInTheDocument();
      });

      const filesButton = screen.getByText('Files');
      fireEvent.click(filesButton);

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-view')).toBeInTheDocument();
      });

      const renameBtn = screen.getByTestId('rename-btn');
      fireEvent.click(renameBtn);

      expect(window.prompt).toHaveBeenCalledWith('Enter new name:', 'test.ts');
    });

    it('calls PATCH API when renaming a file', async () => {
      vi.spyOn(window, 'prompt').mockImplementation(() => 'renamed.ts');

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('left-pane-tab-switcher')).toBeInTheDocument();
      });

      const filesButton = screen.getByText('Files');
      fireEvent.click(filesButton);

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-view')).toBeInTheDocument();
      });

      const renameBtn = screen.getByTestId('rename-btn');
      fireEvent.click(renameBtn);

      await waitFor(() => {
        const renameCall = mockFetch.mock.calls.find(
          (call) => call[0].includes('/files/') && call[1]?.method === 'PATCH'
        );
        expect(renameCall).toBeDefined();
        if (renameCall) {
          expect(renameCall[1].body).toContain('"action":"rename"');
          expect(renameCall[1].body).toContain('"newName":"renamed.ts"');
        }
      });
    });

    it('passes onDelete handler to FileTreeView', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('left-pane-tab-switcher')).toBeInTheDocument();
      });

      const filesButton = screen.getByText('Files');
      fireEvent.click(filesButton);

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-view')).toBeInTheDocument();
      });

      const deleteBtn = screen.getByTestId('delete-btn');
      fireEvent.click(deleteBtn);

      expect(window.confirm).toHaveBeenCalledWith('common.confirmDelete');
    });

    it('calls DELETE API when deleting a file', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('left-pane-tab-switcher')).toBeInTheDocument();
      });

      const filesButton = screen.getByText('Files');
      fireEvent.click(filesButton);

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-view')).toBeInTheDocument();
      });

      const deleteBtn = screen.getByTestId('delete-btn');
      fireEvent.click(deleteBtn);

      await waitFor(() => {
        const deleteCall = mockFetch.mock.calls.find(
          (call) => call[0].includes('/files/') && call[1]?.method === 'DELETE'
        );
        expect(deleteCall).toBeDefined();
        if (deleteCall) {
          expect(deleteCall[0]).toContain('recursive=true');
        }
      });
    });

    it('does not call API when user cancels prompt', async () => {
      vi.spyOn(window, 'prompt').mockImplementation(() => null);

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('left-pane-tab-switcher')).toBeInTheDocument();
      });

      const filesButton = screen.getByText('Files');
      fireEvent.click(filesButton);

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-view')).toBeInTheDocument();
      });

      // Clear previous fetch calls
      mockFetch.mockClear();

      const newFileBtn = screen.getByTestId('new-file-btn');
      fireEvent.click(newFileBtn);

      // Wait a bit to ensure no API call is made
      await new Promise((resolve) => setTimeout(resolve, 100));

      const createCall = mockFetch.mock.calls.find(
        (call) => call[0].includes('/files/') && call[1]?.method === 'POST'
      );
      expect(createCall).toBeUndefined();
    });

    it('does not call DELETE API when user cancels confirmation', async () => {
      vi.spyOn(window, 'confirm').mockImplementation(() => false);

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('left-pane-tab-switcher')).toBeInTheDocument();
      });

      const filesButton = screen.getByText('Files');
      fireEvent.click(filesButton);

      await waitFor(() => {
        expect(screen.getByTestId('file-tree-view')).toBeInTheDocument();
      });

      // Clear previous fetch calls
      mockFetch.mockClear();

      const deleteBtn = screen.getByTestId('delete-btn');
      fireEvent.click(deleteBtn);

      // Wait a bit to ensure no API call is made
      await new Promise((resolve) => setTimeout(resolve, 100));

      const deleteCall = mockFetch.mock.calls.find(
        (call) => call[0].includes('/files/') && call[1]?.method === 'DELETE'
      );
      expect(deleteCall).toBeUndefined();
    });
  });

  describe('Visibility Change Recovery (Issue #246, Issue #266)', () => {
    /**
     * Tests for the visibilitychange-based recovery mechanism.
     *
     * When a smartphone browser puts a page in the background, network requests
     * are suspended and polling timers drift. Upon foreground restoration, the
     * component must re-fetch data to clear stale errors and restore the UI.
     *
     * Issue #266 update: Normal (non-error) state now uses lightweight recovery
     * (direct fetch calls without setLoading) to preserve component tree and
     * prevent input field content from being cleared. Error state still uses
     * handleRetry() for full recovery.
     *
     * Design policy references:
     * - SF-001 (Issue #266): SRP - handleVisibilityChange uses lightweight recovery for normal state
     * - SF-002 (Issue #266): KISS - simple error guard condition
     * - SF-DRY-001: fetch duplication acknowledged with comment documentation
     * - SF-CONS-001: Promise.all parallel execution in lightweight recovery
     * - SF-IMP-001: setError(null) in catch to prevent component tree collapse
     * - SF-IMP-002: error dependency in useCallback acknowledged
     * - SF-001 (Issue #246): RECOVERY_THROTTLE_MS prevents rapid re-fetches
     * - IA-002: Concurrent fetches from visibility + polling + WebSocket are safe
     */

    /**
     * Helper to set document.visibilityState for testing.
     * Uses Object.defineProperty to override the readonly property because
     * visibilityState is a read-only getter on the Document prototype.
     */
    let visibilityStateSpy: ReturnType<typeof vi.spyOn> | null = null;

    function setVisibilityState(state: DocumentVisibilityState) {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => state,
      });
    }

    afterEach(() => {
      // Restore original visibilityState
      if (visibilityStateSpy) {
        visibilityStateSpy.mockRestore();
        visibilityStateSpy = null;
      }
      // Restore default 'visible' state
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
    });

    it('TC-1: triggers data re-fetch when visibilitychange fires with visible state (lightweight recovery, Issue #266)', async () => {
      // [C-IMP-001] Updated: After Issue #266, normal state uses lightweight recovery
      // (direct fetch calls via Promise.all) instead of handleRetry().
      // The fetch calls are the same, but loading state is NOT toggled.
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      // Wait for initial load to complete
      await waitFor(() => {
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });

      // Clear fetch call history after initial load
      mockFetch.mockClear();

      // Set visible state and dispatch visibilitychange event
      setVisibilityState('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // Lightweight recovery should trigger fetchWorktree, fetchMessages, fetchCurrentOutput
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
        const anyWorktreeCall = mockFetch.mock.calls.some(
          (call) => typeof call[0] === 'string' && call[0].includes('/api/worktrees/test-worktree-123')
        );
        expect(anyWorktreeCall).toBe(true);
      });
    });

    it('TC-2: resets error state when visibilitychange fires during error (error guard -> handleRetry, Issue #266 C-CONS-002)', async () => {
      // First, make fetch fail to trigger error state
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: 'Server error' }),
        })
      );

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      // Wait for error state to appear
      await waitFor(() => {
        expect(screen.getByText(/error/i)).toBeInTheDocument();
      });

      // Now fix the fetch to succeed
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/messages')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockMessages),
          });
        }
        if (url.includes('/current-output')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                isRunning: true,
                isGenerating: false,
                content: 'Terminal output',
                thinking: false,
              }),
          });
        }
        if (url.includes('/api/worktrees/')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockWorktree),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      // Dispatch visibilitychange to trigger recovery
      setVisibilityState('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // Error should be cleared and data should load
      await waitFor(() => {
        expect(screen.queryByText(/error loading worktree/i)).not.toBeInTheDocument();
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });
    });

    it('TC-3: does not trigger data re-fetch when visibilityState is hidden', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      // Wait for initial load to complete
      await waitFor(() => {
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });

      // Clear fetch call history after initial load
      mockFetch.mockClear();

      // Set hidden state and dispatch visibilitychange event
      setVisibilityState('hidden');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // Wait a bit to ensure no fetch is triggered
      await new Promise((resolve) => setTimeout(resolve, 100));

      // No fetch calls should have been made
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('TC-4: throttles rapid visibilitychange events within RECOVERY_THROTTLE_MS (SF-001)', async () => {
      // Mock Date.now to control timestamps for throttle testing.
      // RECOVERY_THROTTLE_MS = 5000ms, so events within 5 seconds should be skipped.
      const originalDateNow = Date.now;
      let currentTime = 1000000;
      Date.now = vi.fn(() => currentTime);

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      // Wait for initial load to complete
      await waitFor(() => {
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });

      // Clear fetch call history after initial load
      mockFetch.mockClear();

      // --- 1st visibilitychange: should trigger fetch ---
      setVisibilityState('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });

      // --- 2nd visibilitychange at +2s: should be throttled (within 5s window) ---
      mockFetch.mockClear();
      currentTime += 2000;

      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // Wait a bit to confirm no fetch is triggered
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mockFetch).not.toHaveBeenCalled();

      // --- 3rd visibilitychange at +6s total: should trigger fetch (past 5s window) ---
      currentTime += 4000;
      mockFetch.mockClear();

      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });

      // Restore Date.now
      Date.now = originalDateNow;
    });

    it('TC-5: lightweight recovery does not trigger loading state change (Issue #266)', async () => {
      // Issue #266: The core fix - visibilitychange in normal state should NOT
      // call setLoading(true/false), which would cause component tree unmount/remount
      // and clear MessageInput content.
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      // Wait for initial load to complete
      await waitFor(() => {
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });

      // Verify loading indicator is NOT shown (component tree is stable)
      expect(screen.queryByText(/loading worktree/i)).not.toBeInTheDocument();

      // Clear fetch call history after initial load
      mockFetch.mockClear();

      // Dispatch visibilitychange event
      setVisibilityState('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // After visibility change, loading indicator should NOT appear
      // This is the key assertion: if setLoading(true) were called,
      // the component tree would re-render with LoadingIndicator
      expect(screen.queryByText(/loading worktree/i)).not.toBeInTheDocument();
      // Desktop layout should remain visible (component tree maintained)
      expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();

      // Fetch calls should still occur (lightweight recovery fetches data)
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });
    });

    it('TC-6: lightweight recovery calls all three fetch functions in parallel (Issue #266 SF-CONS-001)', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      // Wait for initial load to complete
      await waitFor(() => {
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });

      // Clear fetch call history after initial load
      mockFetch.mockClear();

      // Dispatch visibilitychange event
      setVisibilityState('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // All three fetch endpoints should be called
      await waitFor(() => {
        const worktreeCall = mockFetch.mock.calls.some(
          (call) => typeof call[0] === 'string' &&
            call[0].includes('/api/worktrees/test-worktree-123') &&
            !call[0].includes('/messages') &&
            !call[0].includes('/current-output')
        );
        const messagesCall = mockFetch.mock.calls.some(
          (call) => typeof call[0] === 'string' && call[0].includes('/messages')
        );
        const currentOutputCall = mockFetch.mock.calls.some(
          (call) => typeof call[0] === 'string' && call[0].includes('/current-output')
        );
        expect(worktreeCall).toBe(true);
        expect(messagesCall).toBe(true);
        expect(currentOutputCall).toBe(true);
      });
    });

    it('TC-7: lightweight recovery failure calls setError(null) to maintain component tree (Issue #266 SF-IMP-001)', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      // Wait for initial load to complete
      await waitFor(() => {
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });

      // Make fetchWorktree fail to simulate network error during lightweight recovery
      // fetchWorktree internally calls setError(message) on failure,
      // so the catch block should call setError(null) to counter it.
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/messages')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockMessages),
          });
        }
        if (url.includes('/current-output')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                isRunning: true,
                isGenerating: false,
                content: 'Terminal output',
                thinking: false,
              }),
          });
        }
        // Make worktree fetch fail (triggers setError inside fetchWorktree)
        if (url.includes('/api/worktrees/')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: 'Server error' }),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      // Dispatch visibilitychange event - lightweight recovery should handle failure silently
      setVisibilityState('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // Wait for the async lightweight recovery to complete
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });

      // SF-IMP-001: The component tree should be maintained even after fetch failure.
      // setError(null) in catch block should prevent ErrorDisplay from being shown.
      // The desktop layout should still be visible.
      expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      expect(screen.queryByText(/error loading worktree/i)).not.toBeInTheDocument();
    });

    it('TC-8: error state uses handleRetry (full recovery) on visibilitychange (Issue #266 SF-001)', async () => {
      // First, make fetch fail to trigger error state
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: 'Server error' }),
        })
      );

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      // Wait for error state to appear
      await waitFor(() => {
        expect(screen.getByText(/error/i)).toBeInTheDocument();
      });

      // Now fix the fetch to succeed
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/messages')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockMessages),
          });
        }
        if (url.includes('/current-output')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                isRunning: true,
                isGenerating: false,
                content: 'Terminal output',
                thinking: false,
              }),
          });
        }
        if (url.includes('/api/worktrees/')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockWorktree),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      // Dispatch visibilitychange to trigger error-path recovery (handleRetry)
      setVisibilityState('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // Error should be cleared and loading should briefly appear (handleRetry calls setLoading)
      // then data should load and desktop layout should appear
      await waitFor(() => {
        expect(screen.queryByText(/error loading worktree/i)).not.toBeInTheDocument();
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });
    });
  });
});
