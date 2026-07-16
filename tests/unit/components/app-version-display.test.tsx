/**
 * Unit Tests for APP_VERSION_DISPLAY constant in WorktreeDetailRefactored
 *
 * Tests the version display functionality in InfoModal (desktop) and MobileInfoContent (mobile).
 * Uses vi.resetModules() + dynamic import to test the module-level constant APP_VERSION_DISPLAY
 * which is evaluated at module load time.
 *
 * Issue #257: Updated to account for VersionSection component extraction (SF-001).
 * The "Version" heading is now rendered via i18n as "worktree.update.version".
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Save original env
const originalEnv = { ...process.env };

// Issue #1277: this suite drives the Info button / modal by their English
// wording, which is now dictionary-driven. Resolve keys through the REAL
// locales/en/*.json so a missing key fails loudly here instead of being echoed
// back as `worktree.detail.viewInfo` by the global mock in tests/setup.ts.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

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

// Mock useUpdateCheck hook (Issue #257)
vi.mock('@/hooks/useUpdateCheck', () => ({
  useUpdateCheck: () => ({
    data: null,
    loading: false,
    error: null,
  }),
}));

// Mock child components
vi.mock('@/components/worktree/WorktreeDesktopLayout', () => ({
  WorktreeDesktopLayout: ({
    activityBar,
    activityPane,
    historyPane,
    rightPane,
  }: {
    activityBar: React.ReactNode;
    activityPane: React.ReactNode;
    historyPane: React.ReactNode;
    rightPane: React.ReactNode;
  }) => (
    <div data-testid="desktop-layout">
      <div data-testid="activity-bar-slot">{activityBar}</div>
      <div data-testid="activity-pane-slot">{activityPane}</div>
      <div data-testid="history-pane-slot">{historyPane}</div>
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
  // Issue #744: real export consumed by TerminalSplitPaneContent for the slot id.
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
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

// Issue #727: LeftPaneTabSwitcher removed — ActivityBar mocked instead
vi.mock('@/components/worktree/ActivityBar', () => ({
  ActivityBar: () => <div data-testid="activity-bar" />,
}));

vi.mock('@/components/worktree/ActivityPane', () => ({
  ActivityPane: () => <div data-testid="activity-pane" />,
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
        // Issue #257: VersionSection renders the i18n key "worktree.update.version",
        // which resolves to "Version" via the real en dictionary (Issue #1277).
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
        // Issue #257: VersionSection renders the i18n key "worktree.update.version",
        // which resolves to "Version" via the real en dictionary (Issue #1277).
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
        // Issue #257: VersionSection renders the i18n key "worktree.update.version",
        // which resolves to "Version" via the real en dictionary (Issue #1277).
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
        // Issue #257: VersionSection renders the i18n key "worktree.update.version",
        // which resolves to "Version" via the real en dictionary (Issue #1277).
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
