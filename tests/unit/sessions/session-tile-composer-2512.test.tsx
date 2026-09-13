/**
 * The tile's composer (Issue #2512, Epic #2508 Phase 4).
 *
 * A tile can now send free text without opening the worktree screen, through
 * the worktree screen's own optimistic layer (`usePendingMessages`, #1121).
 * Pinned here, at the tile:
 *
 *  - a send shows its bubble at once, and goes out as the worktree screen's
 *    request (`worktreeApi.sendMessage` with this tile's instance) — which is
 *    what makes it land in the history the worktree screen reads;
 *  - a failed send can be retried and discarded, and a discard gives the text
 *    back to the composer;
 *  - identical consecutive sends each consume one server echo — never two
 *    bubbles for one message, never one bubble for two;
 *  - connectivity is wired (#2503 / #2535): an offline send is parked, not
 *    failed, and resent once when the server answers;
 *  - the wall reads ONE connection verdict, not one per tile;
 *  - the composer takes its height out of the body without crushing it.
 *
 * `MessageInput` is real — the textarea and the send button are the surface
 * under test. The two network hooks are stubbed with a reactive transcript, so
 * a server echo can be delivered the way `useSplitMessages` delivers one.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within, cleanup } from '@testing-library/react';
import type { ChatMessage, Worktree } from '@/types/models';
import type { ConnectivityState } from '@/hooks/useConnectivity';
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

// ---------------------------------------------------------------------------
// The transcript: a tiny store, so an echo re-renders the tile like a poll does
// ---------------------------------------------------------------------------

const transcript = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    rows: [] as ChatMessage[],
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: ChatMessage[]) {
      this.rows = next;
      listeners.forEach((listener) => listener());
    },
  };
});

const { refreshMessagesMock, refreshPaneMock, sendMessageMock, useSplitMessagesMock } = vi.hoisted(() => ({
  refreshMessagesMock: vi.fn(() => Promise.resolve()),
  refreshPaneMock: vi.fn(() => Promise.resolve()),
  sendMessageMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
}));

vi.mock('@/hooks/useSplitMessages', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useSplitMessages: (options: unknown) => {
      useSplitMessagesMock(options);
      const messages = useSyncExternalStore(
        (listener: () => void) => transcript.subscribe(listener),
        () => transcript.rows,
        () => transcript.rows,
      );
      return { messages, isLoading: false, refresh: refreshMessagesMock };
    },
  };
});

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
    refresh: refreshPaneMock,
  }),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return { ...actual, worktreeApi: { ...actual.worktreeApi, sendMessage: sendMessageMock } };
});

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false, error: null,
    filter: '', setFilter: vi.fn(), refresh: vi.fn(), isCatalogStale: false,
  }),
}));

/** What the tile last handed its chat surface: the rows and the pending callbacks. */
const chatSurface = vi.hoisted(() => ({
  latest: null as null | {
    messages: ChatMessage[];
    history?: {
      onRetryPending?: (tempId: string) => void;
      onDiscardPending?: (tempId: string) => void;
    };
  },
}));

vi.mock('@/components/worktree/ChatSurface', () => ({
  ChatSurface: (props: { worktreeId: string; messages: ChatMessage[] }) => {
    chatSurface.latest = props;
    return React.createElement(
      'div',
      { 'data-testid': `chat-surface-${props.worktreeId}` },
      props.messages.map((m) =>
        React.createElement('div', {
          key: m.id,
          'data-testid': 'row',
          'data-content': m.content,
          'data-optimistic': m.optimisticState ?? '',
        }),
      ),
    );
  },
}));

// Connectivity is mocked only for the grid, where the tile never reads its own.
const useConnectivityMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useConnectivity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useConnectivity')>();
  return { ...actual, useConnectivity: (...args: unknown[]) => useConnectivityMock(...args) };
});

import {
  SessionTile,
  SESSION_TILE_BODY_FLOOR_CLASS,
  SESSION_TILE_HISTORY_ROW_CLASS,
  SESSION_TILE_TERMINAL_ROW_CLASS,
  messagesForTileInstance,
} from '@/components/sessions/SessionTile';
import { SessionTileGrid, SESSION_TILE_HEIGHT_CLASS } from '@/components/sessions/SessionTileGrid';

const ONLINE: PendingConnectivity = { offline: false, reachable: true };
const OFFLINE: PendingConnectivity = { offline: true, reachable: false };

function createWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/test',
    branch: 'feature/2512',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    selectedAgents: ['claude'],
    ...overrides,
  } as Worktree;
}

function serverUserRow(id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    worktreeId: 'wt-1',
    role: 'user',
    content,
    timestamp: new Date(Date.now() + 1000),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    ...extra,
  } as ChatMessage;
}

