/**
 * 対象（ツール・インスタンス）を切り替えた直後のモードのボタン — 同じ事例を PC とスマホに当てる（Issue #3304）
 *
 * `shift+tab` は、許可ダイアログの上では「このセッションの全編集を許可」になる（#2592）。
 * だからボタンは、いま見ているエージェントの枠が `ready` だと分かっているときだけ押せる。
 * 対象が変わった直後は、新しい対象についてまだ何も届いていないので、押せてはいけない。
 *
 * ゲートの入力を持っているのは、PC では pane のフック（`useTerminalPanePolling`）、スマホでは
 * 画面のコントローラー（`useWorktreeDetailController`）。直す前は PC だけが対象の切り替えで
 * 入力を戻していて、スマホは前のエージェントの `ready` と前のモードを持ち越していた
 * （同じツールの別インスタンスへの切り替えでは、後始末そのものが走らなかった）。
 * 片方だけが漏れる形を固定するために、同じ事例の表を両方の面に当てる。
 *
 * どちらの面も、本番の配線（`TerminalSplitPaneContent` / `WorktreeDetailRefactored`）と同じ
 * 渡し方で本物の `AgentModeControl` を描く。見るのは属性だけではない: ボタンを押しても
 * `/special-keys` が飛ばないことまで確かめる（#2592 のテストと同じ理由）。
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const viewport = vi.hoisted(() => ({ mobile: true }));
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => viewport.mobile,
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

// 切断中の realtime。pane のフックは HTTP の poll だけで動く（push の経路は #2240 / #2592 のテストが見る）。
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

import { AgentModeControl } from '@/components/worktree/AgentModeControl';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';
import type { CLIToolType } from '@/lib/cli-tools/types';

// ---------------------------------------------------------------------------
// The agents, and what their panes say
// ---------------------------------------------------------------------------

const WORKTREE_ID = 'wt-3304';

interface Target {
  cliTool: CLIToolType;
  instance: string;
}

const CLAUDE: Target = { cliTool: 'claude', instance: 'claude' };
const CODEX: Target = { cliTool: 'codex', instance: 'codex' };
const CLAUDE_2: Target = { cliTool: 'claude', instance: 'claude-2' };

const ROSTER = [
  { id: 'claude', cliTool: 'claude', order: 0 },
  { id: 'codex', cliTool: 'codex', order: 1 },
  { id: 'claude-2', cliTool: 'claude', alias: 'Review', order: 2 },
];

const FIXTURES = path.resolve(__dirname, '../../fixtures/agent-mode-2592');
const frame = (name: string): string =>
  fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf-8');

type Body = Record<string, unknown>;

/**
 * 入力待ちで止まっている pane。モードは 2 通りで運ぶ: PC は枠（`fullOutput`）から読み、
 * スマホは payload の `agentMode` を読む（#2592）。
 */
const atRest = (target: Target, fixture: string, mode: string): Body => ({
  isRunning: true,
  cliToolId: target.cliTool,
  sessionStatus: 'ready',
  thinking: false,
  isPromptWaiting: false,
  isSelectionListActive: false,
  isPagerActive: false,
  isDismissablePanelActive: false,
  isUnclassifiedActive: false,
  fullOutput: frame(fixture),
  realtimeSnippet: frame(fixture),
  agentMode: mode,
});

/** 許可ダイアログを出している pane。`shift+tab` が「全編集を許可」になる枠。 */
const dialogOnScreen = (target: Target): Body => ({
  isRunning: true,
  cliToolId: target.cliTool,
  sessionStatus: 'waiting',
  thinking: false,
  isPromptWaiting: false,
  isSelectionListActive: true,
  isPagerActive: false,
  isDismissablePanelActive: false,
  isUnclassifiedActive: false,
  fullOutput: 'Do you want to make this edit?\n❯ 1. Yes\n  2. Yes, allow all edits during this session (shift+tab)\n  3. No',
  realtimeSnippet: '',
  agentMode: 'unknown',
});

