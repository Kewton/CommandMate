/**
 * "End" wired to the hand-off (G-4) through the whole screen, PC and phone (Issue #4227,
 * design `mem-ui-4227.md` §4.1・§7.1 G-PR2).
 *
 * The real `WorktreeDetailRefactored` → `WorktreeDetailDesktop` / the phone's actions
 * sheet, and the real hook. The dialog is a stub that shows its target and calls
 * `onStop` / `onClose` when its buttons are pressed (the dialog's own flow is
 * `SessionHandoffDialog-4227.test.tsx`; the real page is the e2e).
 *
 * - mode `on` + `popup`: End opens the hand-off, not the plain confirmation, and nothing
 *   reaches the kill-session route until the hand-off's stop is pressed; that stop is the
 *   existing one (one kill, for the target).
 * - anything else (negative control): End opens the plain confirmation as before.
 *
 * Positive control: before this contract the header's and the sheet's End ran
 * `openActiveKillConfirm`, so the plain confirmation opened on the attended branch too
 * and the hand-off was never drawn — every "hand-off" test here fails on that code.
 *
 * next-intl is the global echo mock: labels read as their keys.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const env = vi.hoisted(() => ({ mobile: false }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-4227',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => env.mobile, MOBILE_BREAKPOINT: 768 }));
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true, width: 288, isMobileDrawerOpen: false, toggle: vi.fn(),
    setWidth: vi.fn(), openMobileDrawer: vi.fn(), closeMobileDrawer: vi.fn(),
  }),
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(), isCatalogStale: false,
  }),
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
vi.mock('@/hooks/useFileTabs', () => ({
  useFileTabs: () => [
    { tabs: [], activeIndex: null },
    { dispatch: vi.fn(), openFile: vi.fn(), closeTab: vi.fn(), activateTab: vi.fn(), onFileRenamed: vi.fn(), onFileDeleted: vi.fn(), moveToFront: vi.fn() },
  ],
}));
vi.mock('@/components/worktree/TerminalContainer', () => ({
  TerminalContainer: ({ terminal }: { terminal: React.ReactNode }) => <div data-testid="terminal-column">{terminal}</div>,
}));
vi.mock('@/components/worktree/FilePanelSplit', () => ({
  FilePanelSplit: ({ terminal }: { terminal: React.ReactNode }) => <>{terminal}</>,
}));
vi.mock('@/components/worktree/TerminalSplitContainer', async () => {
  const actual = await vi.importActual<typeof import('@/components/worktree/TerminalSplitContainer')>(
    '@/components/worktree/TerminalSplitContainer',
  );
  // Issue #4227 pr2c (B P2-1): the stub draws one pane that is not the active instance
  // (`codex-2`, split 1) through the page's own `renderPane`, so its End is the page's wiring.
  return {
    ...actual,
    TerminalSplitContainer: ({ renderPane }: { renderPane?: (args: Record<string, unknown>) => React.ReactNode }) => (
      <div data-testid="split-container">
        {renderPane?.({
          splitIndex: 1,
          cliToolId: 'codex',
          instanceId: 'codex-2',
          instance: undefined,
          availableInstances: [],
          onInstanceChange: () => undefined,
          onFocus: () => undefined,
          isFocused: false,
          onDropInstance: () => undefined,
          isMaximized: false,
          onToggleMaximize: () => undefined,
        })}
      </div>
    ),
  };
});
/**
 * Issue #4227 pr2c (B P2-1): the split pane's own End builds the target of the session it
 * shows (Issue #1171) and hands it to `onRequestSessionEnd`; the stub does the same with
 * its props.
 */
vi.mock('@/components/worktree/TerminalSplitPaneContent', () => ({
  TerminalSplitPaneContent: ({
    cliToolId,
    instanceId,
    onRequestSessionEnd,
  }: {
    cliToolId: string;
    instanceId: string;
    onRequestSessionEnd?: (target: { cliToolId: string; instanceId: string; label: string }) => void;
  }) => (
    <button type="button" data-testid={`split-end-${instanceId}`} onClick={() => onRequestSessionEnd?.({ cliToolId, instanceId, label: 'Review agent' })}>
      end {instanceId}
    </button>
  ),
}));
vi.mock('@/components/worktree/FileTreeView', () => ({ FileTreeView: () => <div data-testid="file-tree-view" /> }));
vi.mock('@/components/worktree/GitPane', () => ({ GitPane: () => <div data-testid="git-pane" /> }));
vi.mock('@/components/worktree/VerificationPane', () => ({ VerificationPane: () => <div data-testid="verification-pane" /> }));

const { useTerminalPanePollingMock, useSplitMessagesMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({ useTerminalPanePolling: useTerminalPanePollingMock }));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
  SPLIT_MESSAGES_POLL_INTERVAL_MS: 5000,
}));

vi.mock('@/components/mem/SessionHandoffDialog', () => ({
  SessionHandoffDialog: ({
    isOpen,
    target,
    onClose,
    onStop,
  }: {
    isOpen: boolean;
    target: { instanceId: string; label: string } | null;
    onClose: () => void;
    onStop: () => Promise<void>;
  }) =>
    isOpen && target ? (
      <div data-testid="handoff-dialog-stub" data-instance={target.instanceId}>
        <button type="button" data-testid="stub-stop" onClick={() => void onStop()}>
          stop
        </button>
        <button type="button" data-testid="stub-close" onClick={onClose}>
          close
        </button>
      </div>
    ) : null,
}));

import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';

const WORKTREE_ID = 'wt-4227';
const KILL_WARNING = 'worktree.session.endWarning';

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