function rows(): { content: string | null; optimistic: string | null }[] {
  return screen.queryAllByTestId('row').map((row) => ({
    content: row.getAttribute('data-content'),
    optimistic: row.getAttribute('data-optimistic'),
  }));
}

function send(text: string, worktreeId = 'wt-1'): void {
  const composer = screen.getByTestId(`session-tile-composer-${worktreeId}`);
  const textarea = within(composer).getByTestId('message-input-textarea');
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.click(within(composer).getByTestId('send-message-button'));
}

/** The pending layer's recovery pass waits a settle window before deciding. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  transcript.rows = [];
  chatSurface.latest = null;
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue({ id: 'srv' });
  refreshMessagesMock.mockClear();
  refreshPaneMock.mockClear();
  useSplitMessagesMock.mockClear();
  useConnectivityMock.mockReset();
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('SessionTile composer (Issue #2512)', () => {
  it('sends free text from the tile and shows the optimistic bubble at once', () => {
    // Never resolves: the bubble must not be waiting on the API.
    sendMessageMock.mockReturnValue(new Promise(() => {}));
    render(<SessionTile worktree={createWorktree()} enabled connectivity={ONLINE} />);

    send('continue');

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith('wt-1', 'continue', { cliToolId: 'claude' });
    expect(rows()).toEqual([{ content: 'continue', optimistic: 'sending' }]);
    // The composer cleared itself rather than waiting for the send.
    const composer = screen.getByTestId('session-tile-composer-wt-1');
    expect((within(composer).getByTestId('message-input-textarea') as HTMLTextAreaElement).value).toBe('');
  });

  it('sends to the selected instance — the request the worktree screen makes — and reconciles its echo', async () => {
    render(
      <SessionTile
        worktree={createWorktree({
          agentInstances: [
            { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
            { id: 'claude-2', cliTool: 'claude', alias: '実装担当', order: 1 },
          ],
        })}
        enabled
        connectivity={ONLINE}
      />,
    );
    fireEvent.change(screen.getByTestId('session-tile-instance-wt-1'), {
      target: { value: 'claude-2' },
    });

    send('yes');

    await waitFor(() => expect(refreshMessagesMock).toHaveBeenCalled());
    expect(sendMessageMock).toHaveBeenCalledWith('wt-1', 'yes', {
      cliToolId: 'claude',
      instanceId: 'claude-2',
    });
    // The history the tile polls is that instance's — the same scope the
    // worktree screen's split reads for `claude-2`.
    expect(useSplitMessagesMock.mock.calls.at(-1)?.[0]).toMatchObject({
      worktreeId: 'wt-1',
      cliToolId: 'claude',
      instanceId: 'claude-2',
    });
    expect(rows()).toEqual([{ content: 'yes', optimistic: 'sending' }]);

    // The echo `/send` wrote arrives through the history poll.
    act(() => transcript.set([serverUserRow('srv-1', 'yes', { instanceId: 'claude-2' })]));

    expect(rows()).toEqual([{ content: 'yes', optimistic: '' }]);
  });

  it('keeps a bubble on the instance it was sent to when the tile is switched', () => {
    sendMessageMock.mockReturnValue(new Promise(() => {}));
    render(
      <SessionTile
        worktree={createWorktree({ selectedAgents: ['claude', 'codex'] })}
        enabled
        connectivity={ONLINE}
      />,
    );

    send('for claude');
    expect(rows()).toHaveLength(1);

    fireEvent.change(screen.getByTestId('session-tile-instance-wt-1'), { target: { value: 'codex' } });
    expect(rows()).toEqual([]);

    fireEvent.change(screen.getByTestId('session-tile-instance-wt-1'), { target: { value: 'claude' } });
    expect(rows()).toEqual([{ content: 'for claude', optimistic: 'sending' }]);
  });

  it('lets a failed send be retried, and discarded back into the composer', async () => {
    sendMessageMock.mockRejectedValue(new Error('500'));
    render(<SessionTile worktree={createWorktree()} enabled connectivity={ONLINE} />);

    send('run the tests');
    await waitFor(() => expect(rows()).toEqual([{ content: 'run the tests', optimistic: 'error' }]));

    const tempId = chatSurface.latest?.messages[0]?.id as string;
    act(() => chatSurface.latest?.history?.onRetryPending?.(tempId));
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(rows()).toEqual([{ content: 'run the tests', optimistic: 'error' }]));

    act(() => chatSurface.latest?.history?.onDiscardPending?.(tempId));

    expect(rows()).toEqual([]);
    const composer = screen.getByTestId('session-tile-composer-wt-1');
    await waitFor(() =>
      expect((within(composer).getByTestId('message-input-textarea') as HTMLTextAreaElement).value).toBe(
        'run the tests',
      ),
    );
  });

  it('never registers identical consecutive sends twice — each consumes exactly one echo', async () => {
    // An older identical message is already in the transcript; it must not
    // confirm either of the new ones.
    transcript.rows = [serverUserRow('old', 'yes', { timestamp: new Date(Date.now() - 60_000) })];
    render(<SessionTile worktree={createWorktree()} enabled connectivity={ONLINE} />);

    send('yes');
    send('yes');
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
    expect(rows().filter((row) => row.optimistic === 'sending')).toHaveLength(2);

    // The first echo lands: one bubble is confirmed, the other keeps waiting.
    act(() => transcript.set([...transcript.rows, serverUserRow('srv-1', 'yes')]));
    expect(rows()).toEqual([
      { content: 'yes', optimistic: '' },
      { content: 'yes', optimistic: '' },
      { content: 'yes', optimistic: 'sending' },
    ]);

    // The second lands: three rows for three messages, none of them doubled.
    act(() => transcript.set([...transcript.rows, serverUserRow('srv-2', 'yes')]));
    expect(rows()).toEqual([
      { content: 'yes', optimistic: '' },
      { content: 'yes', optimistic: '' },
      { content: 'yes', optimistic: '' },
    ]);
  });

  it('parks a send made while offline instead of failing it, and resends it once when the server answers', async () => {
    sendMessageMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { rerender } = render(
      <SessionTile worktree={createWorktree()} enabled connectivity={OFFLINE} />,
    );

    send('when we are back');
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    await settle();
    // Waiting for the network — not the 「送信に失敗しました」 of #2503's bug.
    expect(rows()).toEqual([{ content: 'when we are back', optimistic: 'sending' }]);

    sendMessageMock.mockResolvedValue({ id: 'srv-1' });
    rerender(<SessionTile worktree={createWorktree()} enabled connectivity={ONLINE} />);
    await settle();

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
    expect(sendMessageMock).toHaveBeenLastCalledWith('wt-1', 'when we are back', { cliToolId: 'claude' });
  });

  it('fails the old way when the verdict says the server is there (control)', async () => {
    sendMessageMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<SessionTile worktree={createWorktree()} enabled connectivity={ONLINE} />);

    send('when we are back');

    await waitFor(() => expect(rows()).toEqual([{ content: 'when we are back', optimistic: 'error' }]));
  });

  it('is mounted only while the tile is on screen', () => {
    const { rerender } = render(
      <SessionTile worktree={createWorktree()} enabled={false} connectivity={ONLINE} />,
    );
    expect(screen.queryByTestId('session-tile-composer-wt-1')).toBeNull();
    expect(screen.queryByTestId('message-input-textarea')).toBeNull();

    rerender(<SessionTile worktree={createWorktree()} enabled connectivity={ONLINE} />);
    expect(screen.getByTestId('session-tile-composer-wt-1')).toBeDefined();
  });

  it('stays under the terminal surface too, and a send from there still reconciles', async () => {
    window.localStorage.setItem('commandmate.sessions.tileHistoryVisible', 'false');
    render(<SessionTile worktree={createWorktree()} enabled connectivity={ONLINE} />);
    fireEvent.click(screen.getByTestId('session-tile-surface-terminal-wt-1'));

    // History closed: nothing on screen reads `/messages`, so it is not polled…
    expect(useSplitMessagesMock.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false });
    expect(screen.getByTestId('session-tile-composer-wt-1')).toBeDefined();

    send('on the terminal');
    // …but the send's own refetch still runs, which is what confirms the echo.
    await waitFor(() => expect(refreshMessagesMock).toHaveBeenCalledTimes(1));
    expect(refreshPaneMock).toHaveBeenCalled();
  });

  describe('height', () => {
    const rem = (cls: string, prefix: string) =>
      Number(new RegExp(`${prefix}\\[(\\d+(?:\\.\\d+)?)rem\\]`).exec(cls)?.[1]);

    it('puts the composer under the body, fixed, with the body carrying the floor', () => {
      render(<SessionTile worktree={createWorktree()} enabled connectivity={ONLINE} />);

      const body = screen.getByTestId('session-tile-body-wt-1');
      const composer = screen.getByTestId('session-tile-composer-wt-1');
      expect(body.nextElementSibling).toBe(composer);
      expect(composer.className).toContain('shrink-0');
      expect(body.className).toContain(SESSION_TILE_BODY_FLOOR_CLASS);
      expect(body.className).toContain('flex-1');
      expect(body.className).toContain('overflow-hidden');
    });

    it('leaves the body its floor even with the composer at its tallest', () => {
      // From the classes: a 55px header (Phase 2's measurement) and `MessageInput`
      // on a phone with its textarea at the 160px cap — two input rows, the
      // Auto-Yes row and the form chrome, plus the tile's own border and padding.
      const HEADER_PX = 55;
      const TALLEST_COMPOSER_PX = 261;
      const tilePx = rem(SESSION_TILE_HEIGHT_CLASS, 'h-') * 16;
      const floorPx = rem(SESSION_TILE_BODY_FLOOR_CLASS, 'min-h-') * 16;

      expect(tilePx - HEADER_PX - TALLEST_COMPOSER_PX).toBeGreaterThanOrEqual(floorPx);
      // …and the terminal + History floors from #2510 fit inside that floor.
      expect(
        rem(SESSION_TILE_TERMINAL_ROW_CLASS, 'min-h-') + rem(SESSION_TILE_HISTORY_ROW_CLASS, 'min-h-'),
      ).toBeLessThanOrEqual(rem(SESSION_TILE_BODY_FLOOR_CLASS, 'min-h-'));
    });

    it('keeps the tile inside the 480–560px window #2509 set', () => {
      const tilePx = rem(SESSION_TILE_HEIGHT_CLASS, 'h-') * 16;
      expect(tilePx).toBeGreaterThanOrEqual(480);
      expect(tilePx).toBeLessThanOrEqual(560);
    });
  });
});

describe('messagesForTileInstance (Issue #2512)', () => {
  const pending = (id: string, extra: Partial<ChatMessage>): ChatMessage =>
    ({ ...serverUserRow(id, id), optimisticState: 'sending', ...extra }) as ChatMessage;

  it('keeps server rows and this instance’s bubbles, and holds back another instance’s', () => {
    const server = serverUserRow('srv', 'server row', { instanceId: 'claude-2' });
    const primary = pending('primary', { cliToolId: 'claude', instanceId: undefined });
    const alias = pending('alias', { cliToolId: 'claude', instanceId: 'claude-2' });

    expect(messagesForTileInstance([server, primary, alias], 'claude')).toEqual([server, primary]);
    expect(messagesForTileInstance([server, primary, alias], 'claude-2')).toEqual([server, alias]);
  });

  it('returns the same array when there is nothing to hold back', () => {
    const list = [serverUserRow('srv', 'row'), pending('p', { cliToolId: 'claude' })];
    expect(messagesForTileInstance(list, 'claude')).toBe(list);
  });
});

// ---------------------------------------------------------------------------
// The grid: one verdict for the wall
// ---------------------------------------------------------------------------

type IOCallback = (entries: IntersectionObserverEntry[]) => void;

describe('SessionTileGrid connectivity (Issue #2512)', () => {
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

  function offlineState(): ConnectivityState {
    return {
      status: 'offline',
      isOnline: false,
      isReconnecting: false,
      isOffline: true,
      shouldSurface: true,
      signals: { browserOnline: false, realtimeStatus: 'disconnected', serverReachable: null },
      lastReachableAt: null,
      recheck: vi.fn(),
    };
  }

  beforeEach(() => {
    observers = [];
    original = (globalThis as Record<string, unknown>).IntersectionObserver;
    (globalThis as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver;
    (window as unknown as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver;
    const state = offlineState();
    useConnectivityMock.mockReturnValue(state);
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).IntersectionObserver = original;
    (window as unknown as Record<string, unknown>).IntersectionObserver = original;
  });

  it('reads the verdict once for the wall — waking tiles never read their own', () => {
    const worktrees = ['wt-a', 'wt-b', 'wt-c', 'wt-d', 'wt-e', 'wt-f'].map((id) => createWorktree({ id }));
    render(<SessionTileGrid worktrees={worktrees} />);
    const readsBeforeWaking = useConnectivityMock.mock.calls.length;
    expect(readsBeforeWaking).toBeGreaterThan(0);

    showAll();

    // Six tiles re-rendered with composers; the grid did not.
    expect(screen.getAllByTestId('message-input-textarea')).toHaveLength(6);
    expect(useConnectivityMock.mock.calls.length).toBe(readsBeforeWaking);
  });

  it('hands that verdict to every tile, so a tile in the wall parks an offline send', async () => {
    sendMessageMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<SessionTileGrid worktrees={[createWorktree({ id: 'wt-a' }), createWorktree({ id: 'wt-b' })]} />);
    showAll();

    send('parked', 'wt-b');
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    await settle();

    const tile = screen.getByTestId('session-tile-wt-b');
    const bubble = within(tile).getByTestId('row');
    expect(bubble.getAttribute('data-optimistic')).toBe('sending');
  });

  it('a tile mounted outside the grid reads its own verdict rather than going unwired', async () => {
    sendMessageMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<SessionTile worktree={createWorktree()} enabled />);
    expect(useConnectivityMock).toHaveBeenCalled();

    send('parked');
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    await settle();

    expect(rows()).toEqual([{ content: 'parked', optimistic: 'sending' }]);
  });
});
