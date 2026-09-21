/**
 * The phone's direct-input keyboard, wired into the whole screen (Issue #2799 §1 / §8).
 *
 * Rendered end to end — the real `WorktreeDetailRefactored`, `MobileContent`,
 * `MobileTerminalTab`, `MobileTerminalActionsSheet`, `MessageInput` and the
 * keyboard itself — because every property below is a SEAM between two of
 * them, and a test that stubbed either side would prove the wiring by assuming
 * it:
 *
 *  - entry through the actions sheet, and the sheet's focus restore losing to
 *    the keyboard's blur (the OS keyboard must not come back);
 *  - the keyboard is docked in the bottom bar, outside `<main>` (which scrolls
 *    and carries the tab swipe), and `<main>`'s class literal is untouched;
 *  - the composer is HIDDEN, not unmounted, so a draft typed just before is
 *    kept; the docked navigation pad is unmounted;
 *  - the mode closes — discarding the staged keys — on an instance switch, a
 *    tab switch, or the session stopping;
 *  - the prompt sheet stands down for the mode (a deliberate exception to
 *    #2755, even for a checkbox question under Auto-Yes) and comes back on
 *    `閉じる`, while the tab bar's prompt badge stays up throughout.
 *
 * next-intl is the global echo mock: labels read as their keys.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { getMobileSurfaceModeStorageKey } from '@/config/surface-mode-config';
import { charKeyTestId } from '@/config/mobile-keyboard-layout';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-2799',
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
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(), isCatalogStale: false,
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
  TerminalDisplay: () => (
    <div data-testid="terminal-display">
      <div role="log" />
    </div>
  ),
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: () => (
    <div data-testid="chat-transcript">
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

vi.mock('@/components/worktree/NavigationButtons', () => ({
  NavigationButtons: () => <div data-testid="navigation-buttons" />,
}));

vi.mock('@/components/mobile/MobilePromptSheet', () => ({
  MobilePromptSheet: ({ visible, promptData }: { visible: boolean; promptData: unknown }) =>
    visible && promptData ? <div data-testid="mobile-prompt-sheet" /> : null,
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

const WORKTREE_ID = 'wt-2799';

/** What the fetch stub answers; each test edits it before (or while) rendering. */
interface Scenario {
  claudeRunning: boolean;
  autoYes: boolean;
  prompt: null | { multiSelect: boolean };
  selectionList: boolean;
  /** The worktree has a task row, so the verification strip is drawn (Issue #2824). */
  hasTask: boolean;
  /** The worktree's branch differs from its initial one, so the mismatch alert is drawn (Issue #2824). */
  branchMismatch: boolean;
}
let scenario: Scenario;
let directInputPosts: Array<{ cliToolId: string; events: unknown[]; instanceId?: string }>;

/** `GET /tasks?limit=1` row for `scenario.hasTask` (Issue #2824). */
const TASK_ROW = {
  id: 'task-2799',
  worktreeId: WORKTREE_ID,
  cliToolId: 'claude',
  instanceId: 'claude',
  title: 'Issue #2799: direct input',
  goal: 'goal',
  contractPath: '.commandmate/tasks/issue-2799.yaml',
  contract: {
    version: 1,
    title: 'Issue #2799: direct input',
    goal: 'goal',
    scope: { allow: ['src/**'], deny: [] },
    verify: { gates: ['lint'], gateDefinitions: [] },
    autoYes: { mode: null, allowPromptTypes: [], denyPatterns: [] },
    success: {
      requireWorkEvidence: true,
      requireScopeClean: true,
      requireCommit: false,
      requireEnvClean: false,
      autoVerifyOnStop: false,
    },
  },
  status: 'succeeded',
  lastVerificationRunId: null,
  createdAt: '2026-09-21T06:04:23.075Z',
  updatedAt: '2026-09-21T07:29:36.969Z',
  startedAt: '2026-09-21T06:04:26.451Z',
  finishedAt: '2026-09-21T07:29:36.969Z',
};

/** `gitStatus` for `scenario.branchMismatch` (Issue #2824). */
const MISMATCHED_GIT_STATUS = {
  currentBranch: 'main',
  initialBranch: 'feature/2799',
  isBranchMismatch: true,
  commitHash: 'abc1234',
  isDirty: false,
};

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

