/**
 * 信頼の確認の画面で、UI が「端末で操作が必要（信頼の確認）」と言う（Issue #3758）
 *
 * ## 経路（file:line は確認時点のもの。名前で探すこと）
 *
 * 1. agy の信頼の確認（`Do you trust the contents of this project?` / `> Yes, I trust this
 *    folder` / `No, exit`）は番号が付かないので、`isAntigravityNumberedDialog` が false。
 *    検出器（`tools/antigravity/detect.ts` の `beforePrompt`）は `waiting` /
 *    `antigravity_selection_list`、`hasActivePrompt: false` を返す。prompt としては扱われない
 * 2. `current-output-builder.ts` の `judgeFrame` が `SELECTION_LIST_REASONS` から
 *    `isSelectionListActive: true` を立て、`isPromptWaiting` は false
 * 3. 画面は `isSelectionListActive` から、チャット面では「選択リストが開いています」の帯と
 *    矢印のカード、ターミナル面（PC の分割ペインのフッタ、スマホのドック）では矢印のパッド
 *    だけを出していた。どの面も、これが信頼の確認で、答えるまでエージェントが止まっていること
 *    （Auto-Yes も答えない、#3757）を言わなかった
 *
 * ここでは **本物の `buildCurrentOutput` に実フレーム（`antigravity-live-2364/trust-dialog.txt`）
 * を通した応答** を、そのまま `/current-output` の答えにして、本物の親（PC は
 * `TerminalSplitPaneContent`、スマホは `WorktreeDetailRefactored`）から描く。pane の poll
 * （`useTerminalPanePolling`）も controller も本物で、差し替えるのは tmux の読み取りと `fetch` だけ。
 *
 * 陰性対照: 同じ agy の Switch Model（番号の付かない別の選択）では、帯は今までどおり
 * 「選択リスト」で、注意は出ない。番号付きの dialog（承認）は prompt のままで、選択リストに
 * ならない。
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { render, screen, waitFor, within, cleanup } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import type { AgentInstance } from '@/lib/cli-tools/types';
import {
  getMobileSurfaceModeStorageKey,
  getSplitSurfaceModeStorageKey,
} from '@/config/surface-mode-config';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

// ---------------------------------------------------------------------------
// 足場（selection-list-surfaces-3305 と同じ。pane の poll は差し替えない）
// ---------------------------------------------------------------------------

const { mobileFlag } = vi.hoisted(() => ({ mobileFlag: { value: false } }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-3758',
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
  ChatTranscript: () => (
    <div data-testid="chat-transcript">
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({ visible: true, width: 40, toggle: vi.fn(), setWidth: vi.fn() }),
  DEFAULT_HISTORY_WIDTH: 40,
}));

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()) }),
  SPLIT_MESSAGES_POLL_INTERVAL_MS: 5000,
}));

import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';

// ---------------------------------------------------------------------------
// サーバーの応答: 本物の buildCurrentOutput に実フレームを通す
// ---------------------------------------------------------------------------

const LIVE_2364 = path.resolve(__dirname, '../../../fixtures/antigravity-live-2364');
const capture = (name: string): string => fs.readFileSync(path.join(LIVE_2364, name), 'utf-8');

const WORKTREE_ID = 'wt-3758';
const AGY = 'antigravity' as const;
const NAV_TOOLBAR = 'worktree.navigation.toolbarLabel';
const TRUST_BANNER = 'worktree.chatSurface.reasonTrustConfirmation';
const SELECTION_BANNER = 'worktree.chatSurface.reasonSelectionList';
const TRUST_NOTICE = 'worktree.trustConfirmation.notice';

type Payload = Record<string, unknown>;

/**
 * `/current-output` が返す本文。tmux の読み取り（`captureSessionOutput`）だけを差し替え、
 * 検出・判定・組み立ては本物。Auto-Yes は既定で、事象のときと同じく有効にしておく。
 * JSON を一度通すのは、route が返す形（`NextResponse.json`）と同じにするため。
 */
