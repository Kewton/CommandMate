/**
 * The last send attempt per instance (Issue #3759): not-sent / sent /
 * indeterminate, published as `lastSend` on the prompt observation.
 *
 * Positive controls fail on the code before #3759 (there was no record, no
 * `sendState`, no `lastSend`): #3746's `Antigravity prompt not ready` is kept
 * as `not-sent`, a typed-but-unsent body as `indeterminate`. Negative controls
 * pin what must not change: a successful send still returns its row, a send is
 * never retried on any state, and a record that cannot be made leaves the send's
 * result as it was.
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
vi.mock('@/lib/session/prompt-waiting-guard', () => ({
  isPromptWaiting: (...args: unknown[]) => mockIsPromptWaiting(...args),
  promptWaitingMessage: () => 'wt-1 is waiting on a prompt.',
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
  composerHoldsMessage,
  describeSendAttemptState,
  getLastSendAttempt,
  recordSendAttempt,
  sendMessageDigest,
} from '@/lib/session/send-attempt-state';
import { SessionStartTimeoutError } from '@/lib/session/session-start-error';
import { buildPromptObservation, type ObservationInput } from '@/lib/prompt-observation/observe';
import { formatLastSend, formatPromptObservation } from '../../../../src/cli/commands/prompt';

const mockDb = {} as never;

/** #3746's failure, as `AntigravityTool.sendMessage` wraps it. */
const AGY_NOT_READY =
  'Failed to send message to Antigravity: Antigravity prompt not ready: timed out waiting for the input prompt before sending';
const SUBMIT_UNCONFIRMED =
  'Failed to send message to Claude: Message submit could not be confirmed for session mcbd-claude-wt-1 after 3 attempts (typed but unsent)';

/** The primary instance's record. */
const LAST = (cliToolId: string) => getLastSendAttempt({ worktreeId: 'wt-1', cliToolId, instanceId: cliToolId });

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

describe('[#3759] classifySendFailure', () => {
  it('[#3880] the body quoted in a body-not-landed error never makes it not-sent', () => {
    // The composer's first row is the user's own text, and it says `prompt not ready`.
    expect(
      classifySendFailure(
        new Error(
          'Failed to send message to Codex: Message body did not arrive intact for session s: the paste had not finished ' +
            'arriving after 2000ms (the composer shows "prompt not ready: why does agy say this?"); the message is 1200 bytes / 21 lines. ' +
            'Enter was not pressed, so nothing was submitted (Issue #2464).'
        )
      )
    ).toEqual({ state: 'indeterminate', reason: 'body-not-landed' });
    expect(
      classifySendFailure(
        new Error(
          'Message body did not appear in the composer for session s within 5000ms (it shows "still holds unsent text after 3 clear passes"); ' +
            'the message is 300 bytes. Enter was not pressed, so nothing was submitted (Issue #3366).'
        )
      )
    ).toEqual({ state: 'indeterminate', reason: 'body-not-landed' });
  });

  it('reads every tool\'s readiness timeout as not-sent (positive: #3746)', () => {
    expect(classifySendFailure(new Error(AGY_NOT_READY))).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
    expect(
      classifySendFailure(new Error('Codex prompt not ready: timed out waiting for the input prompt before sending'))
    ).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
    expect(
      classifySendFailure(new SessionStartTimeoutError('Command Code CLI', 'mcbd-command-code-wt-1', 48_000))
    ).toEqual({ state: 'not-sent', reason: 'session-starting' });
    expect(
      classifySendFailure(
        new Error('Composer for session s still holds unsent text after 5 clear passes; refusing to type the message')
      )
    ).toEqual({ state: 'not-sent', reason: 'composer-not-empty' });
  });

  it('reads anything after the body may have been typed as indeterminate (negative: never not-sent)', () => {
    expect(classifySendFailure(new Error(SUBMIT_UNCONFIRMED))).toEqual({
      state: 'indeterminate',
      reason: 'submit-unconfirmed',
    });
    expect(
      classifySendFailure(new Error('Message body did not arrive intact … Enter was not pressed, so nothing was submitted (Issue #2464).'))
    ).toEqual({ state: 'indeterminate', reason: 'body-not-landed' });
    expect(classifySendFailure(new Error('Message was replaced by a TUI autocompletion for session s'))).toEqual({
      state: 'indeterminate',
      reason: 'replaced-by-completion',
    });
    // An error nobody measured is not "safe to resend".
    expect(classifySendFailure(new Error('tmux: server exited unexpectedly'))).toEqual({
      state: 'indeterminate',
      reason: 'send-error',
    });
    expect(classifySendFailure('boom')).toEqual({ state: 'indeterminate', reason: 'send-error' });
  });
});

