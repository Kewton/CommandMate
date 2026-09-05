/**
 * The screen publishes the file-link scope, on BOTH layouts (Issue #2345).
 *
 * Everything else in this Issue is downstream of one fact: the two things a
 * transcript cannot derive — this worktree's absolute root, and the screen's own
 * "open it in the file panel" — actually reach it. They cannot be threaded down
 * as props, because the components in between (`TerminalSplitPaneContent` on PC,
 * `MobileContent` on the phone) each build their children's prop object
 * themselves; so they travel over `ChatFileLinkProvider` from here.
 *
 * That makes this the seam test. Without it the provider could be dropped from
 * one of the two branches and every other suite in the Issue would stay green,
 * because each of them supplies the scope itself.
 *
 * A probe stands in for the layout on each side: the assertion is what the scope
 * says at the depth a transcript sits, not what any particular pane does with it.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useChatFileLinkScope } from '@/lib/chat/chat-file-link-scope';

const { isMobileMock, openFileMock } = vi.hoisted(() => ({
  isMobileMock: vi.fn(() => false),
  openFileMock: vi.fn(() => 'opened'),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-2345',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => isMobileMock(),
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

vi.mock('@/hooks/useUpdateCheck', () => ({
  useUpdateCheck: () => ({ data: null, loading: false, error: null }),
}));

// The desktop file-tab store, so `handleFilePathClick` on PC is observable as a
// call rather than as a panel that would need the whole layout to render.
vi.mock('@/hooks/useFileTabs', () => ({
  useFileTabs: () => [
    { tabs: [], activeIndex: null },
    {
      dispatch: vi.fn(),
      openFile: openFileMock,
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

/** Reports the scope at the depth a transcript sits, and lets a test use it. */
function ScopeProbe({ testId }: { testId: string }) {
  const { worktreePath, openFile } = useChatFileLinkScope();
  return (
    <div data-testid={testId} data-worktree-path={worktreePath ?? ''}>
      <button
        type="button"
        data-testid={`${testId}-open`}
        data-has-open={openFile ? 'yes' : 'no'}
        onClick={() => openFile?.('docs/a.md')}
      />
    </div>
  );
}

vi.mock('@/components/worktree/WorktreeDetailDesktop', () => ({
  WorktreeDetailDesktop: () => <ScopeProbe testId="desktop-scope" />,
}));

vi.mock('@/components/worktree/WorktreeDetailMobile', () => ({
  MobileContent: () => <ScopeProbe testId="mobile-scope" />,
}));

import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';

const WORKTREE_ID = 'wt-2345';
const WORKTREE_PATH = '/Users/dev/work/CommandAgent-develop';

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

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  openFileMock.mockClear();
  isMobileMock.mockReturnValue(false);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/messages')) {
        return Promise.resolve(jsonResponse([]));
      }
      return Promise.resolve(
        jsonResponse({
          id: WORKTREE_ID,
          name: 'feature/2345',
          path: WORKTREE_PATH,
          repositoryPath: '/Users/dev/work/repo',
          repositoryName: 'CommandAgent',
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('[#2345] WorktreeDetailRefactored publishes the file-link scope', () => {
  it.each([
    ['the PC layout', false, 'desktop-scope'],
    ['the phone layout', true, 'mobile-scope'],
  ])('states this worktree’s absolute root on %s', async (_label, mobile, testId) => {
    isMobileMock.mockReturnValue(mobile);
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);

    const probe = await screen.findByTestId(testId);
    await waitFor(() =>
      expect(probe).toHaveAttribute('data-worktree-path', WORKTREE_PATH),
    );
  });

  it('hands the PC layout the screen’s own file-tab open', async () => {
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);

    const button = await screen.findByTestId('desktop-scope-open');
    expect(button).toHaveAttribute('data-has-open', 'yes');
    fireEvent.click(button);
    expect(openFileMock).toHaveBeenCalledWith('docs/a.md');
  });

  it('hands the phone layout an open too — the tab’s no-op is gone', async () => {
    // Phase C. The phone routes to `setMobileFileViewerPath` rather than to the
    // tab store, so what is asserted here is that the callback EXISTS at the
    // depth `MobileTerminalTab` reads it from; where it lands is the screen's
    // own long-standing `handleFilePathClick` branch.
    isMobileMock.mockReturnValue(true);
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);

    const button = await screen.findByTestId('mobile-scope-open');
    expect(button).toHaveAttribute('data-has-open', 'yes');
    expect(openFileMock).not.toHaveBeenCalled();
  });
});
