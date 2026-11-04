/**
 * Issue #4149 F2: a start that could not answer the folder-trust dialog says so.
 *
 * Reported: the cursor stayed on `No, exit` for 60 seconds, nothing was sent, the
 * error said "slow start", and no log line said why (an ERROR-only setting hid the
 * info-level skip). Not reproduced on a real Claude; the ways a key can fail to go
 * out are driven here instead. The one that matches the report is the input lock:
 * its 60-second wait is as long as the start's budget.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';

const logged = vi.hoisted(() => ({ warn: [] as Array<{ event: string; data: unknown }> }));

vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: (event: string, data: unknown) => void logged.warn.push({ event, data }),
      error: vi.fn(),
      withContext: vi.fn(),
    }),
  };
});

vi.mock('@/lib/tmux/session-ownership', () => ({
  assertSessionNotForeign: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));

registerIsolatedAgentHooksDir('claude-trust-4149');

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKeys: vi.fn(),
  capturePane: vi.fn(),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  getPaneCurrentCommand: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  constants: { X_OK: 1 },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  exec: vi.fn((cmd: string, opts: unknown, cb?: unknown) => {
    const callback = (typeof opts === 'function' ? opts : cb) as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    callback(null, { stdout: cmd.includes('which claude') ? '/usr/local/bin/claude' : '', stderr: '' });
    return {};
  }),
}));

import { CLAUDE_INIT_POLL_INTERVAL, CLAUDE_INIT_TIMEOUT, startClaudeSession } from '@/lib/session/claude-session';
import { capturePane, createSession, getPaneCurrentCommand, hasSession, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { isSafeSessionStartError, isSessionStartTimeoutError, SESSION_STARTING_CODE } from '@/lib/session/session-start-error';
import { answerSessionStartTimeout } from '@/app/api/worktrees/[id]/send/send-session-start';
import type { ICLITool } from '@/lib/cli-tools/types';
import { withInstanceInputLock } from '@/lib/session/instance-input-lock';
import { sendNudgeKey } from '@/lib/cli-tools/claude-auto-default-nudge';

const FIXTURES = join(__dirname, '../../fixtures');
const CURSOR_ON_NO = readFileSync(join(FIXTURES, 'claude-trust-dialog-3078/allowlist-default-no-2-1-287.txt'), 'utf-8');
const CURSOR_ON_YES = CURSOR_ON_NO.replace(' ❯ No, exit', '   No, exit').replace(
  '   Yes, I trust this folder',
  ' ❯ Yes, I trust this folder'
);
const NO_READABLE_CURSOR = '   No, exit\n   Yes, I trust this folder';
const AUTO_DEFAULT_NUDGE = readFileSync(join(FIXTURES, 'claude-auto-default-nudge-4134/cursor-yes.txt'), 'utf-8');

const SESSION = 'mcbd-claude-wt';

function enterOnlyCalls(): number {
  return vi.mocked(sendKeys).mock.calls.filter((call) => call[1] === '' && call[2] === true).length;
}

function skips(): Array<{ event: string; data: unknown }> {
  return logged.warn.filter((entry) => entry.event === 'trust-dialog-key-skipped');
}

/** Run a start to the end of its budget (and any lock wait begun inside it). */
async function runOut(): Promise<Error> {
  const promise = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
  const outcome = promise.then(
    () => new Error('the start was expected to fail'),
    (error: Error) => error
  );
  await vi.advanceTimersByTimeAsync(CLAUDE_INIT_TIMEOUT + 120_000);
  return outcome;
}

