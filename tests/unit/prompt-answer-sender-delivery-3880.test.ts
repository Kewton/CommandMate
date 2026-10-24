/**
 * A failed answer says how far its keys got (Issue #3880).
 *
 * `sendPromptAnswer` puts `answerDelivery` on a transport failure
 * (`TmuxSendError`): `indeterminate` when the tmux call that failed ended
 * without an exit status (its key may be on the pane) — and then NOT
 * `keysSent: true`, because no key is known to be there; `not-started` with
 * `keysSent: false` when tmux refused before any key; `delivered` (with the
 * #3839 `keysSent: true`) when keys before the failing call were seen to land.
 * An error of no transport keeps the #3839 behaviour exactly.
 *
 * The tmux double throws errors named `TmuxSendError`, as the real module does
 * (`tests/unit/lib/tmux-send-delivery-3880.test.ts` pins the real ones).
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Delivery = 'not-started' | 'indeterminate';

/** Every key that reached the pane, in order (a timed-out key included). */
let delivered: string[] = [];
/** The `sendKeys` call that fails: the text or its Enter, and how. */
let failTyped: { at: 'text' | 'enter'; delivery: Delivery } | null = null;
/** The `sendSpecialKeys` key that fails, by its index over all calls, and how. */
let failSpecial: { at: number; delivery: Delivery } | null = null;

function tmuxError(message: string, delivery: Delivery, keysDelivered: number): Error {
  return Object.assign(new Error(message), { name: 'TmuxSendError', delivery, keysDelivered });
}

vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(),
  sendKeys: vi.fn(async (_session: string, keys: string, enter = true) => {
    const key = enter ? `${keys}<Enter>` : keys;
    if (failTyped !== null && failTyped.at === (enter ? 'enter' : 'text')) {
      // A timeout after tmux took the key: it is on the pane all the same.
      if (failTyped.delivery === 'indeterminate') delivered.push(key);
      throw tmuxError('Failed to send keys to tmux session: Command failed', failTyped.delivery, 0);
    }
    delivered.push(key);
  }),
  sendSpecialKeys: vi.fn(
    async (_session: string, keys: string[], options?: { shouldContinue?: () => boolean }) => {
      for (let i = 0; i < keys.length; i++) {
        if (failSpecial !== null && failSpecial.at === delivered.length) {
          if (failSpecial.delivery === 'indeterminate') delivered.push(keys[i]);
          throw tmuxError('Failed to send special keys to tmux session: Command failed', failSpecial.delivery, i);
        }
        delivered.push(keys[i]);
        if (i < keys.length - 1 && options?.shouldContinue && !options.shouldContinue()) {
          const stop = new Error('stopped');
          stop.name = 'SpecialKeysAbortedError';
          throw stop;
        }
      }
    },
  ),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

import { sendPromptAnswer } from '@/lib/prompt-answer-sender';
import { capturePane } from '@/lib/tmux/tmux';
import type { PromptData } from '@/types/models';

const SESSION = 'cm-wt-3880-claude';
const stillCurrent = (): boolean => true;

type Thrown = Error & { keysSent?: unknown; answerDelivery?: unknown };

async function thrownBy(send: Promise<void>): Promise<Thrown | null> {
  try {
    await send;
    return null;
  } catch (error: unknown) {
    return error as Thrown;
  }
}

const YES_NO: PromptData = {
  type: 'yes_no',
  question: 'Do you want to proceed?',
  options: ['yes', 'no'],
  status: 'pending',
};

const CHOICE: PromptData = {
  type: 'multiple_choice',
  question: 'Do you want to proceed?',
  options: [
    { number: 1, label: 'Yes', isDefault: true },
    { number: 2, label: 'No', isDefault: false },
  ],
  status: 'pending',
};

beforeEach(() => {
  vi.clearAllMocks();
  delivered = [];
  failTyped = null;
  failSpecial = null;
  vi.mocked(capturePane).mockResolvedValue('');
});

