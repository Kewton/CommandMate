/**
 * Issue #3981 (fix 3): gemini gives up without typing when its prompt does not
 * appear, as codex does (`Codex prompt not ready`).
 *
 * Positive control: before #3981 `waitForPrompt` logged after 15 s and the body
 * was sent anyway — into whatever held the pane. Now the send throws
 * `Gemini prompt not ready` with no key typed, and the send service reads it as
 * `not-sent / prompt-not-ready`. Negative control: a prompt on screen is sent to
 * as before.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pane = vi.hoisted(() => ({ screen: '' }));

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn(),
  capturePane: vi.fn(async () => pane.screen),
  killSession: vi.fn().mockResolvedValue(true),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

const submit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/cli-tools/submit-verified-sender', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/submit-verified-sender')>()),
  sendMessageWithSubmitVerification: submit,
}));

import { BaseCLITool } from '@/lib/cli-tools/base';
import { GeminiTool } from '@/lib/cli-tools/gemini';
import { sendKeys, sendSpecialKey } from '@/lib/tmux/tmux';
import { classifySendFailure } from '@/lib/session/send-attempt-state';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(BaseCLITool.prototype as unknown as { isToolLive: () => Promise<boolean> }, 'isToolLive').mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('[#3981] gemini: no prompt within the wait → nothing typed, not-sent', () => {
  it('positive: 15 s without a prompt throws `prompt not ready` and types no key', async () => {
    pane.screen = 'Loading…';
    const sent = new GeminiTool().sendMessage('wt3981', 'hello');
    const settled = sent.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(16_000);
    const error = await settled;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Gemini prompt not ready/);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
    expect(submit).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendSpecialKey).not.toHaveBeenCalled();
  });

  it('negative: a prompt on screen is sent to as before', async () => {
    pane.screen = '> Type your message or @path/to/file';
    const sent = new GeminiTool().sendMessage('wt3981', 'hello');
    await vi.advanceTimersByTimeAsync(1_000);
    await sent;

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ message: 'hello', cliToolId: 'gemini' }));
  });
});
