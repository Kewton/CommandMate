/**
 * The sidebar notice reaches both screens (Issue #2095).
 *
 * `OpencodeSidebarNotice-2095.test.tsx` proves the component decides correctly.
 * This proves the two surfaces that own a live opencode pane actually render it
 * — PC's split footer and the phone's terminal tab — and that they render it
 * under the SAME condition. #1879 is the precedent for testing that pair
 * together: a gate copied to two call sites is how PC and phone come to disagree
 * about one session, and the pane is the same pane on both.
 *
 * Both are driven by the real `sidebar-on` / `sidebar-off` frames Issue #2046
 * captured, fed through the hook's real `PaneTerminalState` shape. Nothing about
 * the detection is mocked.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';

beforeAll(() => installRadixJsdomPolyfills());

// Every heavy child of the two surfaces. The subject is one bar in the footer.
vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));
vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: () => <div data-testid="message-input" />,
}));
vi.mock('@/components/worktree/NavigationButtons', () => ({
  NavigationButtons: () => <div data-testid="navigation-buttons" />,
}));
vi.mock('@/components/worktree/TerminalEscapeHatch', () => ({
  TerminalEscapeHatch: () => <div data-testid="terminal-escape-hatch" />,
}));
vi.mock('@/components/worktree/OpencodeQuickKeys', () => ({
  OpencodeQuickKeys: () => <div data-testid="opencode-quick-keys" />,
}));
vi.mock('@/components/worktree/AutoYesToggle', () => ({
  AutoYesToggle: () => <div data-testid="auto-yes-toggle" />,
}));
vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(),
  }),
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()) }),
}));
vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({ visible: false, width: 40, toggle: vi.fn(), setWidth: vi.fn() }),
  DEFAULT_HISTORY_WIDTH: 40,
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));

const { useTerminalPanePollingMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));

import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';

const FIXTURES = path.resolve(__dirname, '../../../fixtures/opencode-live-2046/w80');
const frame = (name: string) => fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf-8');

/** The 100 rows both surfaces read, exactly as the hook fills them in. */
function mockPane(fixture: string) {
  const raw = frame(fixture);
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: raw,
      realtimeSnippet: raw.split('\n').slice(-100).join('\n'),
      isRunning: true,
      isThinking: false,
      isSelectionListActive: false,
      isPagerActive: false,
      // What the server publishes for `sidebar-on`; false for the control. The
      // notice does not read it either way — its gate is the frame's geometry —
      // and that independence is the point.
      isUnclassifiedActive: fixture === 'sidebar-on',
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

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

const renderPc = (cliToolId: CLIToolType = 'opencode') =>
  render(
    <TerminalSplitPaneContent
      worktreeId="w-2095"
      splitIndex={0}
      cliToolId={cliToolId}
      availableInstances={[inst(cliToolId)]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
    />,
  );

const renderMobile = (cliToolId: CLIToolType = 'opencode') =>
  render(<MobileTerminalTab worktreeId="w-2095" cliToolId={cliToolId} />);

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe.each([
  ['PC split footer', renderPc],
  ['mobile terminal tab', renderMobile],
] as const)('%s (Issue #2095)', (_name, renderSurface) => {
  it('shows the notice on the frame `ctrl+x b` produced', () => {
    mockPane('sidebar-on');
    renderSurface();

    expect(screen.getByTestId('opencode-sidebar-notice')).toBeInTheDocument();
    expect(screen.getByTestId('opencode-sidebar-notice-chord')).toHaveTextContent('ctrl+x b');
  });

  it('shows nothing on the same session one keystroke earlier', () => {
    mockPane('sidebar-off');
    renderSurface();

    expect(screen.queryByTestId('opencode-sidebar-notice')).not.toBeInTheDocument();
  });

  it('shows nothing for another tool on the identical frame', () => {
    mockPane('sidebar-on');
    renderSurface('claude');

    expect(screen.queryByTestId('opencode-sidebar-notice')).not.toBeInTheDocument();
  });
});
