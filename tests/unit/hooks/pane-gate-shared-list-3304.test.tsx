/**
 * 戻す対象の一覧は 1 つ: PC もスマホも、同じ一覧から始まり、同じ一覧へ戻る（Issue #3304）
 *
 * 直す前は、「まだ何も届いていない」の値を PC の pane のフックとスマホのコントローラーが
 * 別々に書いていて、スマホの側は対象が変わっても `isSelectionListActive` しか戻していなかった。
 * 一覧は `PANE_GATE_NOTHING_ARRIVED`（`src/lib/session/pane-gate-state.ts`）の 1 つになった。
 *
 * ここでは一覧の欄を 1 つずつ、両方の面で確かめる:
 *   1. 何も届く前は、一覧の値である
 *   2. 応答で値が動く（動かせない欄があれば、このテストが古い）
 *   3. 対象が変わったら、一覧の値へ戻る
 * 一覧に欄を足して片方の面が戻さなければ 3 が、応答で書かなければ 2 が落ちる。
 *
 * @vitest-environment jsdom
 */

import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import fs from 'fs';
import path from 'path';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-3304',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => true,
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
}));

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => null,
}));

const realtime = vi.hoisted(() => ({
  status: 'disconnected' as const,
  connected: false,
  subscribe: () => {},
  unsubscribe: () => {},
  addListener: () => () => {},
}));
vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: () => realtime,
}));

import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';
import { PANE_GATE_NOTHING_ARRIVED, type PaneGateState } from '@/lib/session/pane-gate-state';

const WORKTREE_ID = 'wt-3304';
const KEYS = Object.keys(PANE_GATE_NOTHING_ARRIVED) as Array<keyof PaneGateState>;

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const capture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');
const CLAUDE_PLAN = capture('agent-mode-2592/claude-plan.txt');
const PLAN_REVIEW = capture('command-code-plan-review-2763/plan-review-action-focus-approve.txt');

type Body = Record<string, unknown>;

/** 一覧の欄だけを取り出す。 */
function gateOf(state: PaneGateState): PaneGateState {
  return Object.fromEntries(KEYS.map((key) => [key, state[key]])) as unknown as PaneGateState;
}

/** 一覧の値から動いている欄。 */
function movedKeys(state: PaneGateState): string[] {
  return KEYS.filter((key) => !Object.is(state[key], PANE_GATE_NOTHING_ARRIVED[key]));
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

/** `/current-output` の答え。`null` の間は、要求を握ったまま答えない。 */
let currentOutput: Body | null = null;
let requests: string[] = [];

beforeEach(() => {
  window.localStorage.clear();
  currentOutput = null;
  requests = [];
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith('/current-output')) {
      return currentOutput ? Promise.resolve(jsonResponse(currentOutput)) : new Promise<Response>(() => {});
    }
    if (url.pathname.endsWith('/messages')) {
      return Promise.resolve(jsonResponse([
        {
          id: 'm-1',
          worktreeId: WORKTREE_ID,
          role: 'user',
          content: 'hello',
          timestamp: '2026-10-05T00:00:00.000Z',
          messageType: 'normal',
          cliToolId: 'claude',
        },
      ]));
    }
    if (url.pathname.endsWith('/auto-yes')) return Promise.resolve(jsonResponse({ instances: {} }));
    return Promise.resolve(jsonResponse({
      id: WORKTREE_ID,
      name: 'feature/3304',
      path: '/repo/3304',
      repositoryPath: '/repo',
      repositoryName: 'Repo',
      selectedAgents: ['claude', 'codex'],
      agentInstances: [
        { id: 'claude', cliTool: 'claude', order: 0 },
        { id: 'codex', cliTool: 'codex', order: 1 },
        { id: 'claude-2', cliTool: 'claude', alias: 'Review', order: 2 },
      ],
    }));
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('[#3304] PC（useTerminalPanePolling）: 一覧のどの欄も、対象が変わると戻る', () => {
  const mount = () =>
    renderHook(
      ({ instanceId }: { instanceId: string }) =>
        useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId }),
      { initialProps: { instanceId: 'claude' } },
    );

  it('何も届く前は、一覧の値', () => {
    const { result } = mount();
    expect(gateOf(result.current.terminal)).toEqual(PANE_GATE_NOTHING_ARRIVED);
  });

  it('応答で動いた欄が、別インスタンスへ切り替えるとすべて戻る', async () => {
    const moved = new Set<string>();

    // 1 枠目: ダイアログが出ている起動中の pane。分類できない枠（下）とは同時に立たない。
    currentOutput = {
      isRunning: true,
      cliToolId: 'claude',
      sessionStatus: 'waiting',
      fullOutput: CLAUDE_PLAN,
      isSelectionListActive: true,
      isPagerActive: true,
      isDismissablePanelActive: true,
      startingSince: 1_700_000_000_000,
    };
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.terminal.sessionStatus).toBe('waiting'));
    movedKeys(result.current.terminal).forEach((key) => moved.add(key));

    currentOutput = null;
    rerender({ instanceId: 'claude-2' });
    expect(gateOf(result.current.terminal)).toEqual(PANE_GATE_NOTHING_ARRIVED);

    // 2 枠目: 分類できない枠。確定には 2 回続けて、500ms 以上あけて届く必要がある（#1017）。
    currentOutput = { isRunning: true, cliToolId: 'claude', fullOutput: 'unknown TUI', isUnclassifiedActive: true };
    await act(async () => result.current.refresh());
    await new Promise((resolve) => setTimeout(resolve, 550));
    await act(async () => result.current.refresh());
    expect(result.current.terminal.isUnclassifiedActive).toBe(true);
    movedKeys(result.current.terminal).forEach((key) => moved.add(key));

    currentOutput = null;
    rerender({ instanceId: 'claude' });
    expect(gateOf(result.current.terminal)).toEqual(PANE_GATE_NOTHING_ARRIVED);

    // どの欄も、少なくとも 1 回は「動いてから戻った」。
    expect([...moved].sort()).toEqual([...KEYS].sort());
  });
});

