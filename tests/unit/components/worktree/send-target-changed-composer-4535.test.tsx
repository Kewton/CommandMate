/**
 * Issue #4535 段 2 §3.2・§3.3 T19b (INV-V2, S2-Q5 (b)): the fence's 409 `SEND_TARGET_CHANGED`
 * `not_sent` hands a new send's text back to the composer on screen — on the PC split
 * (`TerminalSplitPaneContent`) and on the phone (`MobileTerminalTab` + the docked composer) — and,
 * while the composer's To is not the original target (its `instanceId` and its `cliToolId`), the
 * text cannot be sent to the new To with one press:
 *
 * - Enter once: nothing is POSTed, the composer asks, naming the original and the current target
 * - the question cancelled: nothing is POSTed, the text stays
 * - the question confirmed: one POST, to the current target
 *
 * Both ways the To changes: `target-gone` (another instance) and `tool-changed` (the same id, another
 * tool). Positive control: the To still the original target — Enter sends at once, no question.
 * `worktree-gone`: the text goes back nowhere. The harness is `send-unknown-surfaces-4503`'s.
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
const TEXT = 'please look at the diff';

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
  name: 'phone (MobileTerminalTab + the docked composer)',
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

/** Send TEXT to `original`, switch the To to `current` while it is on its way, then the fence answers. */
async function sendThenRefuse(surface: Surface, original: Target, current: Target, reason: string) {
  let reject: (error: unknown) => void = () => undefined;
  sendMessageMock.mockImplementationOnce(() => new Promise((_resolve, r) => (reject = r)));
  sendMessageMock.mockResolvedValue({ id: 'srv-2' });
  const view = surface.mount(original);
  await waitFor(() => expect(textarea()).toBeInTheDocument());
  if (surface === PHONE) await waitFor(() => expect(screen.getByTestId('mobile-chat-surface')).toBeInTheDocument());
  fireEvent.change(textarea(), { target: { value: TEXT } });
  pressEnter();
  await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(textarea().value).toBe(''));
  view.switchTo(current);
  await flush();
  await act(async () => reject(fence(reason, original)));
  await flush(30);
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

const CHANGES: Array<[string, Target, Target]> = [
  ['target-gone', { id: 'codex-2', tool: 'codex' }, { id: 'claude', tool: 'claude' }],
  ['tool-changed', { id: 'agent-1', tool: 'codex' }, { id: 'agent-1', tool: 'claude' }],
];

describe.each([PC, PHONE])('[#4535 T19b] $name: the text back, and no one-press send to a changed To', (surface) => {
  it.each(CHANGES)(
    '%s: Enter once POSTs nothing and asks; cancelled POSTs nothing; confirmed POSTs once to the current To',
    async (reason, original, current) => {
      await sendThenRefuse(surface, original, current, reason);
      await waitFor(() => expect(textarea().value).toBe(TEXT));

      pressEnter();
      await flush();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const confirm = await screen.findByTestId('message-input-retarget-confirm');
      expect(confirm.textContent).toContain(original.id);
      expect(confirm.textContent).toContain(original.tool);
      expect(confirm.textContent).toContain(current.id);
      expect(confirm.textContent).toContain(current.tool);

      fireEvent.click(screen.getByTestId('message-input-retarget-confirm-no'));
      await flush();
      expect(screen.queryByTestId('message-input-retarget-confirm')).toBeNull();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(textarea().value).toBe(TEXT);

      pressEnter();
      fireEvent.click(await screen.findByTestId('message-input-retarget-confirm-yes'));
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
      const [, content, options] = sendMessageMock.mock.calls[1];
      expect(content).toBe(TEXT);
      expect(options).toMatchObject({ cliToolId: current.tool });
      await flush(30);
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
    },
  );

  it('(positive control) the To still the original target: the text back, Enter sends at once', async () => {
    const same: Target = { id: 'codex-2', tool: 'codex' };
    await sendThenRefuse(surface, same, same, 'dispatch-changed');
    await waitFor(() => expect(textarea().value).toBe(TEXT));
    pressEnter();
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('message-input-retarget-confirm')).toBeNull();
  });

  it('worktree-gone: the text goes back nowhere', async () => {
    const original: Target = { id: 'codex-2', tool: 'codex' };
    await sendThenRefuse(surface, original, { id: 'claude', tool: 'claude' }, 'worktree-gone');
    expect(textarea().value).toBe('');
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(`commandmate:draft-message:${WT}:retarget-hold`)).toBeNull();
  });
});
