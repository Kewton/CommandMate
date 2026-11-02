/**
 * Issue #4065, at the send service: which attempt `lastSend` keeps when sends
 * overlap.
 *
 * - (a) A refusal before any lock (ownership, prompt guard, copilot `/model`)
 *   does not replace the record of a send granted after the refusing request
 *   began.
 * - (c) An old send that fails after its Enter, across a session replacement,
 *   is kept unless a newer grant has a record — refusals in between included.
 * - Grant before input: a granted send that has not typed yet is ranked by its
 *   grant, also when it then fails `not-sent`.
 * - (d) The tools whose shared sender takes the lock inside `sendMessage` tell
 *   the service the body's generation, also when the send throws.
 * - Excluded paths (copilot's selection list and `/model`, opencode's HTTP
 *   delivery and its fallback) are recorded in the order they finish and never
 *   carry a generation.
 *
 * The tools are stand-ins that take the real instance input lock the way the
 * shared sender does (`withInstanceInputLock` + `noteInputTicket`); the shared
 * sender's own call is pinned in
 * `tests/unit/cli-tools/submit-verified-sender-ticket-4065.test.ts`. Nothing
 * here touches tmux or the repository's files.
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

import { sendUserMessage, type SendUserMessageParams } from '@/lib/session/send-user-message';
import { isPromptWaiting } from '@/lib/session/prompt-waiting-guard';
import { checkWorktreeSessionOwnership } from '@/lib/cli-tools/worktree-session-ownership';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import {
  instanceInputGenerationMark,
  invalidateInstanceInput,
  noteDispatchFailed,
  noteDispatchStart,
  noteInputStart,
  noteInputTicket,
  resetInstanceInputLocks,
  withInstanceInputLock,
  type InstanceInputTicket,
} from '@/lib/session/instance-input-lock';
import { clearSendAttempts, getLastSendAttempt, sendMessageDigest } from '@/lib/session/send-attempt-state';
import type { CLIToolType } from '@/lib/cli-tools/types';

type Guard = Awaited<ReturnType<typeof isPromptWaiting>>;
type Ownership = Awaited<ReturnType<typeof checkWorktreeSessionOwnership>>;

const mockDb = {} as never;
const WT = 'wt-4065-svc';

const instanceOf = (cliToolId: string, instanceId: string = cliToolId) => ({ worktreeId: WT, cliToolId, instanceId });
const sessionOf = (cliToolId: CLIToolType) => resolveSessionName(cliToolId, WT, undefined);

/** The sender's error for a send whose session was replaced after its Enter (indeterminate). */
function replacedAfterEnter(session: string): Error {
  return new Error(
    `Session ${session} was replaced during the read-back, after the message and Enter were sent; ` +
      'the previous process may have submitted it (Issue #4048).'
  );
}

/** The sender's error for a re-read under the lock that failed before any key (not-sent). */
function recheckFailed(session: string): Error {
  return new Error(`Could not re-read session ${session} before typing (boom); nothing was typed (Issue #3945)`);
}

interface Gate<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function gate<T = void>(): Gate<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
  expect(condition()).toBe(true);
}

/**
 * A tool whose `sendMessage` takes the instance input lock itself, as the
 * shared sender does. Each call runs the next queued body (default: resolves).
 */
function innerLockTool(name: string, session: string) {
  const bodies: Array<(ticket: InstanceInputTicket) => Promise<void>> = [];
  const sendMessage = vi.fn(() =>
    withInstanceInputLock(session, async (ticket) => {
      noteInputTicket(ticket);
      const body = bodies.shift();
      if (body) await body(ticket);
    })
  );
  return {
    tool: { name, sendMessage, sendMessageWithImage: vi.fn(), sendModelCommand: vi.fn() },
    sendMessage,
    queue: (body: (ticket: InstanceInputTicket) => Promise<void>) => bodies.push(body),
  };
}

function send(cliToolId: CLIToolType, content: string, extra: Partial<SendUserMessageParams> = {}) {
  return sendUserMessage(mockDb, { worktreeId: WT, content, cliToolId, ...extra });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSendAttempts();
  resetInstanceInputLocks();
});

