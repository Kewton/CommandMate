/**
 * A Sessions tile shows the Auto-Yes answer mode beside its toggle, as the
 * worktree screen does (Issue #3863).
 *
 * The mode comes from the list row's `autoYesAnswerModeByInstance` (so a
 * reload or another tab's change shows on the next list read) and from the
 * route's answer to the tile's own toggle (shown at once). A row that names no
 * mode (an older server) shows none. Same harness as
 * `session-tile-auto-yes-2512`: the toggle and composer are real.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within, cleanup } from '@testing-library/react';
import type { Worktree } from '@/types/models';
import type { PendingConnectivity } from '@/hooks/usePendingMessages';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: () => ({
    terminal: {
      output: '', realtimeSnippet: '', isRunning: true, isThinking: false, sessionStatus: 'ready',
      isSelectionListActive: false, isPagerActive: false, isDismissablePanelActive: false,
      isUnclassifiedActive: false, composerText: '', attaching: false, autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()) }),
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false, error: null,
    filter: '', setFilter: vi.fn(), refresh: vi.fn(), isCatalogStale: false,
  }),
}));

vi.mock('@/components/worktree/ChatSurface', () => ({
  ChatSurface: ({ worktreeId }: { worktreeId: string }) =>
    React.createElement('div', { 'data-testid': `chat-surface-${worktreeId}` }),
}));

/** The page's list cache: only `refresh` is read by a tile. */
const cache = vi.hoisted(() => ({ refresh: vi.fn(() => Promise.resolve()) }));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => cache,
}));

import { SessionTile } from '@/components/sessions/SessionTile';

const ONLINE: PendingConnectivity = { offline: false, reachable: true };
const HOUR_MS = 60 * 60 * 1000;

function createWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/test',
    branch: 'feature/2512',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    agentInstances: [
      { id: 'codex', cliTool: 'codex', alias: '', order: 0 },
      { id: 'codex-2', cliTool: 'codex', alias: 'レビュー担当', order: 1 },
    ],
    autoYesByInstance: {},
    ...overrides,
  } as Worktree;
}

/** The tile's Auto-Yes switch. */
function autoYesSwitch(worktreeId = 'wt-1'): HTMLElement {
  return within(screen.getByTestId(`session-tile-composer-${worktreeId}`)).getByRole('switch');
}

function isOn(worktreeId = 'wt-1'): boolean {
  return autoYesSwitch(worktreeId).getAttribute('aria-checked') === 'true';
}

type FetchCall = { url: string; method: string; body: Record<string, unknown> | null };

function fetchCalls(): FetchCall[] {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([input, init]) => ({
    url: String(input),
    method: (init as RequestInit | undefined)?.method ?? 'GET',
    body: (init as RequestInit | undefined)?.body
      ? (JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
      : null,
  }));
}

/** Answer `POST /auto-yes` with what the route stores. */
function answerAutoYes(expiresAt: number | null = null) {
  global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return {
      ok: true,
      json: async () => ({
        enabled: body.enabled === true,
        expiresAt: body.enabled === true ? expiresAt : null,
        pollingStarted: body.enabled === true,
        ...(body.enabled === true ? { answerMode: body.answerMode ?? 'recommended' } : {}),
      }),
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  window.localStorage.clear();
  cache.refresh.mockReset();
  cache.refresh.mockImplementation(() => Promise.resolve());
  answerAutoYes(Date.now() + HOUR_MS);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function modeLabel(worktreeId = 'wt-1'): HTMLElement | null {
  return within(screen.getByTestId(`session-tile-composer-${worktreeId}`)).queryByTestId('auto-yes-answer-mode');
}

describe('[#3863] SessionTile Auto-Yes answer mode', () => {
  it('labels the toggle with the mode the list row names, per instance', () => {
    render(
      <SessionTile
        worktree={createWorktree({
          autoYesByInstance: {
            codex: { enabled: true, expiresAt: Date.now() + HOUR_MS },
            'codex-2': { enabled: true, expiresAt: Date.now() + HOUR_MS },
          },
          autoYesAnswerModeByInstance: { codex: 'careful', 'codex-2': 'recommended' },
        })}
        enabled
        connectivity={ONLINE}
      />,
    );

    expect(modeLabel()?.getAttribute('data-answer-mode')).toBe('careful');
    fireEvent.change(screen.getByTestId('session-tile-instance-wt-1'), { target: { value: 'codex-2' } });
    expect(modeLabel()?.getAttribute('data-answer-mode')).toBe('recommended');
  });

  it('follows a later list read (another tab changed the mode)', () => {
    const on = { codex: { enabled: true, expiresAt: Date.now() + HOUR_MS } };
    const { rerender } = render(
      <SessionTile
        worktree={createWorktree({ autoYesByInstance: on, autoYesAnswerModeByInstance: { codex: 'careful' } })}
        enabled
        connectivity={ONLINE}
      />,
    );
    expect(modeLabel()?.getAttribute('data-answer-mode')).toBe('careful');

    rerender(
      <SessionTile
        worktree={createWorktree({ autoYesByInstance: on, autoYesAnswerModeByInstance: { codex: 'recommended' } })}
        enabled
        connectivity={ONLINE}
      />,
    );
    expect(modeLabel()?.getAttribute('data-answer-mode')).toBe('recommended');
  });

  it('shows no label for a row that names no mode (an older server)', () => {
    render(
      <SessionTile
        worktree={createWorktree({
          autoYesByInstance: { codex: { enabled: true, expiresAt: Date.now() + HOUR_MS } },
        })}
        enabled
        connectivity={ONLINE}
      />,
    );

    expect(isOn()).toBe(true);
    expect(modeLabel()).toBeNull();
  });

  it('turning it on in 慎重 posts careful and labels the toggle at once', async () => {
    render(<SessionTile worktree={createWorktree()} enabled connectivity={ONLINE} />);
    expect(modeLabel()).toBeNull();

    fireEvent.click(autoYesSwitch());
    fireEvent.click(screen.getByTestId('auto-yes-answer-mode-careful'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-button'));
    });

    await waitFor(() => expect(isOn()).toBe(true));
    const post = fetchCalls().find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({ enabled: true, cliToolId: 'codex', instanceId: 'codex', answerMode: 'careful' });
    expect(modeLabel()?.getAttribute('data-answer-mode')).toBe('careful');
  });

  it('turning it on in おまかせ names recommended in the POST', async () => {
    render(<SessionTile worktree={createWorktree()} enabled connectivity={ONLINE} />);

    fireEvent.click(autoYesSwitch());
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-button'));
    });

    await waitFor(() => expect(isOn()).toBe(true));
    const post = fetchCalls().find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({ enabled: true, answerMode: 'recommended' });
    expect(modeLabel()?.getAttribute('data-answer-mode')).toBe('recommended');
  });
});
