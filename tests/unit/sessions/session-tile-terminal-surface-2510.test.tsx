/**
 * SessionTile's terminal surface (Issue #2510, Epic #2508 Phase 2).
 *
 * What a tile does once it is switched to its terminal, held at the markup the
 * acceptance criteria name:
 *
 *  - the frame keeps its columns and scrolls sideways INSIDE the tile, at the
 *    compact density — asserted on the real `TerminalDisplay`, because a stub
 *    could be handed `wrapMode="frame"` and still render a pane that wraps;
 *  - History is stacked under the terminal, shown by default, and both rows
 *    keep a floor;
 *  - the History toggle is the tile's own — it never reads or writes the
 *    worktree screen's key;
 *  - the Phase 1 tile is still what an unswitched tile renders.
 *
 * The network hooks are stubbed (the real ones are pinned against HTTP by
 * `session-tile-viewport-2509`). `ChatSurface` and `HistoryPane` are stubbed to
 * record their props; `TerminalDisplay` is real.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within, cleanup } from '@testing-library/react';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: pushMock }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

const useTerminalPanePollingMock = vi.hoisted(() => vi.fn());
const useSplitMessagesMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
}));

/** The latest `onSurfaceModeChange` each stubbed chat surface was handed. */
const chatSurfaceProps = vi.hoisted(() => ({
  latest: null as null | { onSurfaceModeChange: (mode: 'terminal' | 'chat') => void },
}));

vi.mock('@/components/worktree/ChatSurface', () => ({
  ChatSurface: (props: { worktreeId: string; onSurfaceModeChange: (mode: 'terminal' | 'chat') => void }) => {
    chatSurfaceProps.latest = props;
    return React.createElement('div', { 'data-testid': `chat-surface-${props.worktreeId}` });
  },
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: (props: {
    worktreeId: string;
    messages: unknown[];
    onCollapse?: () => void;
    cliToolId?: string;
    isLoading?: boolean;
  }) =>
    React.createElement('div', {
      'data-testid': `history-pane-${props.worktreeId}`,
      'data-message-count': String(props.messages.length),
      'data-has-collapse': props.onCollapse ? 'true' : 'false',
      'data-cli-tool-id': props.cliToolId,
      'data-loading': props.isLoading ? 'true' : 'false',
    }),
}));

import {
  SessionTile,
  SESSION_TILE_HISTORY_ROW_CLASS,
  SESSION_TILE_TERMINAL_ROW_CLASS,
  sessionTileHistoryRegionId,
} from '@/components/sessions/SessionTile';
import type { Worktree } from '@/types/models';

const WORKTREE_HISTORY_KEY = 'commandmate.worktree.historyVisible';
const TILE_HISTORY_KEY = 'commandmate.sessions.tileHistoryVisible';
const surfaceKey = (id: string) => `commandmate.sessions.tileSurfaceMode-${id}`;

/** A 200-column frame whose rules span the pane, like claude's input box. */
const WIDE_FRAME = ['─'.repeat(200), '> hello', '─'.repeat(200), '  ? for shortcuts'].join('\n');

function createWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/test',
    branch: 'feature/2510',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    selectedAgents: ['claude'],
    ...overrides,
  } as Worktree;
}

function mockPane(output = WIDE_FRAME) {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output,
      realtimeSnippet: output,
      isRunning: true,
      isThinking: false,
      sessionStatus: 'ready',
      isSelectionListActive: false,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
}

const lastMessagesCall = () => useSplitMessagesMock.mock.calls.at(-1)?.[0];
const lastPaneCall = () => useTerminalPanePollingMock.mock.calls.at(-1)?.[0];

const logOf = (element: HTMLElement): HTMLElement =>
  element.querySelector('[role="log"]') as HTMLElement;

function switchToTerminal(id = 'wt-1') {
  fireEvent.click(screen.getByTestId(`session-tile-surface-terminal-${id}`));
}