afterEach(() => {
  clearSendAttempts();
  resetInstanceInputLocks();
});

describe('[#4065 (a)] a refusal before any lock does not replace a later grant\'s record', () => {
  it('positive (claude): R1 waits on the guard, R2 is granted and sent, then R1 is refused — lastSend is R2\'s sent', async () => {
    const guard = gate<Guard>();
    vi.mocked(isPromptWaiting).mockReturnValueOnce(guard.promise).mockResolvedValueOnce({ waiting: false } as Guard);
    mockGetTool.mockReturnValue({ name: 'Claude', sendMessage: vi.fn().mockResolvedValue(undefined), sendMessageWithImage: vi.fn() });
    const r1Attempt = vi.fn();

    const r1 = send('claude', 'R1', { onAttempt: r1Attempt });
    await until(() => vi.mocked(isPromptWaiting).mock.calls.length === 1);
    expect((await send('claude', 'R2')).ok).toBe(true);
    guard.resolve({ waiting: true, reason: 'dialog', blockedBy: null } as unknown as Guard);

    expect(await r1).toMatchObject({ ok: false, stage: 'prompt_waiting' });
    // The request is still told its own outcome.
    expect(r1Attempt).toHaveBeenCalledWith({ state: 'not-sent', reason: 'prompt-waiting' });
    expect(getLastSendAttempt(instanceOf('claude'))).toMatchObject({
      state: 'sent',
      messageDigest: sendMessageDigest('R2'),
    });
  });

  it('positive (claude): the order reversed — R1 refused first, R2 finishes after — lastSend is R2\'s sent', async () => {
    const r2Body = gate();
    const guard = gate<Guard>();
    vi.mocked(isPromptWaiting).mockReturnValueOnce(guard.promise).mockResolvedValueOnce({ waiting: false } as Guard);
    mockGetTool.mockReturnValue({ name: 'Claude', sendMessage: vi.fn(() => r2Body.promise), sendMessageWithImage: vi.fn() });

    const r1 = send('claude', 'R1');
    await until(() => vi.mocked(isPromptWaiting).mock.calls.length === 1);
    const r2 = send('claude', 'R2');
    await until(() => mockGetTool.mock.results.length > 0 && vi.mocked(isPromptWaiting).mock.calls.length === 2);
    guard.resolve({ waiting: true, reason: 'dialog', blockedBy: null } as unknown as Guard);
    await r1;
    r2Body.resolve();
    await r2;

    expect(getLastSendAttempt(instanceOf('claude'))).toMatchObject({ state: 'sent', messageDigest: sendMessageDigest('R2') });
  });

  it('positive (claude): the ownership refusal — likewise not over the later grant', async () => {
    const owner = gate<Ownership>();
    vi.mocked(checkWorktreeSessionOwnership)
      .mockReturnValueOnce(owner.promise)
      .mockResolvedValueOnce({ verdict: 'owned', sessionPath: null } as Ownership);
    mockGetTool.mockReturnValue({ name: 'Claude', sendMessage: vi.fn().mockResolvedValue(undefined), sendMessageWithImage: vi.fn() });

    const r1 = send('claude', 'R1');
    await until(() => vi.mocked(checkWorktreeSessionOwnership).mock.calls.length === 1);
    expect((await send('claude', 'R2')).ok).toBe(true);
    owner.resolve({ verdict: 'foreign', sessionPath: '/elsewhere' } as Ownership);

    expect(await r1).toMatchObject({ ok: false, stage: 'foreign_session' });
    expect(getLastSendAttempt(instanceOf('claude'))).toMatchObject({ state: 'sent', messageDigest: sendMessageDigest('R2') });
  });

  it('positive (copilot): a failed `/model` before the body — not over the later grant', async () => {
    const copilot = innerLockTool('Copilot', sessionOf('copilot'));
    const model = gate();
    copilot.tool.sendModelCommand.mockReturnValueOnce(model.promise);
    mockGetTool.mockReturnValue(copilot.tool);

    const r1 = send('copilot', 'R1', { copilotModel: 'gpt-x' });
    await until(() => copilot.tool.sendModelCommand.mock.calls.length === 1);
    expect((await send('copilot', 'R2')).ok).toBe(true);
    model.reject(new Error('Model "gpt-x" is unsupported'));

    expect(await r1).toMatchObject({ ok: false, stage: 'model' });
    expect(getLastSendAttempt(instanceOf('copilot'))).toMatchObject({ state: 'sent', messageDigest: sendMessageDigest('R2') });
  });

  it('negative: a refusal on its own is recorded as before', async () => {
    vi.mocked(isPromptWaiting).mockResolvedValueOnce({ waiting: true, reason: 'dialog', blockedBy: null } as unknown as Guard);
    mockGetTool.mockReturnValue({ name: 'Claude', sendMessage: vi.fn(), sendMessageWithImage: vi.fn() });

    await send('claude', 'alone');

    expect(getLastSendAttempt(instanceOf('claude'))).toMatchObject({ state: 'not-sent', reason: 'prompt-waiting' });
  });

  it('negative: a refusal that began after the grant was recorded is taken', async () => {
    mockGetTool.mockReturnValue({ name: 'Claude', sendMessage: vi.fn().mockResolvedValue(undefined), sendMessageWithImage: vi.fn() });
    await send('claude', 'R1');
    vi.mocked(isPromptWaiting).mockResolvedValueOnce({ waiting: true, reason: 'dialog', blockedBy: null } as unknown as Guard);

    await send('claude', 'R2');

    expect(getLastSendAttempt(instanceOf('claude'))).toMatchObject({ state: 'not-sent', messageDigest: sendMessageDigest('R2') });
  });

  it('negative: another instance\'s grant in between does not drop this instance\'s refusal', async () => {
    const guard = gate<Guard>();
    vi.mocked(isPromptWaiting).mockReturnValueOnce(guard.promise).mockResolvedValueOnce({ waiting: false } as Guard);
    mockGetTool.mockReturnValue({ name: 'Claude', sendMessage: vi.fn().mockResolvedValue(undefined), sendMessageWithImage: vi.fn() });

    const r1 = send('claude', 'R1');
    await until(() => vi.mocked(isPromptWaiting).mock.calls.length === 1);
    expect((await send('claude', 'other instance', { instanceId: 'claude-2' })).ok).toBe(true);
    guard.resolve({ waiting: true, reason: 'dialog', blockedBy: null } as unknown as Guard);
    await r1;

    expect(getLastSendAttempt(instanceOf('claude'))).toMatchObject({ state: 'not-sent', messageDigest: sendMessageDigest('R1') });
  });

  it('the route\'s observation, when given, is the one compared — not one read on entry here', async () => {
    mockGetTool.mockReturnValue({ name: 'Claude', sendMessage: vi.fn().mockResolvedValue(undefined), sendMessageWithImage: vi.fn() });
    const observedAtRoute = instanceInputGenerationMark();
    expect((await send('claude', 'R2')).ok).toBe(true);
    vi.mocked(isPromptWaiting).mockResolvedValueOnce({ waiting: true, reason: 'dialog', blockedBy: null } as unknown as Guard);

    await send('claude', 'R1', { observedInputGeneration: observedAtRoute });

    expect(getLastSendAttempt(instanceOf('claude'))).toMatchObject({ state: 'sent', messageDigest: sendMessageDigest('R2') });
  });
});

