/**
 * Tests for the shared user-message send service (Issue #1028).
 *
 * Verifies that sendUserMessage performs the full send + history-recording flow
 * (savePendingAssistantResponse -> orphan detection -> send -> createMessage ->
 * orphan delete -> updateLastUserMessage -> clearInProgressMessageId ->
 * startPolling) and preserves the image / model-command branches that
 * previously lived inline in POST /api/worktrees/[id]/send.
 *
 * Issue #1906 removed the copilot branch: it reached past
 * `CopilotTool.sendMessage` into `sendKeys` + a delayed Enter, flattening `\n+`
 * to spaces on the way. The tmux mocks below stay so the assertions can say that
 * nothing here drives tmux any more.
 *
 * Issue #2630 moved a copilot `--model` switch ahead of all of that, and made the
 * body wait for the poller still watching the previous turn; the last block
 * replays the UAT timeline on a fake clock and hands the row it writes to the
 * real `wait` loop.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock, type MockInstance } from 'vitest';

// Mock logger (inline to avoid hoisting issues)
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

// Mock DB layer
const mockCreateMessage = vi.fn();
const mockUpdateLastUserMessage = vi.fn();
const mockClearInProgressMessageId = vi.fn();
const mockGetMessages = vi.fn().mockReturnValue([]);
const mockDeleteMessageById = vi.fn().mockReturnValue(true);
vi.mock('@/lib/db', () => ({
  createMessage: (...args: unknown[]) => mockCreateMessage(...args),
  updateLastUserMessage: (...args: unknown[]) => mockUpdateLastUserMessage(...args),
  clearInProgressMessageId: (...args: unknown[]) => mockClearInProgressMessageId(...args),
  getMessages: (...args: unknown[]) => mockGetMessages(...args),
  deleteMessageById: (...args: unknown[]) => mockDeleteMessageById(...args),
}));

// Mock CLIToolManager
const mockGetTool = vi.fn();
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: (...args: unknown[]) => mockGetTool(...args),
    })),
  },
}));

// Mock polling
const mockStartPolling = vi.fn();
// Issue #2630: the poller registry, as `getActivePollers` reports it (keys are
// `<worktreeId>:<instanceId>`). Empty unless a test registers a chain.
const mockGetActivePollers = vi.fn((): string[] => []);
vi.mock('@/lib/polling/response-poller', () => ({
  startPolling: (...args: unknown[]) => mockStartPolling(...args),
  getActivePollers: () => mockGetActivePollers(),
}));

// Mock assistant response saver
const mockSavePendingAssistantResponse = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/assistant-response-saver', () => ({
  savePendingAssistantResponse: (...args: unknown[]) => mockSavePendingAssistantResponse(...args),
}));

// Issue #1906: these exist only as negative controls. Nothing in
// send-user-message.ts imports them any more (the tmux import allowlist pins
// that), so any call here would mean the bypass came back.
const mockSendKeys = vi.fn().mockResolvedValue(undefined);
const mockSendSpecialKeys = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: (...args: unknown[]) => mockSendKeys(...args),
  sendSpecialKeys: (...args: unknown[]) => mockSendSpecialKeys(...args),
}));

const mockInvalidateCache = vi.fn();
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: (...args: unknown[]) => mockInvalidateCache(...args),
}));

// Import after mocking
import {
  sendUserMessage,
  PREVIOUS_TURN_RECORD_TIMEOUT_MS,
} from '@/lib/session/send-user-message';
// Issue #2630: the real `wait` loop, so the ledger row this send writes is judged
// by the #1975 gate itself rather than by a copy of its comparison.
import { pollWorktree } from '../../../../src/cli/commands/wait';
import type { ApiClient } from '../../../../src/cli/utils/api-client';
import { WaitExitCode } from '../../../../src/cli/types';

// Minimal stand-in for the sqlite Database handle (all DB calls are mocked)
const mockDb = {} as never;

interface ToolMockOptions {
  sendMessage?: ReturnType<typeof vi.fn>;
  sendMessageWithImage?: ReturnType<typeof vi.fn>;
  supportsImage?: boolean;
  sendModelCommand?: ReturnType<typeof vi.fn>;
  getSessionName?: ReturnType<typeof vi.fn>;
}

function makeTool(opts: ToolMockOptions = {}) {
  return {
    name: 'Claude',
    sendMessage: opts.sendMessage ?? vi.fn().mockResolvedValue(undefined),
    sendMessageWithImage: opts.sendMessageWithImage ?? vi.fn().mockResolvedValue(undefined),
    supportsImage: opts.supportsImage !== undefined ? vi.fn(() => opts.supportsImage) : undefined,
    sendModelCommand: opts.sendModelCommand ?? vi.fn().mockResolvedValue(undefined),
    getSessionName: opts.getSessionName ?? vi.fn(() => 'session-name'),
  };
}

describe('sendUserMessage (Issue #1028)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Implementations survive `clearAllMocks`; the #2630 cases below set both.
    mockStartPolling.mockReset();
    mockGetActivePollers.mockReset();
    mockGetMessages.mockReturnValue([]);
    mockSavePendingAssistantResponse.mockResolvedValue(null);
    mockDeleteMessageById.mockReturnValue(true);
    mockCreateMessage.mockReturnValue({ id: 'created-msg', role: 'user', content: 'Hello' });
  });

  it('records a normal message in chat_messages and starts response polling', async () => {
    const tool = makeTool();
    mockGetTool.mockReturnValue(tool);

    const result = await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'Hello',
      cliToolId: 'claude',
      instanceId: 'claude',
    });

    // Previous assistant response captured first
    expect(mockSavePendingAssistantResponse).toHaveBeenCalledWith(
      mockDb,
      'wt-1',
      'claude',
      expect.any(Date),
      'claude'
    );
    // Sent via the tool
    expect(tool.sendMessage).toHaveBeenCalledWith('wt-1', 'Hello', 'claude');
    // Recorded as a user message in history (default messageType 'normal')
    expect(mockCreateMessage).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        worktreeId: 'wt-1',
        role: 'user',
        content: 'Hello',
        messageType: 'normal',
        cliToolId: 'claude',
        instanceId: 'claude',
        timestamp: expect.any(Date),
      })
    );
    // Response polling started so the assistant reply is recorded too
    expect(mockStartPolling).toHaveBeenCalledWith('wt-1', 'claude', 'claude');
    expect(mockClearInProgressMessageId).toHaveBeenCalledWith(mockDb, 'wt-1', 'claude', 'claude');
    expect(mockUpdateLastUserMessage).toHaveBeenCalledWith(mockDb, 'wt-1', 'Hello', expect.any(Date));

    expect(result).toEqual({ ok: true, message: { id: 'created-msg', role: 'user', content: 'Hello' } });
  });

  it('honors an explicit messageType override', async () => {
    mockGetTool.mockReturnValue(makeTool());

    await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'Hi',
      cliToolId: 'claude',
      messageType: 'prompt',
    });

    expect(mockCreateMessage).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ messageType: 'prompt' })
    );
  });

  it('deletes an orphaned duplicate user message only after the new message is persisted (Issue #379)', async () => {
    mockGetTool.mockReturnValue(makeTool());
    mockGetMessages.mockReturnValue([{ id: 'orphan-1', role: 'user', content: 'Hello' }]);

    await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'Hello',
      cliToolId: 'claude',
      instanceId: 'claude',
    });

    expect(mockDeleteMessageById).toHaveBeenCalledWith(mockDb, 'orphan-1');
    // Ordering: persist the new message before deleting the orphan
    const createOrder = mockCreateMessage.mock.invocationCallOrder[0];
    const deleteOrder = mockDeleteMessageById.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(deleteOrder);
  });

  it('does not delete the most recent message when it is not a matching duplicate', async () => {
    mockGetTool.mockReturnValue(makeTool());
    mockGetMessages.mockReturnValue([{ id: 'other', role: 'user', content: 'different text' }]);

    await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'Hello',
      cliToolId: 'claude',
    });

    expect(mockDeleteMessageById).not.toHaveBeenCalled();
  });

  it('returns { ok: false, stage: "send" } and skips recording when the CLI send fails', async () => {
    const tool = makeTool({ sendMessage: vi.fn().mockRejectedValue(new Error('tmux session not found')) });
    mockGetTool.mockReturnValue(tool);

    const result = await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'Hello',
      cliToolId: 'claude',
    });

    expect(result).toEqual({ ok: false, stage: 'send', error: 'tmux session not found' });
    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(mockStartPolling).not.toHaveBeenCalled();
  });

  it('sends the copilot /model command before the message and records history', async () => {
    const sendModelCommand = vi.fn().mockResolvedValue(undefined);
    const tool = makeTool({ sendModelCommand, getSessionName: vi.fn(() => 'copilot-session') });
    mockGetTool.mockReturnValue(tool);

    const result = await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'do it',
      cliToolId: 'copilot',
      instanceId: 'copilot',
      copilotModel: 'gpt-5',
    });

    expect(sendModelCommand).toHaveBeenCalledWith('wt-1', 'gpt-5', 'copilot');
    // Issue #1906: copilot takes the same `ICLITool.sendMessage` path as every
    // other tool. The old branch typed the body with a raw `sendKeys` and never
    // entered `CopilotTool.sendMessage`, so `waitForPrompt` (#1886's folder-trust
    // answer), `SELECTION_LIST_COMMANDS` (#1895) and the #1471 submit
    // verification were all unreachable in production.
    expect(tool.sendMessage).toHaveBeenCalledWith('wt-1', 'do it', 'copilot');
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockSendSpecialKeys).not.toHaveBeenCalled();
    expect(mockInvalidateCache).not.toHaveBeenCalled();
    expect(mockCreateMessage).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ role: 'user', content: 'do it', cliToolId: 'copilot' })
    );
    expect(result).toMatchObject({ ok: true });
  });

  /**
   * Issue #1906. The removed branch did `content.replace(/\n+/g, ' ')` before
   * typing, so a contract preamble or a Markdown body arrived at copilot as one
   * line — measured in the Issue as composer `❯ line one line two line three`.
   *
   * Measured on copilot 1.0.80 (private tmux socket, 200x50): `send-keys` with
   * literal newlines leaves the body multi-line in the composer, a SEPARATE
   * Enter submits all of it, and the transcript echo keeps the line breaks. So
   * the flattening bought nothing and the body now goes through verbatim.
   */
  it('sends a copilot message with its newlines intact (no flattening)', async () => {
    const tool = makeTool({ getSessionName: vi.fn(() => 'copilot-session') });
    mockGetTool.mockReturnValue(tool);
    const body = 'line one\nline two\nline three';

    const result = await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: body,
      cliToolId: 'copilot',
      instanceId: 'copilot',
    });

    expect(result).toMatchObject({ ok: true });
    expect(tool.sendMessage).toHaveBeenCalledWith('wt-1', body, 'copilot');
    const sent = tool.sendMessage.mock.calls[0][1] as string;
    expect(sent).toContain('\n');
    expect(sent).not.toBe('line one line two line three');
    // History records the same unflattened text.
    expect(mockCreateMessage).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ content: body })
    );
  });

  it('returns { ok: false, stage: "model" } and does not send when the /model command fails', async () => {
    const sendModelCommand = vi.fn().mockRejectedValue(new Error('model switch failed'));
    const tool = makeTool({ sendModelCommand, getSessionName: vi.fn(() => 'copilot-session') });
    mockGetTool.mockReturnValue(tool);

    const result = await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'do it',
      cliToolId: 'copilot',
      copilotModel: 'gpt-5',
    });

    expect(result).toEqual({ ok: false, stage: 'model', error: 'model switch failed' });
    expect(tool.sendMessage).not.toHaveBeenCalled();
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(mockStartPolling).not.toHaveBeenCalled();
  });

  /**
   * Issue #2623. `sendModelCommand` now settles on copilot's answer to
   * `/model`, which takes seconds on a copilot that is still loading; the body
   * must not be typed before it settles. (It used to settle in 22 ms and the
   * body followed 0.3 s later into a copilot that never ran it.)
   */
  it('types the copilot body only after the /model switch has settled', async () => {
    let settleSwitch: () => void = () => undefined;
    const sendModelCommand = vi.fn(
      () => new Promise<void>((resolve) => {
        settleSwitch = resolve;
      })
    );
    const tool = makeTool({ sendModelCommand, getSessionName: vi.fn(() => 'copilot-session') });
    mockGetTool.mockReturnValue(tool);

    const pending = sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'do it',
      cliToolId: 'copilot',
      instanceId: 'copilot',
      copilotModel: 'claude-sonnet-5',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendModelCommand).toHaveBeenCalledWith('wt-1', 'claude-sonnet-5', 'copilot');
    expect(tool.sendMessage).not.toHaveBeenCalled();

    settleSwitch();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(tool.sendMessage).toHaveBeenCalledWith('wt-1', 'do it', 'copilot');
    expect(sendModelCommand.mock.invocationCallOrder[0]).toBeLessThan(
      tool.sendMessage.mock.invocationCallOrder[0]
    );
  });

  it('reports a refused copilot model in copilot\'s words and records nothing (Issue #2623)', async () => {
    const refusal =
      'Failed to switch Copilot model to claude-opus-4.6: copilot refused it: Model "claude-opus-4.6" is unsupported.';
    const sendModelCommand = vi.fn().mockRejectedValue(new Error(refusal));
    const tool = makeTool({ sendModelCommand, getSessionName: vi.fn(() => 'copilot-session') });
    mockGetTool.mockReturnValue(tool);

    const result = await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'do it',
      cliToolId: 'copilot',
      copilotModel: 'claude-opus-4.6',
    });

    expect(result).toEqual({ ok: false, stage: 'model', error: refusal });
    expect(tool.sendMessage).not.toHaveBeenCalled();
    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(mockUpdateLastUserMessage).not.toHaveBeenCalled();
    expect(mockStartPolling).not.toHaveBeenCalled();
  });

  it('uses native image sending for image-capable tools', async () => {
    const sendMessageWithImage = vi.fn().mockResolvedValue(undefined);
    const tool = makeTool({ sendMessageWithImage, supportsImage: true });
    mockGetTool.mockReturnValue(tool);

    await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'look at this',
      cliToolId: 'claude',
      instanceId: 'claude',
      absoluteImagePath: '/abs/.commandmate/attachments/img.png',
    });

    expect(sendMessageWithImage).toHaveBeenCalledWith(
      'wt-1',
      'look at this',
      '/abs/.commandmate/attachments/img.png',
      'claude'
    );
    expect(mockCreateMessage).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ content: 'look at this' })
    );
  });

  it('falls back to embedding the image path for non-image-capable tools', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const tool = makeTool({ sendMessage, supportsImage: false });
    mockGetTool.mockReturnValue(tool);

    await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'look',
      cliToolId: 'claude',
      absoluteImagePath: '/abs/img.png',
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'wt-1',
      'look\n\n[添付画像: /abs/img.png]',
      undefined
    );
  });
});

