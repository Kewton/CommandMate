/**
 * 選択リストの操作は、チャット面のカードとターミナル面で同じ（Issue #3305）
 *
 * #2297 は「選択リストのときに出す操作」をチャット面のカードにだけ足した。ターミナル面
 * （PC の分割ペインのフッタ、スマホのドック）は ▲▼◀▶ Enter Esc のままで、Claude の
 * `/model` を確定できるボタンは、利用者の既定のモデル（`~/.claude/settings.json`）を
 * 書き換える `Enter` だけだった。`s`（このセッションのみ）のボタンも、注意文も無かった。
 *
 * ここでは **同じ事例を 3 つの面に当てる**。面ごとに別の suite で「この面にはこれが出る」と
 * 書くと、片方にだけ足した変更は、足した面の suite を緑にしたまま通ってしまう（#2297 が
 * そうだった）。事例は 1 つの表、期待も 1 つの表で、3 つの面がそれを満たすかを見る。
 *
 * 読み取るのは「その面から送れるキー」と「ラベルつきの確定ボタン・注意文があるか」。
 * DOM の形ではない。チャット面は ↵ と「既定に設定」の両方を出したままにしてある
 * （#2297 の suite が固定している。この Issue の契約はチャット面を変えない）ので、
 * `Enter` を送るボタンの数だけは面で違う。その違いは下の「Enter を重ねて出さない」で別に見る。
 *
 * 3 つの面とも本物を描く: 本物の `ChatSurface`、本物の `TerminalSplitPaneContent`、
 * 本物の `WorktreeDetailRefactored`（本物の controller・`MobileContent`・`MobileTerminalTab`）。
 * 差し替えるのは pane の状態（`useTerminalPanePolling`）と `fetch` だけ。
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent, cleanup } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import type { ChatMessage } from '@/types/models';
import { buildRealtimeSnippet } from '@/lib/realtime-snippet';
import { SESSION_SCOPE_KEY, SESSION_SCOPE_KEY_TOOL_IDS } from '@/types/terminal-keys';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

// ---------------------------------------------------------------------------
// 3 つの面を 1 つのファイルで描くための足場
// ---------------------------------------------------------------------------

const { mobileFlag, useTerminalPanePollingMock, useSplitMessagesMock } = vi.hoisted(() => ({
  mobileFlag: { value: false },
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-3305',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mobileFlag.value,
  MOBILE_BREAKPOINT: 768,
}));

vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true,
    width: 288,
    isMobileDrawerOpen: false,
    toggle: vi.fn(),
    setWidth: vi.fn(),
    openMobileDrawer: vi.fn(),
    closeMobileDrawer: vi.fn(),
  }),
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(), isCatalogStale: false,
  }),
}));

vi.mock('@/hooks/useFileTabs', () => ({
  useFileTabs: () => [
    { tabs: [], activeIndex: null },
    {
      dispatch: vi.fn(),
      openFile: vi.fn().mockReturnValue('opened'),
      closeTab: vi.fn(),
      activateTab: vi.fn(),
      onFileRenamed: vi.fn(),
      onFileDeleted: vi.fn(),
      moveToFront: vi.fn(),
    },
  ],
}));

vi.mock('@/components/error/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

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
  ChatTranscript: ({ messages }: { messages: ChatMessage[] }) => (
    <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({ visible: true, width: 40, toggle: vi.fn(), setWidth: vi.fn() }),
  DEFAULT_HISTORY_WIDTH: 40,
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

import { ChatSurface, type ChatSurfaceLiveState } from '@/components/worktree/ChatSurface';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';

// ---------------------------------------------------------------------------
// フレーム（実機の capture）
// ---------------------------------------------------------------------------

const FIXTURES = path.resolve(__dirname, '../../../fixtures/chat-dialog-card-2254');
const capture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

/** claude 2.1.259 の `/model`。フッタは `Enter to set as default · s to use this session only · Esc to cancel`。 */
const CLAUDE_MODEL = capture('claude-model-2-1-259.txt');
/** codex 0.151.0 の `/model`。番号つきの 7 件。フッタは `Press enter to confirm or esc to go back`。 */
const CODEX_MODEL = capture('codex-model-0-151-0.txt');
/** claude 2.1.259 のフォルダの信頼。番号も、セッションだけの確定も無い。 */
const CLAUDE_TRUST = capture('claude-trust-2-1-259.txt');

