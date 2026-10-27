/**
 * A prompt answer that sends an Enter is a writer of the session's input
 * (Issue #3952).
 *
 * - The answer's text, its wait and its Enter are one writer: a message send
 *   that starts after the text cannot type before the Enter (otherwise the
 *   answer's Enter would submit the send's body).
 * - An answer that arrives while a send holds the composer waits for it, then
 *   reads the screen again: the same prompt is answered, a prompt that is gone,
 *   changed or unreadable is not (`PromptAnswerNotDeliveredError`, nothing
 *   typed, `keysSent: false`). Auto-Yes's `stillCurrent` is asked again too.
 * - Negative controls: an `answer_only` digit sends no Enter and does not wait;
 *   another instance's send is not waited for; an answer nobody preceded reads
 *   the pane no more than before.
 *
 * The tmux module is stubbed; the screen reading is the real one.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every key that reached the pane, in order. */
let delivered: string[] = [];
/** Told each time a key lands. */
let onKey: (key: string) => void = () => {};

vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(),
  sendKeys: vi.fn(async (_session: string, keys: string, enter = true) => {
    const key = enter ? `${keys}<Enter>` : keys;
    delivered.push(key);
    onKey(key);
  }),
  sendSpecialKeys: vi.fn(async (_session: string, keys: string[]) => {
    for (const key of keys) {
      delivered.push(key);
      onKey(key);
    }
  }),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

import { PromptAnswerNotDeliveredError, sendPromptAnswer } from '@/lib/prompt-answer-sender';
import { capturePane } from '@/lib/tmux/tmux';
import { resetInstanceInputLocks, withInstanceInputLock } from '@/lib/session/instance-input-lock';
import type { PromptData } from '@/types/models';

const SESSION = 'cm-wt-3952-claude';
const OTHER_SESSION = 'cm-wt-3952-claude-2';

/** claude's plain y/n confirmation, as the generic reader reads it. */
const YES_NO_FRAME = ['some output', '', 'Do you want to proceed? (y/n)', ''].join('\n');
const YES_NO: PromptData = {
  type: 'yes_no',
  question: 'Do you want to proceed?',
  options: ['yes', 'no'],
  status: 'pending',
  instructionText: 'some output\n\nDo you want to proceed? (y/n)',
  approvalTarget: 'some output\n\nDo you want to proceed? (y/n)',
};

/** A numbered permission dialog — another prompt than {@link YES_NO}. */
const choiceFrame = (command: string, cursorOn: 1 | 2 = 1): string =>
  [
    ' Bash command',
    '',
    `   ${command}`,
    '',
    ' Do you want to proceed?',
    `${cursorOn === 1 ? ' ❯' : '  '} 1. Yes`,
    `${cursorOn === 2 ? ' ❯' : '  '} 2. No, and tell Claude what to do differently (esc)`,
    '',
  ].join('\n');

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
function holdSend(session: string = SESSION): { release: () => void; done: Promise<void> } {
  const gate = deferred();
  const done = withInstanceInputLock(session, async () => {
    delivered.push('<send>');
    await gate.promise;
  });
  return { release: gate.resolve, done };
}

beforeEach(() => {
  delivered = [];
  onKey = () => {};
  vi.mocked(capturePane).mockReset();
  vi.mocked(capturePane).mockResolvedValue(YES_NO_FRAME);
  resetInstanceInputLocks();
});

afterEach(() => {
  resetInstanceInputLocks();
});

describe('[#3952] an Enter-sending answer and a message send do not interleave', () => {
  it('positive: a send that starts after the answer’s text waits for its Enter', async () => {
    const typed = deferred();
    onKey = (key) => {
      if (key === 'y') typed.resolve();
    };
    const answer = sendPromptAnswer({ sessionName: SESSION, answer: 'y', cliToolId: 'claude', promptData: YES_NO });
    // Started from this (the test's) context, as another request would be —
    // not from inside the answer's own async context, which would join it.
    await typed.promise;
    const send = withInstanceInputLock(SESSION, async () => {
      delivered.push('<send>');
    });
    await answer;
    await send;
    expect(delivered).toEqual(['y', '<Enter>', '<send>']);
  });

  it('negative: answer_only — one digit, no Enter, and nothing to wait for', async () => {
    vi.mocked(capturePane).mockResolvedValue('');
    const held = holdSend();
    await sendPromptAnswer({
      sessionName: SESSION,
      answer: '1',
      cliToolId: 'codex',
      promptData: {
        type: 'multiple_choice',
        question: 'Allow command?',
        status: 'pending',
        submitMode: 'answer_only',
        options: [
          { number: 1, label: 'Yes', isDefault: true },
          { number: 2, label: 'No' },
        ],
      },
    });
    expect(delivered).toEqual(['<send>', '1']);
    held.release();
    await held.done;
  });
});