describe('[#4149] a start whose trust keys never went out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logged.warn.length = 0;
    vi.useFakeTimers();
    vi.mocked(hasSession).mockResolvedValue(false);
    vi.mocked(createSession).mockResolvedValue();
    vi.mocked(sendKeys).mockResolvedValue();
    vi.mocked(sendSpecialKeys).mockResolvedValue();
    vi.mocked(getPaneCurrentCommand).mockResolvedValue('2.1.287');
    vi.mocked(capturePane).mockResolvedValue(CURSOR_ON_NO);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('another writer holds the input lock for the whole budget: warned, told, and no Enter on `No, exit`', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Taken on the first read, after the launch lines have been typed.
    let taken = false;
    vi.mocked(capturePane).mockImplementation(async () => {
      if (!taken) {
        taken = true;
        void withInstanceInputLock(SESSION, () => held, { waitMs: 1 });
      }
      return CURSOR_ON_NO;
    });

    const error = await runOut();
    release();

    expect(enterOnlyCalls()).toBe(0);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(skips()[0]?.data).toMatchObject({ reason: 'input-lock-timeout' });
    expect(error.message).not.toContain('is a slow start');
    expect(error.message).toContain('folder-trust dialog');
    expect(error.message).toContain('no key reached it');
    expect(error.message).toContain('input-lock-timeout');
    expect(error.message).toContain('No, exit');
    // Still a start to retry, for the route and the push notifier.
    expect(isSessionStartTimeoutError(error)).toBe(true);
    expect(isSafeSessionStartError(error)).toBe(true);
  });

  it('tmux refuses every key: warned once per reason, not once per poll, and told', async () => {
    vi.mocked(sendSpecialKeys).mockRejectedValue(new Error('tmux: no server'));

    const error = await runOut();

    expect(enterOnlyCalls()).toBe(0);
    expect(vi.mocked(sendSpecialKeys).mock.calls.length).toBeGreaterThan(10);
    expect(skips()).toHaveLength(1);
    expect(skips()[0].data).toMatchObject({ reason: 'send-failed', key: 'Down' });
    expect(error.message).toContain('no key reached it');
    expect(error.message).toContain('send-failed');
    expect(error.message).not.toContain('tmux: no server');
  });

  it('Enter that tmux refuses is warned and told the same way', async () => {
    vi.mocked(capturePane).mockResolvedValue(CURSOR_ON_YES);
    vi.mocked(sendKeys).mockImplementation(async (_session, keys, enter) => {
      if (keys === '' && enter === true) throw new Error('tmux: no server');
    });

    const error = await runOut();

    expect(skips()[0]?.data).toMatchObject({ reason: 'send-failed', key: 'Enter' });
    expect(error.message).toContain('no key reached it');
  });

  it('the cursor row cannot be read: no key is guessed, and the reason is warned and told', async () => {
    vi.mocked(capturePane).mockResolvedValue(NO_READABLE_CURSOR);

    const error = await runOut();

    expect(enterOnlyCalls()).toBe(0);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(skips()).toHaveLength(1);
    expect(skips()[0].data).toMatchObject({ reason: 'cursor-unreadable' });
    expect(error.message).toContain('cursor-unreadable');
    expect(error.message).not.toContain('is a slow start');
  });

  it('the dialog outlives the keys that did go out: not "slow", and not "no key"', async () => {
    vi.mocked(capturePane).mockResolvedValue(CURSOR_ON_YES);

    const error = await runOut();

    expect(enterOnlyCalls()).toBe(3);
    expect(skips()).toHaveLength(0);
    expect(error.message).toContain('folder-trust dialog');
    expect(error.message).toContain('stayed open after 3 keys');
    expect(error.message).not.toContain('no key reached it');
    expect(error.message).not.toContain('is a slow start');
  });

  it('the auto-default dialog on screen at the end is named rather than called slow', async () => {
    vi.mocked(capturePane).mockResolvedValue(AUTO_DEFAULT_NUDGE);

    const error = await runOut();

    expect(error.message).toContain('Make auto mode your default permission mode?');
    expect(error.message).not.toContain('is a slow start');
    expect(isSessionStartTimeoutError(error)).toBe(true);
  });

  it('a process left on the folder-trust dialog is not told to just send again: a send does not answer it', async () => {
    vi.mocked(capturePane).mockResolvedValue(CURSOR_ON_YES);

    const error = await runOut();

    expect(error.message).not.toContain('Send it again');
    expect(error.message).toContain('commandmate capture <worktree-id>');
    expect(error.message).toContain('commandmate attach <worktree-id>');
    expect(error.message).toContain('then send the message again');
    expect(error.message).toContain('A send on its own does not answer this dialog');
    // The same error to everything that reads it.
    expect((error as Error & { code?: string }).code).toBe(SESSION_STARTING_CODE);
    expect(isSessionStartTimeoutError(error)).toBe(true);
    expect(isSafeSessionStartError(error)).toBe(true);
  });

  it('the 503 and its message stay on the session-starting path', async () => {
    vi.mocked(capturePane).mockResolvedValue(CURSOR_ON_YES);

    const error = await runOut();
    vi.mocked(getPaneCurrentCommand).mockResolvedValue('2.1.287');

    const response = await answerSessionStartTimeout(
      error.message,
      { name: 'Claude Code', getSessionName: () => SESSION } as unknown as ICLITool,
      'wt',
      undefined
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: error.message, code: SESSION_STARTING_CODE });
  });

  it('control: the auto-default dialog is answered before a send, so sending again is still the advice', async () => {
    vi.mocked(capturePane).mockResolvedValue(AUTO_DEFAULT_NUDGE);

    const error = await runOut();

    expect(error.message).toContain('Send it again');
    expect((error as Error & { code?: string }).code).toBe(SESSION_STARTING_CODE);
  });

  it('control: a start with no dialog keeps the slow-start sentence', async () => {
    vi.mocked(capturePane).mockResolvedValue('Loading...');

    const error = await runOut();

    expect(error.message).toContain('slow start');
    expect(error.message).not.toContain('dialog');
    expect(skips()).toHaveLength(0);
  });

  it('control: a dialog answered in passing leaves nothing behind but the start', async () => {
    let poll = 0;
    const screens = [CURSOR_ON_NO, CURSOR_ON_YES, '❯ '];
    vi.mocked(capturePane).mockImplementation(async () => screens[Math.min(poll++, screens.length - 1)]);

    const promise = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
    await vi.advanceTimersByTimeAsync(CLAUDE_INIT_POLL_INTERVAL * 8 + 1000);

    await expect(promise).resolves.toBeUndefined();
    expect(skips()).toHaveLength(0);
    expect(enterOnlyCalls()).toBe(1);
  });
});

