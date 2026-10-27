/**
 * Issue #3953: a send is stamped when its body starts going into the composer,
 * not when the request arrived.
 *
 * The stamp is the user row's, and `wait`'s #1975 gate compares it with the
 * agent's last `stop`. Between the request and the first key a send can queue
 * for the instance's input lock (up to 60 s), wait out a carried paste mark,
 * re-read the pane and clear the composer; a previous turn (A) that stops in
 * that time used to be older than nothing — its `stop` was later than B's stamp
 * and read as the end of B.
 *
 * The real `sendUserMessage`, input lock and shared sender run here; tmux is a
 * fake codex pane (`@/lib/tmux/tmux` mocked), the clock is fake, and the row the
 * send writes is handed to the real `wait` loop.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

const mockCreateMessage = vi.fn();
const mockUpdateLastUserMessage = vi.fn();
vi.mock('@/lib/db', () => ({
  createMessage: (...args: unknown[]) => mockCreateMessage(...args),
  updateLastUserMessage: (...args: unknown[]) => mockUpdateLastUserMessage(...args),
  clearInProgressMessageId: vi.fn(),
  getMessages: vi.fn(() => []),
  deleteMessageById: vi.fn(() => true),
}));

const mockGetTool = vi.fn();
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: vi.fn(() => ({ getTool: (...args: unknown[]) => mockGetTool(...args) })) },
}));

vi.mock('@/lib/polling/response-poller', () => ({
  startPolling: vi.fn(),
  getActivePollers: vi.fn(() => []),
}));

const mockSavePendingAssistantResponse = vi.fn();
vi.mock('@/lib/assistant-response-saver', () => ({
  savePendingAssistantResponse: (...args: unknown[]) => mockSavePendingAssistantResponse(...args),
}));

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: '/wt-3953' })),
}));

vi.mock('@/lib/session/prompt-waiting-guard', () => ({
  isPromptWaiting: vi.fn(async () => ({ waiting: false })),
  promptWaitingMessage: vi.fn(() => 'prompt waiting'),
}));

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: vi.fn(async () => ''),
}));

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn(),
  sendSpecialKeys: vi.fn(),
  capturePane: vi.fn(),
  clearInputLine: vi.fn(),
  clearComposerLine: vi.fn(),
  clearComposerPasteToken: vi.fn(),
  exactTarget: (name: string) => `=${name}:`,
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

// A body over 512 bytes is pasted (`load-buffer` → `paste-buffer`, Issue #2464).
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn() };
});

import { sendUserMessage } from '@/lib/session/send-user-message';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import {
  CARRIED_PASTE_MARK_TTL_MS,
  INSTANCE_INPUT_LOCK_WAIT_MS,
  getCarriedPasteMark,
  leaveCarriedPasteMark,
  observeInputStart,
  noteInputStart,
  resetInstanceInputLocks,
  withInstanceInputLock,
} from '@/lib/session/instance-input-lock';
import { sendKeys, sendSpecialKeys, capturePane, clearComposerLine } from '@/lib/tmux/tmux';
import { execFile } from 'child_process';
import { CLAUDE_POST_PROMPT_DELAY } from '@/lib/session/claude-session';
import { pollWorktree } from '../../../../src/cli/commands/wait';
import type { ApiClient } from '../../../../src/cli/utils/api-client';
import { WaitExitCode } from '../../../../src/cli/types';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');
const IDLE = read('long-body-2464/codex-idle.capture');
const LIVE_TOKEN = read('long-body-2464/codex-pasted-content.capture');
const LIVE_TOKEN_ROW = '\u001b[38;5;6m[Pasted Content 12288 chars]\u001b[39m';
const composerFrame = (text: string): string => LIVE_TOKEN.replace(LIVE_TOKEN_ROW, text);

const WT = 'wt-3953';
const BODY = 'reply with exactly PONG3953';
const S = resolveSessionName('codex', WT, 'codex');
const REQUEST_AT = Date.UTC(2026, 9, 28, 9, 0, 0, 0);
const mockDb = {} as never;

// ---------------------------------------------------------------------------
// The fake codex pane: one composer, a log of the body's keys with their time.
// ---------------------------------------------------------------------------

let frame = IDLE;
let bodyTypedAt: number | null = null;
let enteredAt: number | null = null;
/** ms `load-buffer` takes to report back. */
let loadDelayMs = 0;
/** When `paste-buffer` put a pasted body into the pane. */
let bodyPastedAt: number | null = null;