// ---------------------------------------------------------------------------
// A server whose `/current-output` answers can be held back
// ---------------------------------------------------------------------------

interface PendingOutput {
  target: Target;
  reply: (body: Body) => void;
}

const server = {
  /** すぐ答える対象と、その答え。ここに無い対象への要求は `pending` に溜まる。 */
  live: new Map<string, Body>(),
  pending: [] as PendingOutput[],
  specialKeys: [] as Body[],
};

const keyOf = (target: Target): string => `${target.cliTool}/${target.instance}`;
const isFor = (target: Target) => (p: PendingOutput): boolean => keyOf(p.target) === keyOf(target);

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

function installServer(): void {
  server.live.clear();
  server.pending = [];
  server.specialKeys = [];
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    if (url.pathname.endsWith('/current-output')) {
      const cliTool = (url.searchParams.get('cliTool') ?? '') as CLIToolType;
      // `instance` の無い要求は、そのツールの primary を指す（PC の親 poll の形）。
      const target: Target = { cliTool, instance: url.searchParams.get('instance') ?? cliTool };
      const now = server.live.get(keyOf(target));
      if (now) return Promise.resolve(jsonResponse(now));
      return new Promise<Response>((resolve) => {
        server.pending.push({ target, reply: (body) => resolve(jsonResponse(body)) });
      });
    }
    if (url.pathname.endsWith('/special-keys')) {
      server.specialKeys.push(JSON.parse(String(init?.body)) as Body);
      return Promise.resolve(jsonResponse({ success: true }));
    }
    if (url.pathname.endsWith('/messages')) return Promise.resolve(jsonResponse([]));
    if (url.pathname.endsWith('/auto-yes')) return Promise.resolve(jsonResponse({ instances: {} }));
    return Promise.resolve(jsonResponse({
      id: WORKTREE_ID,
      name: 'feature/3304',
      path: '/repo/3304',
      repositoryPath: '/repo',
      repositoryName: 'Repo',
      selectedAgents: ['claude', 'codex'],
      agentInstances: ROSTER,
    }));
  }));
}

