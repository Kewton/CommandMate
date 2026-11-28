/**
 * Issue #4535 r6 (INV-V2 rewritten): the table of `retarget-draft-shapes-4535.test.tsx` on the
 * `/sessions` tile and on the discard road. A text the send fence (409 `SEND_TARGET_CHANGED`
 * `not_sent`) handed back — on the first attempt, or by the row's [Discard] after a retry was stopped
 * — in any shape of the draft: while the tile's To is not the original target, Enter once POSTs
 * nothing and asks; the question cancelled POSTs nothing.
 *
 * | shape | expected |
 * |---|---|
 * | only / before / after / between / whitespace / two | asks, POST 0 |
 * | part deleted | either way: one press POSTs at most once |
 *
 * The tile: `target-gone` (another instance). The discard road: `tool-changed` (the same instance id,
 * so the stopped row stays in the tile's history to be discarded). Positive control: the To still
 * the original target — Enter sends at once.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
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
vi.mock('@/hooks/useTerminalPanePolling', () => ({ useTerminalPanePolling: useTerminalPanePollingMock }));
vi.mock('@/hooks/useSplitMessages', () => ({ useSplitMessages: useSplitMessagesMock }));

import { SessionTile } from '@/components/sessions/SessionTile';
import { ToastProvider } from '@/components/common/Toast';
import { resetRevealedStartingTerminals } from '@/hooks/useSessionStartingGate';
import { useWorktreesCache } from '@/hooks/useWorktreesCache';
import type { Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-1';
const TEXT = 'please look at the diff\n\nand run the tests too';
const TEXT2 = 'second stopped send';
const NEXT = 'next thing I typed';

interface Target {
  id: string;
  tool: CLIToolType;
}

function worktree(target: Target): Worktree {
  return {
    id: WT,
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    agentInstances: [{ id: target.id, cliTool: target.tool, alias: '', order: 0 }],
  } as Worktree;
}

function mockPane() {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: '', realtimeSnippet: '', isRunning: true, isThinking: false, sessionStatus: 'ready',
      isSelectionListActive: false, isPagerActive: false, isDismissablePanelActive: false,
      isUnclassifiedActive: false, composerText: '', agentMode: 'unknown', startingSince: null,
      attaching: false, autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(), setPromptAnswering: vi.fn(), clearPrompt: vi.fn(), refresh: vi.fn(),
  });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const posts: Array<Record<string, unknown>> = [];
/** While set, a POST waits for its answer here; otherwise it is created at once. */
let holdAnswers = true;
const answers: Array<(response: Response) => void> = [];

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/worktrees/${WT}/send` && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      if (holdAnswers) return new Promise<Response>((resolve) => answers.push(resolve));
      return json(201, { id: `srv-${posts.length}`, role: 'user', content: 'x', timestamp: new Date().toISOString() });
    }
    if (url.includes('/start-preview')) return json(200, { ok: true, show: false, attended: false });
    // Issue #4606 r3b: the roster the cache's own `refresh()` reads.
    if (url === '/api/worktrees' && shown) return json(200, { worktrees: [worktree(shown.target)], repositories: [] });
    return json(200, {});
  }));
}

function fenceBody(reason: string, original: Target) {
  return {
    error: 'The send target changed',
    code: 'SEND_TARGET_CHANGED',
    reason,
    target: { worktreeId: WT, instanceId: original.id, cliToolId: original.tool },
    current: null,
    requestId: 'r-1',
    sendOutcome: 'not_sent',
  };
}

const PROMPT_WAITING = { error: 'prompt waiting', code: 'PROMPT_WAITING', sendOutcome: 'not_sent' };

const composer = () => within(screen.getByTestId(`session-tile-composer-${WT}`));
const textarea = () => composer().getByTestId('message-input-textarea') as HTMLTextAreaElement;
const pressEnter = () => fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter' });

async function flush(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Issue #4606: the tile rendered by the entry and the To it shows (to read its roster again). */
let shown: { view: ReturnType<typeof render>; target: Target } | null = null;

function Tile({ target, fetched }: { target: Target; fetched?: Worktree }) {
  return (
    <ToastProvider>
      <SessionTile worktree={fetched ?? worktree(target)} enabled />
    </ToastProvider>
  );
}

/** Issue #4606 r3b: a roster fetch through the cache's own `refresh()` that succeeds — the object it adopted. */
async function fetchRoster(): Promise<Worktree> {
  const hook = renderHook(() => useWorktreesCache({ enabled: false }));
  await act(async () => {
    await hook.result.current.refresh();
  });
  const fetched = hook.result.current.worktrees.find((wt) => wt.id === WT);
  hook.unmount();
  return fetched!;
}

type Shape = 'only' | 'before' | 'after' | 'between' | 'whitespace' | 'two' | 'part deleted';

const RESHAPED: Partial<Record<Shape, string>> = {
  after: `${TEXT}\n\n${NEXT}`,
  between: `please look at the diff\n\n${NEXT}\n\nand run the tests too`,
  whitespace: '  please look at the diff \n\n\n\n  and run the tests too\n\n',
  'part deleted': 'please look at the diff',
};

function expectedBack(shape: Shape): string {
  if (shape === 'two') return `${TEXT}\n\n${TEXT2}`;
  if (shape === 'before') return `${NEXT}\n\n${TEXT}`;
  return TEXT;
}

async function sendAll(texts: string[]) {
  for (const text of texts) {
    fireEvent.change(textarea(), { target: { value: text } });
    pressEnter();
    await waitFor(() => expect(textarea().value).toBe(''));
  }
  await waitFor(() => expect(posts).toHaveLength(texts.length));
}

async function answer(i: number, status: number, body: unknown) {
  await act(async () => answers[i](json(status, body)));
  await flush(30);
}

interface Entry {
  name: string;
  /** Brings the text back into the composer; `toChanged` false keeps the original target. */
  arrange(shape: Shape, toChanged: boolean): Promise<void>;
}

/** The tile: the text back on its first attempt (the To changed while it was on its way). */
const TILE: Entry = {
  name: 'the /sessions tile (first attempt)',
  async arrange(shape, toChanged) {
    const original: Target = { id: 'codex-2', tool: 'codex' };
    const current: Target = toChanged ? { id: 'claude', tool: 'claude' } : original;
    const texts = shape === 'two' ? [TEXT, TEXT2] : [TEXT];
    const view = render(<Tile target={original} />);
    shown = { view, target: current };
    await sendAll(texts);
    view.rerender(<Tile target={current} />);
    await flush();
    if (shape === 'before') fireEvent.change(textarea(), { target: { value: NEXT } });
    for (let i = 0; i < texts.length; i += 1) await answer(i, 409, fenceBody('target-gone', original));
  },
};

/** The discard road: a retry stopped by the fence (not handed back), then [Discard]. */
const DISCARD: Entry = {
  name: 'the discard road (a retry stopped, then [Discard])',
  async arrange(shape, toChanged) {
    const original: Target = { id: 'agent-1', tool: 'codex' };
    const current: Target = toChanged ? { id: 'agent-1', tool: 'claude' } : original;
    const texts = shape === 'two' ? [TEXT, TEXT2] : [TEXT];
    const view = render(<Tile target={original} />);
    shown = { view, target: current };
    await sendAll(texts);
    for (let i = 0; i < texts.length; i += 1) await answer(i, 409, PROMPT_WAITING);
    await waitFor(() => expect(screen.getAllByTestId('chat-pending-retry')).toHaveLength(texts.length));
    // Issue #4606 r3b (人の承認 #4606 comment 7183455385): every [retry] is pressed first, then the
    // retries are answered by the fence — a [retry] pressed after the first answer would meet the hold.
    for (let i = 0; i < texts.length; i += 1) {
      fireEvent.click(screen.getAllByTestId('chat-pending-retry')[0]);
      await waitFor(() => expect(posts).toHaveLength(texts.length + i + 1));
    }
    for (let i = 0; i < texts.length; i += 1) await answer(texts.length + i, 409, fenceBody('tool-changed', original));
    expect(textarea().value).toBe('');
    view.rerender(<Tile target={current} />);
    await flush();
    if (shape === 'before') fireEvent.change(textarea(), { target: { value: NEXT } });
    for (let i = 0; i < texts.length; i += 1) {
      fireEvent.click(screen.getAllByTestId('chat-pending-discard')[0]);
      await flush(30);
    }
  },
};

async function arrange(entry: Entry, shape: Shape, toChanged: boolean): Promise<void> {
  await entry.arrange(shape, toChanged);
  await waitFor(() => expect(textarea().value).toBe(expectedBack(shape)));
  const value = RESHAPED[shape];
  if (value !== undefined) fireEvent.change(textarea(), { target: { value } });
  holdAnswers = false;
  posts.length = 0;
}

beforeEach(() => {
  window.localStorage.clear();
  posts.length = 0;
  answers.length = 0;
  holdAnswers = true;
  resetRevealedStartingTerminals();
  useTerminalPanePollingMock.mockReset();
  useSplitMessagesMock.mockReset();
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
  mockPane();
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const ASKING: Shape[] = ['only', 'before', 'after', 'between', 'whitespace', 'two'];

describe.each([TILE, DISCARD])('[#4535 r6 INV-V2] $name: every shape of the draft that holds the text', (entry) => {
  it.each(ASKING)('%s: To changed — Enter once POSTs nothing and asks; cancelled POSTs nothing', async (shape) => {
    await arrange(entry, shape, true);
    const draft = textarea().value;
    pressEnter();
    await flush();
    expect(posts).toHaveLength(0);
    expect(await composer().findByTestId('message-input-retarget-confirm')).toBeInTheDocument();
    fireEvent.click(composer().getByTestId('message-input-retarget-confirm-no'));
    await flush();
    expect(posts).toHaveLength(0);
    expect(textarea().value).toBe(draft);
  });

  it('part deleted: either way, one press POSTs at most once', async () => {
    await arrange(entry, 'part deleted', true);
    pressEnter();
    await flush(30);
    expect(posts.length).toBeLessThanOrEqual(1);
  });

  // Issue #4606 (O-1, 設計書 §3.6 S-1; 人の決定 #4606 comment 7178016428): the To still the original
  // target — the tile holds it until its roster is read again (Enter: POST 0, no question); once read
  // again with the pair still on it, Enter sends to it at once with no question. r3b: the roster read
  // again is a fetch that succeeded after the hold (the cache's own `refresh()`), not a re-render.
  it.each<Shape>(['only', 'before'])('(positive control) %s: the To still the original target — held until the roster is read again, then Enter sends at once', async (shape) => {
    await arrange(entry, shape, false);
    pressEnter();
    await flush(50);
    expect(posts).toHaveLength(0);
    expect(composer().queryByTestId('message-input-retarget-confirm')).toBeNull();
    const fetched = await fetchRoster();
    shown!.view.rerender(<Tile target={shown!.target} fetched={fetched} />);
    await flush();
    pressEnter();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ cliToolId: shown!.target.tool, instanceId: shown!.target.id });
    expect(composer().queryByTestId('message-input-retarget-confirm')).toBeNull();
  });
});
