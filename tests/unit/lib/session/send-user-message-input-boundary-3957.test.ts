/**
 * The REQUIRED input-boundary hook a relay-bound send records its lower bound
 * with (Issue #3957, PR 2).
 *
 * Unlike #3957's `onStart` (logged and swallowed), a throw from
 * `InputBoundaryHooks.beforeInput` must stop the sender before its first key:
 * the relay reservation is gone (cancelled, expired, taken) and typing the body
 * would hand the reply to nobody — or to the wrong relay. The real
 * `sendUserMessage`, input lock and shared sender run here against a fake
 * codex pane (`@/lib/tmux/tmux` mocked) on a fake clock; nothing touches tmux.
 *
 * Also: the hook runs AFTER the lock wait (the S3 window), and the dispatch
 * notes opencode's HTTP path uses.
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
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: '/wt-3957' })),
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
  InputBoundaryRefusedError,
  isInputBoundaryRefusal,
  noteDispatchFailed,
  noteDispatchStart,
  noteInputStart,
  observeInputStart,
  resetInstanceInputLocks,
  withInstanceInputLock,
  type InputBoundaryKind,
} from '@/lib/session/instance-input-lock';
import { sendKeys, sendSpecialKeys, capturePane, clearComposerLine } from '@/lib/tmux/tmux';
import { execFile } from 'child_process';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');
const IDLE = read('long-body-2464/codex-idle.capture');
const LIVE_TOKEN = read('long-body-2464/codex-pasted-content.capture');
const LIVE_TOKEN_ROW = '\u001b[38;5;6m[Pasted Content 12288 chars]\u001b[39m';
const composerFrame = (text: string): string => LIVE_TOKEN.replace(LIVE_TOKEN_ROW, text);

const WT = 'wt-3957-boundary';
const BODY = 'reply with exactly PONG3957';
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



function sendWith(
  hook: (at: Date, kind: InputBoundaryKind) => void,
  content = BODY,
  onAttempt?: (attempt: { state: string; reason: string }) => void
): Promise<Awaited<ReturnType<typeof sendUserMessage>>> {
  return sendUserMessage(mockDb, {
    worktreeId: WT,
    content,
    cliToolId: 'codex',
    instanceId: 'codex',
    inputBoundary: { beforeInput: hook },
    onAttempt,
  });
}

describe('the required input-boundary hook (Issue #3957)', () => {
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

  it('control: a hook that succeeds runs once, right before the typed body, kind input_start', async () => {
    const calls: Array<{ at: number; kind: string }> = [];
    const result = await runToSettled(sendWith((at, kind) => calls.push({ at: at.getTime(), kind })), 30_000);
    expect(result).toMatchObject({ ok: true });
    expect(calls).toEqual([{ at: bodyTypedAt, kind: 'input_start' }]);
  });

  it('a refusing hook stops a TYPED body before its first key, and the attempt is not-sent', async () => {
    const attempts: Array<{ state: string }> = [];
    const result = await runToSettled(
      sendWith(() => { throw new Error('reservation gone'); }, BODY, (a) => attempts.push(a)),
      30_000
    );
    expect(result).toMatchObject({ ok: false, stage: 'send' });
    expect(bodyTypedAt).toBeNull();
    expect(enteredAt).toBeNull();
    expect(vi.mocked(sendKeys).mock.calls.some((call) => call[1] === BODY)).toBe(false);
    expect(attempts).toEqual([{ state: 'not-sent', reason: 'input-lock-lost' }]);
    expect(mockCreateMessage).not.toHaveBeenCalled();
  });

  it('a refusing hook stops a PASTED body before `paste-buffer`', async () => {
    const long = `${'x'.repeat(600)} ${BODY}`;
    const result = await runToSettled(sendWith(() => { throw new Error('reservation gone'); }, long), 30_000);
    expect(result).toMatchObject({ ok: false });
    expect(bodyPastedAt).toBeNull();
    expect(enteredAt).toBeNull();
  });

  it('runs after the input-lock wait: a turn that ended while the send queued is before the boundary', async () => {
    const HELD_FOR_MS = 5_000;
    let release!: () => void;
    const held = withInstanceInputLock(S, () => new Promise<void>((resolve) => (release = resolve)));
    setTimeout(() => release(), HELD_FOR_MS);
    let boundary = 0;
    const result = await runToSettled(sendWith((at) => { boundary = at.getTime(); }), 60_000);
    await held;
    expect(result).toMatchObject({ ok: true });
    expect(boundary).toBeGreaterThanOrEqual(REQUEST_AT + HELD_FOR_MS);
  });
});

describe('observeInputStart: boundary hooks and the dispatch notes (Issue #3957)', () => {
  it('a hook throw propagates out of noteInputStart as InputBoundaryRefusedError; onStart is not run', async () => {
    const onStart = vi.fn();
    await expect(
      observeInputStart(async () => { noteInputStart(); }, onStart, {
        beforeInput: () => { throw new Error('gone'); },
      })
    ).rejects.toBeInstanceOf(InputBoundaryRefusedError);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('control: an onStart throw is still swallowed (the hook is the only required one)', async () => {
    const { inputStartedAt } = await observeInputStart(
      async () => { noteInputStart(new Date(5)); },
      () => { throw new Error('ignored'); }
    );
    expect(inputStartedAt?.getTime()).toBe(5);
  });

  it('a refusal is still recognised after a sender rewrapped it in its own message', () => {
    const wrapped = new Error(`Failed to send message to OpenCode: ${new InputBoundaryRefusedError(new Error('x')).message}`);
    expect(isInputBoundaryRefusal(wrapped)).toBe(true);
    expect(isInputBoundaryRefusal(new Error('prompt not ready'))).toBe(false);
  });

  it('noteDispatchStart runs the hook as dispatch, does not fix the input-start stamp, and can refuse', async () => {
    const kinds: string[] = [];
    const { inputStartedAt } = await observeInputStart(async () => {
      noteDispatchStart(new Date(10));
    }, undefined, { beforeInput: (_at, kind) => kinds.push(kind) });
    expect(kinds).toEqual(['dispatch']);
    expect(inputStartedAt).toBeNull();

    await expect(
      observeInputStart(async () => { noteDispatchStart(); }, undefined, {
        beforeInput: () => { throw new Error('gone'); },
      })
    ).rejects.toBeInstanceOf(InputBoundaryRefusedError);
  });

  it('noteDispatchFailed reaches the hook only after a noted dispatch, once, before the fallback types', async () => {
    const events: string[] = [];
    await observeInputStart(async () => {
      noteDispatchFailed('unknown');
      noteDispatchStart(new Date(10));
      noteDispatchFailed('not_sent');
      noteDispatchFailed('unknown');
      noteInputStart(new Date(20));
    }, undefined, {
      beforeInput: (at, kind) => events.push(`${kind}@${at.getTime()}`),
      onDispatchFailed: (verdict) => events.push(`failed:${verdict}`),
    });
    expect(events).toEqual(['dispatch@10', 'failed:not_sent', 'input_start@20']);
  });
});
