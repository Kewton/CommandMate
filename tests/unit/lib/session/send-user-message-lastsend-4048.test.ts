/**
 * Issue #4048 (review P2 ×2), at the send service:
 *
 * - The late failure of a send whose session was replaced does not overwrite
 *   the newer generation's `lastSend` (`inputGeneration` on the record).
 * - An image send is recorded with the body actually typed (the image
 *   reference appended), so the composer residue the next send finds — known
 *   to the first-prompt receipt by that body — demotes it.
 *
 * Nothing here touches the repository's files or tmux: the tool, the capture
 * and the DB are mocked, and the records live in process memory.
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

vi.mock('@/lib/session/prompt-waiting-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/prompt-waiting-guard')>()),
  isPromptWaiting: vi.fn(async () => ({ waiting: false })),
}));

vi.mock('@/lib/db', () => ({
  createMessage: vi.fn((_db: unknown, msg: Record<string, unknown>) => ({ id: 'row-1', ...msg })),
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
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: vi.fn().mockResolvedValue('raw frame'),
  captureSessionOutput: vi.fn(),
}));
vi.mock('@/lib/detection/composer-text', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/composer-text')>()),
  extractComposerText: vi.fn(() => ({ text: '', state: 'empty' })),
}));

import { sendUserMessage } from '@/lib/session/send-user-message';
import { isPromptWaiting } from '@/lib/session/prompt-waiting-guard';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { invalidateInstanceInput } from '@/lib/session/instance-input-lock';
import {
  clearSendAttempts,
  getLastSendAttempt,
  markLastSendDiscarded,
  sendMessageDigest,
} from '@/lib/session/send-attempt-state';
import {
  clearPromptSubmitReceipts,
  findSubmittedBody,
  notePromptSubmitSession,
  noteSubmittedBody,
} from '@/lib/session/prompt-submit-receipt';
import { ClaudeTool } from '@/lib/cli-tools/claude';

const mockDb = {} as never;
const WT = 'wt-4048';
const SESSION = resolveSessionName('claude', WT, undefined);
const INSTANCE = { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' };

/** The error the sender throws for a send whose session was replaced after its Enter. */
function replacedAfterEnter(): Error {
  return new Error(
    `Session ${SESSION} was replaced during the read-back, after the message and Enter were sent; ` +
      'the previous process may have submitted it (Issue #4048).'
  );
}

function deferred(): { promise: Promise<void>; reject: (error: Error) => void } {
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((_resolve, rej) => {
    reject = rej;
  });
  return { promise, reject };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
  expect(condition()).toBe(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSendAttempts();
  clearPromptSubmitReceipts();
});

afterEach(() => {
  clearSendAttempts();
  clearPromptSubmitReceipts();
});

describe('[#4048 review P2] a replaced session\'s late failure does not overwrite the newer lastSend', () => {
  it('positive: the new generation sent, then the old send fails — lastSend stays the new sent', async () => {
    const old = deferred();
    const sendMessage = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(undefined);
    mockGetTool.mockReturnValue({ name: 'Claude', sendMessage, sendMessageWithImage: vi.fn() });
    const oldAttempt = vi.fn();

    const oldSend = sendUserMessage(mockDb, { worktreeId: WT, content: 'old body', cliToolId: 'claude', onAttempt: oldAttempt });
    await until(() => sendMessage.mock.calls.length === 1);
    // The session is recreated (by another request) while the old send is in flight.
    invalidateInstanceInput(SESSION);
    const newResult = await sendUserMessage(mockDb, { worktreeId: WT, content: 'new body', cliToolId: 'claude' });
    expect(newResult.ok).toBe(true);
    old.reject(replacedAfterEnter());
    const oldResult = await oldSend;

    expect(oldResult.ok).toBe(false);
    // The old request is still told its own outcome.
    expect(oldAttempt).toHaveBeenCalledWith({ state: 'indeterminate', reason: 'send-error' });
    expect(getLastSendAttempt(INSTANCE)).toMatchObject({
      state: 'sent',
      reason: 'submitted',
      messageDigest: sendMessageDigest('new body'),
    });
  });

  it('negative: no newer send — the failure is recorded as before', async () => {
    mockGetTool.mockReturnValue({
      name: 'Claude',
      sendMessage: vi.fn().mockRejectedValue(replacedAfterEnter()),
      sendMessageWithImage: vi.fn(),
    });

    await sendUserMessage(mockDb, { worktreeId: WT, content: 'old body', cliToolId: 'claude' });

    expect(getLastSendAttempt(INSTANCE)).toMatchObject({
      state: 'indeterminate',
      reason: 'send-error',
      messageDigest: sendMessageDigest('old body'),
    });
  });

  it('negative: a later send of the same generation order still replaces the record', async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(replacedAfterEnter()).mockResolvedValueOnce(undefined);
    mockGetTool.mockReturnValue({ name: 'Claude', sendMessage, sendMessageWithImage: vi.fn() });

    await sendUserMessage(mockDb, { worktreeId: WT, content: 'first', cliToolId: 'claude' });
    await sendUserMessage(mockDb, { worktreeId: WT, content: 'second', cliToolId: 'claude' });

    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ state: 'sent', messageDigest: sendMessageDigest('second') });
  });
});

