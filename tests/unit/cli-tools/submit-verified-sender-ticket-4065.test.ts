/**
 * Issue #4065: the shared sender tells the request observing it the generation
 * its body's input lock was granted under — right after the grant, before any
 * key — so the send service ranks the attempt even when the send throws.
 *
 * tmux is mocked; nothing is typed anywhere and no file is written.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockRejectedValue(new Error('capture failed')),
  clearInputLine: vi.fn().mockResolvedValue(undefined),
  clearComposerLine: vi.fn().mockResolvedValue(undefined),
  exactTarget: (name: string) => `=${name}:`,
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('child_process', () => ({ execFile: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const spies = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { ...spies, withContext: () => spies };
  },
}));

import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { sendKeys } from '@/lib/tmux/tmux';
import {
  answerUnderInstanceInputLock,
  instanceInputGenerationMark,
  instanceInputReadMark,
  observeInputStart,
  resetInstanceInputLocks,
  withInstanceInputLock,
} from '@/lib/session/instance-input-lock';

const SESSION = 'mcbd-claude-wt-4065-sender';

beforeEach(() => {
  vi.clearAllMocks();
  resetInstanceInputLocks();
});

afterEach(() => resetInstanceInputLocks());

describe('[#4065] the shared sender tells the body lock\'s generation', () => {
  it('positive: told once with the grant\'s generation, before any key, although the send then throws', async () => {
    const onTicket = vi.fn();
    const before = instanceInputGenerationMark();

    await expect(
      observeInputStart(
        () => sendMessageWithSubmitVerification({ sessionName: SESSION, message: 'hello', cliToolId: 'claude' }),
        undefined,
        undefined,
        { onTicket }
      )
    ).rejects.toThrow();

    expect(onTicket).toHaveBeenCalledTimes(1);
    expect(onTicket).toHaveBeenCalledWith(before + 1);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('joins the outer lock: told the outer ticket\'s generation, no second grant', async () => {
    const onTicket = vi.fn();
    let outer = -1;

    await withInstanceInputLock(SESSION, async (ticket) => {
      outer = ticket.generation;
      await observeInputStart(
        () => sendMessageWithSubmitVerification({ sessionName: SESSION, message: 'hello', cliToolId: 'claude' }),
        undefined,
        undefined,
        { onTicket }
      ).catch(() => undefined);
    });

    expect(onTicket).toHaveBeenCalledWith(outer);
    expect(instanceInputGenerationMark()).toBe(outer);
  });

  it('negative: an observer that throws does not change the send', async () => {
    const result = observeInputStart(
      () => sendMessageWithSubmitVerification({ sessionName: SESSION, message: 'hello', cliToolId: 'claude' }),
      undefined,
      undefined,
      {
        onTicket: () => {
          throw new Error('observer broke');
        },
      }
    );
    // The send's own failure (the unreadable pane), not the observer's.
    await expect(result).rejects.toThrow(/re-read|capture failed/);
  });

  it('negative: an answer\'s lock (a trust dialog, a prompt answer) is not told as the body\'s', async () => {
    const onTicket = vi.fn();

    await observeInputStart(
      () =>
        answerUnderInstanceInputLock(
          SESSION,
          instanceInputReadMark(),
          async () => true,
          async () => undefined
        ),
      undefined,
      undefined,
      { onTicket }
    );

    expect(onTicket).not.toHaveBeenCalled();
  });
});