describe('[#3304] スマホ（useWorktreeDetailController）: 一覧のどの欄も、対象が変わると戻る', () => {
  const mount = () => renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));

  /** ダイアログが出ている起動中の pane。コントローラーは payload の値をそのまま持つ。 */
  const BUSY: Body = {
    isRunning: true,
    cliToolId: 'claude',
    sessionStatus: 'waiting',
    agentMode: 'plan',
    isSelectionListActive: true,
    isPagerActive: true,
    isDismissablePanelActive: true,
    isUnclassifiedActive: true,
    startingSince: 1_700_000_000_000,
    realtimeSnippet: PLAN_REVIEW,
    fullOutput: PLAN_REVIEW,
    isPromptWaiting: true,
    promptData: { type: 'yes_no', question: 'Continue?', options: ['yes', 'no'], status: 'pending' },
  };

  it('何も届く前は、一覧の値', () => {
    const { result } = mount();
    expect(gateOf(result.current)).toEqual(PANE_GATE_NOTHING_ARRIVED);
    expect(result.current.offersPlanApprove).toBe(false);
  });

  it.each([
    ['ツール', 'codex'],
    ['同じツールの別インスタンス', 'claude-2'],
  ])('応答で動いた欄が、%sを切り替えるとすべて戻る', async (_case, nextInstance) => {
    currentOutput = BUSY;
    const { result } = mount();
    await waitFor(() => {
      expect(result.current.rosterReady).toBe(true);
      expect(result.current.sessionStatus).toBe('waiting');
    });
    // このテストの枠は、一覧のすべての欄を動かしている。
    expect(movedKeys(result.current).sort()).toEqual([...KEYS].sort());
    expect(result.current.offersPlanApprove).toBe(true);

    currentOutput = null;
    act(() => { result.current.setActiveInstanceId(nextInstance); });

    expect(gateOf(result.current)).toEqual(PANE_GATE_NOTHING_ARRIVED);
    // 一覧の外でスマホだけが持つ、枠から読んだ値（#2809）も戻る。
    expect(result.current.offersPlanApprove).toBe(false);
  });

  it('同じツールの別インスタンスへ切り替えると、前のインスタンスの prompt と履歴も消して、取り直す', async () => {
    currentOutput = BUSY;
    const { result } = mount();
    await waitFor(() => {
      expect(result.current.rosterReady).toBe(true);
      expect(result.current.state.prompt.visible).toBe(true);
      expect(result.current.state.messages).toHaveLength(1);
    });

    currentOutput = null;
    requests = [];
    act(() => { result.current.setActiveInstanceId('claude-2'); });

    // 残っていると、claude の問いへの答えが claude-2 へ送られる。
    expect(result.current.state.prompt.visible).toBe(false);
    expect(result.current.state.messages).toEqual([]);
    expect(requests.some((r) => r.includes('/current-output') && r.includes('instance=claude-2'))).toBe(true);
    expect(requests.some((r) => r.includes('/messages') && r.includes('instance=claude-2'))).toBe(true);
  });

  it('前と同じ答えの poll は、再描画を起こさない（欄ごとの useState だったときと同じ）', async () => {
    // prompt の無い枠: prompt は届くたびに messageId が変わり、それだけで再描画になる。
    currentOutput = { isRunning: true, cliToolId: 'claude', sessionStatus: 'ready', agentMode: 'plan' };
    // 依存配列の無い effect は、commit のたびに走る。React が「値が同じ」と見て打ち切った
    // 描画は commit されないので、数に入らない。
    let commits = 0;
    const { result } = renderHook(() => {
      useEffect(() => { commits += 1; });
      return useWorktreeDetailController({ worktreeId: WORKTREE_ID });
    });
    await waitFor(() => {
      expect(result.current.rosterReady).toBe(true);
      expect(result.current.loading).toBe(false);
      expect(result.current.sessionStatus).toBe('ready');
    });
    // 最初の読み込みに続く更新が出つくすまで待つ。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    const before = commits;

    await act(async () => { await result.current.fetchCurrentOutput(); });

    expect(commits).toBe(before);
    expect(result.current.sessionStatus).toBe('ready');
  });
});
