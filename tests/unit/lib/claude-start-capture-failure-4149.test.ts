/**
 * Issue #4149 F2: the two silent ways a start's wait can end are observable.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';

const logged = vi.hoisted(() => ({ warn: [] as Array<{ event: string; data: Record<string, unknown> }> }));

vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: (event: string, data: Record<string, unknown>) => void logged.warn.push({ event, data }),
      error: vi.fn(),
      withContext: vi.fn(),
    }),
  };
});

vi.mock('@/lib/tmux/session-ownership', () => ({
  assertSessionNotForeign: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));

registerIsolatedAgentHooksDir('claude-start-capture-4149');

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

import { CLAUDE_INIT_TIMEOUT, startClaudeSession } from '@/lib/session/claude-session';
import { capturePane, createSession, getPaneCurrentCommand, hasSession, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { isSessionStartTimeoutError } from '@/lib/session/session-start-error';

const UNREAD = ' Do you trust the files in this folder?\n   No, exit\n ❯ Yes, I trust this folder\n' + '─'.repeat(20) + '\n';
const OPEN = '   No, exit\n ❯ Yes, I trust this folder\n';

async function runOut(): Promise<Error> {
  const promise = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
  const outcome = promise.then(
    () => new Error('the start was expected to fail'),
    (error: Error) => error
  );
  await vi.advanceTimersByTimeAsync(CLAUDE_INIT_TIMEOUT + 120_000);
  return outcome;
}

describe('[#4149 F2] start observability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logged.warn.length = 0;
    vi.useFakeTimers();
    vi.mocked(hasSession).mockResolvedValue(false);
    vi.mocked(createSession).mockResolvedValue();
    vi.mocked(sendKeys).mockResolvedValue();
    vi.mocked(sendSpecialKeys).mockResolvedValue();
    vi.mocked(getPaneCurrentCommand).mockResolvedValue('2.1.287');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('S1: a capture that fails every poll is warned once and not called a slow start', async () => {
    vi.mocked(capturePane).mockRejectedValue(new Error('tmux: secret detail'));

    const error = await runOut();

    expect(logged.warn).toHaveLength(1);
    expect(logged.warn[0].event).toBe('start-capture-failed');
    expect(JSON.stringify(logged.warn)).not.toContain('secret detail');
    expect(error.message).not.toContain('slow start');
    expect(error.message).not.toContain('is stopped');
    expect(error.message).toContain('could not be read');
    expect(isSessionStartTimeoutError(error)).toBe(true);
  });

  it('S1 negative: one failure among good reads warns once, and a ready screen still starts', async () => {
    vi.mocked(capturePane)
      .mockRejectedValueOnce(new Error('x'))
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValue('❯ \n');
    const promise = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
    await vi.advanceTimersByTimeAsync(CLAUDE_INIT_TIMEOUT);
    await promise;
    expect(logged.warn.filter((w) => w.event === 'start-capture-failed')).toHaveLength(1);
  });

  it('S2: a trust screen not read as open for a while reports how many polls were read', async () => {
    let n = 0;
    vi.mocked(capturePane).mockImplementation(async () => (++n <= 5 ? UNREAD : OPEN));

    await runOut();

    const budget = logged.warn.find((w) => w.event === 'start-budget-exhausted');
    expect(budget).toBeDefined();
    expect(budget?.data.trustTextPolls).toBeGreaterThan(5);
    expect(budget?.data.trustOpenPolls).toBeGreaterThan(0);
    expect(budget?.data.lastScreenKind).toBe('trust-dialog');
    expect(JSON.stringify(budget?.data)).not.toContain('Yes, I trust');
  });

  it('S2: an unread trust screen at the end is not told as a slow start', async () => {
    vi.mocked(capturePane).mockResolvedValue(UNREAD);

    const error = await runOut();

    const budget = logged.warn.find((w) => w.event === 'start-budget-exhausted');
    expect(budget?.data.trustOpenPolls).toBe(0);
    expect(budget?.data.lastScreenKind).toBe('trust-text-unread');
    expect(error.message).not.toContain('is a slow start');
    expect(sendKeys).not.toHaveBeenCalledWith(expect.anything(), '', true);
  });

  it('S2 does not take a trust text left in history above an input box: a nudge stays a nudge', async () => {
    const nudge = readFileSync(join(__dirname, '../../fixtures/claude-auto-default-nudge-4134/cursor-yes.txt'), 'utf-8');
    vi.mocked(capturePane).mockResolvedValue('Yes, I trust this folder\n' + '─'.repeat(20) + '\n' + nudge);

    const error = await runOut();

    expect(error.message).toContain('Make auto mode your default');
    expect(error.message).not.toContain('folder-trust text');
  });

  it('S2 does not take a start that answered the dialog and then only drew an input box', async () => {
    let n = 0;
    vi.mocked(capturePane).mockImplementation(async () => (++n <= 2 ? OPEN : 'Yes, I trust this folder\n' + '─'.repeat(20) + '\nloading\n'));

    const error = await runOut();

    expect(error.message).not.toContain('folder-trust text');
  });
});