/** codex's own `sendMessage`, reduced to the shared sender it ends in (after `preDelayMs`). */
function installTool(cliToolId: 'codex' | 'claude', preDelayMs = 0): void {
  const sessionName = resolveSessionName(cliToolId, WT, cliToolId);
  mockGetTool.mockReturnValue({
    name: cliToolId,
    getSessionName: vi.fn(() => sessionName),
    sendMessage: vi.fn(async (_wt: string, message: string) => {
      if (preDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, preDelayMs));
      // The pane is codex's either way: what is pinned is the stamp, not the screen.
      await sendMessageWithSubmitVerification({ sessionName, message, cliToolId: 'codex' });
    }),
  });
}

function installPane(): void {
  vi.mocked(capturePane).mockImplementation((async () => frame) as never);
  vi.mocked(sendKeys).mockImplementation((async (_session: string, text: string) => {
    if (text === BODY && bodyTypedAt === null) bodyTypedAt = Date.now();
    frame = composerFrame(text);
  }) as never);
  vi.mocked(sendSpecialKeys).mockImplementation((async (_session: string, keys: string[]) => {
    if (keys[0] === 'Enter') {
      if (enteredAt === null) enteredAt = Date.now();
      frame = IDLE;
    }
  }) as never);
  vi.mocked(clearComposerLine).mockImplementation((async () => {
    frame = IDLE;
  }) as never);
  const buffers = new Map<string, string>();
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null) => void
  ) => {
    const name = args[args.indexOf('-b') + 1];
    if (args[0] === 'load-buffer') {
      return {
        stdin: {
          end: (data: string) => {
            buffers.set(name, data);
            setTimeout(() => callback(null), loadDelayMs);
          },
        },
      };
    }
    if (args[0] === 'paste-buffer') {
      const text = buffers.get(name) ?? '';
      buffers.delete(name);
      if (bodyPastedAt === null) bodyPastedAt = Date.now();
      frame = composerFrame(`[Pasted Content ${text.length} chars]`);
    }
    queueMicrotask(() => callback(null));
    return { stdin: { end: () => undefined } };
  }) as never);
  installTool('codex');
}

/** Advance the fake clock in small steps until `promise` settles. */
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

function sendB(
  content = BODY,
  cliToolId: 'codex' | 'claude' = 'codex'
): Promise<Awaited<ReturnType<typeof sendUserMessage>>> {
  return sendUserMessage(mockDb, { worktreeId: WT, content, cliToolId, instanceId: cliToolId });
}

/** The user row's stamp, in epoch ms. */
const userRowAt = (): number => (mockCreateMessage.mock.calls[0][1] as { timestamp: Date }).timestamp.getTime();
/** The stamp the pending-response save was given, in epoch ms. */
const pendingAt = (): number => (mockSavePendingAssistantResponse.mock.calls[0][3] as Date).getTime();

// ---------------------------------------------------------------------------
// What `wait --instance codex` makes of the row
// ---------------------------------------------------------------------------

/** codex at its composer; `lastStopAt()` is its newest `stop`. */
function readyFrame(lastStopAt: () => number) {
  const lastStopEventAt = lastStopAt();
  return {
    isRunning: true,
    isPromptWaiting: false,
    content: 'frame',
    fullOutput: 'frame',
    realtimeSnippet: 'frame',
    lineCount: 1,
    lastCapturedLine: 1,
    promptData: null,
    autoYes: { enabled: false, expiresAt: null },
    thinking: false,
    cliToolId: 'codex',
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
        cliToolId: 'codex',
        capabilities: { supportedEvents: ['stop', 'session_start', 'user_prompt_submit'] },
      },
    },
  };
}

