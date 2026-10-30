/**
 * Issue #3945: the entry points that type into one instance's composer share
 * one input lock — `sendUserMessage` (send route, timer, relay) and the
 * terminal route — and `sendUserMessage` reads its failure back under it.
 *
 * Both entry points drive a codex tool whose `sendMessage` is the real shared
 * sender; tmux is mocked and every key is logged with the fake clock's order.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
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
vi.mock('child_process', () => ({ execFile: vi.fn() }));

vi.mock('@/lib/db', () => ({
  createMessage: vi.fn((_db: unknown, row: Record<string, unknown>) => ({ id: 'm1', ...row })),
  updateLastUserMessage: vi.fn(),
  clearInProgressMessageId: vi.fn(),
  getMessages: vi.fn(() => []),
  deleteMessageById: vi.fn(() => true),
  getWorktreeById: vi.fn(() => ({ id: 'wt-1', name: 'wt', path: '/path' })),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/git/git-route-worktree', () => ({ canonicalWorktreeId: (id: string) => id }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn(), getActivePollers: vi.fn(() => []) }));
vi.mock('@/lib/assistant-response-saver', () => ({ savePendingAssistantResponse: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/cli-tools/opencode', () => ({ formatImagePathFallbackMessage: (c: string) => c }));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn().mockResolvedValue({ verdict: 'owned', sessionPath: '/path' }),
}));
vi.mock('@/lib/cli-tools/session-ownership', () => ({
  checkSessionOwnership: vi.fn().mockResolvedValue({ verdict: 'owned', sessionPath: '/path' }),
  foreignSessionErrorBody: vi.fn(),
}));
vi.mock('@/lib/cli-tools/session-name', () => ({
  resolveSessionName: (tool: string, worktreeId: string) => `mcbd-${tool}-${worktreeId}`,
}));
vi.mock('@/lib/session/resolve-session-target', () => ({
  resolveSessionTargetStrict: vi.fn((_db: unknown, _id: string, opts: { requestedCliTool: string }) => ({
    ok: true,
    target: { cliToolId: opts.requestedCliTool },
  })),
}));
vi.mock('@/lib/session/prompt-waiting-guard', () => ({
  isPromptWaiting: vi.fn().mockResolvedValue({ waiting: false }),
  promptWaitingMessage: vi.fn((id: string) => `${id} is waiting on a prompt.`),
  PROMPT_WAITING_CODE: 'PROMPT_WAITING',
}));
const captureFresh = vi.hoisted(() => vi.fn());
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutputFresh: captureFresh }));

const tools = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: (id: string) => tools.get(id) }) },
}));

import { capturePane, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { sendUserMessage } from '@/lib/session/send-user-message';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { POST as terminalPost } from '@/app/api/worktrees/[id]/terminal/route';
import { clearSendAttempts, getLastSendAttempt } from '@/lib/session/send-attempt-state';
import {
  INSTANCE_INPUT_LOCK_WAIT_MS,
  resetInstanceInputLocks,
  withInstanceInputLock,
} from '@/lib/session/instance-input-lock';

const SESSION = 'mcbd-codex-wt-1';
const FIXTURES = path.resolve(__dirname, '../../fixtures');
const IDLE = readFileSync(path.join(FIXTURES, 'long-body-2464/codex-idle.capture'), 'utf8');
const LIVE_TOKEN = readFileSync(path.join(FIXTURES, 'long-body-2464/codex-pasted-content.capture'), 'utf8');
const composerFrame = (text: string): string =>
  LIVE_TOKEN.replace('\u001b[38;5;6m[Pasted Content 12288 chars]\u001b[39m', text);

let frame = IDLE;
let keys: string[] = [];
/** When set, the next `sendKeys` of this text waits for the returned release. */
let holdTyping: { text: string; release?: () => void } | null = null;

/** A codex tool whose send is the real shared sender. */
const codexTool = {
  name: 'Codex',
  getSessionName: () => SESSION,
  isRunning: vi.fn().mockResolvedValue(true),
  sendMessage: vi.fn((_worktreeId: string, message: string) =>
    sendMessageWithSubmitVerification({ sessionName: SESSION, message, cliToolId: 'codex' })
  ),
  sendMessageWithImage: vi.fn(),
};