describe('[#3759] sendUserMessage records the attempt', () => {
  it('keeps a prompt-not-ready send as not-sent, and does not resend it', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error(AGY_NOT_READY));
    mockGetTool.mockReturnValue(tool(sendMessage));

    const result = await sendUserMessage(mockDb, { worktreeId: 'wt-1', content: 'first brief', cliToolId: 'antigravity' });

    // The result keeps its shape; the state is in the record.
    expect(result).toEqual({ ok: false, stage: 'send', error: AGY_NOT_READY });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(getLastSendAttempt({ worktreeId: 'wt-1', cliToolId: 'antigravity', instanceId: 'antigravity' })).toMatchObject({
      state: 'not-sent',
      reason: 'prompt-not-ready',
      messageDigest: sendMessageDigest('first brief'),
    });
    // Nothing was typed, so nothing is in history either.
    expect(mockCreateMessage).not.toHaveBeenCalled();
  });

  it('records a successful send as sent (negative: the result is unchanged)', async () => {
    mockGetTool.mockReturnValue(tool(vi.fn().mockResolvedValue(undefined)));

    const result = await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'hello',
      cliToolId: 'codex',
      instanceId: 'codex-2',
    });

    expect(result).toMatchObject({ ok: true, message: { id: 'row-1' } });
    expect(getLastSendAttempt({ worktreeId: 'wt-1', cliToolId: 'codex', instanceId: 'codex-2' })).toMatchObject({
      state: 'sent',
      reason: 'submitted',
    });
    // Scoped to the instance: the primary has no record.
    expect(getLastSendAttempt({ worktreeId: 'wt-1', cliToolId: 'codex', instanceId: 'codex' })).toBeNull();
  });

  it('marks a typed-but-unsent body still in the composer as indeterminate composer-residue, sent once', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error(SUBMIT_UNCONFIRMED));
    mockGetTool.mockReturnValue(tool(sendMessage));
    mockExtractComposerText.mockReturnValue({ text: 'please   review\nthe diff', state: 'content' });

    const result = await sendUserMessage(mockDb, { worktreeId: 'wt-1', content: 'please review the diff', cliToolId: 'claude' });

    expect(result).toMatchObject({ ok: false, stage: 'send' });
    expect(LAST('claude')).toMatchObject({ state: 'indeterminate', reason: 'composer-residue' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureFresh).toHaveBeenCalledWith('wt-1', 'claude', expect.any(Number), undefined);
  });

  it('stays submit-unconfirmed when the composer cannot be read, or the tool\'s composer is not measured', async () => {
    mockGetTool.mockReturnValue(tool(vi.fn().mockRejectedValue(new Error(SUBMIT_UNCONFIRMED))));
    mockCaptureFresh.mockRejectedValueOnce(new Error('no such session'));
    await sendUserMessage(mockDb, { worktreeId: 'wt-1', content: 'x', cliToolId: 'claude' });
    expect(LAST('claude')).toMatchObject({ state: 'indeterminate', reason: 'submit-unconfirmed' });

    mockCaptureFresh.mockClear();
    await sendUserMessage(mockDb, { worktreeId: 'wt-1', content: 'x', cliToolId: 'antigravity' });
    expect(LAST('antigravity')).toMatchObject({ state: 'indeterminate', reason: 'submit-unconfirmed' });
    expect(mockCaptureFresh).not.toHaveBeenCalled();
  });

  it('records a prompt-waiting refusal as not-sent', async () => {
    const sendMessage = vi.fn();
    mockGetTool.mockReturnValue(tool(sendMessage));
    mockIsPromptWaiting.mockResolvedValue({ waiting: true, reason: 'scraper', blockedBy: 'scraper' });

    const result = await sendUserMessage(mockDb, { worktreeId: 'wt-1', content: 'x', cliToolId: 'claude' });

    expect(result).toMatchObject({ ok: false, stage: 'prompt_waiting' });
    expect(LAST('claude')).toMatchObject({ state: 'not-sent', reason: 'prompt-waiting' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('leaves the send as it was when the record cannot be made (negative)', async () => {
    mockGetTool.mockReturnValue(tool(vi.fn().mockResolvedValue(undefined)));
    const store = globalThis.__sendAttemptRecords!;
    vi.spyOn(store, 'set').mockImplementation(() => {
      throw new Error('record store broken');
    });

    const result = await sendUserMessage(mockDb, { worktreeId: 'wt-1', content: 'hello', cliToolId: 'claude' });

    expect(result).toMatchObject({ ok: true, message: { id: 'row-1' } });
  });
});

describe('[#3759] the record', () => {
  it('keeps a digest of the message, never the message', () => {
    const instance = { worktreeId: 'wt-1', cliToolId: 'claude', instanceId: 'claude' };
    recordSendAttempt(instance, { state: 'sent', reason: 'submitted', content: 'secret brief body' }, 1_000.7);

    const record = getLastSendAttempt(instance);
    expect(record).toEqual({ at: 1_000, state: 'sent', reason: 'submitted', messageDigest: sendMessageDigest('secret brief body') });
    expect(JSON.stringify(record)).not.toContain('secret');
  });

  it('matches a composer read against the start of the first non-blank line, wrap-proof', () => {
    expect(composerHoldsMessage('please review\n  the diff', '\nplease review the diff')).toBe(true);
    expect(composerHoldsMessage('something else', 'please review the diff')).toBe(false);
    expect(composerHoldsMessage('anything', '   \n')).toBe(false);
  });

  it('says who resends, and never that CommandMate does', () => {
    const notSent = describeSendAttemptState({ state: 'not-sent', reason: 'prompt-not-ready' });
    expect(notSent).toContain('send state: not-sent (prompt-not-ready)');
    expect(notSent).toContain('does not resend');
    const unsure = describeSendAttemptState({ state: 'indeterminate', reason: 'submit-unconfirmed' });
    expect(unsure).toContain('do not resend before checking the pane');
  });
});

describe('[#3759] lastSend on the prompt observation', () => {
  function input(over: Partial<ObservationInput> = {}): ObservationInput {
    return {
      worktreeId: 'wt-1',
      cliToolId: 'antigravity',
      instanceId: 'antigravity',
      resolvedBy: null,
      payload: {
        isRunning: false,
        sessionName: 'mcbd-antigravity-wt-1',
        sessionStatus: 'idle',
        sessionStatusReason: 'session_not_running',
        fullOutput: '',
        isPromptWaiting: false,
        promptData: null,
        promptView: null,
        isSelectionListActive: false,
        isPagerActive: false,
        isDismissablePanelActive: false,
        isUnclassifiedActive: false,
        startingSince: null,
        autoYes: undefined,
        serverPollerActive: false,
      },
      sessionGeneration: null,
      contract: { policy: null, taskId: null },
      appearance: { note: () => 0, forget: () => {} },
      now: 10_000,
      ...over,
    } as ObservationInput;
  }

  it('publishes at / state / reason, and not the digest', () => {
    const observation = buildPromptObservation(
      input({ lastSend: { at: 4_000, state: 'not-sent', reason: 'prompt-not-ready', messageDigest: 'abc' } as never })
    );
    expect(observation.lastSend).toEqual({ at: 4_000, state: 'not-sent', reason: 'prompt-not-ready' });
  });

  it('publishes null when nothing is recorded', () => {
    expect(buildPromptObservation(input()).lastSend).toBeNull();
  });

  it('prints the state for a human, and nothing for an older server', () => {
    expect(formatLastSend({ at: 4_000, state: 'not-sent', reason: 'prompt-not-ready' }, 10_000)).toBe(
      '  last send: not-sent (prompt-not-ready, 6s ago) — the message was not typed; it is not resent automatically'
    );
    expect(formatLastSend({ at: 4_000, state: 'indeterminate', reason: 'composer-residue' }, 10_000)).toContain(
      'do not resend before checking `capture --pane`'
    );
    expect(formatLastSend(undefined)).toBeNull();

    const observation = buildPromptObservation(
      input({ lastSend: { at: 4_000, state: 'not-sent', reason: 'prompt-not-ready' } })
    );
    expect(formatPromptObservation(observation, 10_000)).toContain('last send: not-sent (prompt-not-ready');
    expect(formatPromptObservation({ ...observation, lastSend: undefined }, 10_000)).not.toContain('last send');
  });
});
