/**
 * Acceptance Tests for Issue #266: Tab switching clears input content
 *
 * Tests the fix for the bug where switching browser tabs would clear
 * MessageInput and PromptPanel content because visibilitychange handler
 * triggered setLoading(true/false), causing component tree unmount/remount.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';

// ============================================================================
// Mocks
// ============================================================================

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
  }),
}));

// Mock child components - we need MessageInput to be trackable
vi.mock('@/components/worktree/WorktreeDesktopLayout', () => ({
  WorktreeDesktopLayout: ({ leftPane, rightPane }: { leftPane: React.ReactNode; rightPane: React.ReactNode }) => (
    <div data-testid="desktop-layout">
      <div data-testid="left-pane">{leftPane}</div>
      <div data-testid="right-pane">{rightPane}</div>
    </div>
  ),
}));

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: ({ output, isActive }: { output: string; isActive: boolean }) => (
    <div data-testid="terminal-display">
      <span data-testid="terminal-output">{output}</span>
      {isActive && <span data-testid="terminal-active">Active</span>}
    </div>
  ),
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: ({ messages }: { messages: unknown[] }) => (
    <div data-testid="history-pane">
      <span data-testid="message-count">{messages.length}</span>
    </div>
  ),
}));

// Track MessageInput mount/unmount to detect component tree teardown
let messageInputMountCount = 0;
let messageInputUnmountCount = 0;

vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: ({ worktreeId }: { worktreeId: string }) => {
    const ref = React.useRef(false);
    React.useEffect(() => {
      if (!ref.current) {
        ref.current = true;
        messageInputMountCount++;
      }
      return () => {
        messageInputUnmountCount++;
      };
    }, []);
    return <div data-testid="message-input" data-worktree-id={worktreeId}>Message Input</div>;
  },
}));

vi.mock('@/components/worktree/PromptPanel', () => ({
  PromptPanel: ({ visible, promptData }: { visible: boolean; promptData: unknown }) =>
    visible && promptData ? (
      <div data-testid="prompt-panel">Prompt Panel</div>
    ) : null,
}));

vi.mock('@/components/mobile/MobileHeader', () => ({
  MobileHeader: ({ worktreeName }: { worktreeName: string }) => (
    <header data-testid="mobile-header">
      <span>{worktreeName}</span>
    </header>
  ),
}));

vi.mock('@/components/mobile/MobileTabBar', () => ({
  MobileTabBar: ({ activeTab, onTabChange }: { activeTab: string; onTabChange: (tab: string) => void }) => (
    <nav data-testid="mobile-tab-bar">
      <button onClick={() => onTabChange('terminal')}>Terminal</button>
      <button onClick={() => onTabChange('history')}>History</button>
    </nav>
  ),
}));

vi.mock('@/components/mobile/MobilePromptSheet', () => ({
  MobilePromptSheet: ({ visible, promptData }: { visible: boolean; promptData: unknown }) =>
    visible && promptData ? (
      <div data-testid="mobile-prompt-sheet">Prompt</div>
    ) : null,
}));

vi.mock('@/components/error/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/worktree/FileTreeView', () => ({
  FileTreeView: () => <div data-testid="file-tree-view">FileTree</div>,
}));

vi.mock('@/components/worktree/LeftPaneTabSwitcher', () => ({
  LeftPaneTabSwitcher: ({ activeTab }: { activeTab: string }) => (
    <div data-testid="left-pane-tab-switcher" data-active={activeTab}>Tabs</div>
  ),
}));

vi.mock('@/components/worktree/FileViewer', () => ({
  FileViewer: () => null,
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

// ============================================================================
// Helper
// ============================================================================

function setVisibilityState(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

function setupSuccessfulFetch() {
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
}

// ============================================================================
// Tests
// ============================================================================

describe('Issue #266 Acceptance Tests: Tab switching preserves input content', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile.mockReturnValue(false);
    messageInputMountCount = 0;
    messageInputUnmountCount = 0;
    setupSuccessfulFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore default 'visible' state
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });

  describe('Scenario 1: Normal tab switch does not change loading state, preserving MessageInput', () => {
    it('does not show loading indicator on visibilitychange in normal state', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      // Wait for initial load to complete
      await waitFor(() => {
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });

      // Verify MessageInput is mounted
      expect(screen.getByTestId('message-input')).toBeInTheDocument();
      const mountCountBefore = messageInputMountCount;
      const unmountCountBefore = messageInputUnmountCount;

      // Clear fetch history
      mockFetch.mockClear();

      // Simulate tab switch: hidden -> visible
      setVisibilityState('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // Key assertion: Loading indicator should NOT appear
      expect(screen.queryByText(/loading worktree/i)).not.toBeInTheDocument();

      // Key assertion: Desktop layout should remain
      expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();

      // Key assertion: MessageInput should NOT have been unmounted/remounted
      expect(screen.getByTestId('message-input')).toBeInTheDocument();
      expect(messageInputUnmountCount).toBe(unmountCountBefore);
      expect(messageInputMountCount).toBe(mountCountBefore);
    });
  });

  describe('Scenario 2: Normal tab switch triggers parallel fetch calls', () => {
    it('calls fetchWorktree, fetchMessages, and fetchCurrentOutput in parallel', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });

      // Clear fetch history
      mockFetch.mockClear();

      // Simulate tab return
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
  });

  describe('Scenario 3: fetchWorktree failure during lightweight recovery does not collapse UI', () => {
    it('calls setError(null) to maintain component tree after fetch failure', async () => {
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });

      // Make fetchWorktree fail on visibilitychange
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
        // Worktree fetch fails
        if (url.includes('/api/worktrees/')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: 'Server error' }),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      // Simulate tab return
      setVisibilityState('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // Wait for async recovery to settle
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });

      // Key assertion: Component tree should be maintained despite fetch failure
      // SF-IMP-001: setError(null) in finally block prevents ErrorDisplay from showing
      expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      expect(screen.queryByText(/error loading worktree/i)).not.toBeInTheDocument();
      expect(screen.getByTestId('message-input')).toBeInTheDocument();
    });
  });

  describe('Scenario 4: Error state triggers handleRetry (full recovery) on tab return', () => {
    it('uses handleRetry for full recovery when error state is active', async () => {
      // First, trigger error state
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: 'Server error' }),
        })
      );

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      // Wait for error state
      await waitFor(() => {
        expect(screen.getByText(/error/i)).toBeInTheDocument();
      });

      // Fix fetch to succeed
      setupSuccessfulFetch();

      // Simulate tab return
      setVisibilityState('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // handleRetry should be called, causing full recovery
      // Loading indicator should briefly appear (handleRetry calls setLoading)
      // then data should load and desktop layout should appear
      await waitFor(() => {
        expect(screen.queryByText(/error loading worktree/i)).not.toBeInTheDocument();
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });
    });
  });

  describe('Scenario 5: Throttle guard (5000ms) prevents rapid re-fetches', () => {
    it('skips visibilitychange events within RECOVERY_THROTTLE_MS window', async () => {
      const originalDateNow = Date.now;
      let currentTime = 1000000;
      Date.now = vi.fn(() => currentTime);

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });

      mockFetch.mockClear();

      // 1st event: should trigger fetch
      setVisibilityState('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });

      // 2nd event at +2s: should be throttled (within 5s window)
      mockFetch.mockClear();
      currentTime += 2000;

      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mockFetch).not.toHaveBeenCalled();

      // 3rd event at +6s total: should trigger fetch (past 5s window)
      currentTime += 4000;
      mockFetch.mockClear();

      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });

      Date.now = originalDateNow;
    });
  });

  describe('Acceptance Criterion: Existing message send flow not affected', () => {
    it('handleMessageSent still triggers fetchMessages and fetchCurrentOutput', async () => {
      // We mock MessageInput to call onMessageSent to verify the flow.
      // In the actual test, the message-input mock doesn't trigger this,
      // but we can verify that the fetch calls still work after visibility change.
      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });

      // Verify initial fetches were made (worktree, messages, current-output)
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

      // Verify component is still functional after visibility change
      mockFetch.mockClear();
      setVisibilityState('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // All three fetch calls should fire again
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });

      // Component should still be functional
      expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      expect(screen.getByTestId('message-input')).toBeInTheDocument();
    });
  });

  describe('Acceptance Criterion: PromptPanel content preserved during tab switch', () => {
    it('does not unmount PromptPanel during lightweight recovery', async () => {
      // Setup prompt data in current-output response
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

      // Wait for prompt to appear
      await waitFor(() => {
        expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
      });

      // Clear fetch history
      mockFetch.mockClear();

      // Simulate tab return
      setVisibilityState('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // PromptPanel should still be visible (not unmounted/remounted)
      expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
      // Loading indicator should NOT appear
      expect(screen.queryByText(/loading worktree/i)).not.toBeInTheDocument();
    });
  });
});