describe('[#4048 re-review P2] a request refused before the lock is ordered by when it began', () => {
  type Guard = Awaited<ReturnType<typeof isPromptWaiting>>;

  function heldGuard(): { promise: Promise<Guard>; resolve: (guard: Guard) => void } {
    let resolve!: (guard: Guard) => void;
    const promise = new Promise<Guard>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  const WAITING = { waiting: true, reason: 'dialog', blockedBy: null } as unknown as Guard;
  const FREE = { waiting: false } as unknown as Guard;

  it('positive: the old request\'s guard read waits, the new one sends, then the old guard refuses — lastSend stays the new sent', async () => {
    const oldGuard = heldGuard();
    vi.mocked(isPromptWaiting).mockReturnValueOnce(oldGuard.promise).mockResolvedValueOnce(FREE);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    mockGetTool.mockReturnValue({ name: 'Claude', sendMessage, sendMessageWithImage: vi.fn() });
    const oldAttempt = vi.fn();

    const oldSend = sendUserMessage(mockDb, { worktreeId: WT, content: 'old body', cliToolId: 'claude', onAttempt: oldAttempt });
    await until(() => vi.mocked(isPromptWaiting).mock.calls.length === 1);
    expect((await sendUserMessage(mockDb, { worktreeId: WT, content: 'new body', cliToolId: 'claude' })).ok).toBe(true);
    oldGuard.resolve(WAITING);
    const oldResult = await oldSend;

    expect(oldResult).toMatchObject({ ok: false, stage: 'prompt_waiting' });
    expect(oldAttempt).toHaveBeenCalledWith({ state: 'not-sent', reason: 'prompt-waiting' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const record = getLastSendAttempt(INSTANCE);
    expect(record).toMatchObject({ state: 'sent', reason: 'submitted', messageDigest: sendMessageDigest('new body') });
    // The newer record keeps its generation.
    expect(record?.inputGeneration).toEqual(expect.any(Number));
  });

  it('negative: the reverse order — the old request sent, then a later request is refused — the refusal is recorded', async () => {
    vi.mocked(isPromptWaiting).mockResolvedValueOnce(FREE).mockResolvedValueOnce(WAITING);
    mockGetTool.mockReturnValue({ name: 'Claude', sendMessage: vi.fn().mockResolvedValue(undefined), sendMessageWithImage: vi.fn() });

    expect((await sendUserMessage(mockDb, { worktreeId: WT, content: 'old body', cliToolId: 'claude' })).ok).toBe(true);
    await sendUserMessage(mockDb, { worktreeId: WT, content: 'new body', cliToolId: 'claude' });

    expect(getLastSendAttempt(INSTANCE)).toMatchObject({
      state: 'not-sent',
      reason: 'prompt-waiting',
      messageDigest: sendMessageDigest('new body'),
    });
  });

  it('negative: a request that began first but reached the lock after a later request\'s refusal is still recorded', async () => {
    const oldGuard = heldGuard();
    vi.mocked(isPromptWaiting).mockReturnValueOnce(oldGuard.promise).mockResolvedValueOnce(WAITING);
    mockGetTool.mockReturnValue({ name: 'Claude', sendMessage: vi.fn().mockResolvedValue(undefined), sendMessageWithImage: vi.fn() });

    const oldSend = sendUserMessage(mockDb, { worktreeId: WT, content: 'old body', cliToolId: 'claude' });
    await until(() => vi.mocked(isPromptWaiting).mock.calls.length === 1);
    await sendUserMessage(mockDb, { worktreeId: WT, content: 'new body', cliToolId: 'claude' });
    oldGuard.resolve(FREE);
    expect((await oldSend).ok).toBe(true);

    // Its body went in after that refusal: the last thing that happened.
    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ state: 'sent', messageDigest: sendMessageDigest('old body') });
  });
});

describe('[#4048 review P2] an image send is known by the body actually typed', () => {
  const IMAGE = '/abs/path/shot.png';
  const claude = new ClaudeTool();

  /** A claude tool whose image send notes the typed body, as the sender does for a screen-only `sent`. */
  function imageTool() {
    const sendMessageWithImage = vi.fn(async (_wt: string, message: string, imagePath: string) => {
      noteSubmittedBody(SESSION, claude.imageMessageBody(message, imagePath));
    });
    return {
      name: 'Claude',
      sendMessage: vi.fn(),
      supportsImage: () => true as const,
      imageMessageBody: (message: string, imagePath: string) => claude.imageMessageBody(message, imagePath),
      sendMessageWithImage,
    };
  }

  it('positive: the residue of the image send found by the next send demotes its sent record', async () => {
    notePromptSubmitSession(SESSION, { worktreeId: WT, cliToolId: 'claude' }, Date.now() - 2000);
    mockGetTool.mockReturnValue(imageTool());

    const result = await sendUserMessage(mockDb, {
      worktreeId: WT,
      content: 'この画像を見てください',
      cliToolId: 'claude',
      absoluteImagePath: IMAGE,
    });
    expect(result.ok).toBe(true);

    // The next send's clear reads the typed body back in the composer (#4035 / #4048 item 4).
    const found = findSubmittedBody(SESSION, `この画像を見てください ![](${IMAGE})`);
    expect(found).toEqual({ messageDigest: sendMessageDigest(`この画像を見てください\n![](${IMAGE})`) });
    markLastSendDiscarded(INSTANCE, Date.now(), found?.messageDigest);

    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ state: 'indeterminate', reason: 'found-in-composer' });
  });

  it('negative: the record still names the request\'s own text (the send route\'s fallback match)', async () => {
    mockGetTool.mockReturnValue(imageTool());

    await sendUserMessage(mockDb, { worktreeId: WT, content: 'caption', cliToolId: 'claude', absoluteImagePath: IMAGE });

    expect(getLastSendAttempt(INSTANCE)).toMatchObject({
      state: 'sent',
      messageDigest: sendMessageDigest('caption'),
      typedDigest: sendMessageDigest(`caption\n![](${IMAGE})`),
    });
  });

  it('negative: a send without an image carries no second digest', async () => {
    mockGetTool.mockReturnValue({ name: 'Claude', sendMessage: vi.fn().mockResolvedValue(undefined), sendMessageWithImage: vi.fn() });

    await sendUserMessage(mockDb, { worktreeId: WT, content: 'plain', cliToolId: 'claude' });

    expect(getLastSendAttempt(INSTANCE)).not.toHaveProperty('typedDigest');
  });

  it('ClaudeTool types exactly imageMessageBody', async () => {
    const tool = new ClaudeTool();
    const sendMessage = vi.spyOn(tool, 'sendMessage').mockResolvedValue(undefined);

    await tool.sendMessageWithImage(WT, 'caption', IMAGE);
    await tool.sendMessageWithImage(WT, '', IMAGE);

    expect(sendMessage).toHaveBeenNthCalledWith(1, WT, tool.imageMessageBody('caption', IMAGE), undefined);
    expect(sendMessage).toHaveBeenNthCalledWith(2, WT, `\n![](${IMAGE})`, undefined);
  });
});