describe('[#4149] the auto-default dialog key, the same way', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logged.warn.length = 0;
  });

  it('a key tmux refused is warned with its reason', async () => {
    vi.mocked(sendSpecialKeys).mockRejectedValue(new Error('tmux: no server'));

    const { instanceInputLaunchReadMark } = await import('@/lib/session/instance-input-lock');
    await expect(sendNudgeKey('mcbd-claude-nudge-a', instanceInputLaunchReadMark(), 'Down')).resolves.toBe(false);

    expect(logged.warn).toContainEqual(
      expect.objectContaining({
        event: 'claude-auto-default-nudge-key-skipped',
        data: expect.objectContaining({ key: 'Down', reason: 'send-failed' }),
      })
    );
  });

  it('a screen that moved is warned with its reason', async () => {
    vi.mocked(capturePane).mockResolvedValue('nothing here');

    // A read mark that is not the current one makes the answer read the screen again.
    await expect(sendNudgeKey('mcbd-claude-nudge-b', -1, 'Down')).resolves.toBe(false);

    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(logged.warn).toContainEqual(
      expect.objectContaining({
        event: 'claude-auto-default-nudge-key-skipped',
        data: expect.objectContaining({ key: 'Down', reason: 'target-changed' }),
      })
    );
  });

  it('control: a key that went out warns nothing', async () => {
    vi.mocked(sendSpecialKeys).mockResolvedValue();
    const { instanceInputLaunchReadMark } = await import('@/lib/session/instance-input-lock');

    await expect(sendNudgeKey('mcbd-claude-nudge-c', instanceInputLaunchReadMark(), 'Down')).resolves.toBe(true);

    expect(logged.warn.filter((entry) => entry.event === 'claude-auto-default-nudge-key-skipped')).toEqual([]);
  });
});
