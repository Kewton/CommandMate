/**
 * Issue #3952, third review of the input lock's answers (Codex on f2f7b9a6a).
 *
 * - P1-a: free text that waited for a send is judged again on the screen read
 *   after it — the field still there and the cursor still on it (#2573 /
 *   #2584). A cursor that moved to option 1 in the wait would otherwise turn
 *   the text's Enter into "confirm 1".
 * - P1-b: the caller's last look (`stillAllowedAtSend`, Auto-Yes's contract)
 *   is taken right before the first key whether or not anything was read
 *   again: the guard's own capture is an await the contract can change across.
 * - P2: every key of an answer goes out only while its input ticket is
 *   current — between the text and its Enter, between the arrow keys (when the
 *   caller asks between keys), and before Command Code's second stage. A
 *   session replaced part-way gets none of the rest.
 *
 * The tmux module is stubbed (its `sendSpecialKeys` asks `shouldContinue`
 * between keys, as the real one does); the readings and the lock are real.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Every key that reached the pane, in order. */
let delivered: string[] = [];
/** Told each time a key lands. */
let onKey: (key: string) => void = () => {};
/** Awaited between two keys of one `sendSpecialKeys` call (the real one sleeps there). */
let betweenKeys: () => Promise<void> = async () => {};

vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(),
  sendKeys: vi.fn(async (_session: string, keys: string, enter = true) => {
    const key = enter ? `${keys}<Enter>` : keys;
    delivered.push(key);
    onKey(key);
  }),
  sendSpecialKeys: vi.fn(
    async (_session: string, keys: string[], options?: { shouldContinue?: () => boolean }) => {
      for (let i = 0; i < keys.length; i++) {
        delivered.push(keys[i]);
        onKey(keys[i]);
        if (i < keys.length - 1) {
          await betweenKeys();
          if (options?.shouldContinue && !options.shouldContinue()) {
            throw Object.assign(new Error('aborted'), { name: 'SpecialKeysAbortedError' });
          }
        }
      }
    },
  ),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

import { PromptAnswerInputLostError, PromptAnswerNotDeliveredError, sendPromptAnswer } from '@/lib/prompt-answer-sender';
import { capturePane } from '@/lib/tmux/tmux';
import {
  invalidateInstanceInput,
  resetInstanceInputLocks,
  withInstanceInputLock,
} from '@/lib/session/instance-input-lock';
import { assessPromptAnswerability } from '@/lib/polling/auto-yes-dialog-gate';
import { readCommandCodeQuestionDialog } from '@/lib/detection/tools/command-code/dialog';
import type { MultipleChoicePromptData, PromptData } from '@/types/models';

const SESSION = 'cm-wt-3952-r3';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A message send holding the session's composer until `release`. */
function holdSend(): { release: () => void; done: Promise<void> } {
  const gate = deferred();
  const done = withInstanceInputLock(SESSION, async () => {
    delivered.push('<send>');
    await gate.promise;
  });
  return { release: gate.resolve, done };
}

beforeEach(() => {
  delivered = [];
  onKey = () => {};
  betweenKeys = async () => {};
  vi.mocked(capturePane).mockReset();
  resetInstanceInputLocks();
});

afterEach(() => {
  resetInstanceInputLocks();
});

// ---------------------------------------------------------------------------
// P1-a
// ---------------------------------------------------------------------------

/** Command Code 1.53.0's question with `Type something...` on row 3 (#2522 fixture). */
const FIELD_FRAME = readFileSync(
  path.resolve(__dirname, '../fixtures/command-code-askuserquestion-2522/question-default-on-free-text.txt'),
  'utf8',
);
/** The same question with the cursor moved to option 1. */
const CURSOR_ON_1_FRAME = FIELD_FRAME.replace('  1. Use the generated message', '❯ 1. Use the generated message').replace(
  '❯ 3. Type something...',
  '  3. Type something...',
);

function promptOf(frame: string): PromptData {
  const { promptCheck } = assessPromptAnswerability('command-code', frame);
  if (!promptCheck?.isPrompt || !promptCheck.promptData) throw new Error('fixture is not an answerable prompt');
  return promptCheck.promptData;
}

