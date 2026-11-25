/**
 * Issue #4535 r7 (INV-V2a〜V2c, 設計書 §3.4.1): a text the send fence (409 `SEND_TARGET_CHANGED`
 * `not_sent`) handed back is bound to its original target in the composer that holds it, and only
 * that composer's own send lets it go. Two or more composers of the same worktree are on screen; a
 * column of steps runs; the last Enter's expectation comes from a small model in this file, never
 * from the shape of the draft:
 *
 * - the model keeps, per composer, the set of original targets of the texts it received
 * - only that composer's send empties its set (another composer's, another tab's, a reload, a
 *   switch, how many texts came back — none of them)
 * - the last Enter: some target in the set is not the composer's To → POST 0 and the question;
 *   otherwise POST 1
 *
 * | # | column (steps) | entries |
 * |---|---|---|
 * | 1 | return(optimistic) → changeTo → otherSend(composer 2, a text holding it, to the original) → Enter | PC pair, phone + PC |
 * | 2 | the same with a short text ("ok") | PC pair, phone + PC |
 * | 3 | return → changeTo → otherTabSend (another tab of the same draft, to the original) → Enter | PC |
 * | 5 | return(awaited) / return(brief) → changeTo → otherSend → Enter | two awaited composers |
 * | 6 | type(before) → return (the 409 late) → changeTo → Enter | PC pair, phone + PC |
 * | 7 | secondReturn: the same text back from X and from Y → To = Y → Enter | PC pair, phone + PC |
 * | 8 | return → changeTo → reload → Enter | PC |
 * | 9 | return into composer 1, then 20 more into composer 2 → Enter in composer 1 | PC |
 * | 10 | (positive control) the To the original: POST 1, then no question; "yes": POST 1 to the To, then no question | PC |
 * | 11 | (negative control) worktree-gone / unknown: no text back, no tag | PC |
 *
 * Column 4 (the discard road) and the `/sessions` tiles are `SessionTile-retarget-tag-columns-4535`.
 * The roads that bring a fence's text into a composer each leave one tag next to its draft
 * (`<draftKey>:retarget`): `onTargetChanged` (here, column 1), `noteFenceRefusal` (column 5), the
 * discard (the tile file).
 *
 * @vitest-environment jsdom
 */

import React, { useState } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import type { ConnectivityState } from '@/hooks/useConnectivity';
import { getSplitSurfaceModeStorageKey } from '@/config/surface-mode-config';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

vi.mock('@/hooks/useConnectivity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useConnectivity')>();
  const online = {
    status: 'online', isOnline: true, isReconnecting: false, isOffline: false, shouldSurface: false,
    signals: { browserOnline: true, realtimeStatus: 'connected', serverReachable: true },
    lastReachableAt: 1, recheck: () => undefined,
  } as ConnectivityState;
  return { ...actual, useConnectivity: () => online };
});

const { sendMessageMock, refreshMock, fetchStartPreviewMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  refreshMock: vi.fn(() => Promise.resolve()),
  fetchStartPreviewMock: vi.fn(),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return { ...actual, worktreeApi: { ...actual.worktreeApi, sendMessage: sendMessageMock } };
});

vi.mock('@/lib/handoff/screen-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handoff/screen-client')>();
  return { ...actual, fetchStartPreview: fetchStartPreviewMock };
});

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: refreshMock }),
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false, error: null,
    filter: '', setFilter: vi.fn(), refresh: vi.fn(), isCatalogStale: false,
  }),
}));

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({ messages }: { messages: ChatMessage[] }) => (
    <div data-testid="chat-transcript">
      {messages.map((m) => (
        <div key={m.id} data-optimistic={m.optimisticState ?? ''}>
          {m.content}
        </div>
      ))}
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

const useTerminalPanePollingMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: (...args: unknown[]) => useTerminalPanePollingMock(...args),
  UNCLASSIFIED_CONFIRMATION_COUNT: 2,
  UNCLASSIFIED_CONFIRMATION_DELAY_MS: 500,
}));

function mockPane(): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'output', realtimeSnippet: 'output', isRunning: true, isThinking: false,
      sessionStatus: 'waiting', isSelectionListActive: false, isPagerActive: false,
      isUnclassifiedActive: false, composerText: '', attaching: false, autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(), setPromptAnswering: vi.fn(), clearPrompt: vi.fn(), refresh: vi.fn(),
  });
}

