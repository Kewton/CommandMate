/**
 * Issue #3927: no unsent bar — and so no [Run] Enter — for a codex composer
 * that a dialog has opened below.
 *
 * Rendered from the parents, through the REAL polling hook and the REAL
 * `UnsentComposerBar`: the PC split (`TerminalSplitPaneContent`) and the
 * mobile terminal tab (`MobileTerminalTab`) each own a `useTerminalPanePolling`,
 * and each derives `composerText` from the frame it fetched. Before the fix both
 * showed the old composer's text on this frame, and [Run] posted `['Enter']`,
 * which the pane delivers to the dialog's highlighted option. The controls are
 * the same rows as the live composer, and a claude composer.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import {
  CODEX_DIALOG_BELOW_FRAME,
  CODEX_LIVE_COMPOSER_FRAME,
} from '@tests/fixtures/codex-dialog-below-3927';

beforeAll(() => installRadixJsdomPolyfills());

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: ({ output }: { output: string }) => (
    <div data-testid="terminal-display">
      <span data-testid="terminal-output">{output}</span>
    </div>
  ),
}));

vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: ({ splitIndex }: { splitIndex: number }) => <div data-testid={`message-input-${splitIndex}`} />,
}));

vi.mock('@/components/worktree/AutoYesToggle', () => ({
  AutoYesToggle: () => <div data-testid="auto-yes-toggle" />,
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(),
  }),
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));

vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({ visible: true, width: 40, toggle: vi.fn(), setWidth: vi.fn() }),
  DEFAULT_HISTORY_WIDTH: 40,
}));

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()) }),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

const CLAUDE_RESIDUAL = fs.readFileSync(
  path.resolve(__dirname, '../../lib/detection/fixtures/claude-live-1879/composer-residual-plain.txt'),
  'utf-8',
);

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

function getUrlString(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

let mockFetch: ReturnType<typeof vi.fn>;

/** Every `/current-output` poll answers with `fullOutput`; every POST succeeds. */
function serveFrame(cliToolId: CLIToolType, fullOutput: string) {
  mockFetch.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      json: async () => ({
        isRunning: true,
        cliToolId,
        fullOutput,
        thinking: false,
        isSelectionListActive: false,
        isPagerActive: false,
        isPromptWaiting: false,
        isUnclassifiedActive: false,
      }),
    }),
  );
}

/** The POSTs the page made: the bar's [Run] is the only source of `special-keys` here. */
function specialKeyPosts(): unknown[] {
  return (mockFetch.mock.calls as Array<[string | URL | Request, RequestInit | undefined]>)
    .filter(([input, init]) => init?.method === 'POST' && getUrlString(input).endsWith('/special-keys'))
    .map(([, init]) => JSON.parse(init!.body as string));
}

const SURFACES: Array<[string, (cliToolId: CLIToolType) => void]> = [
  [
    'PC split (TerminalSplitPaneContent)',
    cliToolId => {
      render(
        <TerminalSplitPaneContent
          worktreeId="w-3927"
          splitIndex={0}
          cliToolId={cliToolId}
          availableInstances={[inst(cliToolId)]}
          onInstanceChange={vi.fn()}
          onFocus={vi.fn()}
          autoYes={{ onToggle: vi.fn() }}
        />,
      );
    },
  ],
  [
    'mobile terminal tab (MobileTerminalTab)',
    cliToolId => {
      render(<MobileTerminalTab worktreeId="w-3927" cliToolId={cliToolId} />);
    },
  ],
];

beforeEach(() => {
  window.localStorage.clear();
  mockFetch = vi.fn();
  global.fetch = mockFetch as unknown as typeof fetch;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(SURFACES)('Issue #3927: the unsent bar on the %s', (_surface, renderSurface) => {
  it('positive: no bar and no Run button when a dialog is drawn below the old codex composer', async () => {
    serveFrame('codex', CODEX_DIALOG_BELOW_FRAME);
    renderSurface('codex');

    await waitFor(() => expect(screen.getByTestId('terminal-output').textContent).toBe(CODEX_DIALOG_BELOW_FRAME));
    expect(screen.queryByTestId('unsent-composer-bar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'worktree.unsentComposer.run' })).not.toBeInTheDocument();
    expect(specialKeyPosts()).toEqual([]);
  });

  it('negative: the same rows as the live codex composer show the bar, and Run sends Enter', async () => {
    serveFrame('codex', CODEX_LIVE_COMPOSER_FRAME);
    renderSurface('codex');

    await waitFor(() => expect(screen.getByTestId('unsent-composer-bar')).toBeInTheDocument());
    expect(screen.getByTestId('unsent-composer-text')).toHaveTextContent('row 1: old');
    fireEvent.click(screen.getByRole('button', { name: 'worktree.unsentComposer.run' }));

    await waitFor(() => expect(specialKeyPosts()).toEqual([{ cliToolId: 'codex', keys: ['Enter'] }]));
  });

  it('negative: a claude composer still shows the bar', async () => {
    serveFrame('claude', CLAUDE_RESIDUAL);
    renderSurface('claude');

    await waitFor(() => expect(screen.getByTestId('unsent-composer-bar')).toBeInTheDocument());
    expect(screen.getByTestId('unsent-composer-text')).toHaveTextContent('echo PREFILLED');
  });
});