const db = {} as never;

function terminalRequest(command: string): Promise<Response> {
  const req = new NextRequest('http://localhost:3000/api/worktrees/wt-1/terminal', {
    method: 'POST',
    body: JSON.stringify({ cliToolId: 'codex', command }),
    headers: { 'Content-Type': 'application/json' },
  });
  return terminalPost(req, { params: Promise.resolve({ id: 'wt-1' }) });
}

describe('entry points share one input lock per instance (Issue #3945)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetInstanceInputLocks();
    clearSendAttempts();
    tools.clear();
    tools.set('codex', codexTool);
    frame = IDLE;
    keys = [];
    holdTyping = null;
    vi.mocked(capturePane).mockImplementation((async () => frame) as never);
    vi.mocked(sendKeys).mockImplementation((async (_s: string, text: string) => {
      keys.push(`type:${text}`);
      if (holdTyping !== null && holdTyping.text === text) {
        await new Promise<void>((resolve) => (holdTyping!.release = resolve));
      }
      frame = composerFrame(text);
    }) as never);
    vi.mocked(sendSpecialKeys).mockImplementation((async (_s: string, k: string[]) => {
      keys.push(k.join('+'));
      frame = IDLE;
    }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetInstanceInputLocks();
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it('sendUserMessage then the terminal route: the terminal send types nothing until the first send is done', async () => {
    holdTyping = { text: 'from send' };
    const first = sendUserMessage(db, { worktreeId: 'wt-1', content: 'from send', cliToolId: 'codex' });
    await settle();
    const second = terminalRequest('from terminal');
    await settle();
    expect(keys).toEqual(['type:from send']);

    holdTyping.release!();
    const [a, b] = await Promise.all([first, second]);
    expect(a.ok).toBe(true);
    expect(b.status).toBe(200);
    expect(keys).toEqual(['type:from send', 'Enter', 'type:from terminal', 'Enter']);
  });

  it('the terminal route then sendUserMessage: the same order the other way round', async () => {
    holdTyping = { text: 'from terminal' };
    const first = terminalRequest('from terminal');
    await settle();
    const second = sendUserMessage(db, { worktreeId: 'wt-1', content: 'from send', cliToolId: 'codex' });
    await settle();
    expect(keys).toEqual(['type:from terminal']);

    holdTyping.release!();
    await Promise.all([first, second]);
    expect(keys).toEqual(['type:from terminal', 'Enter', 'type:from send', 'Enter']);
  });

  it('two sendUserMessage calls (send route + timer / relay): one after the other', async () => {
    holdTyping = { text: 'first' };
    const first = sendUserMessage(db, { worktreeId: 'wt-1', content: 'first', cliToolId: 'codex' });
    await settle();
    const second = sendUserMessage(db, { worktreeId: 'wt-1', content: 'second', cliToolId: 'codex' });
    await settle();
    expect(keys).toEqual(['type:first']);
    holdTyping.release!();
    await Promise.all([first, second]);
    expect(keys).toEqual(['type:first', 'Enter', 'type:second', 'Enter']);
  });

  it('a failed send reads its composer back before the next send may type (review #9)', async () => {
    let releaseRead!: () => void;
    const events: string[] = [];
    codexTool.sendMessage.mockImplementationOnce(() =>
      withInstanceInputLock(SESSION, async () => {
        throw new Error(`Message submit could not be confirmed for session ${SESSION} after 4 attempts (typed but unsent)`);
      })
    );
    captureFresh.mockImplementationOnce(async () => {
      events.push('residue-read:start');
      await new Promise<void>((resolve) => (releaseRead = resolve));
      events.push('residue-read:end');
      return composerFrame('first');
    });
    const attempts: unknown[] = [];
    const first = sendUserMessage(db, {
      worktreeId: 'wt-1',
      content: 'first',
      cliToolId: 'codex',
      onAttempt: (attempt) => attempts.push(attempt),
    });
    await settle();
    const second = terminalRequest('second');
    await settle();
    expect(events).toEqual(['residue-read:start']);
    expect(keys).toEqual([]);

    releaseRead();
    const result = await first;
    await second;
    expect(result.ok).toBe(false);
    expect(attempts).toEqual([{ state: 'indeterminate', reason: 'composer-residue' }]);
    expect(keys).toEqual(['type:second', 'Enter']);
  });

  it('a send not admitted in time records not-sent (input-lock-timeout) and types nothing', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const held = withInstanceInputLock(SESSION, () => new Promise<void>((resolve) => (release = resolve)));
    const attempts: unknown[] = [];
    const pending = sendUserMessage(db, {
      worktreeId: 'wt-1',
      content: 'late',
      cliToolId: 'codex',
      onAttempt: (attempt) => attempts.push(attempt),
    });
    await vi.advanceTimersByTimeAsync(INSTANCE_INPUT_LOCK_WAIT_MS);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(keys).toEqual([]);
    expect(attempts).toEqual([{ state: 'not-sent', reason: 'input-lock-timeout' }]);
    expect(getLastSendAttempt({ worktreeId: 'wt-1', cliToolId: 'codex', instanceId: 'codex' })).toMatchObject({
      state: 'not-sent',
      reason: 'input-lock-timeout',
    });
    release();
    await held;
  });

  it('a dialog found under the lock is the prompt guard\'s refusal: stage prompt_waiting / 409', async () => {
    let release!: () => void;
    const held = withInstanceInputLock(SESSION, async () => {
      await new Promise<void>((resolve) => (release = resolve));
      frame = [
        '  Would you like to make the following edits?',
        '',
        '\u001b[1m\u001b[38;5;6m› 1. Yes, proceed (y)\u001b[0m',
        "  2. Yes, and don't ask again for these files",
        '',
        '  Press enter to confirm or esc to cancel',
      ].join('\n');
    });
    const viaSend = sendUserMessage(db, { worktreeId: 'wt-1', content: 'x', cliToolId: 'codex' });
    const viaTerminal = terminalRequest('y');
    await settle();
    release();
    await held;
    const [a, b] = await Promise.all([viaSend, viaTerminal]);
    expect(a).toMatchObject({ ok: false, stage: 'prompt_waiting' });
    expect(b.status).toBe(409);
    await expect(b.json()).resolves.toMatchObject({ code: 'PROMPT_WAITING' });
    expect(keys).toEqual([]);
  });

  it('each request is told its own outcome even when a later send overwrote lastSend (review #9)', async () => {
    codexTool.sendMessage.mockImplementationOnce(() =>
      withInstanceInputLock(SESSION, async () => {
        throw new Error('Failed to send keys to tmux session: boom');
      })
    );
    const firstAttempts: unknown[] = [];
    const first = sendUserMessage(db, {
      worktreeId: 'wt-1',
      content: 'same text',
      cliToolId: 'codex',
      onAttempt: (attempt) => firstAttempts.push(attempt),
    });
    const second = sendUserMessage(db, { worktreeId: 'wt-1', content: 'same text', cliToolId: 'codex' });
    await Promise.all([first, second]);
    expect(getLastSendAttempt({ worktreeId: 'wt-1', cliToolId: 'codex', instanceId: 'codex' })?.state).toBe('sent');
    expect(firstAttempts).toEqual([{ state: 'indeterminate', reason: 'send-error' }]);
  });

  it('a send whose delivery never reaches the composer (opencode over HTTP) does not take the lock', async () => {
    const httpSend = vi.fn().mockResolvedValue(undefined);
    tools.set('opencode', { ...codexTool, name: 'OpenCode', sendMessage: httpSend });
    let release!: () => void;
    const held = withInstanceInputLock('mcbd-opencode-wt-1', () => new Promise<void>((resolve) => (release = resolve)));
    const result = await sendUserMessage(db, { worktreeId: 'wt-1', content: 'over http', cliToolId: 'opencode' });
    expect(result.ok).toBe(true);
    expect(httpSend).toHaveBeenCalledTimes(1);
    release();
    await held;
  });
});