import { ApiError } from '@/lib/api-client';
import { ToastProvider } from '@/components/common/Toast';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';
import { MessageInput } from '@/components/worktree/MessageInput';
import { WorktreeChatSendProvider, useChatOptimisticSend } from '@/contexts/WorktreeChatSendContext';

const WT = 'wt-4535-tags';
const TEXT = 'please look at the diff';
const NEXT = 'next thing I typed';

interface Target {
  id: string;
  tool: CLIToolType;
}

const X: Target = { id: 'codex-2', tool: 'codex' };
const Y: Target = { id: 'codex-3', tool: 'codex' };
const C: Target = { id: 'claude', tool: 'claude' };

const NOT_SHOWN = { ok: true, show: false, attended: false };
const SHOWN = {
  ok: true,
  show: true,
  attended: true,
  injectOnStart: true,
  mode: 'on',
  boundary: { id: 'b-1', kind: 'launch' },
  preview: { open: { count: 1, unreflected: 1 }, humanQuestions: { count: 0, unknownSources: [] }, lastUpdatedAt: null },
};

function inst(target: Target): AgentInstance {
  return { id: target.id, cliTool: target.tool, alias: '', order: 0 };
}

function fence(reason: string, original: Target, sendOutcome: 'not_sent' | 'unknown' = 'not_sent'): ApiError {
  return new ApiError('The send target changed', 409, {
    error: 'The send target changed',
    code: 'SEND_TARGET_CHANGED',
    reason,
    target: { worktreeId: WT, instanceId: original.id, cliToolId: original.tool },
    current: null,
    requestId: 'r-1',
    sendOutcome,
  });
}

// ---------------------------------------------------------------------------
// The model: per composer, the original targets of the texts it received.
// ---------------------------------------------------------------------------

const targetKey = (t: Target) => `${t.id}\u0000${t.tool}`;

class Model {
  private readonly held = new Map<string, Set<string>>();

  receive(composer: string, original: Target): void {
    const set = this.held.get(composer) ?? new Set<string>();
    set.add(targetKey(original));
    this.held.set(composer, set);
  }

  /** That composer's own send — the only thing that empties its set. */
  sent(composer: string): void {
    this.held.set(composer, new Set());
  }

  asks(composer: string, to: Target): boolean {
    return [...(this.held.get(composer) ?? [])].some((key) => key !== targetKey(to));
  }
}

// ---------------------------------------------------------------------------
// The POSTs: each waits for its answer while `holdAnswers` is set.
// ---------------------------------------------------------------------------