async function serverPayload(pane: string, autoYes = true): Promise<Payload> {
  vi.resetModules();
  vi.doMock('@/lib/db', () => ({
    getSessionState: vi.fn(() => null),
    createMessage: vi.fn(),
  }));
  vi.doMock('@/lib/cli-tools/manager', () => ({
    CLIToolManager: {
      getInstance: () => ({
        getTool: () => ({ getSessionName: () => 'mcbd-test-3758', isRunning: async () => true }),
      }),
    },
  }));
  vi.doMock('@/lib/session/cli-session', () => ({
    captureSessionOutput: vi.fn(async () => pane),
  }));
  vi.doMock('@/lib/polling/auto-yes-manager', () => ({
    getAutoYesState: vi.fn(() =>
      autoYes ? { enabled: true, enabledAt: Date.now(), expiresAt: Date.now() + 3_600_000 } : null,
    ),
    buildCompositeKey: (worktreeId: string, cliToolId: string, instanceId?: string) =>
      `${worktreeId}:${cliToolId}:${instanceId ?? cliToolId}`,
    getLastServerResponseTimestamp: vi.fn(() => null),
    isPollerActive: vi.fn(() => true),
  }));
  try {
    const { buildCurrentOutput } = await import('@/lib/session/current-output-builder');
    const payload = await buildCurrentOutput({} as never, WORKTREE_ID, AGY);
    return JSON.parse(JSON.stringify(payload)) as Payload;
  } finally {
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/cli-tools/manager');
    vi.doUnmock('@/lib/session/cli-session');
    vi.doUnmock('@/lib/polling/auto-yes-manager');
  }
}

let TRUST_PAYLOAD: Payload;
let SWITCH_MODEL_PAYLOAD: Payload;
let NUMBERED_DIALOG_PAYLOAD: Payload;

beforeAll(async () => {
  TRUST_PAYLOAD = await serverPayload(capture('trust-dialog.txt'));
  SWITCH_MODEL_PAYLOAD = await serverPayload(capture('picker-switch-model.txt'));
  // Auto-Yes が答える番号付きの dialog は PromptPanel を隠す（#2870）ので、ここは無効で。
  NUMBERED_DIALOG_PAYLOAD = await serverPayload(capture('dialog-create-file.txt'), false);
}, 120_000);

afterAll(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// fetch: 画面の poll も pane の poll も、同じ応答を受け取る
// ---------------------------------------------------------------------------

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

function installFetch(payload: Payload): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const u = String(url);
      if (u.includes('/current-output')) return Promise.resolve(jsonResponse(payload));
      if (u.includes('/special-keys')) return Promise.resolve(jsonResponse({ success: true }));
      if (u.includes('/api/relays')) return Promise.resolve(jsonResponse({ relays: [] }));
      if (u.includes('/messages')) return Promise.resolve(jsonResponse([]));
      if (u.includes('/tasks')) return Promise.resolve(jsonResponse({ tasks: [] }));
      if (u.includes('/verify/runs')) return Promise.resolve(jsonResponse({ runs: [] }));
      return Promise.resolve(
        jsonResponse({
          id: WORKTREE_ID,
          name: 'fix/3758',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
          agentInstances: [{ id: AGY, cliTool: AGY, alias: AGY, order: 0 }],
          sessionStatusByCli: {
            [AGY]: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
          },
        }),
      );
    }),
  );
}

function inst(): AgentInstance {
  return { id: AGY, cliTool: AGY, alias: AGY, order: 0 };
}

// ---------------------------------------------------------------------------
// 面
// ---------------------------------------------------------------------------

async function mountPc(payload: Payload, surface: 'terminal' | 'chat'): Promise<void> {
  mobileFlag.value = false;
  if (surface === 'chat') {
    window.localStorage.setItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0), 'chat');
  }
  installFetch(payload);
  render(
    <TerminalSplitPaneContent
      worktreeId={WORKTREE_ID}
      splitIndex={0}
      cliToolId={AGY}
      availableInstances={[inst()]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
    />,
  );
}