describe('[#3952 review P1-a] free text is judged again on the screen read after the wait', () => {
  it('fixture sanity: the cursor is on the field before, on option 1 after', () => {
    const before = promptOf(FIELD_FRAME) as MultipleChoicePromptData;
    const after = promptOf(CURSOR_ON_1_FRAME) as MultipleChoicePromptData;
    expect(before.options.find((o) => o.isDefault)?.number).toBe(3);
    expect(after.options.find((o) => o.isDefault)?.number).toBe(1);
  });

  it('positive: the cursor moved off the field while the text waited — nothing is typed (#2584 refusal)', async () => {
    const held = holdSend();
    const answer = sendPromptAnswer({
      sessionName: SESSION,
      answer: 'UAT-FREETEXT-KIWI',
      cliToolId: 'command-code',
      promptData: promptOf(FIELD_FRAME),
      frame: FIELD_FRAME,
    });
    await flush();
    vi.mocked(capturePane).mockResolvedValue(CURSOR_ON_1_FRAME);
    held.release();
    await held.done;
    await expect(answer).rejects.toMatchObject({ name: 'FreeTextAnswerRejectedError', kind: 'cursor_elsewhere' });
    expect(delivered).toEqual(['<send>']);
  });

  it('negative: the cursor is still on the field — the text and its Enter go out', async () => {
    const held = holdSend();
    const answer = sendPromptAnswer({
      sessionName: SESSION,
      answer: 'UAT-FREETEXT-KIWI',
      cliToolId: 'command-code',
      promptData: promptOf(FIELD_FRAME),
      frame: FIELD_FRAME,
    });
    await flush();
    vi.mocked(capturePane).mockResolvedValue(FIELD_FRAME);
    held.release();
    await held.done;
    await answer;
    expect(delivered).toEqual(['<send>', 'UAT-FREETEXT-KIWI', '<Enter>']);
  });

  it('negative: no send in the way — typed as before, nothing read again', async () => {
    await sendPromptAnswer({
      sessionName: SESSION,
      answer: 'UAT-FREETEXT-KIWI',
      cliToolId: 'command-code',
      promptData: promptOf(FIELD_FRAME),
      frame: FIELD_FRAME,
    });
    expect(delivered).toEqual(['UAT-FREETEXT-KIWI', '<Enter>']);
    expect(capturePane).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P1-b
// ---------------------------------------------------------------------------

/** codex's numbered approval, answered by digit + Enter. */
const CODEX_PROMPT: PromptData = {
  type: 'multiple_choice',
  question: 'Allow command?',
  status: 'pending',
  options: [
    { number: 1, label: 'Yes', isDefault: true },
    { number: 2, label: 'No' },
  ],
};

describe('[#3952 review P1-b] the last look is taken right before the first key, read again or not', () => {
  it('positive: the contract turned off during the guard’s own capture — nothing is typed', async () => {
    let allowed = true;
    const stillAllowedAtSend = vi.fn(() => allowed);
    // No frame: the number's guard captures the pane itself (an await, and no send in the way).
    vi.mocked(capturePane).mockImplementation(async () => {
      allowed = false;
      return '';
    });
    await expect(
      sendPromptAnswer({ sessionName: SESSION, answer: '1', cliToolId: 'codex', promptData: CODEX_PROMPT, stillAllowedAtSend }),
    ).rejects.toMatchObject({ name: 'PromptAnswerNotDeliveredError', skip: 'answer-withheld', keysSent: false });
    expect(delivered).toEqual([]);
  });

  it('positive: an answer_only digit (no Enter, not a writer) is not typed either', async () => {
    let allowed = true;
    vi.mocked(capturePane).mockImplementation(async () => {
      allowed = false;
      return '';
    });
    await expect(
      sendPromptAnswer({
        sessionName: SESSION,
        answer: '1',
        cliToolId: 'codex',
        promptData: { ...CODEX_PROMPT, submitMode: 'answer_only' },
        stillAllowedAtSend: () => allowed,
      }),
    ).rejects.toBeInstanceOf(PromptAnswerNotDeliveredError);
    expect(delivered).toEqual([]);
  });

  it('negative: still allowed — the answer goes out as before, asked once', async () => {
    vi.mocked(capturePane).mockResolvedValue('');
    const stillAllowedAtSend = vi.fn(() => true);
    await sendPromptAnswer({ sessionName: SESSION, answer: '1', cliToolId: 'codex', promptData: CODEX_PROMPT, stillAllowedAtSend });
    expect(delivered).toEqual(['1', '<Enter>']);
    expect(stillAllowedAtSend).toHaveBeenCalledTimes(1);
  });

  it('negative: no last look given (manual answers) — typed as before', async () => {
    vi.mocked(capturePane).mockResolvedValue('');
    await sendPromptAnswer({ sessionName: SESSION, answer: '1', cliToolId: 'codex', promptData: CODEX_PROMPT });
    expect(delivered).toEqual(['1', '<Enter>']);
  });
});

// ---------------------------------------------------------------------------
// P2
// ---------------------------------------------------------------------------

const YES_NO: PromptData = {
  type: 'yes_no',
  question: 'Do you want to proceed?',
  options: ['yes', 'no'],
  status: 'pending',
};

describe('[#3952 review P2] the keys of an answer stop when its input ticket is lost', () => {
  // The replacement is made from the test's own context, not from inside the
  // answer's: there it would be the answer relaunching its own pane, which
  // keeps its ticket (`invalidateInstanceInput`).
  it('positive: the session is replaced between the text and its Enter — no Enter', async () => {
    const typed = deferred();
    onKey = (key) => {
      if (key === 'y') typed.resolve();
    };
    const answering = sendPromptAnswer({ sessionName: SESSION, answer: 'y', cliToolId: 'claude', promptData: YES_NO }).catch(
      (e: unknown) => e,
    );
    await typed.promise;
    invalidateInstanceInput(SESSION);
    const error = await answering;
    expect(error).toBeInstanceOf(PromptAnswerInputLostError);
    expect(error).toMatchObject({ keysSent: true });
    expect(delivered).toEqual(['y']);
  });

  it('negative: nothing replaced — the text and its Enter', async () => {
    await sendPromptAnswer({ sessionName: SESSION, answer: 'y', cliToolId: 'claude', promptData: YES_NO });
    expect(delivered).toEqual(['y', '<Enter>']);
  });

  const PICK: PromptData = {
    type: 'multiple_choice',
    question: 'Pick',
    status: 'pending',
    options: [
      { number: 1, label: 'A', isDefault: true },
      { number: 2, label: 'B' },
      { number: 3, label: 'C' },
    ],
  };

  it('positive: replaced after the first arrow key (Auto-Yes asks between keys) — the rest are not sent', async () => {
    const firstKey = deferred();
    const gate = deferred();
    onKey = () => firstKey.resolve();
    betweenKeys = () => gate.promise;
    const answering = sendPromptAnswer({
      sessionName: SESSION,
      answer: '3',
      cliToolId: 'claude',
      promptData: PICK,
      frame: '',
      stillCurrent: () => true,
    }).catch((e: unknown) => e);
    await firstKey.promise;
    invalidateInstanceInput(SESSION);
    gate.resolve();
    const error = await answering;
    expect(error).toBeInstanceOf(PromptAnswerInputLostError);
    expect(delivered).toEqual(['Down']);
  });

  it('negative: nothing replaced — every arrow key and the Enter', async () => {
    await sendPromptAnswer({
      sessionName: SESSION,
      answer: '3',
      cliToolId: 'claude',
      promptData: PICK,
      frame: '',
      stillCurrent: () => true,
    });
    expect(delivered).toEqual(['Down', 'Down', 'Enter']);
  });

  it('negative: the caller’s own stillCurrent saying no is still the caller’s stop (PromptAnswerAbortedError)', async () => {
    let current = true;
    onKey = (key) => {
      if (key === 'Down') current = false;
    };
    const error = await sendPromptAnswer({
      sessionName: SESSION,
      answer: '3',
      cliToolId: 'claude',
      promptData: PICK,
      frame: '',
      stillCurrent: () => current,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'PromptAnswerAbortedError', keysSent: true });
  });
});

/** As `prompt-answer-sender-multiselect-2755.test.ts` draws a 1.54.1 checkbox question. */
const RULE = '─'.repeat(200);
function checkboxFrame(ticked: readonly number[], cursor = 1): string {
  const rows = ['node_modules', 'dist', 'coverage'].map((label, index) => {
    const number = index + 1;
    return `${number === cursor ? '❯' : ' '} ${number}. ${ticked.includes(number) ? '[✔]' : '[ ]'} ${label}`;
  });
  return [
    '# Command Code v1.54.1',
    '',
    '⠶ Reading the tree.',
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

function checkboxPayload(frame: string): MultipleChoicePromptData {
  const reading = readCommandCodeQuestionDialog(frame);
  if (reading.kind !== 'prompt' || reading.prompt.promptData?.type !== 'multiple_choice') {
    throw new Error('fixture is not a checkbox question');
  }
  return reading.prompt.promptData;
}

describe('[#3952 review P2] Command Code’s checkbox answer: the second stage needs the ticket too', () => {
  it('positive: replaced while the toggles were read back — the confirm walk is not sent', async () => {
    const reading = deferred();
    const gate = deferred();
    vi.mocked(capturePane).mockImplementation(async () => {
      reading.resolve();
      await gate.promise;
      return checkboxFrame([1]);
    });
    const answering = sendPromptAnswer({
      sessionName: SESSION,
      answer: '1',
      cliToolId: 'command-code',
      promptData: checkboxPayload(checkboxFrame([])),
    }).catch((e: unknown) => e);
    await reading.promise;
    invalidateInstanceInput(SESSION);
    gate.resolve();
    const error = await answering;
    expect(error).toBeInstanceOf(PromptAnswerInputLostError);
    expect(delivered).toEqual(['1']);
  });

  it('negative: nothing replaced — the toggle, then the walk to Submit and its Enter', async () => {
    vi.mocked(capturePane).mockResolvedValueOnce(checkboxFrame([1])).mockResolvedValueOnce(checkboxFrame([1]));
    await sendPromptAnswer({
      sessionName: SESSION,
      answer: '1',
      cliToolId: 'command-code',
      promptData: checkboxPayload(checkboxFrame([])),
    }).catch(() => undefined);
    expect(delivered.slice(0, 5)).toEqual(['1', 'Down', 'Down', 'Down', 'Enter']);
  });
});

// ---------------------------------------------------------------------------
// P2 (fourth contract): a manual answer — no `stillCurrent` from its caller —
// is held to the ticket between its keys too.
// ---------------------------------------------------------------------------

describe('[#3952 review P2, manual answers] the ticket is checked between keys without a caller’s stillCurrent', () => {
  const PICK3: PromptData = {
    type: 'multiple_choice',
    question: 'Pick',
    status: 'pending',
    options: [
      { number: 1, label: 'A', isDefault: true },
      { number: 2, label: 'B' },
      { number: 3, label: 'C' },
    ],
  };

  it('positive: replaced after the first arrow key — the rest are not sent, keysSent: true', async () => {
    const firstKey = deferred();
    const gate = deferred();
    onKey = () => firstKey.resolve();
    betweenKeys = () => gate.promise;
    const answering = sendPromptAnswer({
      sessionName: SESSION,
      answer: '3',
      cliToolId: 'claude',
      promptData: PICK3,
      frame: '',
    }).catch((e: unknown) => e);
    await firstKey.promise;
    invalidateInstanceInput(SESSION);
    gate.resolve();
    const error = await answering;
    expect(error).toBeInstanceOf(PromptAnswerInputLostError);
    expect(error).toMatchObject({ keysSent: true });
    expect(delivered).toEqual(['Down']);
  });

  it('negative: nothing replaced — every arrow key and the Enter', async () => {
    await sendPromptAnswer({ sessionName: SESSION, answer: '3', cliToolId: 'claude', promptData: PICK3, frame: '' });
    expect(delivered).toEqual(['Down', 'Down', 'Enter']);
  });

  it('positive: Command Code’s toggles — replaced after the first, the second is not sent', async () => {
    const firstKey = deferred();
    const gate = deferred();
    onKey = () => firstKey.resolve();
    betweenKeys = () => gate.promise;
    const answering = sendPromptAnswer({
      sessionName: SESSION,
      answer: '1,3',
      cliToolId: 'command-code',
      promptData: checkboxPayload(checkboxFrame([])),
    }).catch((e: unknown) => e);
    await firstKey.promise;
    invalidateInstanceInput(SESSION);
    gate.resolve();
    const error = await answering;
    expect(error).toBeInstanceOf(PromptAnswerInputLostError);
    expect(delivered).toEqual(['1']);
  });

  it('positive: Command Code’s walk to the confirm row — replaced after its first Down, the rest are not sent', async () => {
    const reading = deferred();
    vi.mocked(capturePane).mockImplementation(async () => {
      reading.resolve();
      return checkboxFrame([1]);
    });
    const walking = deferred();
    const gate = deferred();
    onKey = (key) => {
      if (key === 'Down') walking.resolve();
    };
    betweenKeys = async () => {
      if (delivered.includes('Down')) await gate.promise;
    };
    const answering = sendPromptAnswer({
      sessionName: SESSION,
      answer: '1',
      cliToolId: 'command-code',
      promptData: checkboxPayload(checkboxFrame([])),
    }).catch((e: unknown) => e);
    await walking.promise;
    invalidateInstanceInput(SESSION);
    gate.resolve();
    const error = await answering;
    expect(error).toBeInstanceOf(PromptAnswerInputLostError);
    expect(delivered).toEqual(['1', 'Down']);
  });

  it('negative: Command Code’s toggles, nothing replaced — both go out', async () => {
    vi.mocked(capturePane).mockResolvedValue(checkboxFrame([1, 3]));
    await sendPromptAnswer({
      sessionName: SESSION,
      answer: '1,3',
      cliToolId: 'command-code',
      promptData: checkboxPayload(checkboxFrame([])),
    }).catch(() => undefined);
    expect(delivered.slice(0, 2)).toEqual(['1', '3']);
  });
});