interface Post {
  content: string;
  options: { cliToolId?: string; instanceId?: string };
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const posts: Post[] = [];
let holdAnswers = true;

function installSend(): void {
  sendMessageMock.mockImplementation((_worktreeId: string, content: string, options: Post['options']) => {
    if (!holdAnswers) {
      posts.push({ content, options, resolve: () => undefined, reject: () => undefined });
      return Promise.resolve({ id: `srv-${posts.length}`, role: 'user', content, timestamp: new Date() });
    }
    return new Promise((resolve, reject) => posts.push({ content, options, resolve, reject }));
  });
}

async function flush(ms = 10): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

// ---------------------------------------------------------------------------
// The entries: two composers of the same worktree.
// ---------------------------------------------------------------------------

function PcPane({ index, target }: { index: number; target: Target }) {
  const [insert, setInsert] = useState<string | null>(null);
  return (
    <div data-testid={`composer-${index}`}>
      <TerminalSplitPaneContent
        worktreeId={WT}
        splitIndex={index}
        cliToolId={target.tool}
        instanceId={target.id}
        availableInstances={[inst(target)]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        autoYes={{ onToggle: vi.fn() }}
        history={{ onInsertToMessage: setInsert }}
        pendingInsertText={insert}
        onInsertConsumed={() => setInsert(null)}
      />
    </div>
  );
}

/** Stand-in for `MobileComposer` (`WorktreeDetailRefactored`): `MessageInput` + the registered send. */
function PhoneComposer({ target, insert, onConsumed }: { target: Target; insert: string | null; onConsumed: () => void }) {
  const optimisticSend = useChatOptimisticSend({ cliToolId: target.tool, instanceId: target.id });
  return (
    <MessageInput
      worktreeId={WT}
      cliToolId={target.tool}
      instanceId={target.id}
      isSessionRunning
      pendingInsertText={insert}
      onInsertConsumed={onConsumed}
      onOptimisticSend={optimisticSend}
    />
  );
}

function PhonePane({ target }: { target: Target }) {
  const [insert, setInsert] = useState<string | null>(null);
  return (
    <WorktreeChatSendProvider onInsertToComposer={setInsert}>
      <MobileTerminalTab worktreeId={WT} cliToolId={target.tool} instanceId={target.id} />
      <div data-testid="composer-0">
        <PhoneComposer target={target} insert={insert} onConsumed={() => setInsert(null)} />
      </div>
    </WorktreeChatSendProvider>
  );
}

/** A composer whose sends are awaited (no optimistic history): the phone's terminal view, the brief. */
function AwaitedPane({ index, target }: { index: number; target: Target }) {
  return (
    <div data-testid={`composer-${index}`}>
      <MessageInput worktreeId={WT} splitIndex={index} cliToolId={target.tool} instanceId={target.id} isSessionRunning onMessageSent={vi.fn()} />
    </div>
  );
}

type Pair = [Target, Target];

interface Entry {
  name: string;
  render(to: Pair): React.ReactElement;
  /** After the first mount. */
  ready?(): Promise<void>;
}

const PC_PAIR: Entry = {
  name: 'PC: two splits (TerminalSplitPaneContent 0 and 1)',
  render: (to) => (
    <ToastProvider>
      <PcPane index={0} target={to[0]} />
      <PcPane index={1} target={to[1]} />
    </ToastProvider>
  ),
};

const PHONE_AND_PC: Entry = {
  name: 'phone (MobileTerminalTab chat + the docked composer) and a PC split',
  render: (to) => (
    <ToastProvider>
      <PhonePane target={to[0]} />
      <PcPane index={1} target={to[1]} />
    </ToastProvider>
  ),
  async ready() {
    fireEvent.click(screen.getByTestId('mobile-surface-mode-chat'));
    await waitFor(() => expect(screen.getByTestId('mobile-chat-surface')).toBeInTheDocument());
  },
};

const AWAITED_PAIR: Entry = {
  name: 'two awaited composers (MessageInput split 0 and 1)',
  render: (to) => (
    <ToastProvider>
      <AwaitedPane index={0} target={to[0]} />
      <AwaitedPane index={1} target={to[1]} />
    </ToastProvider>
  ),
};

/** One run of a column: the composers on screen, their To, the model. */
class Run {
  readonly model = new Model();
  private view: ReturnType<typeof render> | null = null;
  to: Pair;

  constructor(private readonly entry: Entry, to: Pair) {
    this.to = to;
  }

  async mount(): Promise<void> {
    this.view = render(this.entry.render(this.to));
    await waitFor(() => expect(this.textarea(0)).toBeInTheDocument());
    await this.entry.ready?.();
  }

  scope(i: number) {
    return within(screen.getByTestId(`composer-${i}`));
  }

  textarea(i: number): HTMLTextAreaElement {
    return this.scope(i).getByTestId('message-input-textarea') as HTMLTextAreaElement;
  }

  async changeTo(i: number, target: Target): Promise<void> {
    this.to = (i === 0 ? [target, this.to[1]] : [this.to[0], target]) as Pair;
    this.view?.rerender(this.entry.render(this.to));
    await flush();
  }

  type(i: number, value: string): void {
    fireEvent.change(this.textarea(i), { target: { value } });
  }

  enter(i: number): void {
    fireEvent.keyDown(this.textarea(i), { key: 'Enter', code: 'Enter' });
  }

  /** Type and send from composer `i` (optimistic: the draft clears at once). Returns the POST's index. */
  async send(i: number, text: string): Promise<number> {
    const before = posts.length;
    this.type(i, text);
    this.enter(i);
    await waitFor(() => expect(posts).toHaveLength(before + 1));
    return before;
  }

  /** The fence answers POST `k`: the text comes back to composer `i` (bound to `original`). */
  async refuse(k: number, original: Target, i: number, reason = 'target-gone'): Promise<void> {
    await act(async () => posts[k].reject(fence(reason, original)));
    await flush(30);
    if (reason !== 'worktree-gone') this.model.receive(`composer-${i}`, original);
  }

  /** return(optimistic): send `text` from composer `i` to its To, change the To, the fence answers. */
  async returnOptimistic(i: number, text: string, changedTo: Target): Promise<void> {
    const original = this.to[i];
    const k = await this.send(i, text);
    await waitFor(() => expect(this.textarea(i).value).toBe(''));
    await this.changeTo(i, changedTo);
    await this.refuse(k, original, i);
  }

  /** otherSend: composer `i` sends `text` and it is taken (the model: its own set empties). */
  async otherSend(i: number, text: string): Promise<void> {
    const k = await this.send(i, text);
    await act(async () => posts[k].resolve({ id: `srv-${k}`, role: 'user', content: text, timestamp: new Date() }));
    await flush(30);
    this.model.sent(`composer-${i}`);
  }

  /**
   * The last Enter in composer `i`. The model says whether it asks: then POST 0 and the question
   * (cancelled: still POST 0); otherwise POST 1 and no question.
   */
  async lastEnter(i: number): Promise<void> {
    const asks = this.model.asks(`composer-${i}`, this.to[i]);
    holdAnswers = false;
    const before = posts.length;
    const draft = this.textarea(i).value;
    this.enter(i);
    await flush(30);
    if (asks) {
      expect(posts).toHaveLength(before);
      const confirm = await this.scope(i).findByTestId('message-input-retarget-confirm');
      expect(confirm.textContent).toContain(this.to[i].id);
      fireEvent.click(this.scope(i).getByTestId('message-input-retarget-confirm-no'));
      await flush();
      expect(posts).toHaveLength(before);
      expect(this.textarea(i).value).toBe(draft);
    } else {
      await waitFor(() => expect(posts).toHaveLength(before + 1));
      expect(this.scope(i).queryByTestId('message-input-retarget-confirm')).toBeNull();
      this.model.sent(`composer-${i}`);
    }
  }

  unmount(): void {
    this.view?.unmount();
    this.view = null;
  }
}

/** The tags stored next to a draft (`<draftKey>:retarget`). */
function storedTags(draftKey: string): Array<{ id: string; original: { instanceId: string; cliToolId: string } }> {
  const raw = window.localStorage.getItem(`${draftKey}:retarget`);
  return raw ? JSON.parse(raw) : [];
}
const splitKey = (i: number) => `commandmate:draft-message:${WT}:${i}`;

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(getSplitSurfaceModeStorageKey(WT, 0), 'chat');
  window.localStorage.setItem(getSplitSurfaceModeStorageKey(WT, 1), 'chat');
  window.history.replaceState({}, '', `/worktrees/${WT}`);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: async () => NOT_SHOWN }),
  ) as unknown as typeof fetch;
  posts.length = 0;
  holdAnswers = true;
  sendMessageMock.mockReset();
  installSend();
  fetchStartPreviewMock.mockReset();
  fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
  mockPane();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
});

