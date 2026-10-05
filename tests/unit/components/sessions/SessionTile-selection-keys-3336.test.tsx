/**
 * Issue #3336 — a Sessions tile's terminal surface answers a selection list.
 *
 * #3305 mounted `SelectionListKeys` on the chat card, the PC split's footer and
 * the phone's dock; the tile's terminal surface was left with no control at
 * all, so a picker there could only be driven by switching back to chat. The
 * tile now mounts the same part with the frame it is drawing, so what it
 * offers is `resolveSelectionListOps`' terminal-surface answer.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: () => <div data-testid="tile-message-input" />,
}));

const useTerminalPanePollingMock = vi.hoisted(() => vi.fn());
const useSplitMessagesMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
}));

import { SessionTile } from '@/components/sessions/SessionTile';
import { resetRevealedStartingTerminals } from '@/hooks/useSessionStartingGate';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';

const FIXTURES = path.resolve(__dirname, '../../../fixtures/chat-dialog-card-2254');
const capture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

/** codex 0.151.0 `/model`: seven numbered models. */
const CODEX_MODEL = capture('codex-model-0-151-0.txt');
/** claude 2.1.259 `/model`: `Enter to set as default · s to use this session only`. */
const CLAUDE_MODEL = capture('claude-model-2-1-259.txt');

const TILE_KEYS = 'session-tile-selection-keys-wt-1';

function worktree(cliTool: CLIToolType): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    selectedAgents: [cliTool],
  } as Worktree;
}

function mockPane(
  output: string,
  { isSelectionListActive = true, startingSince = null }: { isSelectionListActive?: boolean; startingSince?: number | null } = {},
) {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output,
      realtimeSnippet: '',
      isRunning: true,
      isThinking: false,
      sessionStatus: 'waiting',
      isSelectionListActive,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      agentMode: 'unknown',
      startingSince,
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

function showTerminalSurface() {
  act(() => {
    fireEvent.click(screen.getByTestId('session-tile-surface-terminal-wt-1'));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  resetRevealedStartingTerminals();
  useTerminalPanePollingMock.mockReset();
  useSplitMessagesMock.mockReset();
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
});

describe('[#3336] SessionTile terminal surface: selection-list controls', () => {
  it('draws the arrow pad and the number keys under the frame for a numbered list', () => {
    mockPane(CODEX_MODEL);
    render(<SessionTile worktree={worktree('codex')} enabled />);
    showTerminalSurface();

    const keys = screen.getByTestId(TILE_KEYS);
    expect(within(keys).getByRole('toolbar', { name: 'TUI Navigation' })).toBeInTheDocument();
    expect(within(within(keys).getByTestId('selection-number-keys')).getAllByRole('button')).toHaveLength(7);
    expect(screen.getByTestId('session-tile-terminal-stack-wt-1')).toContainElement(keys);
  });

  it("offers claude's labelled commits on /model, as the other terminal surfaces do", () => {
    mockPane(CLAUDE_MODEL);
    render(<SessionTile worktree={worktree('claude')} enabled />);
    showTerminalSurface();

    const keys = screen.getByTestId(TILE_KEYS);
    expect(within(keys).getByTestId('selection-commit-session')).toBeInTheDocument();
    expect(within(keys).getByTestId('selection-commit-default')).toBeInTheDocument();
  });

  it('draws nothing when no selection list is up', () => {
    mockPane(CODEX_MODEL, { isSelectionListActive: false });
    render(<SessionTile worktree={worktree('codex')} enabled />);
    showTerminalSurface();

    expect(screen.queryByTestId(TILE_KEYS)).toBeNull();
  });

  it('draws nothing while the agent is launching', () => {
    mockPane(CODEX_MODEL, { startingSince: Date.now() });
    render(<SessionTile worktree={worktree('codex')} enabled />);
    showTerminalSurface();

    expect(screen.queryByTestId(TILE_KEYS)).toBeNull();
  });

  it('leaves the chat surface to its card (no second copy outside it)', () => {
    mockPane(CODEX_MODEL);
    render(<SessionTile worktree={worktree('codex')} enabled />);

    expect(screen.queryByTestId(TILE_KEYS)).toBeNull();
    expect(screen.getAllByTestId('selection-number-keys')).toHaveLength(1);
  });
});