function promptPayload(): Record<string, unknown> {
  if (scenario.prompt === null) return { isPromptWaiting: false, promptData: null };
  return {
    isPromptWaiting: true,
    promptData: {
      type: 'multiple_choice',
      question: 'Which caches should I clear?',
      status: 'pending',
      isAskUserQuestion: true,
      ...(scenario.prompt.multiSelect ? { multiSelect: true } : {}),
      options: [
        { number: 1, label: 'node_modules', isDefault: true },
        { number: 2, label: 'dist', isDefault: false },
      ],
    },
  };
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/direct-input')) {
        directInputPosts.push(JSON.parse(String(init?.body ?? '{}')));
        return Promise.resolve(jsonResponse({ success: true }));
      }
      if (u.includes('/current-output')) {
        return Promise.resolve(
          jsonResponse({
            isRunning: true,
            fullOutput: 'row 1\nrow 2',
            realtimeSnippet: 'row 2',
            thinking: false,
            sessionStatus: 'ready',
            isSelectionListActive: scenario.selectionList,
            isPagerActive: false,
            isUnclassifiedActive: false,
            ...promptPayload(),
          }),
        );
      }
      if (u.includes('/auto-yes')) {
        return Promise.resolve(
          jsonResponse({ instances: { claude: { enabled: scenario.autoYes, expiresAt: null } } }),
        );
      }
      if (u.includes('/messages')) return Promise.resolve(jsonResponse([]));
      if (u.includes('/tasks')) {
        return Promise.resolve(jsonResponse({ tasks: scenario.hasTask ? [TASK_ROW] : [] }));
      }
      if (u.includes('/verify/runs')) return Promise.resolve(jsonResponse({ runs: [] }));
      return Promise.resolve(
        jsonResponse({
          id: WORKTREE_ID,
          name: 'feature/2799',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
          selectedAgents: ['claude', 'codex'],
          agentInstances: [
            { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
            { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
          ],
          sessionStatusByCli: {
            claude: { isRunning: scenario.claudeRunning, isWaitingForResponse: false, isProcessing: false },
            codex: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
          },
          ...(scenario.branchMismatch ? { gitStatus: MISMATCHED_GIT_STATUS } : {}),
        }),
      );
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  scenario = {
    claudeRunning: true,
    autoYes: false,
    prompt: null,
    selectionList: false,
    hasTask: false,
    branchMismatch: false,
  };
  directInputPosts = [];
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'row 1\nrow 2',
      realtimeSnippet: 'row 2',
      isRunning: true,
      isThinking: false,
      sessionStatus: 'ready',
      isSelectionListActive: false,
      isPagerActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()) });
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

async function renderScreen() {
  const utils = render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
  await screen.findByTestId('mobile-more-actions-button');
  return utils;
}

/** Open the sheet and return the direct-input row once the screen has its session state. */
async function openSheetRow(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId('mobile-more-actions-button'));
  return screen.findByTestId('actions-sheet-direct-input');
}

async function openKeyboard(): Promise<HTMLElement> {
  await waitFor(async () => {
    if (!screen.queryByTestId('mobile-terminal-actions-sheet')) {
      fireEvent.click(screen.getByTestId('mobile-more-actions-button'));
    }
    expect(screen.getByTestId('actions-sheet-direct-input')).not.toHaveAttribute('aria-disabled');
  });
  fireEvent.click(screen.getByTestId('actions-sheet-direct-input'));
  return screen.findByTestId('mobile-direct-input-keyboard');
}

function stagedChips(): string[] {
  return screen.queryAllByTestId('direct-input-chip').map((chip) => chip.textContent ?? '');
}

