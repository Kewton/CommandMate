/**
 * A toggle that retires the in-flight whole-worktree GETs re-reads the map
 * itself, so another instance's state is not lost (Issue #3723, 3rd review P2).
 *
 * The previous fix advances the GETs' latest-request counter on a successful
 * toggle POST, discarding every GET begun before it. When the primary and an
 * alias are both armed and the primary is turned OFF while the mount-time GET
 * is still out, that GET was the only reader of the alias (the current-output
 * poll seeds one instance): the map read all OFF and the 12 s contract re-read
 * stopped for good. The toggle now issues one whole-worktree GET after the
 * POST, and that answer decides the alias and the re-read gate.
 *
 * Drawn from both parents: the PC split (two splits, primary + alias) and the
 * phone composer (the primary active; the alias is seen through the re-read
 * that keeps running only while something is armed).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { getTerminalSplitsStorageKey } from '@/config/terminal-split-config';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-3723',
  useSearchParams: () => new URLSearchParams(),
}));

const viewport = vi.hoisted(() => ({ mobile: true }));
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => viewport.mobile,
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
import { AUTO_YES_CONTRACT_REFRESH_MS } from '@/hooks/useWorktreeDetailController';

const WORKTREE_ID = 'wt-3723';
const PRIMARY = 'claude';
const ALIAS = 'claude-2';

/** The server's arming per instance, as a GET begun NOW reads it. */
let server: Record<string, boolean>;
let holdGets: boolean;
let held: Array<() => void>;
let autoYesGets: number;

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

function entry(on: boolean): Record<string, unknown> {
  return { enabled: on, expiresAt: on ? Date.now() + 3_600_000 : null };
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (u.includes('/current-output')) {
        const instance = new URL(u, 'http://localhost').searchParams.get('instance') ?? PRIMARY;
        return Promise.resolve(
          jsonResponse({
            isRunning: true,
            fullOutput: 'row 1',
            realtimeSnippet: 'row 1',
            thinking: false,
            sessionStatus: 'ready',
            isSelectionListActive: false,
            isPagerActive: false,
            isUnclassifiedActive: false,
            isPromptWaiting: false,
            promptData: null,
            autoYes: { ...entry(server[instance] ?? false), lastSuppression: null },
          }),
        );
      }
      if (u.includes('/auto-yes') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { enabled: boolean; instanceId: string };
        server[body.instanceId] = body.enabled;
        return Promise.resolve(jsonResponse(entry(body.enabled)));
      }
      if (u.includes('/auto-yes')) {
        autoYesGets += 1;
        // Read when the GET starts: a held GET answers what the server said then.
        const body = { instances: { [PRIMARY]: entry(server[PRIMARY]), [ALIAS]: entry(server[ALIAS]) } };
        if (holdGets) {
          return new Promise<Response>((resolve) => {
            held.push(() => resolve(jsonResponse(body)));
          });
        }
        return Promise.resolve(jsonResponse(body));
      }
      if (u.includes('/messages')) return Promise.resolve(jsonResponse([]));
      if (u.includes('/tasks')) return Promise.resolve(jsonResponse({ tasks: [] }));
      if (u.includes('/verify/runs')) return Promise.resolve(jsonResponse({ runs: [] }));
      return Promise.resolve(
        jsonResponse({
          id: WORKTREE_ID,
          name: 'feature/3723',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
          selectedAgents: ['claude'],
          agentInstances: [
            { id: PRIMARY, cliTool: 'claude', alias: 'Claude', order: 0 },
            { id: ALIAS, cliTool: 'claude', alias: 'Claude 2', order: 1 },
          ],
          sessionStatusByCli: {
            claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
          },
        }),
      );
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem(`activeInstanceId-${WORKTREE_ID}`, PRIMARY);
  window.localStorage.setItem(
    getTerminalSplitsStorageKey(WORKTREE_ID),
    JSON.stringify({
      splits: [
        { cliToolId: 'claude', instanceId: PRIMARY },
        { cliToolId: 'claude', instanceId: ALIAS },
      ],
      widths: [0.5, 0.5],
    }),
  );
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  server = { [PRIMARY]: true, [ALIAS]: true };
  holdGets = false;
  held = [];
  autoYesGets = 0;
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'row 1',
      realtimeSnippet: 'row 1',
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

async function settle(ms = 300): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function toggles(): HTMLElement[] {
  return screen.getAllByRole('switch', { name: 'autoYes.toggleLabel' });
}

describe.each([
  ['the PC split', false],
  ['the phone composer', true],
])('[#3723] %s: turning the primary OFF while the whole-map GET is out', (_label, mobile) => {
  beforeEach(() => {
    viewport.mobile = mobile;
  });

  it('keeps the alias ON from the post-toggle re-read, and the contract re-read keeps running', async () => {
    holdGets = true; // the mount-time GETs stay out
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
    await settle(2_500); // the current-output poll seeds the primary ON
    expect(held.length).toBeGreaterThan(0);
    const primaryToggle = toggles()[0];
    expect(primaryToggle.getAttribute('aria-checked')).toBe('true');

    holdGets = false; // GETs begun from here on are answered
    fireEvent.click(primaryToggle); // ON -> OFF: no dialog, straight to the POST
    await settle();
    expect(server[PRIMARY]).toBe(false);

    // The stale mount-time GETs (primary still ON) land now and are discarded.
    await act(async () => {
      for (const release of held.splice(0)) release();
    });
    await settle();

    expect(toggles()[0].getAttribute('aria-checked')).toBe('false');
    if (!mobile) {
      expect(toggles()[1].getAttribute('aria-checked')).toBe('true'); // the alias split
    }

    const before = autoYesGets;
    await settle(AUTO_YES_CONTRACT_REFRESH_MS);
    await settle();
    expect(autoYesGets).toBeGreaterThan(before); // something is still armed
    expect(toggles()[0].getAttribute('aria-checked')).toBe('false');
  });
});