describe('[#3952] an answer that arrives during a send', () => {
  it('waits for the send, reads the same prompt again, and answers (negative control)', async () => {
    const held = holdSend();
    const answer = sendPromptAnswer({ sessionName: SESSION, answer: 'y', cliToolId: 'claude', promptData: YES_NO });
    await flush();
    expect(delivered).toEqual(['<send>']);
    vi.mocked(capturePane).mockClear();
    held.release();
    await held.done;
    await answer;
    expect(delivered).toEqual(['<send>', 'y', '<Enter>']);
    expect(capturePane).toHaveBeenCalledTimes(1);
  });

  it('positive: the prompt is gone after the send — nothing is typed', async () => {
    const held = holdSend();
    const answer = sendPromptAnswer({ sessionName: SESSION, answer: 'y', cliToolId: 'claude', promptData: YES_NO });
    await flush();
    vi.mocked(capturePane).mockResolvedValue('❯ ');
    held.release();
    await held.done;
    const error = await answer.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PromptAnswerNotDeliveredError);
    expect(error).toMatchObject({ skip: 'target-changed', keysSent: false, reason: 'answer_not_delivered' });
    expect(delivered).toEqual(['<send>']);
  });

  it('positive: another prompt is up after the send — nothing is typed', async () => {
    const held = holdSend();
    const answer = sendPromptAnswer({
      sessionName: SESSION,
      answer: '1',
      cliToolId: 'claude',
      promptData: { type: 'multiple_choice', question: 'Bash command npm test Do you want to proceed?', status: 'pending', options: [
        { number: 1, label: 'Yes', isDefault: true },
        { number: 2, label: 'No, and tell Claude what to do differently (esc)', requiresTextInput: true },
      ] },
      frame: choiceFrame('npm test'),
    });
    await flush();
    vi.mocked(capturePane).mockResolvedValue(choiceFrame('rm -rf build'));
    held.release();
    await held.done;
    await expect(answer).rejects.toMatchObject({ name: 'PromptAnswerNotDeliveredError', skip: 'target-changed' });
    expect(delivered).toEqual(['<send>']);
  });

  it('negative: the same numbered prompt with the cursor moved is still answered', async () => {
    const held = holdSend();
    const answer = sendPromptAnswer({
      sessionName: SESSION,
      answer: '1',
      cliToolId: 'claude',
      promptData: { type: 'multiple_choice', question: 'Bash command npm test Do you want to proceed?', status: 'pending', options: [
        { number: 1, label: 'Yes', isDefault: true },
        { number: 2, label: 'No, and tell Claude what to do differently (esc)', requiresTextInput: true },
      ] },
      frame: choiceFrame('npm test'),
    });
    await flush();
    vi.mocked(capturePane).mockResolvedValue(choiceFrame('npm test', 2));
    held.release();
    await held.done;
    await answer;
    // Review P1-1: the keys are placed from where the cursor is now (on 2),
    // not from the reading before the wait — a bare Enter would confirm 2.
    expect(delivered).toEqual(['<send>', 'Up', 'Enter']);
  });

  it('positive: the screen cannot be read after the send — nothing is typed', async () => {
    const held = holdSend();
    const answer = sendPromptAnswer({ sessionName: SESSION, answer: 'y', cliToolId: 'claude', promptData: YES_NO });
    await flush();
    vi.mocked(capturePane).mockRejectedValue(new Error('no server running'));
    held.release();
    await held.done;
    await expect(answer).rejects.toMatchObject({ name: 'PromptAnswerNotDeliveredError', skip: 'recheck-failed' });
    expect(delivered).toEqual(['<send>']);
  });

  it('positive: Auto-Yes lost its grant while it waited — nothing is typed, nothing read', async () => {
    let current = true;
    const held = holdSend();
    const answer = sendPromptAnswer({
      sessionName: SESSION,
      answer: 'y',
      cliToolId: 'claude',
      promptData: YES_NO,
      stillCurrent: () => current,
    });
    await flush();
    current = false;
    vi.mocked(capturePane).mockClear();
    held.release();
    await held.done;
    await expect(answer).rejects.toMatchObject({ name: 'PromptAnswerNotDeliveredError', skip: 'target-changed' });
    expect(capturePane).not.toHaveBeenCalled();
    expect(delivered).toEqual(['<send>']);
  });

  it('negative: a send to another instance is not waited for', async () => {
    const held = holdSend(OTHER_SESSION);
    vi.mocked(capturePane).mockClear();
    await sendPromptAnswer({ sessionName: SESSION, answer: 'y', cliToolId: 'claude', promptData: YES_NO });
    expect(delivered).toEqual(['<send>', 'y', '<Enter>']);
    expect(capturePane).not.toHaveBeenCalled();
    held.release();
    await held.done;
  });

  it('a send arriving while the answer is typing waits for the whole answer', async () => {
    let releaseFirstKey: () => void = () => {};
    const firstKeyHeld = new Promise<void>((r) => {
      releaseFirstKey = r;
    });
    const { sendSpecialKeys } = await import('@/lib/tmux/tmux');
    vi.mocked(sendSpecialKeys).mockImplementationOnce(async (_s: string, keys: string[]) => {
      await firstKeyHeld;
      delivered.push(...keys);
    });
    const answer = sendPromptAnswer({
      sessionName: SESSION,
      answer: '2',
      cliToolId: 'claude',
      promptData: { type: 'multiple_choice', question: 'Pick', status: 'pending', options: [
        { number: 1, label: 'A', isDefault: true },
        { number: 2, label: 'B' },
      ] },
      frame: '',
    });
    await flush();
    const send = withInstanceInputLock(SESSION, async () => {
      delivered.push('<send>');
    });
    await flush();
    expect(delivered).toEqual([]);
    releaseFirstKey();
    await answer;
    await send;
    expect(delivered).toEqual(['Down', 'Enter', '<send>']);
  });
});

