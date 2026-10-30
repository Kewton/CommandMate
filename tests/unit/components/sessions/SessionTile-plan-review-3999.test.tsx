/**
 * Issue #3999 — a `/sessions` tile answers Command Code's plan review from its
 * terminal surface, and its composer does not send into it.
 *
 * Before: the tile's selection-list row was capped at 8rem and scrolled the
 * arrow pad and everything under it together, and the plan review's controls
 * were not drawn on the terminal surface at all. The pixels are measured in
 * `tests/e2e/plan-review-reachable-3999.spec.ts`; jsdom checks the wiring:
 *
 *  - positive: on a REVIEW frame the row draws the controls, is not capped,
 *    and the terminal / History rows drop their floors (they give way, the
 *    buttons do not); the composer is told the review is up — on the chat
 *    surface too;
 *  - negative: any other selection list keeps #3336's capped row and #2510's
 *    floors, and the composer is not stopped.
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

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: () => (
    <div data-testid="chat-transcript">
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false, error: null,
    filter: '', setFilter: vi.fn(), refresh: vi.fn(), isCatalogStale: false,
  }),
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
}));

import {
  SessionTile,
  SESSION_TILE_HISTORY_ROW_CLASS,
  SESSION_TILE_HISTORY_ROW_YIELDING_CLASS,
  SESSION_TILE_PLAN_REVIEW_ROW_CLASS,
  SESSION_TILE_SELECTION_KEYS_ROW_CLASS,
  SESSION_TILE_TERMINAL_ROW_CLASS,
  SESSION_TILE_TERMINAL_ROW_YIELDING_CLASS,
} from '@/components/sessions/SessionTile';
import { resetRevealedStartingTerminals } from '@/hooks/useSessionStartingGate';
import type { Worktree } from '@/types/models';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const capture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');
const PLAN_REVIEW_LONG = capture('command-code-plan-review-2763/plan-review-long-top.txt');
const COMMAND_CODE_MODEL = capture('chat-dialog-card-2254/command-code-model-1-40-1.txt');

function worktree(): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    selectedAgents: ['command-code'],
  } as Worktree;
}

function mockPane(frame: string) {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: frame,
      realtimeSnippet: '',
      isRunning: true,
      isThinking: false,
      sessionStatus: 'waiting',
      isSelectionListActive: true,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      agentMode: 'unknown',
      startingSince: null,
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

function renderTerminalTile() {
  render(<SessionTile worktree={worktree()} enabled />);
  act(() => {
    fireEvent.click(screen.getByTestId('session-tile-surface-terminal-wt-1'));
  });
}

const composer = () => screen.getByTestId('session-tile-composer-wt-1');

beforeEach(() => {
  window.localStorage.clear();
  resetRevealedStartingTerminals();
  useTerminalPanePollingMock.mockReset();
  useSplitMessagesMock.mockReset();
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe('[#3999] tile, terminal surface: the plan review row', () => {
  it('draws the controls in an uncapped row; terminal and History give way', () => {
    mockPane(PLAN_REVIEW_LONG);
    renderTerminalTile();

    const row = screen.getByTestId('session-tile-selection-keys-wt-1');
    const controls = within(row).getByTestId('plan-review-controls');
    for (const id of ['plan-review-comment-input', 'plan-review-submit', 'plan-review-approve', 'plan-review-cancel']) {
      expect(within(controls).getByTestId(id)).toBeInTheDocument();
    }
    expect(row.className).toContain(SESSION_TILE_PLAN_REVIEW_ROW_CLASS);
    expect(row.className).not.toContain(SESSION_TILE_SELECTION_KEYS_ROW_CLASS);
    expect(screen.getByTestId('session-tile-terminal-wt-1').className).toContain(
      SESSION_TILE_TERMINAL_ROW_YIELDING_CLASS,
    );
    expect(screen.getByTestId('session-tile-history-wt-1').className).toContain(
      SESSION_TILE_HISTORY_ROW_YIELDING_CLASS,
    );
    expect(within(composer()).getByTestId('composer-plan-review-notice')).toBeInTheDocument();
  });

  it('negative control: another selection list keeps #3336’s row and #2510’s floors', () => {
    mockPane(COMMAND_CODE_MODEL);
    renderTerminalTile();

    const row = screen.getByTestId('session-tile-selection-keys-wt-1');
    expect(within(row).queryByTestId('plan-review-controls')).toBeNull();
    expect(row.className).toContain(SESSION_TILE_SELECTION_KEYS_ROW_CLASS);
    expect(screen.getByTestId('session-tile-terminal-wt-1').className).toContain(SESSION_TILE_TERMINAL_ROW_CLASS);
    expect(screen.getByTestId('session-tile-history-wt-1').className).toContain(SESSION_TILE_HISTORY_ROW_CLASS);
    expect(within(composer()).queryByTestId('composer-plan-review-notice')).toBeNull();
  });
});

describe('[#3999] tile, chat surface: the composer is stopped too', () => {
  it('a REVIEW frame on the chat surface raises the composer notice', () => {
    mockPane(PLAN_REVIEW_LONG);
    render(<SessionTile worktree={worktree()} enabled />);
    expect(screen.getByTestId('plan-review-controls')).toBeInTheDocument();
    expect(within(composer()).getByTestId('composer-plan-review-notice')).toBeInTheDocument();
  });
});
