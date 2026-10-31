/**
 * Issue #4031 (items 2 and 4), at the send service:
 *
 * - 4: a long body whose `load-buffer` failed never reached the pane, so the
 *   send is `not-sent` (`paste-not-started`) with or without a bound relay —
 *   read by code through the tool's wrap (`cause`), not by wording. A
 *   `paste-buffer` failure (same transport wording before #4031) stays
 *   `indeterminate` / `send-error`.
 * - 2: the PROMPT_WAITING refusal names the instance the send was for
 *   (`--instance codex-2`); a send to the primary keeps the sentence as before.
 *
 * Nothing here touches the repository's files or tmux: the tool, the capture
 * and the DB are mocked, and the record lives in process memory.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));

const mockIsPromptWaiting = vi.fn();
vi.mock('@/lib/session/prompt-waiting-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/prompt-waiting-guard')>()),
  isPromptWaiting: (...args: unknown[]) => mockIsPromptWaiting(...args),
}));

const mockCreateMessage = vi.fn();
vi.mock('@/lib/db', () => ({
  createMessage: (...args: unknown[]) => mockCreateMessage(...args),
  updateLastUserMessage: vi.fn(),
  clearInProgressMessageId: vi.fn(),
  getMessages: vi.fn(() => []),
  deleteMessageById: vi.fn(() => true),
}));

const mockGetTool = vi.fn();
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({ getTool: (...args: unknown[]) => mockGetTool(...args) })),
  },
}));

vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn(), getActivePollers: () => [] }));
vi.mock('@/lib/assistant-response-saver', () => ({
  savePendingAssistantResponse: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

const mockCaptureFresh = vi.fn();
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: (...args: unknown[]) => mockCaptureFresh(...args),
  captureSessionOutput: vi.fn(),
}));

const mockExtractComposerText = vi.fn();
vi.mock('@/lib/detection/composer-text', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/composer-text')>()),
  extractComposerText: (...args: unknown[]) => mockExtractComposerText(...args),
}));

import { sendUserMessage } from '@/lib/session/send-user-message';
import {
  classifySendFailure,
  clearSendAttempts,
  getLastSendAttempt,
} from '@/lib/session/send-attempt-state';
import { PASTE_NOT_STARTED_CODE } from '@/lib/session/send-attempt-types';

const mockDb = {} as never;

/** The error `pasteBody` throws when `load-buffer` failed (#4011 / #4031). */
function loadBufferFailure(): Error {
  return Object.assign(
    new Error('Failed to load message into tmux buffer: Command failed: tmux load-buffer -b cm-send-1-1 -'),
    { delivery: 'not-started' as const, code: PASTE_NOT_STARTED_CODE },
  );
}

/** The error `pasteBody` throws when `paste-buffer` failed: some of it may be on the pane. */
function pasteBufferFailure(): Error {
  return new Error('Failed to paste message into tmux session: Command failed: tmux paste-buffer -p -r -d');
}

/** A tool's wrap, as every tool but claude writes it since #4031. */
function wrapped(tool: string, error: Error): Error {
  return new Error(`Failed to send message to ${tool}: ${error.message}`, { cause: error });
}

function tool(sendMessage: ReturnType<typeof vi.fn>) {
  return { name: 'Tool', sendMessage, sendMessageWithImage: vi.fn(), sendModelCommand: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSendAttempts();
  mockIsPromptWaiting.mockResolvedValue({ waiting: false });
  mockCreateMessage.mockImplementation((_db: unknown, msg: Record<string, unknown>) => ({ id: 'row-1', ...msg }));
  mockCaptureFresh.mockResolvedValue('raw frame');
  mockExtractComposerText.mockReturnValue({ text: '', state: 'empty' });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSendAttempts();
});