/** The numbered permission dialog's reading, with the cursor on `cursorOn`. */
const choicePrompt = (cursorOn: 1 | 2): PromptData => ({
  type: 'multiple_choice',
  question: 'Bash command npm test Do you want to proceed?',
  status: 'pending',
  options: [
    { number: 1, label: 'Yes', isDefault: cursorOn === 1 },
    { number: 2, label: 'No, and tell Claude what to do differently (esc)', isDefault: cursorOn === 2, requiresTextInput: true },
  ],
});

describe('[#3952 review P1-1] cursor keys come from the screen read after the wait', () => {
  it('positive: the cursor moved from 2 to 1 while the answer "2" waited — Down, Enter (not a bare Enter on 1)', async () => {
    const held = holdSend();
    const answer = sendPromptAnswer({
      sessionName: SESSION,
      answer: '2',
      cliToolId: 'claude',
      promptData: choicePrompt(2),
      frame: choiceFrame('npm test', 2),
    });
    await flush();
    vi.mocked(capturePane).mockResolvedValue(choiceFrame('npm test', 1));
    held.release();
    await held.done;
    await answer;
    expect(delivered).toEqual(['<send>', 'Down', 'Enter']);
  });

  it('negative: the cursor did not move — the same keys as without a wait', async () => {
    const held = holdSend();
    const answer = sendPromptAnswer({
      sessionName: SESSION,
      answer: '2',
      cliToolId: 'claude',
      promptData: choicePrompt(1),
      frame: choiceFrame('npm test', 1),
    });
    await flush();
    vi.mocked(capturePane).mockResolvedValue(choiceFrame('npm test', 1));
    held.release();
    await held.done;
    await answer;
    expect(delivered).toEqual(['<send>', 'Down', 'Enter']);
  });

  it('negative: no wait — the keys come from the caller’s reading, nothing is read again', async () => {
    vi.mocked(capturePane).mockClear();
    await sendPromptAnswer({
      sessionName: SESSION,
      answer: '2',
      cliToolId: 'claude',
      promptData: choicePrompt(2),
      frame: choiceFrame('npm test', 2),
    });
    expect(delivered).toEqual(['Enter']);
    expect(capturePane).not.toHaveBeenCalled();
  });
});

describe('[#3952 review P1-2] the caller’s last look is taken again right before the first key', () => {
  it('positive: no longer allowed once the wait is over — nothing is typed (answer-withheld)', async () => {
    let allowed = true;
    const stillAllowedAtSend = vi.fn(() => allowed);
    vi.mocked(capturePane).mockResolvedValue(YES_NO_FRAME);
    const held = holdSend();
    const answer = sendPromptAnswer({
      sessionName: SESSION,
      answer: 'y',
      cliToolId: 'claude',
      promptData: YES_NO,
      stillAllowedAtSend,
    });
    await flush();
    allowed = false;
    held.release();
    await held.done;
    const error = await answer.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PromptAnswerNotDeliveredError);
    expect(error).toMatchObject({ skip: 'answer-withheld', keysSent: false, reason: 'answer_not_delivered' });
    expect(delivered).toEqual(['<send>']);
    expect(stillAllowedAtSend).toHaveBeenCalledTimes(1);
  });

  it('negative: still allowed after the wait — answered', async () => {
    const stillAllowedAtSend = vi.fn(() => true);
    vi.mocked(capturePane).mockResolvedValue(YES_NO_FRAME);
    const held = holdSend();
    const answer = sendPromptAnswer({
      sessionName: SESSION,
      answer: 'y',
      cliToolId: 'claude',
      promptData: YES_NO,
      stillAllowedAtSend,
    });
    await flush();
    held.release();
    await held.done;
    await answer;
    expect(delivered).toEqual(['<send>', 'y', '<Enter>']);
    expect(stillAllowedAtSend).toHaveBeenCalledTimes(1);
  });

  it('negative: no wait — not asked again (the caller looked right before the call)', async () => {
    const stillAllowedAtSend = vi.fn(() => false);
    await sendPromptAnswer({
      sessionName: SESSION,
      answer: 'y',
      cliToolId: 'claude',
      promptData: YES_NO,
      stillAllowedAtSend,
    });
    expect(delivered).toEqual(['y', '<Enter>']);
    expect(stillAllowedAtSend).not.toHaveBeenCalled();
  });
});