describe('[#4065 (c)] an old send that fails after its Enter across a replacement', () => {
  it('pinned: no newer grant — the old send\'s indeterminate is kept over the new request\'s refusal', async () => {
    const old = gate();
    const sendMessage = vi.fn().mockReturnValueOnce(old.promise);
    mockGetTool.mockReturnValue({ name: 'Claude', sendMessage, sendMessageWithImage: vi.fn() });

    const r1 = send('claude', 'R1');
    await until(() => sendMessage.mock.calls.length === 1);
    invalidateInstanceInput(sessionOf('claude'));
    vi.mocked(isPromptWaiting).mockResolvedValueOnce({ waiting: true, reason: 'dialog', blockedBy: null } as unknown as Guard);
    await send('claude', 'R2');
    old.reject(replacedAfterEnter(sessionOf('claude')));
    await r1;

    expect(getLastSendAttempt(instanceOf('claude'))).toMatchObject({
      state: 'indeterminate',
      messageDigest: sendMessageDigest('R1'),
    });
  });

  it('positive: a newer grant recorded, then a refusal, then the old send fails — lastSend stays the refusal', async () => {
    const old = gate();
    const sendMessage = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(undefined);
    mockGetTool.mockReturnValue({ name: 'Claude', sendMessage, sendMessageWithImage: vi.fn() });

    const r1 = send('claude', 'R1');
    await until(() => sendMessage.mock.calls.length === 1);
    invalidateInstanceInput(sessionOf('claude'));
    expect((await send('claude', 'R3')).ok).toBe(true);
    vi.mocked(isPromptWaiting).mockResolvedValueOnce({ waiting: true, reason: 'dialog', blockedBy: null } as unknown as Guard);
    await send('claude', 'R2');
    old.reject(replacedAfterEnter(sessionOf('claude')));
    await r1;

    expect(getLastSendAttempt(instanceOf('claude'))).toMatchObject({
      state: 'not-sent',
      reason: 'prompt-waiting',
      messageDigest: sendMessageDigest('R2'),
    });
  });
});