describe('[#2799] entering and leaving', () => {
  it('opens from the actions sheet, which closes; the keyboard is in the bottom bar, not in <main>', async () => {
    await renderScreen();
    const keyboard = await openKeyboard();

    expect(screen.queryByTestId('mobile-terminal-actions-sheet')).not.toBeInTheDocument();
    const main = document.querySelector('main');
    expect(main).not.toBeNull();
    expect(main!.className).toBe('flex-1 min-h-0 overflow-y-auto');
    expect(main).not.toContainElement(keyboard);
    // Docked beside the composer it stands in for.
    expect(screen.getByTestId('mobile-composer-wrapper').parentElement).toContainElement(keyboard);

    fireEvent.click(screen.getByTestId('direct-input-close'));
    expect(screen.queryByTestId('mobile-direct-input-keyboard')).not.toBeInTheDocument();
  });

  it('sends the staged keys to the active instance as one request, and nothing before 送信', async () => {
    await renderScreen();
    await openKeyboard();
    fireEvent.click(screen.getByTestId('direct-key-esc'));
    fireEvent.click(screen.getByTestId('direct-key-down'));
    expect(directInputPosts).toHaveLength(0);

    await act(async () => {
      fireEvent.click(screen.getByTestId('direct-input-send'));
    });
    expect(directInputPosts).toEqual([
      { cliToolId: 'claude', events: [{ type: 'key', key: 'Escape' }, { type: 'key', key: 'Down' }] },
    ]);
  });

  it('dismisses the OS keyboard AFTER the sheet hands focus back to the composer', async () => {
    // iOS does not move focus for a button tap, so the element the sheet's
    // focus trap restores on close is the composer textarea. The keyboard's
    // blur has to run after that restore, or the OS keyboard reopens.
    await renderScreen();
    const textarea = screen.getByTestId('message-input-textarea');
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    const row = await openSheetRow();
    expect(document.activeElement).not.toBe(textarea); // the trap took it
    await waitFor(() => expect(row).not.toHaveAttribute('aria-disabled'));
    fireEvent.click(row);
    await screen.findByTestId('mobile-direct-input-keyboard');

    expect(document.activeElement).not.toBe(textarea);
    expect(document.activeElement?.matches('input, textarea, [contenteditable="true"]') ?? false).toBe(false);
  });

  it('keeps the composer mounted and its draft, hidden with display:none while open', async () => {
    await renderScreen();
    const textarea = screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;
    // Typed "just now": well inside MessageInput's 500ms draft-save debounce.
    fireEvent.change(textarea, { target: { value: 'half a thought' } });

    await openKeyboard();
    const wrapper = screen.getByTestId('mobile-composer-wrapper');
    expect(wrapper.className.split(' ')).toContain('hidden');
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
    // Same node, still in the document, same value.
    expect(screen.getByTestId('message-input-textarea')).toBe(textarea);
    expect(textarea.value).toBe('half a thought');

    fireEvent.click(screen.getByTestId('direct-input-close'));
    expect(wrapper.className.split(' ')).not.toContain('hidden');
    expect(wrapper).not.toHaveAttribute('aria-hidden');
    expect((screen.getByTestId('message-input-textarea') as HTMLTextAreaElement).value).toBe('half a thought');
  });

  it('stands the docked navigation pad down while open', async () => {
    scenario.selectionList = true;
    await renderScreen();
    await screen.findByTestId('navigation-buttons');
    await openKeyboard();
    expect(screen.queryByTestId('navigation-buttons')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('direct-input-close'));
    expect(screen.getByTestId('navigation-buttons')).toBeInTheDocument();
  });

  it('locks the surface pill while open', async () => {
    await renderScreen();
    await openKeyboard();
    expect(screen.getByTestId('mobile-surface-mode-chat')).toHaveAttribute('aria-disabled', 'true');
  });

  it('writes nothing it staged to localStorage or sessionStorage', async () => {
    await renderScreen();
    await openKeyboard();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    fireEvent.click(screen.getByTestId('direct-input-toggle-chars'));
    for (const char of 'qwerty') fireEvent.click(screen.getByTestId(charKeyTestId(char)));
    expect(stagedChips()).toEqual(['qwerty']);
    for (const [, value] of setItem.mock.calls) {
      expect(String(value)).not.toContain('qwerty');
    }
  });
});

describe('[#2799 §1] when the row can be used', () => {
  it('is unavailable with the tab reason off the Terminal tab — and the mode does not open', async () => {
    await renderScreen();
    fireEvent.click(screen.getByTestId('mobile-tab-history'));
    const row = await openSheetRow();
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('actions-sheet-direct-input-reason')).toHaveTextContent(
      'worktree.directInputKeyboard.unavailableTab',
    );
    fireEvent.click(row);
    expect(screen.queryByTestId('mobile-direct-input-keyboard')).not.toBeInTheDocument();
  });

  it('is unavailable with the chat reason on the chat surface', async () => {
    window.localStorage.setItem(getMobileSurfaceModeStorageKey(WORKTREE_ID), 'chat');
    await renderScreen();
    await screen.findByTestId('mobile-chat-surface');
    const row = await openSheetRow();
    await waitFor(() =>
      expect(screen.getByTestId('actions-sheet-direct-input-reason')).toHaveTextContent(
        'worktree.directInputKeyboard.unavailableChat',
      ),
    );
    expect(row).toHaveAttribute('aria-disabled', 'true');
  });

  it('is unavailable with the session reason when no session is running', async () => {
    scenario.claudeRunning = false;
    await renderScreen();
    await openSheetRow();
    expect(screen.getByTestId('actions-sheet-direct-input')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('actions-sheet-direct-input-reason')).toHaveTextContent(
      'worktree.directInputKeyboard.unavailableSession',
    );
  });
});