describe.each([PC_PAIR, PHONE_AND_PC])('[#4535 r7 INV-V2b] $name: another composer\'s send does not let the text go', (entry) => {
  it('column 1: return(optimistic) → changeTo → otherSend(composer 2, holding the text, to the original) → Enter', async () => {
    const run = new Run(entry, [X, X]);
    await run.mount();
    await run.returnOptimistic(0, TEXT, C);
    await waitFor(() => expect(run.textarea(0).value).toBe(TEXT));
    await run.otherSend(1, `${TEXT} — and the tests`);
    await run.lastEnter(0);
  });

  it('column 2: the same with a short text ("ok")', async () => {
    const run = new Run(entry, [X, X]);
    await run.mount();
    await run.returnOptimistic(0, 'ok', C);
    await waitFor(() => expect(run.textarea(0).value).toBe('ok'));
    await run.otherSend(1, 'ok');
    await run.lastEnter(0);
  });

  it('column 6: type(before) → return (the 409 late) → changeTo → Enter', async () => {
    const run = new Run(entry, [X, X]);
    await run.mount();
    const k = await run.send(0, TEXT);
    await waitFor(() => expect(run.textarea(0).value).toBe(''));
    await run.changeTo(0, C);
    run.type(0, NEXT);
    await run.refuse(k, X, 0);
    await waitFor(() => expect(run.textarea(0).value).toBe(`${NEXT}\n\n${TEXT}`));
    await run.lastEnter(0);
  });

  it('column 7: secondReturn — the same text back from X and from Y, the To Y → Enter', async () => {
    const run = new Run(entry, [X, X]);
    await run.mount();
    const first = await run.send(0, TEXT);
    await waitFor(() => expect(run.textarea(0).value).toBe(''));
    await run.changeTo(0, Y);
    const second = await run.send(0, TEXT);
    await waitFor(() => expect(run.textarea(0).value).toBe(''));
    await run.changeTo(0, C);
    await run.refuse(first, X, 0);
    await run.refuse(second, Y, 0);
    await waitFor(() => expect(run.textarea(0).value).toBe(`${TEXT}\n\n${TEXT}`));
    await run.changeTo(0, Y);
    await run.lastEnter(0);
  });
});