describe('[#4065] between the grant and the input', () => {
  it('pinned: R1 granted, not yet typed; R2 begins after the grant and is refused; R1 then fails not-sent — R1 is kept', async () => {
    const r1Body = gate();
    const sendMessage = vi.fn().mockReturnValueOnce(r1Body.promise);
    mockGetTool.mockReturnValue({ name: 'Claude', sendMessage, sendMessageWithImage: vi.fn() });

    const r1 = send('claude', 'R1');
    await until(() => sendMessage.mock.calls.length === 1);
    vi.mocked(isPromptWaiting).mockResolvedValueOnce({ waiting: true, reason: 'dialog', blockedBy: null } as unknown as Guard);
    await send('claude', 'R2');
    expect(getLastSendAttempt(instanceOf('claude'))).toMatchObject({ messageDigest: sendMessageDigest('R2') });
    r1Body.reject(recheckFailed(sessionOf('claude')));
    await r1;

    expect(getLastSendAttempt(instanceOf('claude'))).toMatchObject({
      state: 'not-sent',
      reason: 'recheck-failed',
      messageDigest: sendMessageDigest('R1'),
    });
  });

  it('positive: R2 began before R1\'s grant; R1 fails not-sent after its grant; R2\'s refusal comes last — R1 is kept', async () => {
    const guard = gate<Guard>();
    vi.mocked(isPromptWaiting).mockReturnValueOnce(guard.promise).mockResolvedValueOnce({ waiting: false } as Guard);
    mockGetTool.mockReturnValue({
      name: 'Claude',
      sendMessage: vi.fn().mockRejectedValue(recheckFailed(sessionOf('claude'))),
      sendMessageWithImage: vi.fn(),
    });

    const r2 = send('claude', 'R2');
    await until(() => vi.mocked(isPromptWaiting).mock.calls.length === 1);
    await send('claude', 'R1');
    guard.resolve({ waiting: true, reason: 'dialog', blockedBy: null } as unknown as Guard);
    await r2;

    expect(getLastSendAttempt(instanceOf('claude'))).toMatchObject({ reason: 'recheck-failed', messageDigest: sendMessageDigest('R1') });
  });
});

