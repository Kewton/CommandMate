/**
 * 選択リストの操作の取り残し 2 つ（Issue #3336）
 *
 *  - 番号キーの窓: `SelectionListKeys` は、カードが描くダイアログの範囲で番号を数える。
 *    番号の無い `Select agent` の上（末尾 40 行以内）に番号つきの返答がある画面で、
 *    どちらの面にも番号キーが出ない。番号つきのダイアログ（codex の `/model`）は今までどおり。
 *  - opencode のモデルのキー: チャット面で選択リストが開いている間は、カードの
 *    `OpencodeModelKeys` の 1 か所だけ。フッタの `OpencodeQuickKeys`（PC の分割ペイン、
 *    スマホのタブ）は出さない。ターミナル面と、選択リストが無いときは今までどおり。
 *
 * `/sessions` のタイルのターミナル面は `SessionTile-selection-keys-3336.test.tsx` が見る。
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, cleanup } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import {
  getMobileSurfaceModeStorageKey,
  getSplitSurfaceModeStorageKey,
} from '@/config/surface-mode-config';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: () => <div data-testid="message-input" />,
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
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
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({ visible: true, width: 40, toggle: vi.fn(), setWidth: vi.fn() }),
  DEFAULT_HISTORY_WIDTH: 40,
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

const { useTerminalPanePollingMock, useSplitMessagesMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
}));

vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
  UNCLASSIFIED_CONFIRMATION_COUNT: 2,
  UNCLASSIFIED_CONFIRMATION_DELAY_MS: 500,
}));

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
  SPLIT_MESSAGES_POLL_INTERVAL_MS: 5000,
}));

import { SelectionListKeys } from '@/components/worktree/SelectionListKeys';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';
import type { SelectionListSurface } from '@/lib/session/selection-list-ops';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const capture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');

/** opencode の `Select agent`（番号なし）の上、末尾 40 行以内に `1. Yes` / `2. No` / `3. Cancel`。 */
const AGENT_LIST_OVER_NUMBERED_REPLY = capture(
  'selection-list-number-window-3336/opencode-agent-list-over-numbered-reply.txt',
);
/** codex 0.151.0 の `/model`。番号つきの 7 件。 */
const CODEX_MODEL = capture('chat-dialog-card-2254/codex-model-0-151-0.txt');

const WORKTREE_ID = 'wt-3336';
const SURFACES: readonly SelectionListSurface[] = ['chat', 'terminal'];

function numberKeyCount(): number {
  const row = screen.queryByTestId('selection-number-keys');
  return row ? within(row).getAllByRole('button').length : 0;
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }),
  );
  useSplitMessagesMock.mockReturnValue({
    messages: [],
    isLoading: false,
    refresh: vi.fn(() => Promise.resolve()),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

// ---------------------------------------------------------------------------
// 2: 番号キーの窓
// ---------------------------------------------------------------------------

describe('[#3336] 番号キーは、ダイアログの範囲で数える', () => {
  it.each(SURFACES)('%s 面: 番号の無いダイアログの上の返答に、番号キーを出さない', (surface) => {
    render(
      <SelectionListKeys
        worktreeId={WORKTREE_ID}
        cliToolId="opencode"
        frame={AGENT_LIST_OVER_NUMBERED_REPLY}
        surface={surface}
      />,
    );
    expect(screen.getByRole('toolbar', { name: 'worktree.navigation.toolbarLabel' })).toBeInTheDocument();
    expect(numberKeyCount()).toBe(0);
  });

  it.each(SURFACES)('%s 面: 番号つきのダイアログ（codex の /model）は今までどおり 7 つ', (surface) => {
    render(
      <SelectionListKeys
        worktreeId={WORKTREE_ID}
        cliToolId="codex"
        frame={CODEX_MODEL}
        surface={surface}
      />,
    );
    expect(numberKeyCount()).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 3: opencode のモデルのキーは 1 か所
// ---------------------------------------------------------------------------

function mockPane(frame: string, isSelectionListActive: boolean): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: frame,
      realtimeSnippet: frame,
      isRunning: true,
      isThinking: false,
      sessionStatus: 'waiting',
      isSelectionListActive,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
}

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

interface FooterHost {
  name: string;
  storageKey: string;
  render: () => void;
}

const HOSTS: readonly FooterHost[] = [
  {
    name: 'PC の分割ペイン',
    storageKey: getSplitSurfaceModeStorageKey(WORKTREE_ID, 0),
    render: () => {
      render(
        <TerminalSplitPaneContent
          worktreeId={WORKTREE_ID}
          splitIndex={0}
          cliToolId="opencode"
          availableInstances={[inst('opencode')]}
          onInstanceChange={vi.fn()}
          onFocus={vi.fn()}
          autoYes={{ onToggle: vi.fn() }}
        />,
      );
    },
  },
  {
    name: 'スマホのタブ',
    storageKey: getMobileSurfaceModeStorageKey(WORKTREE_ID),
    render: () => {
      render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="opencode" />);
    },
  },
];

/** フッタの quick keys の帯（折りたたみ・展開を問わない）。 */
function quickKeysStrip(): HTMLElement | null {
  return (
    screen.queryByTestId('opencode-quick-keys-disclosure') ??
    screen.queryByTestId('opencode-quick-keys')
  );
}

describe.each(HOSTS)('[#3336] $name: opencode のモデルのキー', (host) => {
  it('チャット面で選択リストが開いている間は、カードの 1 か所だけ', async () => {
    window.localStorage.setItem(host.storageKey, 'chat');
    mockPane(AGENT_LIST_OVER_NUMBERED_REPLY, true);
    host.render();

    await waitFor(() => expect(screen.getByTestId('chat-dialog-card')).toBeInTheDocument());
    expect(screen.getAllByTestId('opencode-model-keys')).toHaveLength(1);
    expect(within(screen.getByTestId('chat-dialog-card-actions')).getByTestId('opencode-model-keys'))
      .toBeInTheDocument();
    expect(quickKeysStrip()).toBeNull();
  });

  it('陰性対照: チャット面でも、選択リストが無ければフッタの帯は今までどおり', async () => {
    window.localStorage.setItem(host.storageKey, 'chat');
    mockPane(AGENT_LIST_OVER_NUMBERED_REPLY, false);
    host.render();

    await waitFor(() => expect(quickKeysStrip()).not.toBeNull());
    expect(screen.queryByTestId('chat-dialog-card')).toBeNull();
  });

  it('陰性対照: ターミナル面は変えない（選択リストが開いていても帯が出る）', async () => {
    window.localStorage.setItem(host.storageKey, 'terminal');
    mockPane(AGENT_LIST_OVER_NUMBERED_REPLY, true);
    host.render();

    await waitFor(() => expect(quickKeysStrip()).not.toBeNull());
    expect(screen.queryByTestId('chat-dialog-card')).toBeNull();
  });
});