describe('[#4535 r7 INV-V2b] PC: another tab, a reload, many texts back', () => {
  it('column 3: return → changeTo → otherTabSend (another tab of the same draft, to the original) → Enter', async () => {
    const run = new Run(PC_PAIR, [X, X]);
    await run.mount();
    await run.returnOptimistic(0, TEXT, C);
    await waitFor(() => expect(run.textarea(0).value).toBe(TEXT));
    await flush(600);
    // Another tab: its own document (a separate render) on the same draft, opened now.
    const otherTab = render(
      <ToastProvider>
        <div data-testid="other-tab">
          <MessageInput worktreeId={WT} splitIndex={0} cliToolId={X.tool} instanceId={X.id} isSessionRunning onMessageSent={vi.fn()} />
        </div>
      </ToastProvider>,
    );
    const otherTextarea = within(screen.getByTestId('other-tab')).getByTestId('message-input-textarea') as HTMLTextAreaElement;
    holdAnswers = false;
    const before = posts.length;
    fireEvent.change(otherTextarea, { target: { value: `${TEXT} (from the other tab)` } });
    await act(async () => {
      fireEvent.submit(otherTextarea.closest('form')!);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(posts).toHaveLength(before + 1));
    await flush(30);
    // What the other tab wrote reaches this tab as a `storage` event.
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: `${splitKey(0)}:retarget` }));
      window.dispatchEvent(new StorageEvent('storage', { key: splitKey(0) }));
    });
    otherTab.unmount();
    holdAnswers = true;
    await run.lastEnter(0);
  });

  it('column 8: return → changeTo → reload → Enter (the tag comes back with the draft)', async () => {
    const run = new Run(PC_PAIR, [X, X]);
    await run.mount();
    await run.returnOptimistic(0, TEXT, C);
    await waitFor(() => expect(run.textarea(0).value).toBe(TEXT));
    await flush(600);
    run.unmount();
    await run.mount();
    await waitFor(() => expect(run.textarea(0).value).toBe(TEXT));
    await run.lastEnter(0);
  });

  it('column 9: return into composer 1, then 20 more into composer 2 → Enter in composer 1', async () => {
    const run = new Run(PC_PAIR, [X, X]);
    await run.mount();
    await run.returnOptimistic(0, 'the first stopped text', C);
    const sent: number[] = [];
    for (let n = 0; n < 20; n += 1) sent.push(await run.send(1, `task number ${n + 1}`));
    await run.changeTo(1, C);
    for (const k of sent) await run.refuse(k, X, 1);
    await waitFor(() => expect(run.textarea(1).value).toContain('task number 20'));
    await run.lastEnter(0);
  });
});