describe('[#4065 (d)] the tools whose sender takes the lock inside sendMessage', () => {
  const INNER_LOCK_TOOLS: CLIToolType[] = ['copilot', 'vibe-local', 'opencode', 'gemini', 'antigravity', 'command-code'];

  it.each(INNER_LOCK_TOOLS)(
    'positive (%s): the old grant fails late after a replacement and a newer grant was sent — lastSend is the newer sent',
    async (cliToolId) => {
      const session = sessionOf(cliToolId);
      const t = innerLockTool(cliToolId, session);
      const old = gate();
      t.queue(() => old.promise);
      mockGetTool.mockReturnValue(t.tool);

      const r1 = send(cliToolId, 'R1');
      await until(() => t.sendMessage.mock.calls.length === 1);
      invalidateInstanceInput(session);
      expect((await send(cliToolId, 'R2')).ok).toBe(true);
      old.reject(replacedAfterEnter(session));
      await r1;

      expect(getLastSendAttempt(instanceOf(cliToolId))).toMatchObject({ state: 'sent', messageDigest: sendMessageDigest('R2') });
    }
  );

  it.each(INNER_LOCK_TOOLS)(
    'positive (%s): R1 refused by the guard after R2 was granted and sent — lastSend is R2\'s sent',
    async (cliToolId) => {
      const t = innerLockTool(cliToolId, sessionOf(cliToolId));
      const guard = gate<Guard>();
      vi.mocked(isPromptWaiting).mockReturnValueOnce(guard.promise).mockResolvedValueOnce({ waiting: false } as Guard);
      mockGetTool.mockReturnValue(t.tool);

      const r1 = send(cliToolId, 'R1');
      await until(() => vi.mocked(isPromptWaiting).mock.calls.length === 1);
      expect((await send(cliToolId, 'R2')).ok).toBe(true);
      guard.resolve({ waiting: true, reason: 'dialog', blockedBy: null } as unknown as Guard);
      await r1;

      expect(getLastSendAttempt(instanceOf(cliToolId))).toMatchObject({ state: 'sent', messageDigest: sendMessageDigest('R2') });
    }
  );

  it('the generation survives a throw after the grant (copilot, not-sent under the lock)', async () => {
    const t = innerLockTool('Copilot', sessionOf('copilot'));
    t.queue(async () => {
      throw recheckFailed(sessionOf('copilot'));
    });
    mockGetTool.mockReturnValue(t.tool);
    const before = instanceInputGenerationMark();

    await send('copilot', 'R1');

    expect(getLastSendAttempt(instanceOf('copilot'))).toMatchObject({
      state: 'not-sent',
      reason: 'recheck-failed',
      inputGeneration: before + 1,
    });
  });

  it('claude / codex: the inner sender joins the outer ticket — one grant, told twice, the same generation', async () => {
    const session = sessionOf('codex');
    const sendMessage = vi.fn(() =>
      withInstanceInputLock(session, async (ticket) => {
        noteInputTicket(ticket);
        noteInputTicket(ticket);
      })
    );
    mockGetTool.mockReturnValue({ name: 'Codex', sendMessage, sendMessageWithImage: vi.fn() });
    const before = instanceInputGenerationMark();

    await send('codex', 'body');

    expect(instanceInputGenerationMark()).toBe(before + 1);
    expect(getLastSendAttempt(instanceOf('codex'))).toMatchObject({ state: 'sent', inputGeneration: before + 1 });
  });

  it('regression guard: copilot A begins, B is refused by the guard, A is sent — lastSend is A\'s sent (#4048:177, with the inner lock)', async () => {
    const t = innerLockTool('Copilot', sessionOf('copilot'));
    const a = gate();
    t.queue(() => a.promise);
    vi.mocked(isPromptWaiting)
      .mockResolvedValueOnce({ waiting: false } as Guard)
      .mockResolvedValueOnce({ waiting: true, reason: 'dialog', blockedBy: null } as unknown as Guard);
    mockGetTool.mockReturnValue(t.tool);

    const sendA = send('copilot', 'body A');
    await until(() => t.sendMessage.mock.calls.length === 1);
    await send('copilot', 'body B');
    a.resolve();
    expect((await sendA).ok).toBe(true);

    expect(getLastSendAttempt(instanceOf('copilot'))).toMatchObject({ state: 'sent', messageDigest: sendMessageDigest('body A') });
  });
});