describe('[#2799 §1] closing by itself — and discarding what was staged', () => {
  it('closes when another instance tab is chosen, and nothing reaches either agent', async () => {
    await renderScreen();
    await openKeyboard();
    fireEvent.click(screen.getByTestId('direct-key-esc'));
    expect(stagedChips()).toEqual(['ESC']);

    const nav = screen.getByRole('navigation', { name: 'worktree.detail.agentInstanceSelection' });
    const codexTab = within(nav)
      .getAllByRole('button')
      .find((button) => button.textContent?.includes('Codex'));
    expect(codexTab).toBeDefined();
    fireEvent.click(codexTab!);

    await waitFor(() => expect(screen.queryByTestId('mobile-direct-input-keyboard')).not.toBeInTheDocument());
    expect(directInputPosts).toHaveLength(0);

    // Reopened for the new target: empty.
    await openKeyboard();
    expect(stagedChips()).toEqual([]);
  });

  it('closes on leaving the Terminal tab', async () => {
    await renderScreen();
    await openKeyboard();
    fireEvent.click(screen.getByTestId('direct-key-esc'));
    fireEvent.click(screen.getByTestId('mobile-tab-history'));
    await waitFor(() => expect(screen.queryByTestId('mobile-direct-input-keyboard')).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId('mobile-tab-terminal'));
    await screen.findByTestId('mobile-terminal-region');
    expect(screen.queryByTestId('mobile-direct-input-keyboard')).not.toBeInTheDocument();
  });

  it('stays open across polls that keep the session running, and closes when it stops', async () => {
    await renderScreen();
    await openKeyboard();
    fireEvent.click(screen.getByTestId('direct-key-esc'));

    // One poll cycle (2s while running) that changes nothing.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2300));
    });
    expect(screen.getByTestId('mobile-direct-input-keyboard')).toBeInTheDocument();
    expect(stagedChips()).toEqual(['ESC']);

    scenario.claudeRunning = false;
    await waitFor(
      () => expect(screen.queryByTestId('mobile-direct-input-keyboard')).not.toBeInTheDocument(),
      { timeout: 4000 },
    );
    expect(directInputPosts).toHaveLength(0);
  }, 15_000);
});

describe('[#2799 §8] the prompt sheet stands down for the mode', () => {
  it('hides the sheet while open and brings it back on 閉じる; the prompt badge stays up', async () => {
    scenario.prompt = { multiSelect: false };
    await renderScreen();
    await screen.findByTestId('mobile-prompt-sheet');

    await openKeyboard();
    expect(screen.queryByTestId('mobile-prompt-sheet')).not.toBeInTheDocument();
    expect(screen.getByTestId('prompt-badge')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('direct-input-close'));
    expect(screen.getByTestId('mobile-prompt-sheet')).toBeInTheDocument();
  });

  it('hides even a checkbox question under Auto-Yes — the one exception to #2755, for the mode only', async () => {
    scenario.prompt = { multiSelect: true };
    scenario.autoYes = true;
    await renderScreen();
    // #2755 unchanged outside the mode.
    await screen.findByTestId('mobile-prompt-sheet');

    await openKeyboard();
    expect(screen.queryByTestId('mobile-prompt-sheet')).not.toBeInTheDocument();
    expect(screen.getByTestId('prompt-badge')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('direct-input-close'));
    expect(screen.getByTestId('mobile-prompt-sheet')).toBeInTheDocument();
  });
});

describe('[#2824] the bands above <main> stand aside while the keyboard is open', () => {
  it('hides the verification strip while open, and brings it back on 閉じる', async () => {
    scenario.hasTask = true;
    await renderScreen();
    await screen.findByTestId('verification-status-chip');

    await openKeyboard();
    expect(screen.queryByTestId('verification-status-chip')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('direct-input-close'));
    expect(await screen.findByTestId('verification-status-chip')).toBeInTheDocument();
  });

  it('hides the branch-mismatch alert while open, and brings it back on 閉じる', async () => {
    scenario.branchMismatch = true;
    await renderScreen();
    await screen.findByTestId('branch-mismatch-alert');

    await openKeyboard();
    expect(screen.queryByTestId('branch-mismatch-alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('direct-input-close'));
    expect(await screen.findByTestId('branch-mismatch-alert')).toBeInTheDocument();
  });
});