/**
 * Issue #2630. UAT TC-2623-06 (copilot 1.0.85, isolated server), on the clock
 * of a `send --model` that arrived while copilot was running a turn:
 *
 *   +0.000 s   the send arrives (the user row used to be stamped here)
 *   +16.217 s  the running turn (BUSY06C) reports `stop`
 *   +21.857 s  `/model` answered
 *   +22.192 s  body typed — `wait --instance copilot` completed at once on the
 *              +16.217 s `stop`, and BUSY06C never reached History
 *   +27.711 s  the new turn (PONG06) reports `stop`
 */
describe('a copilot --model send that waits out a running turn (Issue #2630)', () => {
  const REQUEST_AT = Date.UTC(2026, 8, 17, 10, 57, 34, 462);
  const PREVIOUS_STOP_AT = REQUEST_AT + 16_217;
  const SWITCH_ANSWERED_AT = REQUEST_AT + 21_857;
  const NEW_STOP_AT = REQUEST_AT + 27_711;
  const POLLER_KEY = 'wt-1:copilot';

  type ModelCommand = (worktreeId: string, modelName: string, instanceId?: string) => Promise<void>;
  type TypeBody = (worktreeId: string, message: string, instanceId?: string) => Promise<void>;

  interface Harness {
    sendModelCommand: Mock<ModelCommand>;
    sendMessage: Mock<TypeBody>;
    /** Replies the previous turn's poller wrote to History. */
    recorded: string[];
    recordedAt: () => number | null;
    bodyTypedAt: () => number | null;
    saveCalledAt: () => number | null;
  }

  /**
   * copilot, and the response poller `send 1` started, reduced to what this
   * Issue is about.
   *
   * `sendModelCommand` settles when `/model` is answered. copilot reads idle
   * from 1 s before that — the switch waits for exactly that before it types
   * `/model` — and every earlier frame shows the turn still running.
   *
   * The poller ticks every 2 s. A tick records the previous turn only while
   * copilot is idle AND that turn is still the newest one on the pane: once a
   * body is typed, extraction starts after the new prompt, and `startPolling`
   * retires the chain outright. Recording ends the chain, as a copilot chain
   * does after a saved reply. The ticks are phased so that the first one after
   * the switch lands 0.64 s after the answer — later than the 0.34 s the body
   * took to follow it in the UAT.
   *
   * @param previousPollerRunning - false for a copilot that was idle when the
   *   send arrived: its last reply is already recorded and no chain is left
   */
  function setUpHarness(previousPollerRunning = true): Harness {
    const idleAt = SWITCH_ANSWERED_AT - 1_000;
    let chain: 'previous' | 'next' | null = previousPollerRunning ? 'previous' : null;
    let recordedAt: number | null = null;
    let bodyTypedAt: number | null = null;
    let saveCalledAt: number | null = null;
    const recorded: string[] = [];

    const tick = (): void => {
      if (chain !== 'previous') return;
      if (Date.now() < idleAt) return;
      if (bodyTypedAt !== null) return;
      recorded.push('BUSY06C');
      recordedAt = Date.now();
      chain = null;
    };
    setTimeout(() => {
      tick();
      setInterval(tick, 2_000);
    }, 500);

    mockGetActivePollers.mockImplementation(() => (chain === null ? [] : [POLLER_KEY]));
    mockStartPolling.mockImplementation(() => {
      chain = 'next';
    });
    mockSavePendingAssistantResponse.mockImplementation(() => {
      saveCalledAt = Date.now();
      return Promise.resolve(null);
    });

    const sendModelCommand = vi.fn<ModelCommand>(
      () => new Promise<void>((resolve) => setTimeout(resolve, SWITCH_ANSWERED_AT - REQUEST_AT))
    );
    const sendMessage = vi.fn<TypeBody>(async () => {
      bodyTypedAt = Date.now();
    });
    mockGetTool.mockReturnValue(
      makeTool({ sendModelCommand, sendMessage, getSessionName: vi.fn(() => 'copilot-session') })
    );

    return {
      sendModelCommand,
      sendMessage,
      recorded,
      recordedAt: () => recordedAt,
      bodyTypedAt: () => bodyTypedAt,
      saveCalledAt: () => saveCalledAt,
    };
  }

  /**
   * Advance the fake clock in small steps until `promise` settles, so the clock
   * stops where the work did rather than at an arbitrary horizon.
   */
  async function runToSettled<T>(promise: Promise<T>, horizonMs: number): Promise<T> {
    let settled = false;
    const tracked = promise.finally(() => {
      settled = true;
    });
    const deadline = Date.now() + horizonMs;
    while (!settled && Date.now() < deadline) {
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(settled).toBe(true);
    return tracked;
  }

  /** Run a send to completion on the fake clock. */
  function send(params: { copilotModel?: string } = {}) {
    return runToSettled(
      sendUserMessage(mockDb, {
        worktreeId: 'wt-1',
        content: 'reply with exactly PONG06',
        cliToolId: 'copilot',
        instanceId: 'copilot',
        copilotModel: params.copilotModel,
      }),
      60_000
    );
  }

  /** The `timestamp` of the user row the send wrote, in epoch ms. */
  function stampedAt(): number {
    const row = mockCreateMessage.mock.calls[0][1] as { timestamp: Date };
    return row.timestamp.getTime();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockStartPolling.mockReset();
    mockGetActivePollers.mockReset();
    mockGetMessages.mockReset();
    mockGetMessages.mockReturnValue([]);
    mockSavePendingAssistantResponse.mockReset();
    mockSavePendingAssistantResponse.mockResolvedValue(null);
    mockDeleteMessageById.mockReturnValue(true);
    mockCreateMessage.mockReturnValue({ id: 'created-msg', role: 'user', content: 'reply with exactly PONG06' });
    vi.useFakeTimers({ now: REQUEST_AT });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('control: the harness loses the previous reply when the body follows the switch at once', async () => {
    // The pre-#2630 order, spelled out: switch, type, restart the poller. If
    // this recorded BUSY06C, the case below would pass without proving anything.
    const h = setUpHarness();
    await runToSettled(
      (async () => {
        await h.sendModelCommand('wt-1', 'claude-sonnet-5', 'copilot');
        await h.sendMessage('wt-1', 'reply with exactly PONG06', 'copilot');
        mockStartPolling('wt-1', 'copilot', 'copilot');
      })(),
      60_000
    );
    // Give the poller every tick it would have had.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.bodyTypedAt()).toBe(SWITCH_ANSWERED_AT);
    expect(h.recorded).toEqual([]);
  });

  it('types the body only after the poller watching the previous turn has recorded it', async () => {
    const h = setUpHarness();

    const result = await send({ copilotModel: 'claude-sonnet-5' });

    expect(result).toMatchObject({ ok: true });
    expect(h.recorded).toEqual(['BUSY06C']);
    expect(h.recordedAt()).toBe(SWITCH_ANSWERED_AT + 643);
    expect(h.bodyTypedAt()).not.toBeNull();
    expect(h.bodyTypedAt()!).toBeGreaterThanOrEqual(h.recordedAt()!);
    // Within one registry re-read of the poller stopping.
    expect(h.bodyTypedAt()! - h.recordedAt()!).toBeLessThanOrEqual(100);
    // The new turn gets its own poller only after the body is in.
    expect(mockStartPolling).toHaveBeenCalledWith('wt-1', 'copilot', 'copilot');
    expect(h.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartPolling.mock.invocationCallOrder[0]
    );
  });

  it('stamps the user row after the switch and the previous turn, not when the request arrived', async () => {
    const h = setUpHarness();

    await send({ copilotModel: 'claude-sonnet-5' });

    const stamp = stampedAt();
    expect(stamp).toBeGreaterThan(PREVIOUS_STOP_AT);
    expect(stamp).toBeGreaterThanOrEqual(SWITCH_ANSWERED_AT);
    // Sorts after the reply the poller just recorded (that row is dated when it
    // was saved).
    expect(stamp).toBeGreaterThanOrEqual(h.recordedAt()!);
    // Read as the body is typed: never after it, or a fast new turn's `stop`
    // could predate the row that asked for it.
    expect(stamp).toBe(h.bodyTypedAt());
    expect(stamp).toBeLessThan(NEW_STOP_AT);
    expect(mockUpdateLastUserMessage).toHaveBeenCalledWith(
      mockDb,
      'wt-1',
      'reply with exactly PONG06',
      new Date(stamp)
    );
  });

  it('runs the pending-response save after the switch has settled, with the same stamp', async () => {
    const h = setUpHarness();

    await send({ copilotModel: 'claude-sonnet-5' });

    expect(mockSavePendingAssistantResponse).toHaveBeenCalledTimes(1);
    expect(mockSavePendingAssistantResponse).toHaveBeenCalledWith(
      mockDb,
      'wt-1',
      'copilot',
      new Date(stampedAt()),
      'copilot'
    );
    expect(h.saveCalledAt()!).toBeGreaterThanOrEqual(SWITCH_ANSWERED_AT);
    const saveOrder = mockSavePendingAssistantResponse.mock.invocationCallOrder[0];
    expect(h.sendModelCommand.mock.invocationCallOrder[0]).toBeLessThan(saveOrder);
    expect(saveOrder).toBeLessThan(mockGetMessages.mock.invocationCallOrder[0]);
    expect(saveOrder).toBeLessThan(h.sendMessage.mock.invocationCallOrder[0]);
  });

  it('does not delete the previous user row when its reply was recorded during the switch', async () => {
    // A retry with the same text: at request time the newest row is the
    // unanswered-looking user row, but by the time the body is typed the poller
    // has written the reply under it.
    const h = setUpHarness();
    mockGetMessages.mockImplementation(() =>
      h.recorded.length > 0
        ? [{ id: 'reply-1', role: 'assistant', content: 'BUSY06C' }]
        : [{ id: 'user-1', role: 'user', content: 'reply with exactly PONG06' }]
    );

    await send({ copilotModel: 'claude-sonnet-5' });

    expect(h.recorded).toEqual(['BUSY06C']);
    expect(mockDeleteMessageById).not.toHaveBeenCalled();
  });

  describe('what `wait --instance copilot` reads from that row (#1975 gate)', () => {
    // `wait` reports on stderr; its lines are what these cases read.
    let mockConsoleError: MockInstance<typeof console.error>;

    beforeEach(() => {
      mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      mockConsoleError.mockRestore();
    });

    /** copilot at its composer; its last `stop` is PONG06's once that has happened. */
    const composerFrame = () => {
      const lastStopEventAt = Date.now() >= NEW_STOP_AT ? NEW_STOP_AT : PREVIOUS_STOP_AT;
      return {
        isRunning: true,
        isComplete: false,
        isPromptWaiting: false,
        isGenerating: false,
        content: 'frame',
        fullOutput: 'frame',
        realtimeSnippet: 'frame',
        lineCount: 1,
        lastCapturedLine: 1,
        promptData: null,
        autoYes: { enabled: false, expiresAt: null },
        thinking: false,
        thinkingMessage: null,
        cliToolId: 'copilot',
        isSelectionListActive: false,
        lastServerResponseTimestamp: null,
        serverPollerActive: false,
        sessionStatus: 'ready',
        sessionStatusReason: 'hook_stop',
        lastStopEventAt,
        structuredEvents: {
          lastEventType: 'stop',
          lastEventAt: lastStopEventAt,
          lastEventDetail: null,
          promptWaitingSince: null,
          promptWaitingSource: null,
          source: {
            cliToolId: 'copilot',
            // src/lib/hooks/sources/copilot/source.ts
            capabilities: {
              supportedEvents: ['stop', 'session_start', 'session_end', 'user_prompt_submit', 'post_tool_use'],
            },
          },
        },
      };
    };

    /** A client serving that frame and a ledger whose newest user row is stamped `stamp`. */
    function clientFor(stamp: number): ApiClient {
      return {
        get: vi.fn(async (path: string) => {
          if (path.startsWith('/api/worktrees/wt-1/current-output')) return composerFrame();
          if (path.startsWith('/api/worktrees/wt-1/messages?')) {
            return [
              {
                id: 'created-msg',
                worktreeId: 'wt-1',
                role: 'user',
                content: 'reply with exactly PONG06',
                timestamp: new Date(stamp).toISOString(),
                messageType: 'normal',
                cliToolId: 'copilot',
                instanceId: 'copilot',
                archived: false,
              },
            ];
          }
          throw new Error(`unexpected request: ${path}`);
        }),
      } as unknown as ApiClient;
    }

    async function waitOn(stamp: number): Promise<{ exitCode: number; completedAt: number }> {
      const { exitCode } = await runToSettled(
        pollWorktree(clientFor(stamp), 'wt-1', {
          instance: 'copilot',
          timeout: 300,
          onPrompt: 'agent',
        }),
        120_000
      );
      return { exitCode, completedAt: Date.now() };
    }

    const stderr = () => mockConsoleError.mock.calls.map((c) => String(c[0]));

    it('control: the stamp the request arrived with completes on the previous turn\'s stop', async () => {
      const { exitCode, completedAt } = await waitOn(REQUEST_AT);

      expect(exitCode).toBe(WaitExitCode.SUCCESS);
      expect(stderr()).toEqual(['Completed: wt-1 (basis=hook_stop)']);
      expect(completedAt).toBeLessThan(NEW_STOP_AT);
    });

    it('holds until the new turn has stopped when the row is stamped by this send', async () => {
      setUpHarness();
      await send({ copilotModel: 'claude-sonnet-5' });

      const { exitCode, completedAt } = await waitOn(stampedAt());

      expect(exitCode).toBe(WaitExitCode.SUCCESS);
      expect(completedAt).toBeGreaterThanOrEqual(NEW_STOP_AT);
      const lines = stderr();
      expect(lines[0]).toContain('has not started this turn yet');
      expect(lines[lines.length - 1]).toBe('Completed: wt-1 (basis=hook_stop)');
    });
  });

  describe('sends that never waited keep their behaviour', () => {
    it('a send without --model neither consults the poller registry nor moves its stamp', async () => {
      // A chain for the running turn is registered and never stops: a send
      // without `--model` types into the running turn at once, as before.
      mockGetActivePollers.mockReturnValue([POLLER_KEY]);
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      mockGetTool.mockReturnValue(makeTool({ sendMessage, getSessionName: vi.fn(() => 'copilot-session') }));

      const result = await send();

      expect(result).toMatchObject({ ok: true });
      expect(mockGetActivePollers).not.toHaveBeenCalled();
      expect(stampedAt()).toBe(REQUEST_AT);
      expect(mockSavePendingAssistantResponse).toHaveBeenCalledWith(
        mockDb,
        'wt-1',
        'copilot',
        new Date(REQUEST_AT),
        'copilot'
      );
      // Same order as before: save, orphan lookup, type.
      const saveOrder = mockSavePendingAssistantResponse.mock.invocationCallOrder[0];
      expect(saveOrder).toBeLessThan(mockGetMessages.mock.invocationCallOrder[0]);
      expect(mockGetMessages.mock.invocationCallOrder[0]).toBeLessThan(
        sendMessage.mock.invocationCallOrder[0]
      );
    });

    it('a --model send to an idle copilot types the body as soon as the switch answers', async () => {
      const h = setUpHarness(false);

      const result = await send({ copilotModel: 'claude-sonnet-5' });

      expect(result).toMatchObject({ ok: true });
      expect(mockGetActivePollers).toHaveBeenCalled();
      expect(h.recorded).toEqual([]);
      expect(h.bodyTypedAt()).toBe(SWITCH_ANSWERED_AT);
      expect(stampedAt()).toBe(SWITCH_ANSWERED_AT);
    });

    it('a poller that never stops delays the body by the bound, not forever', async () => {
      mockGetActivePollers.mockReturnValue([POLLER_KEY]);
      let bodyTypedAt: number | null = null;
      const sendModelCommand = vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, SWITCH_ANSWERED_AT - REQUEST_AT))
      );
      mockGetTool.mockReturnValue(
        makeTool({
          sendModelCommand,
          getSessionName: vi.fn(() => 'copilot-session'),
          sendMessage: vi.fn(async () => {
            bodyTypedAt = Date.now();
          }),
        })
      );

      const result = await send({ copilotModel: 'claude-sonnet-5' });

      expect(result).toMatchObject({ ok: true });
      expect(bodyTypedAt).not.toBeNull();
      const delay = bodyTypedAt! - SWITCH_ANSWERED_AT;
      expect(delay).toBeGreaterThanOrEqual(PREVIOUS_TURN_RECORD_TIMEOUT_MS);
      expect(delay).toBeLessThanOrEqual(PREVIOUS_TURN_RECORD_TIMEOUT_MS + 100);
      expect(mockCreateMessage).toHaveBeenCalledTimes(1);
    });

    it('a refused switch returns before the save and leaves the previous turn\'s poller running', async () => {
      mockGetActivePollers.mockReturnValue([POLLER_KEY]);
      const sendModelCommand = vi.fn().mockRejectedValue(new Error('copilot refused it'));
      const tool = makeTool({ sendModelCommand, getSessionName: vi.fn(() => 'copilot-session') });
      mockGetTool.mockReturnValue(tool);

      const result = await send({ copilotModel: 'claude-opus-4.6' });

      expect(result).toEqual({ ok: false, stage: 'model', error: 'copilot refused it' });
      expect(mockGetActivePollers).not.toHaveBeenCalled();
      expect(mockSavePendingAssistantResponse).not.toHaveBeenCalled();
      expect(mockGetMessages).not.toHaveBeenCalled();
      expect(tool.sendMessage).not.toHaveBeenCalled();
      expect(mockStartPolling).not.toHaveBeenCalled();
    });
  });
});