describe('[#4065] excluded paths keep the order they finish in', () => {
  it('opencode HTTP: a dispatch is recorded without a generation, and does not forget the newer grant', async () => {
    const session = sessionOf('opencode');
    const old = gate();
    const http = gate();
    let call = 0;
    const sendMessage = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return withInstanceInputLock(session, async (ticket) => {
          noteInputTicket(ticket);
          await old.promise;
        });
      }
      if (call === 2) {
        return withInstanceInputLock(session, async (ticket) => {
          noteInputTicket(ticket);
        });
      }
      noteDispatchStart();
      await http.promise;
    });
    mockGetTool.mockReturnValue({ name: 'OpenCode', sendMessage, sendMessageWithImage: vi.fn() });

    const g1 = send('opencode', 'G1');
    await until(() => sendMessage.mock.calls.length === 1);
    invalidateInstanceInput(session);
    expect((await send('opencode', 'G2')).ok).toBe(true);
    const viaHttp = send('opencode', 'HTTP');
    await until(() => sendMessage.mock.calls.length === 3);
    http.resolve();
    await viaHttp;
    expect(getLastSendAttempt(instanceOf('opencode'))).toMatchObject({ state: 'sent', messageDigest: sendMessageDigest('HTTP') });
    expect(getLastSendAttempt(instanceOf('opencode'))).not.toHaveProperty('inputGeneration');

    old.reject(replacedAfterEnter(session));
    await g1;
    expect(getLastSendAttempt(instanceOf('opencode'))).toMatchObject({ messageDigest: sendMessageDigest('HTTP') });
  });

  it('opencode HTTP unknown → keyboard fallback: still excluded, no generation on the record', async () => {
    const session = sessionOf('opencode');
    const sendMessage = vi.fn(async () => {
      noteDispatchStart();
      noteDispatchFailed('unknown');
      await withInstanceInputLock(session, async (ticket) => {
        noteInputTicket(ticket);
        noteInputStart();
      });
    });
    mockGetTool.mockReturnValue({ name: 'OpenCode', sendMessage, sendMessageWithImage: vi.fn() });

    await send('opencode', 'fallback');

    const record = getLastSendAttempt(instanceOf('opencode'));
    expect(record).toMatchObject({ state: 'sent' });
    expect(record).not.toHaveProperty('inputGeneration');
  });

  it('copilot selection list: typed under its own lock, input noted without a ticket — excluded', async () => {
    const session = sessionOf('copilot');
    const sendMessage = vi.fn(() =>
      withInstanceInputLock(session, async () => {
        noteInputStart();
      })
    );
    mockGetTool.mockReturnValue({ name: 'Copilot', sendMessage, sendMessageWithImage: vi.fn(), sendModelCommand: vi.fn() });

    await send('copilot', '/model');

    const record = getLastSendAttempt(instanceOf('copilot'));
    expect(record).toMatchObject({ state: 'sent' });
    expect(record).not.toHaveProperty('inputGeneration');
  });

  it('copilot `/model`: its own lock\'s ticket is not the body\'s generation', async () => {
    const session = sessionOf('copilot');
    const sendModelCommand = vi.fn(() => withInstanceInputLock(session, async () => undefined));
    mockGetTool.mockReturnValue({ name: 'Copilot', sendMessage: vi.fn().mockResolvedValue(undefined), sendMessageWithImage: vi.fn(), sendModelCommand });

    await send('copilot', 'body', { copilotModel: 'gpt-x' });

    expect(sendModelCommand).toHaveBeenCalled();
    expect(getLastSendAttempt(instanceOf('copilot'))).not.toHaveProperty('inputGeneration');
  });

  it('negative: two excluded sends — the one that finishes last is kept', async () => {
    const first = gate();
    let call = 0;
    const sendMessage = vi.fn(async () => {
      call += 1;
      noteDispatchStart();
      if (call === 1) await first.promise;
    });
    mockGetTool.mockReturnValue({ name: 'OpenCode', sendMessage, sendMessageWithImage: vi.fn() });

    const a = send('opencode', 'A');
    await until(() => sendMessage.mock.calls.length === 1);
    await send('opencode', 'B');
    first.resolve();
    await a;

    expect(getLastSendAttempt(instanceOf('opencode'))).toMatchObject({ messageDigest: sendMessageDigest('A') });
  });
});