beforeEach(() => {
  window.localStorage.clear();
  pushMock.mockClear();
  chatSurfaceProps.latest = null;
  useTerminalPanePollingMock.mockReset();
  mockPane();
  useSplitMessagesMock.mockReset();
  useSplitMessagesMock.mockReturnValue({
    messages: [{ id: 'm1' }, { id: 'm2' }],
    isLoading: false,
    refresh: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('SessionTile surfaces (Issue #2510)', () => {
  it('still opens on chat, with no terminal and no History toggle', () => {
    render(<SessionTile worktree={createWorktree()} enabled />);

    expect(screen.getByTestId('chat-surface-wt-1')).toBeDefined();
    expect(screen.queryByTestId('session-tile-terminal-wt-1')).toBeNull();
    expect(screen.queryByTestId('session-tile-history-toggle-wt-1')).toBeNull();
    expect(
      screen.getByTestId('session-tile-surface-chat-wt-1').getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByTestId('session-tile-surface-terminal-wt-1').getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('switches to the terminal and remembers it for this worktree', () => {
    render(<SessionTile worktree={createWorktree()} enabled />);

    switchToTerminal();

    expect(screen.queryByTestId('chat-surface-wt-1')).toBeNull();
    expect(screen.getByTestId('session-tile-terminal-wt-1')).toBeDefined();
    expect(window.localStorage.getItem(surfaceKey('wt-1'))).toBe('terminal');
    expect(
      screen.getByTestId('session-tile-surface-terminal-wt-1').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('reopens on the terminal a tile was left on', () => {
    window.localStorage.setItem(surfaceKey('wt-1'), 'terminal');

    render(<SessionTile worktree={createWorktree()} enabled />);

    expect(screen.getByTestId('session-tile-terminal-wt-1')).toBeDefined();
    expect(screen.queryByTestId('chat-surface-wt-1')).toBeNull();
  });

  it("lets the chat surface's open-the-terminal button switch the tile in place", () => {
    render(<SessionTile worktree={createWorktree()} enabled />);

    act(() => chatSurfaceProps.latest?.onSurfaceModeChange('terminal'));

    expect(screen.getByTestId('session-tile-terminal-wt-1')).toBeDefined();
    // Phase 1 navigated to the worktree screen here; the tile now has a terminal.
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('goes back to chat from the header', () => {
    window.localStorage.setItem(surfaceKey('wt-1'), 'terminal');
    render(<SessionTile worktree={createWorktree()} enabled />);

    fireEvent.click(screen.getByTestId('session-tile-surface-chat-wt-1'));

    expect(screen.getByTestId('chat-surface-wt-1')).toBeDefined();
    expect(screen.queryByTestId('session-tile-terminal-wt-1')).toBeNull();
    expect(window.localStorage.getItem(surfaceKey('wt-1'))).toBe('chat');
  });

  it('keeps each tile its own surface', () => {
    render(
      <>
        <SessionTile worktree={createWorktree({ id: 'wt-1' })} enabled />
        <SessionTile worktree={createWorktree({ id: 'wt-2' })} enabled />
      </>,
    );

    switchToTerminal('wt-1');

    expect(screen.getByTestId('session-tile-terminal-wt-1')).toBeDefined();
    expect(screen.getByTestId('chat-surface-wt-2')).toBeDefined();
  });
});

describe('SessionTile terminal width (Issue #2510)', () => {
  it('keeps the frame columns and scrolls sideways inside the terminal log', () => {
    render(<SessionTile worktree={createWorktree()} enabled />);
    switchToTerminal();

    const log = logOf(screen.getByTestId('session-tile-terminal-wt-1'));
    const body = log.firstElementChild as HTMLElement;
    expect(body.className).toContain('whitespace-pre');
    expect(body.className).toContain('w-max');
    expect(body.style.minWidth).toBe('200ch');
    expect(log.className).toContain('overflow-x-auto');
    expect(log.className).not.toContain('overflow-x-hidden');
  });

  it('sets the frame at the compact density', () => {
    render(<SessionTile worktree={createWorktree()} enabled />);
    switchToTerminal();

    const classes = logOf(screen.getByTestId('session-tile-terminal-wt-1')).className.split(/\s+/);
    expect(classes).toContain('text-xs');
    expect(classes).not.toContain('text-sm');
  });

  it('clips at every box between the scroll region and the page', () => {
    // The sideways scroll must belong to the log. Each ancestor up to the tile
    // either clips or may shrink below its content, so a 200ch frame cannot
    // widen the tile, its grid cell or the page.
    render(<SessionTile worktree={createWorktree()} enabled />);
    switchToTerminal();

    const terminalRow = screen.getByTestId('session-tile-terminal-wt-1');
    expect(terminalRow.className).toContain('overflow-hidden');
    expect(terminalRow.className).toContain('min-w-0');
    expect(screen.getByTestId('session-tile-terminal-stack-wt-1').className).toContain('min-w-0');
    const tile = screen.getByTestId('session-tile-wt-1');
    expect(tile.className).toContain('overflow-hidden');
    expect(tile.className).toContain('min-w-0');
  });

  it('renders the frame for every tool the same way, not just opencode', () => {
    render(
      <SessionTile
        worktree={createWorktree({ selectedAgents: ['codex'] })}
        enabled
      />,
    );
    switchToTerminal();

    const log = logOf(screen.getByTestId('session-tile-terminal-wt-1'));
    expect(log.className).toContain('overflow-x-auto');
  });

  it('keeps the #2511 tile cadence on both pollers when the terminal is showing', async () => {
    const { TILE_PANE_POLLING_CADENCE, TILE_MESSAGES_POLLING_CADENCE } = await import(
      '@/config/pane-polling-cadence'
    );
    render(<SessionTile worktree={createWorktree()} enabled />);
    switchToTerminal();

    expect(lastPaneCall()).toMatchObject({ enabled: true, cadence: TILE_PANE_POLLING_CADENCE });
    expect(lastMessagesCall()).toMatchObject({ enabled: true, cadence: TILE_MESSAGES_POLLING_CADENCE });
  });

  it('renders nothing and polls nothing while off screen', () => {
    window.localStorage.setItem(surfaceKey('wt-1'), 'terminal');

    render(<SessionTile worktree={createWorktree()} enabled={false} />);

    expect(screen.queryByTestId('session-tile-terminal-wt-1')).toBeNull();
    expect(screen.queryByTestId('history-pane-wt-1')).toBeNull();
    expect(screen.getByTestId('session-tile-placeholder-wt-1')).toBeDefined();
    expect(lastPaneCall()).toMatchObject({ enabled: false });
    expect(lastMessagesCall()).toMatchObject({ enabled: false });
  });
});

describe('SessionTile stacked History (Issue #2510)', () => {
  it('shows History under the terminal by default', () => {
    render(<SessionTile worktree={createWorktree()} enabled />);
    switchToTerminal();

    const stack = screen.getByTestId('session-tile-terminal-stack-wt-1');
    expect(stack.className).toContain('flex-col');
    const rows = Array.from(stack.children).map((child) => child.getAttribute('data-testid'));
    // Terminal on top, History below — vertical, not the worktree screen's column.
    expect(rows).toEqual(['session-tile-terminal-wt-1', 'session-tile-history-wt-1']);

    const pane = within(screen.getByTestId('session-tile-history-wt-1')).getByTestId('history-pane-wt-1');
    expect(pane.getAttribute('data-message-count')).toBe('2');
    expect(pane.getAttribute('data-cli-tool-id')).toBe('claude');
  });

  it('gives both rows a share and a floor, so neither is crushed', () => {
    render(<SessionTile worktree={createWorktree()} enabled />);
    switchToTerminal();

    const terminalRow = screen.getByTestId('session-tile-terminal-wt-1');
    const historyRow = screen.getByTestId('session-tile-history-wt-1');
    expect(terminalRow.className).toContain(SESSION_TILE_TERMINAL_ROW_CLASS);
    expect(historyRow.className).toContain(SESSION_TILE_HISTORY_ROW_CLASS);
    expect(SESSION_TILE_TERMINAL_ROW_CLASS).toMatch(/min-h-\[\d+(\.\d+)?rem\]/);
    expect(SESSION_TILE_HISTORY_ROW_CLASS).toMatch(/min-h-\[\d+(\.\d+)?rem\]/);
    expect(historyRow.className).toContain('overflow-hidden');
  });

  it('keeps the floors inside the tile body, so the ratio decides on a real tile', () => {
    // The tile is 32rem tall (SESSION_TILE_HEIGHT_CLASS) with a ~3.3rem header.
    const floor = (cls: string) => Number(/min-h-\[(\d+(?:\.\d+)?)rem\]/.exec(cls)?.[1]);
    expect(floor(SESSION_TILE_TERMINAL_ROW_CLASS) + floor(SESSION_TILE_HISTORY_ROW_CLASS)).toBeLessThan(
      32 - 3.5,
    );
    // …and the terminal gets the larger share.
    expect(floor(SESSION_TILE_TERMINAL_ROW_CLASS)).toBeGreaterThan(floor(SESSION_TILE_HISTORY_ROW_CLASS));
  });

  it('offers no collapse arrow inside History — the header toggle owns the region', () => {
    render(<SessionTile worktree={createWorktree()} enabled />);
    switchToTerminal();

    expect(screen.getByTestId('history-pane-wt-1').getAttribute('data-has-collapse')).toBe('false');
    const toggle = screen.getByTestId('session-tile-history-toggle-wt-1');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(sessionTileHistoryRegionId('wt-1'));
    expect(screen.getByTestId('session-tile-history-wt-1').id).toBe(sessionTileHistoryRegionId('wt-1'));
  });

  it('hides History, gives the terminal the whole body and persists under the tile key', () => {
    render(<SessionTile worktree={createWorktree()} enabled />);
    switchToTerminal();

    fireEvent.click(screen.getByTestId('session-tile-history-toggle-wt-1'));

    expect(screen.queryByTestId('session-tile-history-wt-1')).toBeNull();
    expect(screen.getByTestId('session-tile-terminal-wt-1').className).toContain('flex-1');
    expect(screen.getByTestId('session-tile-history-toggle-wt-1').getAttribute('aria-pressed')).toBe('false');
    expect(window.localStorage.getItem(TILE_HISTORY_KEY)).toBe('false');
  });

  it('never touches the worktree screen History key', () => {
    render(<SessionTile worktree={createWorktree()} enabled />);
    switchToTerminal();

    fireEvent.click(screen.getByTestId('session-tile-history-toggle-wt-1'));
    fireEvent.click(screen.getByTestId('session-tile-history-toggle-wt-1'));

    expect(window.localStorage.getItem(WORKTREE_HISTORY_KEY)).toBeNull();
  });

  it('shows History even when the worktree screen has it closed', () => {
    window.localStorage.setItem(WORKTREE_HISTORY_KEY, 'false');

    render(<SessionTile worktree={createWorktree()} enabled />);
    switchToTerminal();

    expect(screen.getByTestId('session-tile-history-wt-1')).toBeDefined();
  });

  it('stops polling /messages while History is closed on the terminal, and resumes when reopened', () => {
    render(<SessionTile worktree={createWorktree()} enabled />);
    switchToTerminal();
    expect(lastMessagesCall()).toMatchObject({ enabled: true });

    fireEvent.click(screen.getByTestId('session-tile-history-toggle-wt-1'));
    expect(lastMessagesCall()).toMatchObject({ enabled: false });
    // The terminal is still on screen, so its poller is not.
    expect(lastPaneCall()).toMatchObject({ enabled: true });

    fireEvent.click(screen.getByTestId('session-tile-history-toggle-wt-1'));
    expect(lastMessagesCall()).toMatchObject({ enabled: true });
  });

  it('still polls /messages on chat, whatever the stacked History toggle says', () => {
    window.localStorage.setItem(TILE_HISTORY_KEY, 'false');

    render(<SessionTile worktree={createWorktree()} enabled />);

    expect(screen.getByTestId('chat-surface-wt-1')).toBeDefined();
    expect(lastMessagesCall()).toMatchObject({ enabled: true });
  });

  it('applies one History choice to every terminal tile on the wall', () => {
    window.localStorage.setItem(surfaceKey('wt-1'), 'terminal');
    window.localStorage.setItem(surfaceKey('wt-2'), 'terminal');
    render(
      <>
        <SessionTile worktree={createWorktree({ id: 'wt-1' })} enabled />
        <SessionTile worktree={createWorktree({ id: 'wt-2' })} enabled />
      </>,
    );

    fireEvent.click(screen.getByTestId('session-tile-history-toggle-wt-1'));

    expect(screen.queryByTestId('session-tile-history-wt-1')).toBeNull();
    expect(screen.queryByTestId('session-tile-history-wt-2')).toBeNull();
  });
});