describe('[#3880] the text path', () => {
  it('the typed text times out after landing: indeterminate, and not keysSent', async () => {
    failTyped = { at: 'text', delivery: 'indeterminate' };
    const error = await thrownBy(
      sendPromptAnswer({ sessionName: SESSION, answer: 'y', cliToolId: 'claude', promptData: YES_NO, stillCurrent }),
    );
    expect(delivered).toEqual(['y']);
    expect(error?.answerDelivery).toBe('indeterminate');
    // #3820's ledger counts this `failed` (may or may not be on the pane), not `partial`.
    expect(error !== null && 'keysSent' in error).toBe(false);
  });

  it('the Enter after the text times out: indeterminate, and keysSent: true (#3839)', async () => {
    failTyped = { at: 'enter', delivery: 'indeterminate' };
    const error = await thrownBy(
      sendPromptAnswer({ sessionName: SESSION, answer: 'y', cliToolId: 'claude', promptData: YES_NO, stillCurrent }),
    );
    expect(delivered).toEqual(['y', '<Enter>']);
    expect(error?.answerDelivery).toBe('indeterminate');
    expect(error?.keysSent).toBe(true);
  });

  it('negative: tmux refused the text: not-started and keysSent: false (retryable)', async () => {
    failTyped = { at: 'text', delivery: 'not-started' };
    const error = await thrownBy(
      sendPromptAnswer({ sessionName: SESSION, answer: 'y', cliToolId: 'claude', promptData: YES_NO, stillCurrent }),
    );
    expect(delivered).toEqual([]);
    expect(error?.answerDelivery).toBe('not-started');
    expect(error?.keysSent).toBe(false);
  });

  it('negative: tmux refused the Enter after the text: delivered (the text) and keysSent: true', async () => {
    failTyped = { at: 'enter', delivery: 'not-started' };
    const error = await thrownBy(
      sendPromptAnswer({ sessionName: SESSION, answer: 'y', cliToolId: 'claude', promptData: YES_NO }),
    );
    expect(delivered).toEqual(['y']);
    expect(error?.answerDelivery).toBe('delivered');
    expect(error?.keysSent).toBe(true);
  });

  it('negative: an error of no transport says nothing new (#3839 as it was)', async () => {
    vi.mocked(capturePane).mockResolvedValue('');
    const { sendKeys } = await import('@/lib/tmux/tmux');
    vi.mocked(sendKeys).mockRejectedValueOnce(new Error('tmux send-keys failed'));
    const error = await thrownBy(
      sendPromptAnswer({ sessionName: SESSION, answer: 'y', cliToolId: 'claude', promptData: YES_NO, stillCurrent }),
    );
    expect(error?.message).toBe('tmux send-keys failed');
    expect(error !== null && 'answerDelivery' in error).toBe(false);
    expect(error !== null && 'keysSent' in error).toBe(false);
  });
});

describe('[#3880] the cursor path: several keys', () => {
  it('the first key times out after landing: indeterminate, and not keysSent', async () => {
    failSpecial = { at: 0, delivery: 'indeterminate' };
    const error = await thrownBy(
      sendPromptAnswer({ sessionName: SESSION, answer: '2', cliToolId: 'claude', promptData: CHOICE, stillCurrent }),
    );
    expect(delivered).toEqual(['Down']);
    expect(error?.answerDelivery).toBe('indeterminate');
    expect(error !== null && 'keysSent' in error).toBe(false);
  });

  it('the second key times out: indeterminate, and keysSent: true', async () => {
    failSpecial = { at: 1, delivery: 'indeterminate' };
    const error = await thrownBy(
      sendPromptAnswer({ sessionName: SESSION, answer: '2', cliToolId: 'claude', promptData: CHOICE, stillCurrent }),
    );
    expect(delivered).toEqual(['Down', 'Enter']);
    expect(error?.answerDelivery).toBe('indeterminate');
    expect(error?.keysSent).toBe(true);
  });

  it('without stillCurrent (a manual answer) the keys before the failure still count', async () => {
    // #3839 counted them through `shouldContinue` only; the error's count covers this path.
    failSpecial = { at: 1, delivery: 'not-started' };
    const error = await thrownBy(
      sendPromptAnswer({ sessionName: SESSION, answer: '2', cliToolId: 'claude', promptData: CHOICE }),
    );
    expect(delivered).toEqual(['Down']);
    expect(error?.answerDelivery).toBe('delivered');
    expect(error?.keysSent).toBe(true);
  });

  it('negative: the first key refused: not-started and keysSent: false', async () => {
    failSpecial = { at: 0, delivery: 'not-started' };
    const error = await thrownBy(
      sendPromptAnswer({ sessionName: SESSION, answer: '2', cliToolId: 'claude', promptData: CHOICE, stillCurrent }),
    );
    expect(delivered).toEqual([]);
    expect(error?.answerDelivery).toBe('not-started');
    expect(error?.keysSent).toBe(false);
  });

  it('negative: a send that goes through throws nothing', async () => {
    await sendPromptAnswer({ sessionName: SESSION, answer: '2', cliToolId: 'claude', promptData: CHOICE, stillCurrent });
    expect(delivered).toEqual(['Down', 'Enter']);
  });
});