function clientFor(stamp: number, lastStopAt: () => number): ApiClient {
  return {
    get: vi.fn(async (p: string) => {
      if (p.startsWith(`/api/worktrees/${WT}/current-output`)) return readyFrame(lastStopAt);
      if (p.startsWith(`/api/worktrees/${WT}/messages?`)) {
        return [
          {
            id: 'created-msg',
            worktreeId: WT,
            role: 'user',
            content: BODY,
            timestamp: new Date(stamp).toISOString(),
            messageType: 'normal',
            cliToolId: 'codex',
            instanceId: 'codex',
            archived: false,
          },
        ];
      }
      throw new Error(`unexpected request: ${p}`);
    }),
  } as unknown as ApiClient;
}

/** Run `wait` on a row stamped `stamp`; B's own turn stops at `bStopAt`, A's at `aStopAt`. */
async function waitOn(stamp: number, aStopAt: number, bStopAt: number): Promise<{ exitCode: number; completedAt: number }> {
  const lastStopAt = (): number => (Date.now() >= bStopAt ? bStopAt : aStopAt);
  const { exitCode } = await runToSettled(
    pollWorktree(clientFor(stamp, lastStopAt), WT, { instance: 'codex', timeout: 300, onPrompt: 'agent' }),
    120_000
  );
  return { exitCode, completedAt: Date.now() };
}