async function mountPhone(payload: Payload, surface: 'terminal' | 'chat'): Promise<void> {
  mobileFlag.value = true;
  window.localStorage.setItem(`activeCliTab-${WORKTREE_ID}`, AGY);
  window.localStorage.setItem(`activeInstanceId-${WORKTREE_ID}`, AGY);
  if (surface === 'chat') {
    window.localStorage.setItem(getMobileSurfaceModeStorageKey(WORKTREE_ID), 'chat');
  }
  installFetch(payload);
  render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  mobileFlag.value = false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

// ===========================================================================
// 応答（検出の結果）
// ===========================================================================

describe('[#3758] サーバーの応答: 信頼の確認は選択リストで、prompt ではない', () => {
  it('trust-dialog.txt: waiting / antigravity_selection_list、prompt は無い', () => {
    expect(TRUST_PAYLOAD.sessionStatus).toBe('waiting');
    expect(TRUST_PAYLOAD.sessionStatusReason).toBe('antigravity_selection_list');
    expect(TRUST_PAYLOAD.isSelectionListActive).toBe(true);
    expect(TRUST_PAYLOAD.isPromptWaiting).toBe(false);
    expect(TRUST_PAYLOAD.startingSince ?? null).toBeNull();
    expect(String(TRUST_PAYLOAD.fullOutput)).toContain('Do you trust the contents of this project?');
  });

  it('陰性対照の応答: Switch Model は選択リスト、番号付きの dialog は prompt', () => {
    expect(SWITCH_MODEL_PAYLOAD.isSelectionListActive).toBe(true);
    expect(NUMBERED_DIALOG_PAYLOAD.isSelectionListActive).toBe(false);
    expect(NUMBERED_DIALOG_PAYLOAD.isPromptWaiting).toBe(true);
  });
});

// ===========================================================================
// PC
// ===========================================================================

describe('[#3758] PC（TerminalSplitPaneContent から）', () => {
  it('ターミナル面: フッタのパッドの上に「端末で操作が必要（信頼の確認）」が出る', async () => {
    await mountPc(TRUST_PAYLOAD, 'terminal');
    const footer = screen.getByTestId('split-footer-0');
    await waitFor(() => within(footer).getByRole('toolbar', { name: NAV_TOOLBAR }));
    expect(within(footer).getByTestId('selection-trust-notice')).toHaveTextContent(TRUST_NOTICE);
  });

  it('チャット面: 帯が信頼の確認の文になり、カードと矢印は今までどおり出る', async () => {
    await mountPc(TRUST_PAYLOAD, 'chat');
    const banner = await screen.findByTestId('chat-surface-terminal-banner');
    await waitFor(() => expect(banner).toHaveTextContent(TRUST_BANNER));
    expect(banner).toHaveAttribute('data-reason', 'selectionList');
    expect(banner).toHaveAttribute('data-trust-confirmation', 'true');
    const card = screen.getByTestId('chat-dialog-card');
    expect(card).toHaveTextContent('Yes, I trust this folder');
    expect(within(card).getByRole('toolbar', { name: NAV_TOOLBAR })).toBeInTheDocument();
    // 同じことを 2 度言わない: カードの中には注意を出さない。
    expect(screen.queryByTestId('selection-trust-notice')).toBeNull();
  });

  it('陰性: Switch Model では帯は「選択リスト」のままで、注意は出ない', async () => {
    await mountPc(SWITCH_MODEL_PAYLOAD, 'chat');
    const banner = await screen.findByTestId('chat-surface-terminal-banner');
    await waitFor(() => expect(banner).toHaveTextContent(SELECTION_BANNER));
    expect(banner).not.toHaveAttribute('data-trust-confirmation');
    cleanup();
    window.localStorage.clear();

    await mountPc(SWITCH_MODEL_PAYLOAD, 'terminal');
    const footer = screen.getByTestId('split-footer-0');
    await waitFor(() => within(footer).getByRole('toolbar', { name: NAV_TOOLBAR }));
    expect(within(footer).queryByTestId('selection-trust-notice')).toBeNull();
  });

  it('陰性: 番号付きの dialog は今までどおり prompt で、帯も注意も出ない', async () => {
    await mountPc(NUMBERED_DIALOG_PAYLOAD, 'terminal');
    // PromptPanel が番号付きの選択肢を出す（今までどおり）。
    const panel = await screen.findByTestId('prompt-panel');
    await waitFor(() => expect(panel).toHaveTextContent('Allow creation of this file?'));
    expect(screen.queryByRole('toolbar', { name: NAV_TOOLBAR })).toBeNull();
    expect(screen.queryByTestId('selection-trust-notice')).toBeNull();
    expect(screen.queryByTestId('chat-surface-terminal-banner')).toBeNull();
  });
});

// ===========================================================================
// スマホ
// ===========================================================================

describe('[#3758] スマホ（WorktreeDetailRefactored から）', () => {
  it('ターミナル面: ドックのパッドの上に「端末で操作が必要（信頼の確認）」が出る', async () => {
    await mountPhone(TRUST_PAYLOAD, 'terminal');
    await waitFor(() => {
      expect(screen.getAllByRole('toolbar', { name: NAV_TOOLBAR })).toHaveLength(1);
    });
    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('selection-trust-notice')).toHaveTextContent(TRUST_NOTICE),
    );
    expect(screen.getAllByTestId('selection-trust-notice')).toHaveLength(1);
  });

  it('チャット面: 帯が信頼の確認の文になる', async () => {
    await mountPhone(TRUST_PAYLOAD, 'chat');
    const banner = await screen.findByTestId('chat-surface-terminal-banner', {}, { timeout: 5000 });
    await waitFor(() => expect(banner).toHaveTextContent(TRUST_BANNER));
    expect(banner).toHaveAttribute('data-trust-confirmation', 'true');
    expect(screen.getByTestId('chat-dialog-card')).toHaveTextContent('Yes, I trust this folder');
  });

  it('陰性: Switch Model ではドックに注意は出ない', async () => {
    await mountPhone(SWITCH_MODEL_PAYLOAD, 'terminal');
    await waitFor(() => {
      expect(screen.getAllByRole('toolbar', { name: NAV_TOOLBAR })).toHaveLength(1);
    });
    expect(screen.queryByTestId('selection-trust-notice')).toBeNull();
  });
});
