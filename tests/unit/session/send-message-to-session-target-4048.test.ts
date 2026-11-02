/**
 * Issue #4048 item 5: `sendMessageToSession` takes the instance the session runs
 * and hands it to the submit-verified sender, so claude's first-prompt check
 * reads that instance's entry; a call without it looks up by name as before.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/tmux/session-ownership', () => ({
  assertSessionNotForeign: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  capturePane: vi.fn().mockResolvedValue('> '),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  constants: { X_OK: 1 },
}));

vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, opts: unknown, cb?: unknown) => {
    const callback = (typeof opts === 'function' ? opts : cb) as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    callback(null, { stdout: '', stderr: '' });
    return {};
  }),
}));

import { sendMessageToSession } from '@/lib/session-key-sender';
import { CLAUDE_POST_PROMPT_DELAY, getSessionName, sendMessageToClaude } from '@/lib/session/claude-session';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { clearPromptSubmitReceipts, getPromptSubmitTarget } from '@/lib/session/prompt-submit-receipt';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clearPromptSubmitReceipts();
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(CLAUDE_POST_PROMPT_DELAY + 1000);
  return promise;
}

describe('[#4048 5] sendMessageToSession', () => {
  it('positive: passes the explicit target to the sender', async () => {
    await settle(sendMessageToSession('mcbd-claude-wt', 'hello', 0, 1000, { worktreeId: 'wt', instanceId: 'claude-2' }));

    expect(sendMessageWithSubmitVerification).toHaveBeenCalledWith({
      sessionName: 'mcbd-claude-wt',
      message: 'hello',
      cliToolId: 'claude',
      target: { worktreeId: 'wt', instanceId: 'claude-2' },
    });
  });

  it('negative: without a target the sender is called exactly as before (name lookup)', async () => {
    await settle(sendMessageToSession('mcbd-claude-wt', 'hello', 0, 1000));

    expect(sendMessageWithSubmitVerification).toHaveBeenCalledWith({
      sessionName: 'mcbd-claude-wt',
      message: 'hello',
      cliToolId: 'claude',
    });
  });
});

describe('[#4048 5] sendMessageToClaude', () => {
  it.each([
    ['the primary', undefined],
    ['another instance', 'claude-2'],
  ])('names %s by worktree and instance, the same one its session name resolves to', async (_label, instanceId) => {
    await settle(sendMessageToClaude('wt-4048', 'hello', instanceId));

    expect(sendMessageWithSubmitVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: getSessionName('wt-4048', instanceId),
        target: { worktreeId: 'wt-4048', instanceId },
      })
    );
    // Sending registers nothing.
    expect(getPromptSubmitTarget(getSessionName('wt-4048', instanceId))).toBeNull();
  });
});