describe('[#4031] classifySendFailure: a failed load-buffer is not-sent', () => {
  it('positive: wrapped by a tool (cause kept) — not-sent / paste-not-started', () => {
    expect(classifySendFailure(wrapped('Codex', loadBufferFailure()))).toEqual({
      state: 'not-sent',
      reason: 'paste-not-started',
    });
  });

  it('positive: unwrapped (claude, whose sender does not wrap) — not-sent / paste-not-started', () => {
    expect(classifySendFailure(loadBufferFailure())).toEqual({ state: 'not-sent', reason: 'paste-not-started' });
  });

  it('negative: a paste-buffer failure stays indeterminate / send-error', () => {
    expect(classifySendFailure(wrapped('Codex', pasteBufferFailure()))).toEqual({
      state: 'indeterminate',
      reason: 'send-error',
    });
    expect(classifySendFailure(pasteBufferFailure())).toEqual({ state: 'indeterminate', reason: 'send-error' });
  });

  it('negative: `delivery: not-started` alone (a later tmux call that never started) is not read as not-sent', () => {
    const enterNeverStarted = Object.assign(new Error('Failed to send special key: Command failed: tmux send-keys Enter'), {
      delivery: 'not-started' as const,
    });
    expect(classifySendFailure(wrapped('Codex', enterNeverStarted))).toEqual({
      state: 'indeterminate',
      reason: 'send-error',
    });
  });

  it('negative: the wording alone, without the code, is not trusted', () => {
    expect(classifySendFailure(new Error('Failed to send message to Codex: Failed to load message into tmux buffer: x'))).toEqual({
      state: 'indeterminate',
      reason: 'send-error',
    });
  });
});

describe('[#4031] sendUserMessage: lastSend after a failed load-buffer (no relay)', () => {
  it('positive: the attempt and lastSend are not-sent / paste-not-started', async () => {
    mockGetTool.mockReturnValue(tool(vi.fn().mockRejectedValue(wrapped('Codex', loadBufferFailure()))));
    const onAttempt = vi.fn();
    const result = await sendUserMessage(mockDb, { worktreeId: 'wt-1', content: 'x'.repeat(600), cliToolId: 'codex', onAttempt });

    expect(result.ok).toBe(false);
    expect(onAttempt).toHaveBeenCalledWith({ state: 'not-sent', reason: 'paste-not-started' });
    expect(getLastSendAttempt({ worktreeId: 'wt-1', cliToolId: 'codex', instanceId: 'codex' })).toMatchObject({
      state: 'not-sent',
      reason: 'paste-not-started',
    });
  });

  it('negative: a failed paste-buffer stays indeterminate', async () => {
    mockGetTool.mockReturnValue(tool(vi.fn().mockRejectedValue(wrapped('Codex', pasteBufferFailure()))));
    const onAttempt = vi.fn();
    await sendUserMessage(mockDb, { worktreeId: 'wt-1', content: 'x'.repeat(600), cliToolId: 'codex', onAttempt });

    expect(onAttempt).toHaveBeenCalledWith({ state: 'indeterminate', reason: 'send-error' });
    expect(getLastSendAttempt({ worktreeId: 'wt-1', cliToolId: 'codex', instanceId: 'codex' })).toMatchObject({
      state: 'indeterminate',
    });
  });
});

describe('[#4031] sendUserMessage: the PROMPT_WAITING refusal names the instance', () => {
  it('positive: a send to codex-2 is told to answer with --instance codex-2', async () => {
    mockIsPromptWaiting.mockResolvedValue({ waiting: true, blockedBy: 'scraper', reason: 'prompt_detected' });
    mockGetTool.mockReturnValue(tool(vi.fn()));
    const result = await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'hello',
      cliToolId: 'codex',
      instanceId: 'codex-2',
    });

    expect(result).toMatchObject({ ok: false, stage: 'prompt_waiting' });
    expect((result as { error: string }).error).toContain('`commandmate respond wt-1 <answer> --instance codex-2`');
  });

  it('positive: the send hint of the structured refusal names it too', async () => {
    mockIsPromptWaiting.mockResolvedValue({ waiting: true, blockedBy: 'structured', reason: 'hook_permission_prompt' });
    mockGetTool.mockReturnValue(tool(vi.fn()));
    const result = await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'hello',
      cliToolId: 'codex',
      instanceId: 'codex-2',
    });

    expect((result as { error: string }).error).toContain(
      '`commandmate send wt-1 <message> --instance codex-2 --ignore-structured-prompt`',
    );
  });

  it('negative: a send to the primary keeps the sentence as before', async () => {
    mockIsPromptWaiting.mockResolvedValue({ waiting: true, blockedBy: 'scraper', reason: 'prompt_detected' });
    mockGetTool.mockReturnValue(tool(vi.fn()));
    const result = await sendUserMessage(mockDb, { worktreeId: 'wt-1', content: 'hello', cliToolId: 'codex' });

    const error = (result as { error: string }).error;
    expect(error).toContain('Answer the prompt first: `commandmate respond wt-1 <answer>`.');
    expect(error).not.toContain('--instance');
  });
});
