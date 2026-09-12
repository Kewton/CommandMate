/**
 * What the phone actually shows when it loses signal (Issue #2498).
 *
 * The controller suite
 * (`tests/unit/hooks/useWorktreeDetailController-offline-resilience-2498.test.tsx`)
 * pins the verdicts. This one renders the real screen and asks the question the
 * bug report asked: after the network drops, is the screen still there, is the
 * half-typed message still in the composer, and does an expired session say
 * something the user can act on?
 *
 * The composer assertion is the reason this file exists at all. "The draft
 * survives" is not a property of any single value — it is a property of the
 * component tree not being unmounted, which only a real render can show.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-2498-screen',
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

vi.mock('@/hooks/useUpdateCheck', () => ({
  useUpdateCheck: () => ({ data: null, loading: false, error: null }),
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
import { WorktreesCacheProvider } from '@/components/providers/WorktreesCacheProvider';

const WORKTREE_ID = 'wt-2498-screen';

/** Idle cadence of the detail poll (no CLI is reported as running below). */
const IDLE_POLL_MS = 5000;

/**
 * `STALE_BANNER_FAILURE_THRESHOLD` consecutive failures. Spelled as a duration
 * so the test reads the way the bug report does: "five seconds of no signal".
 */
const OUTAGE_MS = IDLE_POLL_MS * 3;

/** The heading `ErrorDisplay` renders — the full-screen card this Issue is about. */
const ERROR_CARD_HEADING = 'worktree.detail.errorLoading';

type Mode = 'ok' | 'offline' | 'login-redirect';
let mode: Mode = 'ok';

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

/** The /login page the middleware's 307 lands on — HTML, 200, `redirected`. */
function loginRedirectResponse(): Response {
  return {
    ok: true,
    status: 200,
    redirected: true,
    url: 'http://localhost/login',
    headers: new Headers({ 'content-type': 'text/html' }),
    json: () => Promise.reject(new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON")),
  } as unknown as Response;
}

const worktree = {
  id: WORKTREE_ID,
  name: 'feature/2498',
  path: '/tmp/wt',
  repositoryPath: '/tmp/repo',
  repositoryName: 'CommandMate',
  selectedAgents: ['claude'],
  agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }],
  sessionStatusByCli: {
    claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
  },
  sessionStatusByInstance: {
    claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
  },
};

function stubApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (mode === 'offline') {
        // What a phone with no signal actually produces.
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      if (url === '/api/worktrees') {
        return Promise.resolve(jsonResponse({ worktrees: [worktree], repositories: [] }));
      }
      if (typeof url === 'string' && url.includes('/current-output')) {
        return Promise.resolve(jsonResponse({
          isRunning: true, fullOutput: '', realtimeSnippet: '', thinking: false,
          sessionStatus: 'ready', isSelectionListActive: false, isPagerActive: false,
          isPromptWaiting: false, promptData: null,
        }));
      }
      if (typeof url === 'string' && url.includes('/messages')) {
        return Promise.resolve(jsonResponse([]));
      }
      if (typeof url === 'string' && url.includes('/auto-yes')) {
        return Promise.resolve(jsonResponse({ instances: {} }));
      }
      if (mode === 'login-redirect') {
        return Promise.resolve(loginRedirectResponse());
      }
      return Promise.resolve(jsonResponse(worktree));
    }),
  );
}

function mockPaneState(): void {
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
  useSplitMessagesMock.mockReturnValue({
    messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()),
  });
}

/** Advance timers AND drain the promise chain each fired timer starts. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderScreen() {
  return render(
    <WorktreesCacheProvider>
      <WorktreeDetailRefactored worktreeId={WORKTREE_ID} />
    </WorktreesCacheProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mode = 'ok';
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  mockPaneState();
  stubApi();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('[#2498] the phone screen survives an outage', () => {
  it('keeps the screen standing and only floats a reconnecting banner', async () => {
    renderScreen();
    await advance(0);
    expect(screen.getByTestId('mobile-worktree-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('worktree-detail-reconnecting-banner')).not.toBeInTheDocument();

    mode = 'offline';
    await advance(OUTAGE_MS);

    // The whole point: NOT replaced by the full-screen error card.
    expect(screen.queryByText(ERROR_CARD_HEADING)).not.toBeInTheDocument();
    expect(screen.getByTestId('mobile-worktree-shell')).toBeInTheDocument();
    expect(screen.getByTestId('worktree-detail-reconnecting-banner')).toBeInTheDocument();
  });

  it('does not lose the half-typed message', async () => {
    renderScreen();
    await advance(0);

    const composer = screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'この修正をレビューして' } });
    expect(composer.value).toBe('この修正をレビューして');

    mode = 'offline';
    await advance(OUTAGE_MS);

    // Same element, same draft: the tree was never unmounted.
    const afterOutage = screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;
    expect(afterOutage.value).toBe('この修正をレビューして');
  });

  it('drops the banner on its own when the signal returns', async () => {
    renderScreen();
    await advance(0);

    mode = 'offline';
    await advance(OUTAGE_MS);
    expect(screen.getByTestId('worktree-detail-reconnecting-banner')).toBeInTheDocument();

    // Nothing is pressed.
    mode = 'ok';
    await advance(IDLE_POLL_MS);

    expect(screen.queryByTestId('worktree-detail-reconnecting-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('mobile-worktree-shell')).toBeInTheDocument();
  });
});

describe('[#2498] an expired session offers a way back in', () => {
  it('shows the re-login notice instead of the HTML parse failure', async () => {
    mode = 'login-redirect';
    renderScreen();
    await advance(0);

    expect(screen.getByTestId('worktree-detail-session-expired')).toBeInTheDocument();
    expect(screen.getByTestId('worktree-detail-relogin')).toBeInTheDocument();
    // The message names the session, not a JSON parser.
    expect(screen.getByText('worktree.editor.sessionExpired')).toBeInTheDocument();
    expect(screen.queryByText(/Unexpected token/)).not.toBeInTheDocument();
    expect(screen.queryByText(ERROR_CARD_HEADING)).not.toBeInTheDocument();
  });
});

describe('[#2498] a failed first load is unchanged', () => {
  it('still shows the error card with its Retry button', async () => {
    mode = 'offline';
    renderScreen();
    await advance(0);

    // Nothing was ever rendered, so there is no screen worth keeping — the
    // pre-#2498 card is still the right answer here.
    expect(screen.getByText(ERROR_CARD_HEADING)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.retry' })).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-worktree-shell')).not.toBeInTheDocument();
  });
});
