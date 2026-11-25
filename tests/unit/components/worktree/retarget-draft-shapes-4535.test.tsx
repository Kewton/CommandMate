/**
 * Issue #4535 r6 (INV-V2 rewritten, PM's disposition after the second hole of the same kind): a text
 * the send fence (409 `SEND_TARGET_CHANGED` `not_sent`) handed back is in the composer in any shape
 * of the draft — while the composer's To is not the original target (`instanceId` and `cliToolId`),
 * one press (Enter) POSTs nothing and asks; the question cancelled POSTs nothing.
 *
 * The table: the shapes of the draft × the entries. This file has the PC split
 * (`TerminalSplitPaneContent`) and the phone (`MobileTerminalTab` + the docked composer); the
 * `/sessions` tile and the discard road are `SessionTile-retarget-draft-shapes-4535.test.tsx`.
 *
 * | shape | expected |
 * |---|---|
 * | only — the text back into an empty composer | asks, POST 0 |
 * | before — another text typed while the send was on its way (the 409 late) | asks, POST 0 |
 * | after — another text typed after it came back | asks, POST 0 |
 * | between — another text typed between the text's paragraphs | asks, POST 0 |
 * | whitespace — other spaces / newlines around and between, a trailing newline | asks, POST 0 |
 * | two — two stopped sends came back one after the other | asks, POST 0 |
 * | part deleted — the person deleted a part of it (no longer the same text) | either way: one press POSTs at most once |
 *
 * Positive control: the To still the original target — Enter sends at once (only, before).
 *
 * @vitest-environment jsdom
 */

import React, { useState } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor, cleanup } from '@testing-library/react';
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