const WORKTREE_ID = 'wt-3305';
const NAV_TOOLBAR = 'worktree.navigation.toolbarLabel';
const ARROWS = ['Down', 'Left', 'Right', 'Up'];

// ---------------------------------------------------------------------------
// 面から読み取るもの
// ---------------------------------------------------------------------------

/** 1 つの面が、選択リストに対して出している操作。 */
interface OfferedOps {
  /** この面から送れるキー（重複なし、整列済み）。 */
  keys: string[];
  /** 番号キーの数。 */
  numbers: number;
  /** 「このセッションのみ」のボタンがある。 */
  sessionOnly: boolean;
  /** 「既定に設定」のボタンがある。 */
  setDefault: boolean;
  /** 「Enter は既定を書き換える」の注意文がある。 */
  warning: boolean;
}

function readOps(scope: HTMLElement): OfferedOps {
  const pad = within(scope).getByRole('toolbar', { name: NAV_TOOLBAR });
  const padKeys = within(pad)
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? '');
  const numberRow = within(scope).queryByTestId('selection-number-keys');
  const numberKeys = numberRow
    ? within(numberRow)
        .getAllByRole('button')
        .map((button) => button.textContent ?? '')
    : [];
  const sessionOnly = within(scope).queryByTestId('selection-commit-session') !== null;
  const setDefault = within(scope).queryByTestId('selection-commit-default') !== null;
  const keys = new Set<string>([
    ...padKeys,
    ...numberKeys,
    ...(sessionOnly ? [SESSION_SCOPE_KEY] : []),
    ...(setDefault ? ['Enter'] : []),
  ]);
  return {
    keys: [...keys].sort(),
    numbers: numberKeys.length,
    sessionOnly,
    setDefault,
    warning: within(scope).queryByTestId('selection-commit-warning') !== null,
  };
}

/** `Enter` を送るボタンの数（矢印パッドの ↵ と、ラベルつきの「既定に設定」）。 */
function enterControlCount(scope: HTMLElement): number {
  const pad = within(scope).getByRole('toolbar', { name: NAV_TOOLBAR });
  const padEnter = within(pad).queryByRole('button', { name: 'Enter' }) !== null ? 1 : 0;
  const labelled = within(scope).queryByTestId('selection-commit-default') !== null ? 1 : 0;
  return padEnter + labelled;
}

// ---------------------------------------------------------------------------
// pane の状態と fetch
// ---------------------------------------------------------------------------

interface PaneFlags {
  isSelectionListActive?: boolean;
  isPagerActive?: boolean;
}

