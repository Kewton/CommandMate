/**
 * The tile's Auto-Yes toggle (Issue #2512, Epic #2508 Phase 4).
 *
 * Method b: the state rides `GET /api/worktrees` (`autoYesByInstance`), which
 * the page already polls, so a wall of tiles shows its toggles for free. Pinned
 * here:
 *
 *  - the toggle reads the SELECTED instance's entry from the row, and an expired
 *    arming reads as off;
 *  - **no tile asks the server for its Auto-Yes state** — the request count does
 *    not grow with the number of tiles (the acceptance criterion's "テストで
 *    固定する");
 *  - a toggle goes through the existing `POST /api/worktrees/:id/auto-yes` with
 *    the tile's `(cliToolId, instanceId)`, shows its result at once and re-reads
 *    the list once, whatever the number of tiles.
 *
 * `MessageInput` and `AutoYesToggle` are real (the toggle lives in the
 * composer's meta row); the two pollers and the chat body are stubbed.
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
import { SessionTileGrid } from '@/components/sessions/SessionTileGrid';

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

describe('SessionTile Auto-Yes — reading the list row (Issue #2512)', () => {
  it('shows the selected instance’s arming, with its countdown', () => {
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
    const composer = screen.getByTestId('session-tile-composer-wt-1');
    // `AutoYesToggle`'s own countdown, labelled through the (echoing) intl mock.
    expect(within(composer).getByLabelText('autoYes.timeRemaining').textContent).toMatch(
      /^(59:\d\d|1:00:00)$/,
    );
  });

  it('follows the instance selector — each instance has its own Auto-Yes', () => {
    render(
      <SessionTile
        worktree={createWorktree({
          autoYesByInstance: { 'codex-2': { enabled: true, expiresAt: Date.now() + HOUR_MS } },
        })}
        enabled
        connectivity={ONLINE}
      />,
    );
    expect(isOn()).toBe(false);

    fireEvent.change(screen.getByTestId('session-tile-instance-wt-1'), { target: { value: 'codex-2' } });

    expect(isOn()).toBe(true);
  });

  it('reads an arming whose countdown has already run out as off', () => {
    render(
      <SessionTile
        worktree={createWorktree({
          autoYesByInstance: { codex: { enabled: true, expiresAt: Date.now() - 1000 } },
        })}
        enabled
        connectivity={ONLINE}
      />,
    );

    expect(isOn()).toBe(false);
  });

  it('reads a row without the field (an older server) as off', () => {
    render(
      <SessionTile
        worktree={createWorktree({ autoYesByInstance: undefined })}
        enabled
        connectivity={ONLINE}
      />,
    );

    expect(isOn()).toBe(false);
  });
});

describe('SessionTile Auto-Yes — toggling (Issue #2512)', () => {
  it('turns it off through the existing route for THIS instance, shows OFF at once and re-reads the list once', async () => {
    const armed = createWorktree({
      autoYesByInstance: { 'codex-2': { enabled: true, expiresAt: Date.now() + HOUR_MS } },
    });
    render(<SessionTile worktree={armed} enabled connectivity={ONLINE} />);
    fireEvent.change(screen.getByTestId('session-tile-instance-wt-1'), { target: { value: 'codex-2' } });
    expect(isOn()).toBe(true);

    await act(async () => {
      fireEvent.click(autoYesSwitch());
    });

    expect(fetchCalls()).toEqual([
      {
        url: '/api/worktrees/wt-1/auto-yes',
        method: 'POST',
        body: { enabled: false, cliToolId: 'codex', instanceId: 'codex-2' },
      },
    ]);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    // The row still says ON — it is the route's answer that is on screen.
    expect(armed.autoYesByInstance?.['codex-2']?.enabled).toBe(true);
    expect(isOn()).toBe(false);
  });

  it('turns it on through the confirm dialog and shows the new countdown at once', async () => {
    const expiresAt = Date.now() + 3 * HOUR_MS;
    answerAutoYes(expiresAt);
    render(<SessionTile worktree={createWorktree()} enabled connectivity={ONLINE} />);
    expect(isOn()).toBe(false);

    fireEvent.click(autoYesSwitch());
    const confirm = await screen.findByTestId('confirm-button');
    await act(async () => {
      fireEvent.click(confirm);
    });

    await waitFor(() => expect(isOn()).toBe(true));
    const [call] = fetchCalls();
    expect(call.url).toBe('/api/worktrees/wt-1/auto-yes');
    expect(call.method).toBe('POST');
    expect(call.body).toMatchObject({ enabled: true, cliToolId: 'codex', instanceId: 'codex' });
    expect(typeof call.body?.duration).toBe('number');
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  it('changes nothing when the route refuses', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({ error: 'nope' }) })) as unknown as typeof fetch;
    render(
      <SessionTile
        worktree={createWorktree({
          autoYesByInstance: { codex: { enabled: true, expiresAt: Date.now() + HOUR_MS } },
        })}
        enabled
        connectivity={ONLINE}
      />,
    );

    await act(async () => {
      fireEvent.click(autoYesSwitch());
    });

    expect(isOn()).toBe(true);
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  it('holds the answer until the refresh has landed, then lets the refreshed row decide', async () => {
    // A stop pattern that matched within the same second: the list comes back
    // OFF although this tile just turned it ON.
    let resolveRefresh: () => void = () => {};
    cache.refresh.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    answerAutoYes(Date.now() + HOUR_MS);
    const before = createWorktree();
    const { rerender } = render(<SessionTile worktree={before} enabled connectivity={ONLINE} />);

    fireEvent.click(autoYesSwitch());
    await act(async () => {
      fireEvent.click(await screen.findByTestId('confirm-button'));
    });
    await waitFor(() => expect(isOn()).toBe(true));

    // A poll that left before the POST lands first: still OFF, and still held.
    const stalePoll = createWorktree();
    rerender(<SessionTile worktree={stalePoll} enabled connectivity={ONLINE} />);
    expect(isOn()).toBe(true);

    // The refresh this toggle asked for resolves, and its row renders.
    await act(async () => {
      resolveRefresh();
    });
    const refreshed = createWorktree();
    rerender(<SessionTile worktree={refreshed} enabled connectivity={ONLINE} />);

    expect(isOn()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The wall: request count does not scale with tiles
// ---------------------------------------------------------------------------

type IOCallback = (entries: IntersectionObserverEntry[]) => void;

describe('SessionTileGrid Auto-Yes cost (Issue #2512)', () => {
  let observers: Array<{ callback: IOCallback; nodes: Element[] }> = [];
  let original: unknown;

  class MockIntersectionObserver {
    private entry: { callback: IOCallback; nodes: Element[] };
    constructor(callback: IOCallback) {
      this.entry = { callback, nodes: [] };
      observers.push(this.entry);
    }
    observe = (node: Element) => {
      this.entry.nodes.push(node);
    };
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = vi.fn(() => []);
    root = null;
    rootMargin = '';
    thresholds = [];
  }

  function showAll(): void {
    act(() => {
      for (const observer of observers) {
        observer.callback(
          observer.nodes.map((target) => ({ target, isIntersecting: true })) as unknown as IntersectionObserverEntry[],
        );
      }
    });
  }

  /** A wall of `count` armed tiles, all on screen. */
  function renderWall(count: number): Worktree[] {
    const worktrees = Array.from({ length: count }, (_, index) =>
      createWorktree({
        id: `wt-${index}`,
        autoYesByInstance: { codex: { enabled: true, expiresAt: Date.now() + HOUR_MS } },
      }),
    );
    render(<SessionTileGrid worktrees={worktrees} />);
    showAll();
    return worktrees;
  }

  /** Every request the wall has made that is about Auto-Yes. */
  function autoYesRequests(): FetchCall[] {
    return fetchCalls().filter((call) => call.url.includes('/auto-yes'));
  }

  beforeEach(() => {
    observers = [];
    original = (globalThis as Record<string, unknown>).IntersectionObserver;
    (globalThis as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver;
    (window as unknown as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).IntersectionObserver = original;
    (window as unknown as Record<string, unknown>).IntersectionObserver = original;
  });

  it.each([1, 8, 20])('%i armed tiles on screen show their state with zero Auto-Yes requests', async (count) => {
    renderWall(count);

    // Give any mount-time or effect-time request its chance to be made.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(screen.getAllByRole('switch')).toHaveLength(count);
    for (let index = 0; index < count; index += 1) {
      expect(isOn(`wt-${index}`)).toBe(true);
    }
    expect(autoYesRequests()).toEqual([]);
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  it.each([1, 8])('toggling one of %i tiles costs one POST and one list re-read', async (count) => {
    renderWall(count);

    await act(async () => {
      fireEvent.click(autoYesSwitch('wt-0'));
    });

    expect(autoYesRequests()).toEqual([
      {
        url: '/api/worktrees/wt-0/auto-yes',
        method: 'POST',
        body: { enabled: false, cliToolId: 'codex', instanceId: 'codex' },
      },
    ]);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    expect(isOn('wt-0')).toBe(false);
    if (count > 1) expect(isOn('wt-1')).toBe(true);
  });
});