describe('[#4535 r7 INV-V2c] PC: positive and negative controls', () => {
  it('column 10a: the To still the original target — POST 1, then the next send asks nothing', async () => {
    const run = new Run(PC_PAIR, [X, X]);
    await run.mount();
    const k = await run.send(0, TEXT);
    await waitFor(() => expect(run.textarea(0).value).toBe(''));
    await run.refuse(k, X, 0, 'dispatch-changed');
    await waitFor(() => expect(run.textarea(0).value).toBe(TEXT));
    await run.lastEnter(0);
    expect(posts[posts.length - 1].options).toMatchObject({ instanceId: X.id, cliToolId: X.tool });
    expect(storedTags(splitKey(0))).toEqual([]);
    run.type(0, 'another thing');
    await run.lastEnter(0);
  });

  it('column 10b: the To changed — "yes" POSTs once to the current To, then the next send asks nothing', async () => {
    const run = new Run(PC_PAIR, [X, X]);
    await run.mount();
    await run.returnOptimistic(0, TEXT, C);
    await waitFor(() => expect(run.textarea(0).value).toBe(TEXT));
    holdAnswers = false;
    const before = posts.length;
    run.enter(0);
    await flush(30);
    expect(posts).toHaveLength(before);
    fireEvent.click(await run.scope(0).findByTestId('message-input-retarget-confirm-yes'));
    await waitFor(() => expect(posts).toHaveLength(before + 1));
    expect(posts[before].content).toBe(TEXT);
    expect(posts[before].options).toMatchObject({ cliToolId: C.tool });
    expect(posts[before].options.instanceId ?? posts[before].options.cliToolId).toBe(C.id);
    run.model.sent('composer-0');
    await flush(30);
    expect(posts).toHaveLength(before + 1);
    expect(storedTags(splitKey(0))).toEqual([]);
    run.type(0, 'another thing');
    await run.lastEnter(0);
  });

  it.each([
    ['worktree-gone', 'not_sent'],
    ['dispatch-changed', 'unknown'],
  ] as const)('column 11: %s (%s) — no text back, no tag', async (reason, outcome) => {
    const run = new Run(PC_PAIR, [X, X]);
    await run.mount();
    const k = await run.send(0, TEXT);
    await waitFor(() => expect(run.textarea(0).value).toBe(''));
    await run.changeTo(0, C);
    await act(async () => posts[k].reject(fence(reason, X, outcome)));
    await flush(30);
    expect(run.textarea(0).value).toBe('');
    expect(storedTags(splitKey(0))).toEqual([]);
  });
});

describe('[#4535 r7 INV-V2a] the roads that bring a fence\'s text into a composer leave its tag', () => {
  it('onTargetChanged (the optimistic road): one tag next to the draft, naming the original target', async () => {
    const run = new Run(PC_PAIR, [X, X]);
    await run.mount();
    await run.returnOptimistic(0, TEXT, C);
    await waitFor(() => expect(run.textarea(0).value).toBe(TEXT));
    const tags = storedTags(splitKey(0));
    expect(tags).toHaveLength(1);
    expect(tags[0].original).toEqual({ instanceId: X.id, cliToolId: X.tool });
    expect(typeof tags[0].id).toBe('string');
    // Only that composer holds it.
    expect(storedTags(splitKey(1))).toEqual([]);
  });
});

describe('[#4535 r7 INV-V2b] the awaited roads (noteFenceRefusal): two awaited composers', () => {
  async function returnAwaited(run: Run, brief: boolean): Promise<void> {
    if (brief) fetchStartPreviewMock.mockResolvedValue(SHOWN);
    const before = posts.length;
    run.type(0, TEXT);
    await act(async () => {
      fireEvent.submit(run.textarea(0).closest('form')!);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (brief) fireEvent.click(await screen.findByTestId('session-start-brief-decline'));
    await waitFor(() => expect(posts).toHaveLength(before + 1));
    // Awaited: the text stays in the composer while it is on its way.
    expect(run.textarea(0).value).toBe(TEXT);
    fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
    await run.refuse(before, X, 0);
    expect(run.textarea(0).value).toBe(TEXT);
  }

  it.each([
    ['the plain awaited send', false],
    ['the brief-choice send', true],
  ])('column 5 (%s): return → changeTo → otherSend → Enter; one tag next to the draft', async (_name, brief) => {
    const run = new Run(AWAITED_PAIR, [X, X]);
    await run.mount();
    await returnAwaited(run, brief);
    const tags = storedTags(splitKey(0));
    expect(tags).toHaveLength(1);
    expect(tags[0].original).toEqual({ instanceId: X.id, cliToolId: X.tool });
    await run.changeTo(0, C);
    // composer 2 (awaited) sends a text holding it to the original, and it is taken.
    holdAnswers = false;
    const before = posts.length;
    run.type(1, `${TEXT} — and the tests`);
    await act(async () => {
      fireEvent.submit(run.textarea(1).closest('form')!);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(posts).toHaveLength(before + 1));
    await flush(30);
    run.model.sent('composer-1');
    holdAnswers = true;
    await run.lastEnter(0);
  });
});
