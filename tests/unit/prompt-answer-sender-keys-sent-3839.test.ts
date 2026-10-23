/**
 * A send that fails after a key reached the pane says so (Issue #3839).
 *
 * `sendPromptAnswer` puts `keysSent: true` on a failure that comes after a key
 * of the answer is known to be on the pane — the typed text before its Enter,
 * the keys `sendSpecialKeys` had already sent when a later one failed — so
 * Auto-Yes does not type the answer again over them. A failure before any key
 * is left as it was, and the errors that already name `keysSent` keep their
 * own word.
 *
 * The tmux double sends keys one at a time and asks `shouldContinue` between
 * them, as `sendSpecialKeys` does (`tests/unit/lib/tmux-special-keys-abort-3706.test.ts`).
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Every key that reached the pane, in order. */
let delivered: string[] = [];
/** The `sendSpecialKeys` key that fails, by its index over all calls; null: none. */
let failSpecialAt: number | null = null;
/** Whether the typed text (`'text'`) or its Enter (`'enter'`) fails. */
let failTyped: 'text' | 'enter' | null = null;

vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(),
  sendKeys: vi.fn(async (_session: string, keys: string, enter = true) => {
    if (failTyped === (enter ? 'enter' : 'text')) throw new Error('tmux send-keys failed');
    delivered.push(enter ? `${keys}<Enter>` : keys);
  }),
  sendSpecialKeys: vi.fn(
    async (_session: string, keys: string[], options?: { shouldContinue?: () => boolean }) => {
      for (let i = 0; i < keys.length; i++) {
        if (failSpecialAt === delivered.length) {
          throw new Error('Failed to send special keys to tmux session: gone');
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

import {
  MultiSelectAnswerRejectedError,
  PromptAnswerAbortedError,
  sendPromptAnswer,
} from '@/lib/prompt-answer-sender';
import { capturePane } from '@/lib/tmux/tmux';
import { readCommandCodeQuestionDialog } from '@/lib/detection/tools/command-code/dialog';
import { isMultipleChoicePrompt } from '../helpers/prompt-type-guards';
import type { MultipleChoicePromptData, PromptData } from '@/types/models';

const SESSION = 'cm-wt-3839-claude';
const stillCurrent = (): boolean => true;

/** What the sender threw, or null when it did not. */
async function thrownBy(send: Promise<void>): Promise<(Error & { keysSent?: unknown }) | null> {
  try {
    await send;
    return null;
  } catch (error: unknown) {
    return error as Error & { keysSent?: unknown };
  }
}

const YES_NO: PromptData = {
  type: 'yes_no',
  question: 'Do you want to proceed?',
  options: ['yes', 'no'],
  status: 'pending',
};

/** claude's checkbox list: `Space` on the row, then down to `Next`, then Enter. */
const CHECKBOX: PromptData = {
  type: 'multiple_choice',
  question: 'Pick:',
  options: [
    { number: 1, label: '[ ] Option A', isDefault: true },
    { number: 2, label: '[ ] Option B', isDefault: false },
    { number: 3, label: '[ ] Option C', isDefault: false },
  ],
  status: 'pending',
};

beforeEach(() => {
  vi.clearAllMocks();
  delivered = [];
  failSpecialAt = null;
  failTyped = null;
  // The guard's own read of the pane: nothing there to refuse on.
  vi.mocked(capturePane).mockResolvedValue('');
});

describe('[#3839] the text path: the typed answer, then its Enter', () => {
  it('an Enter that fails after the text is typed carries keysSent: true', async () => {
    failTyped = 'enter';
    const error = await thrownBy(
      sendPromptAnswer({ sessionName: SESSION, answer: 'y', cliToolId: 'claude', promptData: YES_NO, stillCurrent }),
    );
    expect(delivered).toEqual(['y']);
    expect(error?.message).toBe('tmux send-keys failed');
    expect(error?.keysSent).toBe(true);
  });

  it('the same without stillCurrent (a manual answer): the text is on the pane all the same', async () => {
    failTyped = 'enter';
    const error = await thrownBy(
      sendPromptAnswer({ sessionName: SESSION, answer: 'y', cliToolId: 'claude', promptData: YES_NO }),
    );
    expect(error?.keysSent).toBe(true);
  });

  it('negative: a failure typing the text itself says nothing about keys', async () => {
    failTyped = 'text';
    const error = await thrownBy(
      sendPromptAnswer({ sessionName: SESSION, answer: 'y', cliToolId: 'claude', promptData: YES_NO, stillCurrent }),
    );
    expect(delivered).toEqual([]);
    expect(error?.message).toBe('tmux send-keys failed');
    expect(error !== null && 'keysSent' in error).toBe(false);
  });

  it('negative: a send that goes through throws nothing', async () => {
    await sendPromptAnswer({ sessionName: SESSION, answer: 'y', cliToolId: 'claude', promptData: YES_NO, stillCurrent });
    expect(delivered).toEqual(['y', '<Enter>']);
  });
});

describe("[#3839] claude's checkbox list: Space, then down to Next, then Enter", () => {
  it('a failure after the Space carries keysSent: true', async () => {
    // answer 2: Down, Space, Down, Down, Enter — the third key fails.
    failSpecialAt = 2;
    const error = await thrownBy(
      sendPromptAnswer({ sessionName: SESSION, answer: '2', cliToolId: 'claude', promptData: CHECKBOX, stillCurrent }),
    );
    expect(delivered).toEqual(['Down', 'Space']);
    expect(error?.message).toMatch(/Failed to send special keys/);
    expect(error?.keysSent).toBe(true);
  });

  it('negative: a failure on the first key says nothing about keys', async () => {
    failSpecialAt = 0;
    const error = await thrownBy(
      sendPromptAnswer({ sessionName: SESSION, answer: '2', cliToolId: 'claude', promptData: CHECKBOX, stillCurrent }),
    );
    expect(delivered).toEqual([]);
    expect(error !== null && 'keysSent' in error).toBe(false);
  });

  it('negative: a stop between the keys is still the stop, keysSent: true', async () => {
    let asked = 0;
    const error = await thrownBy(
      sendPromptAnswer({
        sessionName: SESSION,
        answer: '2',
        cliToolId: 'claude',
        promptData: CHECKBOX,
        stillCurrent: () => ++asked < 2,
      }),
    );
    expect(error).toBeInstanceOf(PromptAnswerAbortedError);
    expect(error?.keysSent).toBe(true);
  });

  it('negative: the keys and the call are as before', async () => {
    await sendPromptAnswer({ sessionName: SESSION, answer: '2', cliToolId: 'claude', promptData: CHECKBOX, stillCurrent });
    expect(delivered).toEqual(['Down', 'Space', 'Down', 'Down', 'Enter']);
  });
});

// ---------------------------------------------------------------------------
// Command Code's checkbox question (#2755): its refusals keep their own word
// ---------------------------------------------------------------------------

const RULE = '─'.repeat(200);
function questionFrame(ticked: readonly number[]): string {
  const rows = ['node_modules', 'dist', 'coverage'].map((label, index) => {
    const number = index + 1;
    return `${number === 1 ? '❯' : ' '} ${number}. ${ticked.includes(number) ? '[✔]' : '[ ]'} ${label}`;
  });
  return [
    '# Command Code v1.54.1',
    '',
    RULE,
    '',
    '● Cleanup | ◯ Review',
    '',
    'Which caches should I clear?',
    '',
    ...rows,
    '  Submit',
    '',
    'Enter to select | Arrow keys to navigate | 1-9 quick select | n notes | c chat | Esc to cancel',
    '',
  ].join('\n');
}
function payloadFor(frame: string): MultipleChoicePromptData {
  const reading = readCommandCodeQuestionDialog(frame);
  if (reading.kind !== 'prompt') throw new Error(`fixture is not readable: ${reading.kind}`);
  const data = reading.prompt.promptData;
  if (!isMultipleChoicePrompt(data)) throw new Error('fixture is not multiple choice');
  return data;
}

describe("[#3839] Command Code's checkbox question", () => {
  it('a transport failure on the confirm row, after the toggles, carries keysSent: true', async () => {
    vi.mocked(capturePane).mockResolvedValueOnce(questionFrame([1, 3]));
    // toggles: '1' (index 0); then Down, Down, Down, Enter — the first Down fails.
    failSpecialAt = 1;
    const error = await thrownBy(
      sendPromptAnswer({
        sessionName: SESSION,
        answer: '1,3',
        cliToolId: 'command-code',
        promptData: payloadFor(questionFrame([3])),
        stillCurrent,
      }),
    );
    expect(delivered).toEqual(['1']);
    expect(error).not.toBeInstanceOf(MultiSelectAnswerRejectedError);
    expect(error?.keysSent).toBe(true);
  });

  it('negative: a refusal with no key sent keeps keysSent: false', async () => {
    // Nothing to toggle, and the read-back fails: refused before any key.
    vi.mocked(capturePane).mockRejectedValueOnce(new Error('capture failed'));
    const error = await thrownBy(
      sendPromptAnswer({
        sessionName: SESSION,
        answer: '3',
        cliToolId: 'command-code',
        promptData: payloadFor(questionFrame([3])),
        stillCurrent,
      }),
    );
    expect(delivered).toEqual([]);
    expect(error).toBeInstanceOf(MultiSelectAnswerRejectedError);
    expect(error?.keysSent).toBe(false);
  });
});
