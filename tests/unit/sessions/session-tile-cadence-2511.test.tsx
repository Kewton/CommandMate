/**
 * SessionTile asks for the tile profile, not the worktree screen's (#2511).
 *
 * The cadence itself is pinned in `tests/unit/hooks/` and
 * `tests/unit/config/`; the one thing those cannot see is whether the tile
 * actually *passes* the profile. A tile that forgets the option silently falls
 * back to `DETAIL_PANE_POLLING_CADENCE` — the hook's default — and every number
 * in `docs/design/sessions-tile-polling-2511.md` becomes wrong with nothing
 * failing. That is what this file is for.
 *
 * It also pins the direction of the comparison rather than only the identity, so
 * a future edit that points the tile at some third profile still has to be a
 * profile that is slower than the worktree screen's.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import {
  DETAIL_MESSAGES_POLLING_CADENCE,
  DETAIL_PANE_POLLING_CADENCE,
  TILE_MESSAGES_POLLING_CADENCE,
  TILE_PANE_POLLING_CADENCE,
} from '@/config/pane-polling-cadence';

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
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
vi.mock('@/components/worktree/ChatSurface', () => ({
  ChatSurface: () => React.createElement('div', { 'data-testid': 'chat-surface' }),
}));

import { SessionTile } from '@/components/sessions/SessionTile';
import type { Worktree } from '@/types/models';

const worktree = {
  id: 'wt-1',
  name: 'feature/test',
  path: '/path/to/wt',
  repositoryPath: '/path/to/repo',
  repositoryName: 'MyRepo',
  selectedAgents: ['claude'],
} as Worktree;

beforeEach(() => {
  useTerminalPanePollingMock.mockReset();
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: '', realtimeSnippet: '', isRunning: false, isThinking: false, sessionStatus: '',
      isSelectionListActive: false, isPagerActive: false, isDismissablePanelActive: false,
      isUnclassifiedActive: false, composerText: '', attaching: true, autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
  useSplitMessagesMock.mockReset();
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
});

describe('SessionTile polling profile (Issue #2511)', () => {
  it('hands the terminal poller the tile cadence', () => {
    render(<SessionTile worktree={worktree} enabled />);

    expect(useTerminalPanePollingMock).toHaveBeenCalledWith(
      expect.objectContaining({ cadence: TILE_PANE_POLLING_CADENCE }),
    );
  });

  it('hands the history poller the tile cadence', () => {
    render(<SessionTile worktree={worktree} enabled />);

    expect(useSplitMessagesMock).toHaveBeenCalledWith(
      expect.objectContaining({ cadence: TILE_MESSAGES_POLLING_CADENCE }),
    );
  });

  it('never hands either poller the worktree screen profile', () => {
    render(<SessionTile worktree={worktree} enabled />);

    const paneCadence = useTerminalPanePollingMock.mock.calls[0][0].cadence;
    const messagesCadence = useSplitMessagesMock.mock.calls[0][0].cadence;
    expect(paneCadence).not.toBe(DETAIL_PANE_POLLING_CADENCE);
    expect(messagesCadence).not.toBe(DETAIL_MESSAGES_POLLING_CADENCE);
  });

  it('whatever profile it passes is slower than the worktree screen in every slot', () => {
    render(<SessionTile worktree={worktree} enabled />);

    const pane = useTerminalPanePollingMock.mock.calls[0][0].cadence;
    const messages = useSplitMessagesMock.mock.calls[0][0].cadence;
    expect(pane.activeMs).toBeGreaterThan(DETAIL_PANE_POLLING_CADENCE.activeMs);
    expect(pane.idleMs).toBeGreaterThan(DETAIL_PANE_POLLING_CADENCE.idleMs);
    expect(pane.wsFallbackMs).toBeGreaterThanOrEqual(DETAIL_PANE_POLLING_CADENCE.wsFallbackMs);
    expect(messages.pollMs).toBeGreaterThan(DETAIL_MESSAGES_POLLING_CADENCE.pollMs);
    expect(messages.wsFallbackMs).toBeGreaterThan(DETAIL_MESSAGES_POLLING_CADENCE.wsFallbackMs);
  });

  it('still suspends both pollers when the tile is off screen', () => {
    // The Phase 1 saving (#2509). A cheaper cadence does not replace it: a tile
    // nobody can see should cost nothing at all, not 4 requests a minute.
    render(<SessionTile worktree={worktree} enabled={false} />);

    expect(useTerminalPanePollingMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, cadence: TILE_PANE_POLLING_CADENCE }),
    );
    expect(useSplitMessagesMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, cadence: TILE_MESSAGES_POLLING_CADENCE }),
    );
  });
});
