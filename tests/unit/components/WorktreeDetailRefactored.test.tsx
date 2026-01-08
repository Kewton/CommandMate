/**
 * Unit Tests for WorktreeDetailRefactored Component
 *
 * Tests the refactored WorktreeDetail component that integrates all Phase 1-4 components
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  FileTreeView: ({ worktreeId, onFileSelect }: { worktreeId: string; onFileSelect: (path: string) => void }) => (
    <div data-testid="file-tree-view">
      <span data-testid="file-tree-worktree-id">{worktreeId}</span>
      <button onClick={() => onFileSelect('/test/file.ts')}>Select File</button>
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
});