/** 溜めておいた要求に答えて、応答が state に届く（か、捨てられる）まで待つ。 */
async function answer(requests: PendingOutput[], body: Body): Promise<void> {
  await act(async () => {
    for (const request of requests) {
      server.pending.splice(server.pending.indexOf(request), 1);
      request.reply(body);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

// ---------------------------------------------------------------------------
// The two surfaces
// ---------------------------------------------------------------------------

interface Surface {
  /** `target` を開き、最初の応答が届くまで待つ。 */
  open: (target: Target) => Promise<void>;
  switchTo: (target: Target) => void;
  /** いまの対象へ、もう 1 回取りにいく（応答は `server` が握る）。 */
  pollNow: () => void;
}

/** PC: split の pane。`TerminalSplitPaneContent` の `agentModeSlot` と同じ渡し方。 */
function pcSurface(): Surface {
  let refresh: () => Promise<void> = async () => {};
  let rerender: (ui: React.ReactElement) => void = () => {};

  function Pane({ target }: { target: Target }) {
    const pane = useTerminalPanePolling({
      worktreeId: WORKTREE_ID,
      cliToolId: target.cliTool,
      instanceId: target.instance,
    });
    refresh = pane.refresh;
    return (
      <AgentModeControl
        worktreeId={WORKTREE_ID}
        cliToolId={target.cliTool}
        instanceId={target.instance}
        agentMode={pane.terminal.agentMode}
        sessionStatus={pane.terminal.sessionStatus}
        isPromptWaiting={pane.prompt.visible}
        isSelectionListActive={pane.terminal.isSelectionListActive}
        isDismissablePanelActive={pane.terminal.isDismissablePanelActive}
        isUnclassifiedActive={pane.terminal.isUnclassifiedActive}
        onKeysSent={pane.refresh}
      />
    );
  }

  return {
    open: async (target) => {
      rerender = render(<Pane target={target} />).rerender;
    },
    switchTo: (target) => {
      rerender(<Pane target={target} />);
    },
    pollNow: () => {
      act(() => { void refresh(); });
    },
  };
}

type Controller = ReturnType<typeof useWorktreeDetailController>;

/** スマホ: 画面のコントローラー。`WorktreeDetailRefactored` の `agentModeSlot` と同じ渡し方。 */
function Phone({ worktreeId, onRender }: { worktreeId: string; onRender: (c: Controller) => void }) {
  const controller = useWorktreeDetailController({ worktreeId });
  onRender(controller);
  return (
    <AgentModeControl
      worktreeId={worktreeId}
      cliToolId={controller.activeCliTab}
      instanceId={controller.activeInstanceId}
      agentMode={controller.agentMode}
      sessionStatus={controller.sessionStatus}
      isPromptWaiting={controller.state.prompt.visible}
      isSelectionListActive={controller.isSelectionListActive}
      isDismissablePanelActive={controller.isDismissablePanelActive}
      isUnclassifiedActive={controller.isUnclassifiedActive}
      onKeysSent={controller.fetchCurrentOutput}
    />
  );
}

function phoneSurface(): Surface & { controller: () => Controller; rerender: (worktreeId?: string) => void } {
  let controller: Controller | null = null;
  let rerenderRoot: (ui: React.ReactElement) => void = () => {};
  const onRender = (c: Controller): void => { controller = c; };
  const current = (): Controller => {
    if (!controller) throw new Error('the phone surface is not open');
    return controller;
  };

  return {
    controller: current,
    rerender: (worktreeId = WORKTREE_ID) => {
      rerenderRoot(<Phone worktreeId={worktreeId} onRender={onRender} />);
    },
    open: async (target) => {
      window.localStorage.setItem(`activeInstanceId-${WORKTREE_ID}`, target.instance);
      window.localStorage.setItem(`activeCliTab-${WORKTREE_ID}`, target.cliTool);
      rerenderRoot = render(<Phone worktreeId={WORKTREE_ID} onRender={onRender} />).rerender;
      // 名簿が届く前は alias（`claude-2`）を知らないので、切り替えられない。
      await waitFor(() => expect(current().rosterReady).toBe(true));
    },
    switchTo: (target) => {
      act(() => { current().setActiveInstanceId(target.instance); });
    },
    pollNow: () => {
      act(() => { void current().fetchCurrentOutput(); });
    },
  };
}

// ---------------------------------------------------------------------------
// What the operator sees
// ---------------------------------------------------------------------------

const button = (): HTMLButtonElement =>
  screen.getByTestId('agent-mode-cycle-button') as HTMLButtonElement;

/** ボタンが押せるか、どのモードを表示しているか、チップが出ているか。 */
function gate(): { pressable: boolean; mode: string | null; chip: boolean } {
  return {
    pressable: !button().disabled,
    mode: button().getAttribute('data-agent-mode'),
    chip: screen.queryByTestId('agent-mode-chip') !== null,
  };
}

/** まだ何も届いていない: 押せない・モードは「不明」・チップは出ない。 */
const NOTHING_ARRIVED = { pressable: false, mode: 'unknown', chip: false };

/** 押してみて、キーがブラウザを出ていないことを確かめる。 */
function pressAndExpectNothingSent(): void {
  fireEvent.click(button());
  expect(server.specialKeys).toEqual([]);
}

beforeEach(() => {
  window.localStorage.clear();
  viewport.mobile = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  installServer();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The same cases, on both surfaces
// ---------------------------------------------------------------------------

const SURFACES = [
  ['PC（useTerminalPanePolling）', pcSurface],
  ['スマホ（useWorktreeDetailController）', phoneSurface],
] as const;

const SWITCHES = [
  ['ツールを切り替えた', CODEX],
  ['同じツールの別インスタンスへ切り替えた', CLAUDE_2],
] as const;

describe.each(SURFACES)('[#3304] %s: 対象を切り替えた直後のモードのボタン', (_name, makeSurface) => {
  /** claude を `auto` モードで開き、押せる状態から始める（切り替える前は、今までどおり押せる）。 */
  async function openClaudeAtRest(): Promise<Surface> {
    server.live.set(keyOf(CLAUDE), atRest(CLAUDE, 'claude-auto', 'auto'));
    const surface = makeSurface();
    await surface.open(CLAUDE);
    await waitFor(() => expect(gate()).toEqual({ pressable: true, mode: 'auto', chip: true }));
    // ここから先の `/current-output` は、テストが答えるまで届かない。
    server.live.clear();
    return surface;
  }

  it.each(SWITCHES)('%s直後は、押せず、表示は「不明」', async (_case, next) => {
    const surface = await openClaudeAtRest();

    surface.switchTo(next);

    expect(gate()).toEqual(NOTHING_ARRIVED);
    pressAndExpectNothingSent();
  });

  it.each(SWITCHES)('%s直後に、切り替え先をすぐ取りにいく', async (_case, next) => {
    const surface = await openClaudeAtRest();

    surface.switchTo(next);

    expect(server.pending.filter(isFor(next)).length).toBeGreaterThan(0);
  });

  it.each(SWITCHES)(
    '%s後に、切り替えの前の要求の応答が届いても、押せず、表示は「不明」のまま',
    async (_case, next) => {
      const surface = await openClaudeAtRest();
      surface.pollNow();
      const beforeSwitch = server.pending.filter(isFor(CLAUDE));
      expect(beforeSwitch.length).toBeGreaterThan(0);

      surface.switchTo(next);
      // 前のエージェントは「入力待ち・auto」と答える。採用したら、ボタンは押せてしまう。
      await answer(beforeSwitch, atRest(CLAUDE, 'claude-auto', 'auto'));

      expect(gate()).toEqual(NOTHING_ARRIVED);
      pressAndExpectNothingSent();
    },
  );

  it('切り替え先の最初の応答が「入力待ち」なら、そのモードで押せるようになり、キーは切り替え先へ届く', async () => {
    const surface = await openClaudeAtRest();
    surface.switchTo(CODEX);
    expect(gate()).toEqual(NOTHING_ARRIVED);

    await answer(server.pending.filter(isFor(CODEX)), atRest(CODEX, 'codex-plan', 'plan'));

    await waitFor(() => expect(gate()).toEqual({ pressable: true, mode: 'plan', chip: true }));
    fireEvent.click(button());
    await waitFor(() => expect(server.specialKeys).toEqual([{ cliToolId: 'codex', keys: ['BTab'] }]));
  });

  it('切り替え先の最初の応答が許可ダイアログなら、届いた後も押せない', async () => {
    const surface = await openClaudeAtRest();
    surface.switchTo(CLAUDE_2);
    expect(gate()).toEqual(NOTHING_ARRIVED);

    await answer(server.pending.filter(isFor(CLAUDE_2)), dialogOnScreen(CLAUDE_2));

    await waitFor(() => expect(button().disabled).toBe(true));
    expect(gate().pressable).toBe(false);
    pressAndExpectNothingSent();
  });

  it('対象が変わらなければ戻さない: 同じ対象の次の応答が、そのまま表示を進める', async () => {
    const surface = await openClaudeAtRest();

    surface.pollNow();
    // 応答を待っている間も、前の応答の表示のまま（「まだ何も届いていない」へは戻らない）。
    expect(gate()).toEqual({ pressable: true, mode: 'auto', chip: true });
    await answer(server.pending.filter(isFor(CLAUDE)), atRest(CLAUDE, 'claude-plan', 'plan'));

    await waitFor(() => expect(gate()).toEqual({ pressable: true, mode: 'plan', chip: true }));
  });
});

// ---------------------------------------------------------------------------
// The controller's other ways of changing what it polls
// ---------------------------------------------------------------------------

describe('[#3304] コントローラー: 取りにいく対象が変わる、ほかの経路', () => {
  it('PC の幅では、同じツールの別インスタンスへ切り替えても戻さない（親 poll はツール単位で、対象は変わっていない）', async () => {
    viewport.mobile = false;
    server.live.set(keyOf(CLAUDE), atRest(CLAUDE, 'claude-auto', 'auto'));
    const phone = phoneSurface();
    await phone.open(CLAUDE);
    await waitFor(() => expect(gate()).toEqual({ pressable: true, mode: 'auto', chip: true }));
    server.live.clear();

    phone.switchTo(CLAUDE_2);

    expect(phone.controller().activeInstanceId).toBe('claude-2');
    expect(gate()).toEqual({ pressable: true, mode: 'auto', chip: true });
    expect(server.pending).toEqual([]);
  });

  it('PC の幅でも、ツールを切り替えたら戻して取り直す', async () => {
    viewport.mobile = false;
    server.live.set(keyOf(CLAUDE), atRest(CLAUDE, 'claude-auto', 'auto'));
    const phone = phoneSurface();
    await phone.open(CLAUDE);
    await waitFor(() => expect(gate()).toEqual({ pressable: true, mode: 'auto', chip: true }));
    server.live.clear();

    phone.switchTo(CODEX);

    expect(gate()).toEqual(NOTHING_ARRIVED);
    expect(server.pending.filter(isFor(CODEX)).length).toBeGreaterThan(0);
  });

  it('PC の幅で primary を取っていた画面がスマホの幅になり、見ているのが別インスタンスなら、戻して取り直す', async () => {
    // PC の親 poll は `instance` を付けないので、届いているのは primary（claude）の状態。
    // スマホの幅では、同じ画面が `claude-2` を取りにいく。
    viewport.mobile = false;
    server.live.set(keyOf(CLAUDE), atRest(CLAUDE, 'claude-auto', 'auto'));
    const phone = phoneSurface();
    await phone.open(CLAUDE);
    await waitFor(() => expect(gate()).toEqual({ pressable: true, mode: 'auto', chip: true }));
    phone.switchTo(CLAUDE_2);
    expect(gate()).toEqual({ pressable: true, mode: 'auto', chip: true });
    server.live.clear();

    viewport.mobile = true;
    phone.rerender();

    expect(gate()).toEqual(NOTHING_ARRIVED);
    pressAndExpectNothingSent();
    expect(server.pending.filter(isFor(CLAUDE_2)).length).toBeGreaterThan(0);
  });

  it('幅が変わっても、見ているのが primary なら戻さない（取りにいく対象は同じ）', async () => {
    viewport.mobile = false;
    server.live.set(keyOf(CLAUDE), atRest(CLAUDE, 'claude-auto', 'auto'));
    const phone = phoneSurface();
    await phone.open(CLAUDE);
    await waitFor(() => expect(gate()).toEqual({ pressable: true, mode: 'auto', chip: true }));

    viewport.mobile = true;
    phone.rerender();

    expect(gate()).toEqual({ pressable: true, mode: 'auto', chip: true });
  });

  it('別の worktree へ変わったら、戻す', async () => {
    server.live.set(keyOf(CLAUDE), atRest(CLAUDE, 'claude-auto', 'auto'));
    const phone = phoneSurface();
    await phone.open(CLAUDE);
    await waitFor(() => expect(gate()).toEqual({ pressable: true, mode: 'auto', chip: true }));
    server.live.clear();

    phone.rerender('wt-3304-other');

    expect(gate()).toEqual(NOTHING_ARRIVED);
    pressAndExpectNothingSent();
  });
});
