/**
 * Unit Tests for APP_VERSION_DISPLAY constant in WorktreeDetailRefactored
 *
 * Tests the version display functionality in InfoModal (desktop) and MobileInfoContent (mobile).
 * Uses vi.resetModules() + dynamic import to test the module-level constant APP_VERSION_DISPLAY
 * which is evaluated at module load time.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Save original env
const originalEnv = { ...process.env };

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

// Mock useIsMobile hook - will be controlled per test
let mockIsMobileValue = false;
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobileValue,
  MOBILE_BREAKPOINT: 768,
}));

// Mock SidebarContext
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

// Mock child components
vi.mock('@/components/worktree/WorktreeDesktopLayout', () => ({
  WorktreeDesktopLayout: ({ leftPane, rightPane }: { leftPane: React.ReactNode; rightPane: React.ReactNode }) => (
    <div data-testid="desktop-layout">
      <div data-testid="left-pane">{leftPane}</div>
      <div data-testid="right-pane">{rightPane}</div>
    </div>
  ),
}));

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: ({ output }: { output: string }) => (
    <div data-testid="terminal-display">{output}</div>
  ),
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: ({ messages, worktreeId }: { messages: unknown[]; worktreeId: string }) => (
    <div data-testid="history-pane">
      <span data-testid="history-worktree-id">{worktreeId}</span>
    </div>
  ),
}));

vi.mock('@/components/worktree/PromptPanel', () => ({
  PromptPanel: () => null,
}));

vi.mock('@/components/mobile/MobileHeader', () => ({
  MobileHeader: ({ worktreeName, status }: { worktreeName: string; status: string }) => (
    <header data-testid="mobile-header">
      <span>{worktreeName}</span>
      <span>{status}</span>
    </header>
  ),
}));

vi.mock('@/components/mobile/MobileTabBar', () => ({
  MobileTabBar: ({ activeTab, onTabChange }: { activeTab: string; onTabChange: (tab: string) => void }) => (
    <nav data-testid="mobile-tab-bar">
      <button data-testid="tab-info" onClick={() => onTabChange('info')}>Info</button>
      <button data-testid="tab-terminal" onClick={() => onTabChange('terminal')}>Terminal</button>
    </nav>
  ),
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
      <button onClick={() => onTabChange('history')}>History</button>
      <button onClick={() => onTabChange('files')}>Files</button>
    </div>
  ),
}));

vi.mock('@/components/worktree/FileViewer', () => ({
  FileViewer: () => null,
}));

// Mock data
const mockWorktree = {
  id: 'test-worktree-123',
  name: 'feature/test-branch',
  path: '/path/to/worktree',
  repositoryPath: '/path/to/repo',
  repositoryName: 'TestRepo',
  description: 'Test description',
  updatedAt: '2024-01-15T10:00:00Z',
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

// Mock fetch
const mockFetch = vi.fn();

function setupFetchMock() {
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
            isRunning: false,
            isGenerating: false,
            content: '',
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

describe('APP_VERSION_DISPLAY', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch;
    setupFetchMock();
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('InfoModal (Desktop)', () => {
    beforeEach(() => {
      mockIsMobileValue = false;
    });

    it('displays version "v0.1.12" when NEXT_PUBLIC_APP_VERSION is set', async () => {
      process.env.NEXT_PUBLIC_APP_VERSION = '0.1.12';

      vi.resetModules();
      const { WorktreeDetailRefactored } = await import(
        '@/components/worktree/WorktreeDetailRefactored'
      );

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      // Wait for data to load
      await waitFor(() => {
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });

      // Click the info button to open InfoModal
      const infoButton = screen.getByLabelText('View worktree information');
      fireEvent.click(infoButton);

      // Check for version display
      await waitFor(() => {
        expect(screen.getByText('Version')).toBeInTheDocument();
        expect(screen.getByText('v0.1.12')).toBeInTheDocument();
      });
    });

    it('shows "-" when NEXT_PUBLIC_APP_VERSION is not set', async () => {
      delete process.env.NEXT_PUBLIC_APP_VERSION;

      vi.resetModules();
      const { WorktreeDetailRefactored } = await import(
        '@/components/worktree/WorktreeDetailRefactored'
      );

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });

      const infoButton = screen.getByLabelText('View worktree information');
      fireEvent.click(infoButton);

      await waitFor(() => {
        const versionHeadings = screen.getAllByText('Version');
        expect(versionHeadings.length).toBeGreaterThan(0);
        // Find the Version section and check value is "-"
        const versionSection = versionHeadings[0].closest('div');
        expect(versionSection).not.toBeNull();
        const valueElement = versionSection!.querySelector('p');
        expect(valueElement).not.toBeNull();
        expect(valueElement!.textContent).toBe('-');
      });
    });
  });

  describe('MobileInfoContent (Mobile)', () => {
    beforeEach(() => {
      mockIsMobileValue = true;
    });

    it('displays version "v0.1.12" when NEXT_PUBLIC_APP_VERSION is set', async () => {
      process.env.NEXT_PUBLIC_APP_VERSION = '0.1.12';

      vi.resetModules();
      const { WorktreeDetailRefactored } = await import(
        '@/components/worktree/WorktreeDetailRefactored'
      );

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      // Wait for data to load
      await waitFor(() => {
        expect(screen.getByTestId('mobile-header')).toBeInTheDocument();
      });

      // Switch to info tab
      const infoTab = screen.getByTestId('tab-info');
      fireEvent.click(infoTab);

      // Check for version display
      await waitFor(() => {
        expect(screen.getByText('Version')).toBeInTheDocument();
        expect(screen.getByText('v0.1.12')).toBeInTheDocument();
      });
    });

    it('shows "-" when NEXT_PUBLIC_APP_VERSION is not set', async () => {
      delete process.env.NEXT_PUBLIC_APP_VERSION;

      vi.resetModules();
      const { WorktreeDetailRefactored } = await import(
        '@/components/worktree/WorktreeDetailRefactored'
      );

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      await waitFor(() => {
        expect(screen.getByTestId('mobile-header')).toBeInTheDocument();
      });

      // Switch to info tab
      const infoTab = screen.getByTestId('tab-info');
      fireEvent.click(infoTab);

      await waitFor(() => {
        const versionHeadings = screen.getAllByText('Version');
        expect(versionHeadings.length).toBeGreaterThan(0);
        const versionSection = versionHeadings[0].closest('div');
        expect(versionSection).not.toBeNull();
        const valueElement = versionSection!.querySelector('p');
        expect(valueElement).not.toBeNull();
        expect(valueElement!.textContent).toBe('-');
      });
    });
  });
});