let modeBody: unknown;
let kills: string[];
let modeReads: string[];

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  kills = [];
  modeReads = [];
  modeBody = { ok: true, mode: 'on', features: { popup: true } };
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: '', realtimeSnippet: '', isRunning: true, isThinking: false,
      sessionStatus: 'ready', isSelectionListActive: false, isPagerActive: false,
      isUnclassifiedActive: false, composerText: '', attaching: false, autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()) });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const u = String(url);
      if (u.includes('/mem/mode')) {
        modeReads.push(u);
        return Promise.resolve(jsonResponse(modeBody));
      }
      if (u.includes('/kill-session')) {
        kills.push(u);
        return Promise.resolve(jsonResponse({ success: true, message: 'ok' }));
      }
      if (u.includes('/current-output')) {
        return Promise.resolve(jsonResponse({ isRunning: true, fullOutput: '', realtimeSnippet: '', thinking: false, isPromptWaiting: false, promptData: null }));
      }
      if (u.includes('/messages')) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(
        jsonResponse({
          id: WORKTREE_ID,
          name: 'feature/4227',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
          selectedAgents: ['claude'],
          agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }],
          sessionStatusByCli: { claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false } },
          sessionStatusByInstance: { claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false } },
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

async function pressEnd(): Promise<void> {
  render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
  if (env.mobile) {
    fireEvent.click(await screen.findByTestId('mobile-more-actions-button'));
    const end = await screen.findByTestId('actions-sheet-end');
    await waitFor(() => expect(end).not.toBeDisabled());
    fireEvent.click(end);
  } else {
    fireEvent.click(await screen.findByTestId('desktop-kill-session'));
  }
}

for (const layout of ['PC', 'phone'] as const) {
  describe(`[#4227 G-4] End on the ${layout}`, () => {
    beforeEach(() => {
      env.mobile = layout === 'phone';
    });

    it('mode on + popup: the hand-off opens for the active instance; nothing is killed until its stop', async () => {
      await pressEnd();
      const dialog = await screen.findByTestId('handoff-dialog-stub');
      expect(dialog).toHaveAttribute('data-instance', 'claude');
      expect(screen.queryByText(KILL_WARNING)).toBeNull();
      expect(kills).toEqual([]);

      fireEvent.click(screen.getByTestId('stub-stop'));
      await waitFor(() => expect(kills).toHaveLength(1));
      expect(kills[0]).toBe(`/api/worktrees/${WORKTREE_ID}/kill-session?cliTool=claude&instance=claude`);
    });

    it('closing the hand-off kills nothing and opens no confirmation', async () => {
      await pressEnd();
      await screen.findByTestId('handoff-dialog-stub');
      fireEvent.click(screen.getByTestId('stub-close'));
      await waitFor(() => expect(screen.queryByTestId('handoff-dialog-stub')).toBeNull());
      expect(screen.queryByText(KILL_WARNING)).toBeNull();
      expect(kills).toEqual([]);
    });

    it.each([
      ['unattended (popup off)', { ok: true, mode: 'on', features: { popup: false } }],
      ['mode derived', { ok: true, mode: 'derived', features: { popup: true } }],
    ])('%s: the plain confirmation as before (negative control)', async (_label, body) => {
      modeBody = body;
      await pressEnd();
      expect(await screen.findByText(KILL_WARNING)).toBeInTheDocument();
      expect(screen.queryByTestId('handoff-dialog-stub')).toBeNull();
      expect(kills).toEqual([]);
    });
  });
}

/**
 * Issue #4227 pr2c (review B P2-1): a PC split's own End goes through the same "end" for
 * that split's session, not the active one. The pane here is `codex-2` while the active
 * instance is `claude`. Positive control: the split's End wired to the active instance's
 * end (`openActiveEnd`) opens the hand-off for `claude` and its plain confirmation kills
 * `claude`; wired to the old `openKillConfirm` it reads no mode — each test fails then.
 */
describe('[#4227 G-4] B P2-1: a PC split pane’s own End, for a session that is not the active one', () => {
  beforeEach(() => {
    env.mobile = false;
  });

  it('mode on + popup: one mode read, the hand-off for that pane’s session, nothing killed until its stop', async () => {
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
    fireEvent.click(await screen.findByTestId('split-end-codex-2'));
    const dialog = await screen.findByTestId('handoff-dialog-stub');
    expect(dialog).toHaveAttribute('data-instance', 'codex-2');
    expect(modeReads).toEqual([`/api/worktrees/${WORKTREE_ID}/mem/mode`]);
    expect(screen.queryByText(KILL_WARNING)).toBeNull();
    expect(kills).toEqual([]);
    fireEvent.click(screen.getByTestId('stub-stop'));
    await waitFor(() => expect(kills).toEqual([`/api/worktrees/${WORKTREE_ID}/kill-session?cliTool=codex&instance=codex-2`]));
  });

  it('popup off: the plain confirmation for that pane’s session; nothing killed until it is confirmed, then that session only', async () => {
    modeBody = { ok: true, mode: 'on', features: { popup: false } };
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
    fireEvent.click(await screen.findByTestId('split-end-codex-2'));
    expect(await screen.findByText(KILL_WARNING)).toBeInTheDocument();
    expect(modeReads).toHaveLength(1);
    expect(screen.queryByTestId('handoff-dialog-stub')).toBeNull();
    expect(kills).toEqual([]);
    fireEvent.click(screen.getByTestId('kill-session-confirm-button'));
    await waitFor(() => expect(kills).toEqual([`/api/worktrees/${WORKTREE_ID}/kill-session?cliTool=codex&instance=codex-2`]));
  });
});