describe('a send is stamped when its body starts going in (Issue #3953)', () => {
  let mockConsoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: REQUEST_AT });
    resetInstanceInputLocks();
    frame = IDLE;
    bodyTypedAt = null;
    bodyPastedAt = null;
    loadDelayMs = 0;
    enteredAt = null;
    mockSavePendingAssistantResponse.mockResolvedValue(null);
    mockCreateMessage.mockImplementation((_db: unknown, row: Record<string, unknown>) => ({ id: 'created-msg', ...row }));
    installPane();
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    mockConsoleError.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
    resetInstanceInputLocks();
  });

  describe('A stops while B queues for the input lock', () => {
    const HELD_FOR_MS = 5_000;
    const A_STOP_AT = REQUEST_AT + 3_000;
    const B_STOP_AT = REQUEST_AT + 12_000;

    async function sendBehindHeldLock(): Promise<void> {
      let release!: () => void;
      const held = withInstanceInputLock(S, () => new Promise<void>((resolve) => (release = resolve)));
      setTimeout(() => release(), HELD_FOR_MS);
      const result = await runToSettled(sendB(), 60_000);
      await held;
      expect(result).toMatchObject({ ok: true });
    }

    it('stamps the user row at the first key of the body, after A stopped', async () => {
      await sendBehindHeldLock();

      expect(bodyTypedAt).toBeGreaterThanOrEqual(REQUEST_AT + HELD_FOR_MS);
      expect(userRowAt()).toBe(bodyTypedAt);
      expect(userRowAt()).toBeGreaterThan(A_STOP_AT);
      expect(mockUpdateLastUserMessage).toHaveBeenCalledWith(mockDb, WT, BODY, new Date(userRowAt()));
    });

    it('`wait` does not complete on A\'s stop: it holds until B\'s turn stops', async () => {
      await sendBehindHeldLock();

      const { exitCode, completedAt } = await waitOn(userRowAt(), A_STOP_AT, B_STOP_AT);

      expect(exitCode).toBe(WaitExitCode.SUCCESS);
      expect(completedAt).toBeGreaterThanOrEqual(B_STOP_AT);
    });

    it('control: a row stamped when the request arrived completes on A\'s stop', async () => {
      const { exitCode, completedAt } = await waitOn(REQUEST_AT, A_STOP_AT, B_STOP_AT);

      expect(exitCode).toBe(WaitExitCode.SUCCESS);
      expect(completedAt).toBeLessThan(B_STOP_AT);
    });

    it('keeps the pending row before the user row: its stamp is the earlier one', async () => {
      await sendBehindHeldLock();

      expect(pendingAt()).toBe(REQUEST_AT);
      expect(pendingAt()).toBeLessThan(userRowAt());
      expect(mockSavePendingAssistantResponse.mock.invocationCallOrder[0]).toBeLessThan(
        mockCreateMessage.mock.invocationCallOrder[0]
      );
    });
  });

  describe('A stops while B, admitted at once, waits out a carried paste mark', () => {
    const A_STOP_AT = REQUEST_AT + 3_000;
    const B_STOP_AT = REQUEST_AT + CARRIED_PASTE_MARK_TTL_MS + 4_000;

    async function sendAfterMark(): Promise<number> {
      await withInstanceInputLock(S, async (ticket) => leaveCarriedPasteMark(ticket));
      const expiresAt = getCarriedPasteMark(S)!.expiresAt;
      const result = await runToSettled(sendB(), 60_000);
      expect(result).toMatchObject({ ok: true });
      return expiresAt;
    }

    it('stamps the user row after the mark expired, after A stopped', async () => {
      const expiresAt = await sendAfterMark();

      expect(bodyTypedAt).toBeGreaterThanOrEqual(expiresAt);
      expect(userRowAt()).toBe(bodyTypedAt);
      expect(userRowAt()).toBeGreaterThan(A_STOP_AT);
      expect(pendingAt()).toBe(REQUEST_AT);
    });

    it('`wait` holds until B\'s turn stops', async () => {
      await sendAfterMark();

      const { exitCode, completedAt } = await waitOn(userRowAt(), A_STOP_AT, B_STOP_AT);

      expect(exitCode).toBe(WaitExitCode.SUCCESS);
      expect(completedAt).toBeGreaterThanOrEqual(B_STOP_AT);
    });
  });

  describe('a B that stops at once', () => {
    it('is stamped no later than its first key, so its own stop right after Enter completes `wait`', async () => {
      const result = await runToSettled(sendB(), 60_000);
      expect(result).toMatchObject({ ok: true });
      // B's turn stops 1 ms after its Enter — before the send's read-back is done.
      const bStopAt = enteredAt! + 1;
      expect(userRowAt()).toBeLessThanOrEqual(bodyTypedAt!);
      expect(userRowAt()).toBeLessThan(bStopAt);

      const { exitCode, completedAt } = await waitOn(userRowAt(), REQUEST_AT - 60_000, bStopAt);

      expect(exitCode).toBe(WaitExitCode.SUCCESS);
      expect(completedAt).toBeLessThan(bStopAt + 60_000);
    });
  });

  describe('A stops while a long B is being loaded for its paste (consistency review P2-1)', () => {
    const LONG_BODY = 'B '.padEnd(800, 'b');
    const LOAD_MS = 4_000;
    const A_STOP_AT = REQUEST_AT + 2_000;
    const B_STOP_AT = REQUEST_AT + 10_000;

    async function sendLong(): Promise<void> {
      loadDelayMs = LOAD_MS;
      const result = await runToSettled(sendB(LONG_BODY), 60_000);
      expect(result).toMatchObject({ ok: true });
    }

    it('stamps the user row as the paste reaches the pane, after `load-buffer` and after A stopped', async () => {
      await sendLong();

      expect(bodyPastedAt).toBeGreaterThanOrEqual(REQUEST_AT + LOAD_MS);
      expect(userRowAt()).toBe(bodyPastedAt);
      expect(userRowAt()).toBeGreaterThan(A_STOP_AT);
      expect(pendingAt()).toBe(REQUEST_AT);
    });

    it('`wait` holds until B\'s turn stops', async () => {
      await sendLong();

      const { exitCode, completedAt } = await waitOn(userRowAt(), A_STOP_AT, B_STOP_AT);

      expect(exitCode).toBe(WaitExitCode.SUCCESS);
      expect(completedAt).toBeGreaterThanOrEqual(B_STOP_AT);
    });
  });

  describe('negative controls', () => {
    it('a claude send, whose fixed settle wait moves the clock, is stamped at its first key — not when it arrived', async () => {
      // consistency review P2-2: claude waits CLAUDE_POST_PROMPT_DELAY before the
      // shared sender on every send, so with nothing to queue behind the stamp
      // still lands that much after the request.
      installTool('claude', CLAUDE_POST_PROMPT_DELAY);

      const result = await runToSettled(sendB(BODY, 'claude'), 60_000);

      expect(result).toMatchObject({ ok: true });
      expect(bodyTypedAt).toBe(REQUEST_AT + CLAUDE_POST_PROMPT_DELAY);
      expect(userRowAt()).toBe(bodyTypedAt);
      expect(pendingAt()).toBe(REQUEST_AT);
      expect(pendingAt()).toBeLessThan(userRowAt());
    });

    it('a send that neither queues nor waits out a mark is stamped as before: when it arrived', async () => {
      const result = await runToSettled(sendB(), 60_000);

      expect(result).toMatchObject({ ok: true });
      expect(bodyTypedAt).toBe(REQUEST_AT);
      expect(userRowAt()).toBe(REQUEST_AT);
      expect(pendingAt()).toBe(REQUEST_AT);
    });

    it('a send not admitted in time writes no row (not-sent as before)', async () => {
      let release!: () => void;
      const held = withInstanceInputLock(S, () => new Promise<void>((resolve) => (release = resolve)));
      const attempts: unknown[] = [];
      const result = await runToSettled(
        sendUserMessage(mockDb, {
          worktreeId: WT,
          content: BODY,
          cliToolId: 'codex',
          instanceId: 'codex',
          onAttempt: (a) => attempts.push(a),
        }),
        INSTANCE_INPUT_LOCK_WAIT_MS + 1_000
      );
      release();
      await held;

      expect(result).toMatchObject({ ok: false, stage: 'send' });
      expect(attempts).toEqual([{ state: 'not-sent', reason: 'input-lock-timeout' }]);
      expect(bodyTypedAt).toBeNull();
      expect(mockCreateMessage).not.toHaveBeenCalled();
      expect(mockUpdateLastUserMessage).not.toHaveBeenCalled();
    });

    it('a path that never notes input keeps the stamp read before the save', async () => {
      mockGetTool.mockReturnValue({
        name: 'OpenCode',
        getSessionName: vi.fn(() => 'opencode-session'),
        sendMessage: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 2_000))),
      });

      const result = await runToSettled(
        sendUserMessage(mockDb, { worktreeId: WT, content: BODY, cliToolId: 'opencode' }),
        60_000
      );

      expect(result).toMatchObject({ ok: true });
      expect(userRowAt()).toBe(REQUEST_AT);
    });
  });
});

describe('observeInputStart / noteInputStart (Issue #3953)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: REQUEST_AT });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the first note in its context and ignores later ones', async () => {
    const observed = observeInputStart(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      noteInputStart();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      noteInputStart();
      return 'done';
    });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(observed).resolves.toEqual({ value: 'done', inputStartedAt: new Date(REQUEST_AT + 1_000) });
  });

  it('reports null when nothing noted input, and a note outside any context does nothing', async () => {
    noteInputStart();
    await expect(observeInputStart(async () => 1)).resolves.toEqual({ value: 1, inputStartedAt: null });
  });

  it('keeps concurrent contexts apart', async () => {
    const a = observeInputStart(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      noteInputStart();
    });
    const b = observeInputStart(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      noteInputStart();
    });
    await vi.advanceTimersByTimeAsync(300);

    expect((await a).inputStartedAt).toEqual(new Date(REQUEST_AT + 300));
    expect((await b).inputStartedAt).toEqual(new Date(REQUEST_AT + 100));
  });
});