const { sendMessageMock, refreshMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  refreshMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return { ...actual, worktreeApi: { ...actual.worktreeApi, sendMessage: sendMessageMock } };
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
        <div key={m.id} data-testid={`row-${m.id}`} data-optimistic={m.optimisticState ?? ''}>
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

const WT = 'wt-4535';
const TEXT = 'please look at the diff\n\nand run the tests too';
const TEXT2 = 'second stopped send';
const NEXT = 'next thing I typed';

interface Target {
  id: string;
  tool: CLIToolType;
}

function inst(target: Target): AgentInstance {
  return { id: target.id, cliTool: target.tool, alias: '', order: 0 };
}

function fence(reason: string, original: Target): ApiError {
  return new ApiError('The send target changed', 409, {
    error: 'The send target changed',
    code: 'SEND_TARGET_CHANGED',
    reason,
    target: { worktreeId: WT, instanceId: original.id, cliToolId: original.tool },
    current: null,
    requestId: 'r-1',
    sendOutcome: 'not_sent',
  });
}

/** The PC split as the worktree screen mounts it: History's insert feeds the composer's insert. */
function PcHarness({ target }: { target: Target }) {
  const [insert, setInsert] = useState<string | null>(null);
  return (
    <ToastProvider>
      <TerminalSplitPaneContent
        worktreeId={WT}
        splitIndex={0}
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
    </ToastProvider>
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

function PhoneHarness({ target }: { target: Target }) {
  const [insert, setInsert] = useState<string | null>(null);
  return (
    <ToastProvider>
      <WorktreeChatSendProvider onInsertToComposer={setInsert}>
        <MobileTerminalTab worktreeId={WT} cliToolId={target.tool} instanceId={target.id} />
        <PhoneComposer target={target} insert={insert} onConsumed={() => setInsert(null)} />
      </WorktreeChatSendProvider>
    </ToastProvider>
  );
}

interface Surface {
  name: string;
  mount(target: Target): { switchTo(next: Target): void };
  chat?: boolean;
}

const PC: Surface = {
  name: 'PC split (TerminalSplitPaneContent)',
  mount(target) {
    window.localStorage.setItem(getSplitSurfaceModeStorageKey(WT, 0), 'chat');
    const view = render(<PcHarness target={target} />);
    return { switchTo: (next) => view.rerender(<PcHarness target={next} />) };
  },
};

const PHONE: Surface = {
  name: 'phone (MobileTerminalTab chat + the docked composer)',
  chat: true,
  mount(target) {
    const view = render(<PhoneHarness target={target} />);
    fireEvent.click(screen.getByTestId('mobile-surface-mode-chat'));
    return { switchTo: (next) => view.rerender(<PhoneHarness target={next} />) };
  },
};

const textarea = () => screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;

async function flush(ms = 10): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function pressEnter(): void {
  fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter' });
}

const ORIGINAL: Target = { id: 'codex-2', tool: 'codex' };
const CHANGED: Target = { id: 'claude', tool: 'claude' };

type Shape = 'only' | 'before' | 'after' | 'between' | 'whitespace' | 'two' | 'part deleted';

/**
 * Sends (TEXT, and TEXT2 for `two`) to `original`, changes the To to `current` while they are on
 * their way, shapes the draft as `shape`, and lets the fence answer. Returns the POSTs so far.
 */
async function arrange(surface: Surface, shape: Shape, current: Target): Promise<number> {
  const rejects: Array<(error: unknown) => void> = [];
  sendMessageMock.mockImplementation(() => new Promise((_resolve, reject) => rejects.push(reject)));
  const view = surface.mount(ORIGINAL);
  await waitFor(() => expect(textarea()).toBeInTheDocument());
  if (surface.chat) await waitFor(() => expect(screen.getByTestId('mobile-chat-surface')).toBeInTheDocument());
  const texts = shape === 'two' ? [TEXT, TEXT2] : [TEXT];
  for (const text of texts) {
    fireEvent.change(textarea(), { target: { value: text } });
    pressEnter();
    await waitFor(() => expect(textarea().value).toBe(''));
  }
  expect(sendMessageMock).toHaveBeenCalledTimes(texts.length);
  view.switchTo(current);
  await flush();
  if (shape === 'before') fireEvent.change(textarea(), { target: { value: NEXT } });
  for (let i = 0; i < texts.length; i += 1) {
    await act(async () => rejects[i](fence('target-gone', ORIGINAL)));
    await flush(30);
  }
  const back = shape === 'two' ? `${TEXT}\n\n${TEXT2}` : shape === 'before' ? `${NEXT}\n\n${TEXT}` : TEXT;
  await waitFor(() => expect(textarea().value).toBe(back));
  const reshaped: Partial<Record<Shape, string>> = {
    after: `${TEXT}\n\n${NEXT}`,
    between: `please look at the diff\n\n${NEXT}\n\nand run the tests too`,
    whitespace: '  please look at the diff \n\n\n\n  and run the tests too\n\n',
    'part deleted': 'please look at the diff',
  };
  const value = reshaped[shape];
  if (value !== undefined) fireEvent.change(textarea(), { target: { value } });
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue({ id: 'srv-2' });
  return texts.length;
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WT}`);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: async () => ({ ok: true, show: false, attended: false }) }),
  ) as unknown as typeof fetch;
  sendMessageMock.mockReset();
  mockPane();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
});

const ASKING: Shape[] = ['only', 'before', 'after', 'between', 'whitespace', 'two'];

describe.each([PC, PHONE])('[#4535 r6 INV-V2] $name: every shape of the draft that holds the text', (surface) => {
  it.each(ASKING)('%s: To changed — Enter once POSTs nothing and asks; cancelled POSTs nothing', async (shape) => {
    await arrange(surface, shape, CHANGED);
    const draft = textarea().value;
    pressEnter();
    await flush();
    expect(sendMessageMock).not.toHaveBeenCalled();
    const confirm = await screen.findByTestId('message-input-retarget-confirm');
    expect(confirm.textContent).toContain(ORIGINAL.id);
    expect(confirm.textContent).toContain(CHANGED.id);
    fireEvent.click(screen.getByTestId('message-input-retarget-confirm-no'));
    await flush();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(textarea().value).toBe(draft);
  });

  it('part deleted: either way, one press POSTs at most once', async () => {
    await arrange(surface, 'part deleted', CHANGED);
    pressEnter();
    await flush(30);
    expect(sendMessageMock.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it.each<Shape>(['only', 'before'])('(positive control) %s: the To still the original target — Enter sends at once', async (shape) => {
    await arrange(surface, shape, ORIGINAL);
    pressEnter();
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('message-input-retarget-confirm')).toBeNull();
  });
});
