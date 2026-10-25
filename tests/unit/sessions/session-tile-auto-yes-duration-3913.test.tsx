/**
 * Turning Auto-Yes on for 5h / 24h from a Sessions tile (Issue #3913).
 *
 * "その他" → 5h / 24h on the tile's selected instance posts that many ms for
 * that instance, the remaining time comes from the POST's `expiresAt`, and the
 * other instance on the tile stays as it was. Same harness as
 * `session-tile-auto-yes-answer-mode-3863`: the toggle and composer are real.
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

/** Answer `POST /auto-yes` with what the route stores: expiresAt = now + duration. */
function answerAutoYes() {
  global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return {
      ok: true,
      json: async () => ({
        enabled: body.enabled === true,
        expiresAt: body.enabled === true ? Date.now() + Number(body.duration ?? HOUR_MS) : null,
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
  answerAutoYes();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function chooseOther(hours: number): void {
  fireEvent.click(screen.getByTestId('auto-yes-duration-other'));
  fireEvent.change(screen.getByTestId('auto-yes-duration-select'), { target: { value: String(hours * HOUR_MS) } });
}

function remaining(worktreeId = 'wt-1'): string | null {
  return within(screen.getByTestId(`session-tile-composer-${worktreeId}`)).queryByLabelText('autoYes.timeRemaining')?.textContent ?? null;
}

describe('[#3913] SessionTile Auto-Yes duration', () => {
  it.each([5, 24])('"その他" → %ih on codex-2 posts that many ms for codex-2 only', async (hours) => {
    render(<SessionTile worktree={createWorktree()} enabled connectivity={ONLINE} />);
    fireEvent.change(screen.getByTestId('session-tile-instance-wt-1'), { target: { value: 'codex-2' } });

    fireEvent.click(autoYesSwitch());
    chooseOther(hours);
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-button'));
    });

    await waitFor(() => expect(isOn()).toBe(true));
    const enables = fetchCalls().filter((c) => c.method === 'POST' && c.body?.enabled === true);
    expect(enables).toHaveLength(1);
    expect(enables[0].body).toMatchObject({ enabled: true, cliToolId: 'codex', instanceId: 'codex-2', duration: hours * HOUR_MS });
    expect(remaining()).toMatch(new RegExp(`^(${hours}:00:00|${hours - 1}:59:[0-5]\\d)$`));

    // The other instance is untouched.
    fireEvent.change(screen.getByTestId('session-tile-instance-wt-1'), { target: { value: 'codex' } });
    expect(isOn()).toBe(false);
    expect(remaining()).toBeNull();
  });

  it('cancelling after choosing 24h and reopening posts 1h (negative control: the default)', async () => {
    render(<SessionTile worktree={createWorktree()} enabled connectivity={ONLINE} />);

    fireEvent.click(autoYesSwitch());
    chooseOther(24);
    fireEvent.click(screen.getByText('common.cancel'));
    fireEvent.click(autoYesSwitch());
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-button'));
    });

    await waitFor(() => expect(isOn()).toBe(true));
    const post = fetchCalls().find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({ enabled: true, instanceId: 'codex', duration: HOUR_MS });
  });
});