/** タブ・分割ペインが自分の poll で持っている pane の状態。 */
function mockPane(frame: string, flags: PaneFlags = {}): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: frame,
      realtimeSnippet: frame,
      isRunning: true,
      isThinking: false,
      sessionStatus: 'waiting',
      isSelectionListActive: flags.isSelectionListActive ?? true,
      isPagerActive: flags.isPagerActive ?? false,
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
  useSplitMessagesMock.mockReturnValue({
    messages: [],
    isLoading: false,
    refresh: vi.fn(() => Promise.resolve()),
  });
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: `http://localhost/api/worktrees/${WORKTREE_ID}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** `/special-keys` へ送られた本文。面をまたいで、送られたキーをここで見る。 */
let keyPosts: Array<{ cliToolId: string; keys: string[]; instanceId?: string }> = [];

/**
 * 画面自身の `/current-output` poll（スマホのドックの pad を立てるのはこの応答）と、
 * `/special-keys` の記録。`screenFlags` は画面の poll が見た状態で、タブの poll
 * （`mockPane`）とは別に与えられる — 実機でも 2 つは別々に届く。
 */
function installFetch(frame: string, cliToolId: CLIToolType, screenFlags: PaneFlags = {}): void {
  keyPosts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/special-keys')) {
        keyPosts.push(JSON.parse(String(init?.body ?? '{}')));
        return Promise.resolve(jsonResponse({ success: true }));
      }
      if (u.includes('/current-output')) {
        return Promise.resolve(
          jsonResponse({
            isRunning: true,
            cliToolId,
            fullOutput: frame,
            realtimeSnippet: buildRealtimeSnippet(frame),
            thinking: false,
            sessionStatus: 'waiting',
            isSelectionListActive: screenFlags.isSelectionListActive ?? true,
            isPagerActive: screenFlags.isPagerActive ?? false,
            isUnclassifiedActive: false,
            isPromptWaiting: false,
            promptData: null,
          }),
        );
      }
      if (u.includes('/api/relays')) return Promise.resolve(jsonResponse({ relays: [] }));
      if (u.includes('/messages')) return Promise.resolve(jsonResponse([]));
      if (u.includes('/tasks')) return Promise.resolve(jsonResponse({ tasks: [] }));
      if (u.includes('/verify/runs')) return Promise.resolve(jsonResponse({ runs: [] }));
      return Promise.resolve(
        jsonResponse({
          id: WORKTREE_ID,
          name: 'feature/3305',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
          agentInstances: [{ id: cliToolId, cliTool: cliToolId, alias: cliToolId, order: 0 }],
          sessionStatusByCli: {
            [cliToolId]: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
          },
        }),
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// 3 つの面
// ---------------------------------------------------------------------------

interface SurfaceInput {
  cliToolId: CLIToolType;
  frame: string;
  /** タブ・分割ペインの poll が見た状態（既定: 選択リスト）。 */
  pane?: PaneFlags;
  /** スマホの画面の poll が見た状態（既定: `pane` と同じ）。 */
  screen?: PaneFlags;
}

interface Surface {
  name: string;
  /** 面を描き、選択リストの操作が出る範囲を返す。 */
  mount: (input: SurfaceInput) => Promise<HTMLElement>;
}

const SELECTION_LIST: ChatSurfaceLiveState = {
  isRunning: true,
  sessionStatus: 'waiting',
  isThinking: false,
  isPromptWaiting: false,
  promptData: null,
  isSelectionListActive: true,
  isPagerActive: false,
  isUnclassifiedActive: false,
};

const CHAT_CARD: Surface = {
  name: 'チャット面のカード',
  mount: async ({ cliToolId, frame }) => {
    installFetch(frame, cliToolId);
    render(
      <ChatSurface
        messages={[]}
        worktreeId={WORKTREE_ID}
        cliToolId={cliToolId}
        live={SELECTION_LIST}
        onSurfaceModeChange={vi.fn()}
        frame={frame}
      />,
    );
    return screen.getByTestId('chat-dialog-card-actions');
  },
};

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

const PC_FOOTER: Surface = {
  name: 'ターミナル面: PC のフッタ',
  mount: async ({ cliToolId, frame, pane }) => {
    mobileFlag.value = false;
    mockPane(frame, pane);
    installFetch(frame, cliToolId, pane);
    render(
      <TerminalSplitPaneContent
        worktreeId={WORKTREE_ID}
        splitIndex={0}
        cliToolId={cliToolId}
        availableInstances={[inst(cliToolId)]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        autoYes={{ onToggle: vi.fn() }}
      />,
    );
    const footer = screen.getByTestId('split-footer-0');
    await waitFor(() => within(footer).getByRole('toolbar', { name: NAV_TOOLBAR }));
    // ターミナル表示のまま（チャット面のカードではない）。
    expect(screen.queryByTestId('chat-dialog-card')).not.toBeInTheDocument();
    return footer;
  },
};

const PHONE_DOCK: Surface = {
  name: 'ターミナル面: スマホのドック',
  mount: async ({ cliToolId, frame, pane, screen: screenFlags }) => {
    mobileFlag.value = true;
    // このタブ（＝この instance）を開いた状態から始める。
    window.localStorage.setItem(`activeCliTab-${WORKTREE_ID}`, cliToolId);
    window.localStorage.setItem(`activeInstanceId-${WORKTREE_ID}`, cliToolId);
    mockPane(frame, pane);
    installFetch(frame, cliToolId, screenFlags ?? pane);
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
    await waitFor(() => {
      expect(screen.getAllByRole('toolbar', { name: NAV_TOOLBAR })).toHaveLength(1);
    });
    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-dialog-card')).not.toBeInTheDocument();
    return document.body;
  },
};

const TERMINAL_SURFACES: readonly Surface[] = [PC_FOOTER, PHONE_DOCK];
const SURFACES: readonly Surface[] = [CHAT_CARD, ...TERMINAL_SURFACES];

// ---------------------------------------------------------------------------
// 事例（3 つの面に同じものを当てる）
// ---------------------------------------------------------------------------

interface Case {
  name: string;
  cliToolId: CLIToolType;
  frame: string;
  expected: OfferedOps;
}

const CASES: readonly Case[] = [
  {
    name: 'claude の /model（`s` を受けるツール。Enter は既定のモデルを書き換える）',
    cliToolId: 'claude',
    frame: CLAUDE_MODEL,
    expected: {
      keys: [...ARROWS, 'Enter', 'Escape', SESSION_SCOPE_KEY].sort(),
      // この画面の番号キーは、押した時点で既定を書き換える（#2297 の実測）。出さない。
      numbers: 0,
      sessionOnly: true,
      setDefault: true,
      warning: true,
    },
  },
  {
    name: '`s` を受けないツール（codex）に、同じフッタのフレーム',
    cliToolId: 'codex',
    frame: CLAUDE_MODEL,
    expected: {
      keys: [...ARROWS, 'Enter', 'Escape'].sort(),
      numbers: 0,
      sessionOnly: false,
      setDefault: false,
      warning: false,
    },
  },
  {
    name: '番号つきの選択リスト（codex の /model、7 件）',
    cliToolId: 'codex',
    frame: CODEX_MODEL,
    expected: {
      keys: [...ARROWS, 'Enter', 'Escape', '1', '2', '3', '4', '5', '6', '7'].sort(),
      numbers: 7,
      sessionOnly: false,
      setDefault: false,
      warning: false,
    },
  },
];

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  mobileFlag.value = false;
  keyPosts = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

// ===========================================================================
// 同じ事例 → 同じ操作
// ===========================================================================

describe('[#3305] 選択リストの操作は、3 つの面で同じ', () => {
  it('前提: codex は `s` を宣言していない（事例 2 と 3 の陰性対照が成り立つ条件）', () => {
    expect(SESSION_SCOPE_KEY_TOOL_IDS as readonly string[]).toContain('claude');
    expect(SESSION_SCOPE_KEY_TOOL_IDS as readonly string[]).not.toContain('codex');
  });

  describe.each(CASES)('$name', ({ cliToolId, frame, expected }) => {
    it.each(SURFACES)('$name: 表のとおりの操作を出す', async ({ mount }) => {
      const scope = await mount({ cliToolId, frame });

      await waitFor(() => {
        expect(readOps(scope)).toEqual(expected);
      });
    });

    it('3 つの面を順に描いて比べても、同じ操作になる', async () => {
      const seen: OfferedOps[] = [];
      for (const surface of SURFACES) {
        const scope = await surface.mount({ cliToolId, frame });
        await waitFor(() => {
          expect(readOps(scope)).toEqual(expected);
        });
        seen.push(readOps(scope));
        cleanup();
        window.localStorage.clear();
      }

      expect(seen).toHaveLength(3);
      expect(seen[1]).toEqual(seen[0]);
      expect(seen[2]).toEqual(seen[0]);
    });
  });
});

// ===========================================================================
// ターミナル面で、実際にキーが届く（陽性対照: 直す前はボタンが無い）
// ===========================================================================

describe('[#3305] ターミナル面の claude /model: セッションだけに適用できる', () => {
  it.each(TERMINAL_SURFACES)('$name: 「このセッションのみ」は `s` を送る', async ({ mount }) => {
    const scope = await mount({ cliToolId: 'claude', frame: CLAUDE_MODEL });

    fireEvent.click(await within(scope).findByTestId('selection-commit-session'));

    expect(keyPosts).toEqual([{ cliToolId: 'claude', keys: [SESSION_SCOPE_KEY] }]);
  });

  it.each(TERMINAL_SURFACES)('$name: 「既定に設定」は `Enter` を送る', async ({ mount }) => {
    const scope = await mount({ cliToolId: 'claude', frame: CLAUDE_MODEL });

    fireEvent.click(await within(scope).findByTestId('selection-commit-default'));

    expect(keyPosts).toEqual([{ cliToolId: 'claude', keys: ['Enter'] }]);
  });

  it.each(TERMINAL_SURFACES)('$name: 注意文が出る', async ({ mount }) => {
    const scope = await mount({ cliToolId: 'claude', frame: CLAUDE_MODEL });

    expect(await within(scope).findByTestId('selection-commit-warning')).toBeInTheDocument();
  });
});

// ===========================================================================
// 確定の Enter を 2 つ並べない
// ===========================================================================

describe('[#3305] ターミナル面: 「既定に設定」が出るとき、ラベルの無い Enter を重ねて出さない', () => {
  it.each(TERMINAL_SURFACES)('$name: Enter を送るボタンは「既定に設定」の 1 つだけ', async ({ mount }) => {
    const scope = await mount({ cliToolId: 'claude', frame: CLAUDE_MODEL });
    await within(scope).findByTestId('selection-commit-default');

    const pad = within(scope).getByRole('toolbar', { name: NAV_TOOLBAR });
    expect(within(pad).queryByRole('button', { name: 'Enter' })).not.toBeInTheDocument();
    expect(enterControlCount(scope)).toBe(1);
    // 矢印と Esc は、今までどおり。
    for (const name of ['Left', 'Up', 'Down', 'Right', 'Escape']) {
      expect(within(pad).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  // 陰性対照: Enter を外しているのは「既定に設定」が出ていることで、ツールでもフレームでもない。
  it.each(TERMINAL_SURFACES)(
    '$name: `s` を受けないツールでは、同じフレームでも Enter が残る（今までどおり）',
    async ({ mount }) => {
      const scope = await mount({ cliToolId: 'codex', frame: CLAUDE_MODEL });

      const pad = within(scope).getByRole('toolbar', { name: NAV_TOOLBAR });
      const labels = within(pad)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'));
      expect(labels).toEqual(['Left', 'Up', 'Down', 'Right', 'Enter', 'Escape']);
      expect(within(scope).queryByTestId('selection-commit-keys')).not.toBeInTheDocument();
      expect(within(scope).queryByTestId('selection-number-keys')).not.toBeInTheDocument();
    },
  );

  it.each(TERMINAL_SURFACES)(
    '$name: claude でも、フッタがセッションだけの確定を言わない画面（フォルダの信頼）は今までどおり',
    async ({ mount }) => {
      const scope = await mount({ cliToolId: 'claude', frame: CLAUDE_TRUST });

      const pad = within(scope).getByRole('toolbar', { name: NAV_TOOLBAR });
      const labels = within(pad)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'));
      expect(labels).toEqual(['Left', 'Up', 'Down', 'Right', 'Enter', 'Escape']);
      expect(within(scope).queryByTestId('selection-commit-keys')).not.toBeInTheDocument();
      expect(within(scope).queryByTestId('selection-number-keys')).not.toBeInTheDocument();
    },
  );

  it('チャット面のカードは ↵ と「既定に設定」の両方を出したまま（この Issue では変えない）', async () => {
    const scope = await CHAT_CARD.mount({ cliToolId: 'claude', frame: CLAUDE_MODEL });

    expect(enterControlCount(scope)).toBe(2);
  });
});

// ===========================================================================
// 選択リストでない画面には出さない
// ===========================================================================

describe('[#3305] ターミナル面: ページャには、番号キーも確定ボタンも出さない', () => {
  // ページャは `isSelectionListActive` の部分集合で、同じ pad が出る。本文に `1.` `2.` が
  // あっても選択肢ではないので、番号キーにしない（チャット面はページャを別の分岐で描く）。
  it.each(TERMINAL_SURFACES)('$name: 番号つきのフレームでも PgUp / PgDn だけが足される', async ({ mount }) => {
    const pager = { isSelectionListActive: true, isPagerActive: true };
    const scope = await mount({ cliToolId: 'codex', frame: CODEX_MODEL, pane: pager });

    const pad = within(scope).getByRole('toolbar', { name: NAV_TOOLBAR });
    await waitFor(() => {
      expect(within(pad).getByRole('button', { name: 'Page Up' })).toBeInTheDocument();
    });
    expect(within(pad).getByRole('button', { name: 'Enter' })).toBeInTheDocument();
    expect(within(scope).queryByTestId('selection-number-keys')).not.toBeInTheDocument();
    expect(within(scope).queryByTestId('selection-commit-keys')).not.toBeInTheDocument();
  });
});

describe('[#3305] スマホのドック: タブの poll が選択リストを見ていない間は、今までどおりの pad', () => {
  // ドックの pad を立てるのは画面の poll、フレームを持っているのはタブの poll。2 つは別々に
  // 届くので、画面だけが先に「選択リスト」と言うことがある。そのときタブが持っているのは
  // 選択リストになる前のフレームで、そこから番号キーや確定ボタンを決めてはいけない。
  it('タブのフレームが番号つきでも、タブ自身が選択リストと言うまで番号キーを出さない', async () => {
    const scope = await PHONE_DOCK.mount({
      cliToolId: 'codex',
      frame: CODEX_MODEL,
      pane: { isSelectionListActive: false },
      screen: { isSelectionListActive: true },
    });

    const pad = within(scope).getByRole('toolbar', { name: NAV_TOOLBAR });
    const labels = within(pad)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual(['Left', 'Up', 'Down', 'Right', 'Enter', 'Escape']);
    expect(within(scope).queryByTestId('selection-number-keys')).not.toBeInTheDocument();
    expect(within(scope).queryByTestId('selection-commit-keys')).not.toBeInTheDocument();
  });

  it('タブがページャと言っているフレームは、画面がページャと言っていなくても番号キーにしない', async () => {
    const scope = await PHONE_DOCK.mount({
      cliToolId: 'codex',
      frame: CODEX_MODEL,
      pane: { isSelectionListActive: true, isPagerActive: true },
      screen: { isSelectionListActive: true, isPagerActive: false },
    });

    expect(within(scope).queryByTestId('selection-number-keys')).not.toBeInTheDocument();
    expect(within(scope).queryByTestId('selection-commit-keys')).not.toBeInTheDocument();
  });

  // 陽性対照: 上の 2 つと同じフレームで、2 つの poll がそろって選択リストと言えば出る。
  it('2 つの poll がそろえば、同じフレームから番号キーが出る', async () => {
    const scope = await PHONE_DOCK.mount({ cliToolId: 'codex', frame: CODEX_MODEL });

    const numbers = await within(scope).findByTestId('selection-number-keys');
    expect(numbers).toHaveAttribute('data-option-count', '7');

    fireEvent.click(within(numbers).getByTestId('selection-number-key-7'));
    expect(keyPosts).toEqual([{ cliToolId: 'codex', keys: ['7'] }]);
  });
});
