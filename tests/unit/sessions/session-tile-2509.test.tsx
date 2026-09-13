/**
 * SessionTile — the tile header and what it is deliberately not (Issue #2509).
 *
 * Two things this suite exists to hold in place:
 *
 *  1. the branch link, which is the tile's only route to `/worktrees/<id>`, and
 *  2. the fact that the CARD is not a link. Wrapping the card would turn every
 *     scroll, every jump-to-latest and every dialog key inside the tile into a
 *     navigation away from `/sessions` — the one behaviour the Issue rules out,
 *     and the reason the header is a row rather than a wrapper.
 *
 * The network hooks are stubbed here (the real ones are exercised against the
 * real HTTP seam by `session-tile-viewport-2509`), so this file is about markup.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

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

const paneState = vi.hoisted(() => ({
  terminal: {
    output: '',
    realtimeSnippet: '',
    isRunning: false,
    isThinking: false,
    sessionStatus: '',
    isSelectionListActive: false,
    isPagerActive: false,
    isDismissablePanelActive: false,
    isUnclassifiedActive: false,
    composerText: '',
    attaching: true,
    autoScroll: true,
  },
  prompt: { visible: false, data: null, messageId: null, answering: false },
}));

const useTerminalPanePollingMock = vi.hoisted(() => vi.fn());
const useSplitMessagesMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
}));

// Records what the tile asks its chat surface to render, so the instance
// selector's effect on the surface is observable without the real transcript.
vi.mock('@/components/worktree/ChatSurface', () => ({
  ChatSurface: ({ worktreeId, cliToolId, instanceId }: {
    worktreeId: string;
    cliToolId?: string;
    instanceId?: string;
  }) =>
    React.createElement('div', {
      'data-testid': `chat-surface-${worktreeId}`,
      'data-cli-tool-id': cliToolId,
      'data-instance-id': instanceId,
    }),
}));

import { SessionTile } from '@/components/sessions/SessionTile';
import type { Worktree } from '@/types/models';

function createWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    selectedAgents: ['claude'],
    ...overrides,
  } as Worktree;
}

beforeEach(() => {
  pushMock.mockClear();
  useTerminalPanePollingMock.mockReset();
  useTerminalPanePollingMock.mockReturnValue({
    terminal: paneState.terminal,
    prompt: paneState.prompt,
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
  useSplitMessagesMock.mockReset();
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
});

describe('SessionTile (Issue #2509)', () => {
  describe('the branch link', () => {
    it('shows `branch` and links it to the worktree screen', () => {
      render(
        <SessionTile
          worktree={createWorktree({ branch: 'feature/2509-tiles', name: 'wt-dir-name' })}
          enabled
        />,
      );

      const link = screen.getByTestId('session-tile-branch-wt-1');
      expect(link.textContent).toBe('feature/2509-tiles');
      expect(link.getAttribute('href')).toBe('/worktrees/wt-1');
    });

    it('falls back to `name` for a row synced before branch was recorded', () => {
      render(
        <SessionTile worktree={createWorktree({ branch: undefined, name: 'legacy-name' })} enabled />,
      );

      expect(screen.getByTestId('session-tile-branch-wt-1').textContent).toBe('legacy-name');
    });

    it('is the ONLY link in the tile — the card itself is not one', () => {
      render(<SessionTile worktree={createWorktree({ branch: 'feature/x' })} enabled />);

      const tile = screen.getByTestId('session-tile-wt-1');
      expect(tile.tagName).not.toBe('A');
      expect(tile.closest('a')).toBeNull();
      const links = within(tile).getAllByRole('link');
      expect(links).toHaveLength(1);
      expect(links[0].getAttribute('data-testid')).toBe('session-tile-branch-wt-1');
    });
  });

  describe('the instance selector', () => {
    it('is absent for a worktree with a single agent', () => {
      render(<SessionTile worktree={createWorktree({ selectedAgents: ['claude'] })} enabled />);

      expect(screen.queryByTestId('session-tile-instance-wt-1')).toBeNull();
      expect(screen.getByTestId('chat-surface-wt-1').getAttribute('data-instance-id')).toBe('claude');
    });

    it('switches which instance the surface and the pollers are aimed at', () => {
      render(
        <SessionTile
          worktree={createWorktree({ selectedAgents: ['claude', 'codex'] })}
          enabled
        />,
      );

      const select = screen.getByTestId('session-tile-instance-wt-1') as HTMLSelectElement;
      expect(select.value).toBe('claude');

      fireEvent.change(select, { target: { value: 'codex' } });

      const surface = screen.getByTestId('chat-surface-wt-1');
      expect(surface.getAttribute('data-instance-id')).toBe('codex');
      expect(surface.getAttribute('data-cli-tool-id')).toBe('codex');
      const lastPollCall = useTerminalPanePollingMock.mock.calls.at(-1)?.[0];
      expect(lastPollCall).toMatchObject({ worktreeId: 'wt-1', cliToolId: 'codex', instanceId: 'codex' });
    });

    it('prefers the agentInstances roster and shows its aliases', () => {
      render(
        <SessionTile
          worktree={createWorktree({
            selectedAgents: ['claude'],
            agentInstances: [
              { id: 'codex', cliTool: 'codex', alias: 'レビュー担当', order: 0 },
              { id: 'codex-2', cliTool: 'codex', alias: '実装担当', order: 1 },
            ],
          })}
          enabled
        />,
      );

      const select = screen.getByTestId('session-tile-instance-wt-1');
      expect(select.textContent).toContain('レビュー担当');
      expect(select.textContent).toContain('実装担当');
      expect(screen.getByTestId('chat-surface-wt-1').getAttribute('data-instance-id')).toBe('codex');
    });
  });

  describe('enabled', () => {
    it('suspends both hooks and withholds the chat surface when off screen', () => {
      render(<SessionTile worktree={createWorktree()} enabled={false} />);

      expect(useTerminalPanePollingMock.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false });
      expect(useSplitMessagesMock.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false });
      expect(screen.queryByTestId('chat-surface-wt-1')).toBeNull();
      expect(screen.getByTestId('session-tile-placeholder-wt-1')).toBeDefined();
    });

    it('still shows the header while off screen, so the wall is readable before it fills in', () => {
      render(<SessionTile worktree={createWorktree({ branch: 'feature/x' })} enabled={false} />);

      expect(screen.getByTestId('session-tile-branch-wt-1').textContent).toBe('feature/x');
    });
  });
});
