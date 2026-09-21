/**
 * The keys a Command Code checkbox answer sends (Issue #2755 §6 / §7).
 *
 * Every expectation below is #2754's measurement, restated as an argument list:
 * digits toggle, `Enter` on an option row toggles, `Enter` on `Submit` opens a
 * **Review page**, and only the `Enter` on that page sends the answer. The
 * point of pinning `sendSpecialKeys`'s arguments rather than an outcome is that
 * nothing here can be checked against a running tool — the measurement lives in
 * `docs/design/command-code-1541-askuserquestion.md` and this file is what
 * stops the code drifting away from it.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

import {
  sendPromptAnswer,
  MultiSelectAnswerRejectedError,
  MULTI_SELECT_NOT_COMMITTED_REASON,
} from '@/lib/prompt-answer-sender';
import { capturePane, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { readCommandCodeQuestionDialog } from '@/lib/detection/tools/command-code/dialog';
import { isMultipleChoicePrompt } from '../../helpers/prompt-type-guards';
import type { MultipleChoicePromptData } from '@/types/models';

const SESSION = 'mcbd-command-code-wt';
const RULE = '─'.repeat(200);

/**
 * A 1.54.1 checkbox question, drawn the way the captures draw it.
 *
 * Synthetic on purpose: the three cases the Issue names are defined by which
 * boxes are ticked, and a fixture directory cannot hold one capture per
 * combination. The SHAPE is taken from
 * `tests/fixtures/command-code-askuserquestion-2754/multiselect-initial.txt`
 * — rule, tab strip, question, `N. [ ] label` rows at indent 2, a bare
 * `Submit`, and the hint bar — and `readsTheSyntheticFrame` below asserts the
 * real reader accepts it before any of the key expectations run.
 */
function questionFrame(options: {
  readonly ticked: readonly number[];
  readonly cursor?: number;
  readonly labels?: readonly string[];
  readonly question?: string;
  readonly confirm?: string;
}): string {
  const labels = options.labels ?? ['node_modules', 'dist', 'coverage'];
  const cursor = options.cursor ?? 1;
  const rows = labels.map((label, index) => {
    const number = index + 1;
    const box = options.ticked.includes(number) ? '[✔]' : '[ ]';
    return `${number === cursor ? '❯' : ' '} ${number}. ${box} ${label}`;
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
    options.question ?? 'Which caches should I clear?',
    '',
    ...rows,
    `  ${options.confirm ?? 'Submit'}`,
    '',
    'Enter to select | Arrow keys to navigate | 1-9 quick select | n notes | c chat | Esc to cancel',
    '',
  ].join('\n');
}

/** The Review page `Enter` on the confirm row opens (#2754 §3.3). */
function reviewFrame(unanswered = false): string {
  return [
    '# Command Code v1.54.1',
    '',
    RULE,
    '',
    '✔ Cleanup | ● Review',
    '',
    ...(unanswered ? ['⚠ You have not answered all questions', ''] : []),
    '1. Which caches should I clear?',
    unanswered ? '   No answer' : '   node_modules, coverage',
    '',
    '❯ 1. Submit',
    '  2. Cancel',
    '',
    '← to go back and edit',
    '',
  ].join('\n');
}

/** The payload the route would have re-verified against `frame`. */
function payloadFor(frame: string): MultipleChoicePromptData {
  const reading = readCommandCodeQuestionDialog(frame);
  if (reading.kind !== 'prompt') throw new Error(`fixture is not readable: ${reading.kind}`);
  const data = reading.prompt.promptData;
  if (!isMultipleChoicePrompt(data)) throw new Error('fixture is not multiple choice');
  return data;
}

/** Every `sendSpecialKeys` call, as key arrays, in order. */
function keyCalls(): string[][] {
  return vi.mocked(sendSpecialKeys).mock.calls.map((call) => call[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('[#2755] the synthetic frame is the one the reader reads', () => {
  it('reads as a checkbox question with the ticks the case names', () => {
    const data = payloadFor(questionFrame({ ticked: [3] }));
    expect(data.multiSelect).toBe(true);
    expect(data.options.map((o) => o.label)).toEqual(['node_modules', 'dist', 'coverage']);
    expect(data.options.filter((o) => o.checked).map((o) => o.number)).toEqual([3]);
    expect(data.options.find((o) => o.isDefault)?.number).toBe(1);
  });
});

describe('[#2755] the key sequence, per #2754’s measured semantics', () => {
  /**
   * Drive one answer with a scripted pane.
   *
   * `capturePane` is answered in order: first the read-back after the toggles,
   * then the read-back after the confirm row. Nothing else captures.
   */
  async function answer(
    before: string,
    afterToggle: string,
    afterConfirm: string,
    wanted: string,
  ): Promise<void> {
    vi.mocked(capturePane)
      .mockResolvedValueOnce(afterToggle)
      .mockResolvedValueOnce(afterConfirm);
    await sendPromptAnswer({
      sessionName: SESSION,
      answer: wanted,
      cliToolId: 'command-code',
      promptData: payloadFor(before),
    });
  }

  it('(a) additions only: current={3} → wanted={1,2,3}', async () => {
    await answer(
      questionFrame({ ticked: [3] }),
      questionFrame({ ticked: [1, 2, 3] }),
      reviewFrame(),
      '1,2,3',
    );

    expect(keyCalls()).toEqual([
      // 1. the symmetric difference, ascending, one digit per press. The cursor
      //    does not move, which is why nothing is navigated between them.
      ['1', '2'],
      // 2. down to the confirm row (three options, cursor on 1) and open it.
      //    `Enter` here is NOT the send: it draws the Review page.
      ['Down', 'Down', 'Down', 'Enter'],
      // 3. the Review page's own `❯ 1. Submit`. THIS is the send.
      ['Enter'],
    ]);
    // Nothing is ever typed at this screen.
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('(b) a removal: current={3} → wanted={1,2} unticks 3', async () => {
    await answer(
      questionFrame({ ticked: [3] }),
      questionFrame({ ticked: [1, 2] }),
      reviewFrame(),
      '1,2',
    );

    // `3` is pressed even though it is not in the answer: the answer is the
    // final SET, and a box the operator ticked in the terminal has to come off.
    expect(keyCalls()).toEqual([
      ['1', '2', '3'],
      ['Down', 'Down', 'Down', 'Enter'],
      ['Enter'],
    ]);
  });

  it('(c) no change: current={1,3} → wanted={1,3} toggles nothing', async () => {
    await answer(
      questionFrame({ ticked: [1, 3] }),
      questionFrame({ ticked: [1, 3] }),
      reviewFrame(),
      '1,3',
    );

    // No digit call at all — pressing them would turn both boxes OFF.
    expect(keyCalls()).toEqual([
      ['Down', 'Down', 'Down', 'Enter'],
      ['Enter'],
    ]);
  });

  it('walks down from wherever the cursor is, and only downwards', async () => {
    // `↑` from option 1 goes to two different rows depending on whether the
    // list has ever reported a highlight, and the frame does not say which
    // (#2754 §4.4). `↓` is one row per press, every time.
    await answer(
      questionFrame({ ticked: [], cursor: 3 }),
      questionFrame({ ticked: [2], cursor: 3 }),
      reviewFrame(),
      '2',
    );

    expect(keyCalls()).toEqual([['2'], ['Down', 'Enter'], ['Enter']]);
  });

  it('treats a `Next` row that advances to the next question as committed', async () => {
    // On a call with several questions the confirm row reads `Next` and its
    // `Enter` opens the FOLLOWING question rather than a Review page. That is
    // the commit for this one — its tab turns `✔` — so the arm stops there.
    vi.mocked(capturePane)
      .mockResolvedValueOnce(questionFrame({ ticked: [1], confirm: 'Next' }))
      .mockResolvedValueOnce(
        questionFrame({ ticked: [], question: 'Which files should I update?', confirm: 'Submit' }),
      );

    await sendPromptAnswer({
      sessionName: SESSION,
      answer: '1',
      cliToolId: 'command-code',
      promptData: payloadFor(questionFrame({ ticked: [], confirm: 'Next' })),
    });

    expect(keyCalls()).toEqual([['1'], ['Down', 'Down', 'Down', 'Enter']]);
  });
});

describe('[#2755] it refuses rather than confirm something it did not verify', () => {
  it('does not press the confirm row when the read-back ticks disagree', async () => {
    // The toggles went out and the screen did not take them — the digit is dead
    // whenever the cursor has left the list, and nothing on the frame says the
    // tool accepted the keystroke. Confirming here would submit a set nobody
    // verified, which is the failure this Issue exists to stop one screen
    // earlier.
    vi.mocked(capturePane).mockResolvedValueOnce(questionFrame({ ticked: [3] }));

    await expect(
      sendPromptAnswer({
        sessionName: SESSION,
        answer: '1,2,3',
        cliToolId: 'command-code',
        promptData: payloadFor(questionFrame({ ticked: [3] })),
      }),
    ).rejects.toBeInstanceOf(MultiSelectAnswerRejectedError);

    expect(keyCalls()).toEqual([['1', '2']]);
    expect(keyCalls().flat()).not.toContain('Enter');
  });

  it('does not press the confirm row when the question has gone', async () => {
    vi.mocked(capturePane).mockResolvedValueOnce('# Command Code v1.54.1\n\n❯ Ask anything\n');

    const error = await sendPromptAnswer({
      sessionName: SESSION,
      answer: '1',
      cliToolId: 'command-code',
      promptData: payloadFor(questionFrame({ ticked: [] })),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MultiSelectAnswerRejectedError);
    expect((error as MultiSelectAnswerRejectedError).stage).toBe('screen-changed');
    expect((error as MultiSelectAnswerRejectedError).reason).toBe(
      MULTI_SELECT_NOT_COMMITTED_REASON,
    );
    expect(keyCalls()).toEqual([['1']]);
  });

  it('does not press the confirm row when the pane cannot be re-read', async () => {
    vi.mocked(capturePane).mockRejectedValueOnce(new Error('no server running'));

    const error = await sendPromptAnswer({
      sessionName: SESSION,
      answer: '1',
      cliToolId: 'command-code',
      promptData: payloadFor(questionFrame({ ticked: [] })),
    }).catch((e: unknown) => e);

    expect((error as MultiSelectAnswerRejectedError).stage).toBe('recapture-failed');
    expect(keyCalls()).toEqual([['1']]);
  });

  it('never confirms a Review page that says answers are missing', async () => {
    // The page the undocumented `d` reaches. Confirming it sends `No answer`
    // for questions nobody has been shown (Issue #2755 §7).
    vi.mocked(capturePane)
      .mockResolvedValueOnce(questionFrame({ ticked: [1] }))
      .mockResolvedValueOnce(reviewFrame(true));

    const error = await sendPromptAnswer({
      sessionName: SESSION,
      answer: '1',
      cliToolId: 'command-code',
      promptData: payloadFor(questionFrame({ ticked: [] })),
    }).catch((e: unknown) => e);

    expect((error as MultiSelectAnswerRejectedError).stage).toBe('review-unanswered');
    expect(keyCalls()).toEqual([['1'], ['Down', 'Down', 'Down', 'Enter']]);
  });

  it('reports `not-committed` when neither a review page nor a new question came up', async () => {
    vi.mocked(capturePane)
      .mockResolvedValueOnce(questionFrame({ ticked: [1] }))
      .mockResolvedValueOnce(questionFrame({ ticked: [1] }));

    const error = await sendPromptAnswer({
      sessionName: SESSION,
      answer: '1',
      cliToolId: 'command-code',
      promptData: payloadFor(questionFrame({ ticked: [] })),
    }).catch((e: unknown) => e);

    expect((error as MultiSelectAnswerRejectedError).stage).toBe('not-committed');
    expect((error as MultiSelectAnswerRejectedError).keysSent).toBe(true);
  });
});

describe('[#2755] the arm is entered only for what it was measured on', () => {
  it('leaves a SINGLE-select command-code answer on the pre-#2755 path', async () => {
    // 受入基準 (b): the call list for a single-select answer does not move. The
    // question reader publishes this screen `answer_only`, so the digit goes
    // out as text with no Enter after it, exactly as #2574 left it.
    const single = questionFrame({ ticked: [] }).replace(/\[[ ✔]\] /g, '');
    const data = payloadFor(single);
    expect(data.multiSelect).toBeUndefined();

    await sendPromptAnswer({
      sessionName: SESSION,
      answer: '2',
      cliToolId: 'command-code',
      promptData: data,
      frame: single,
    });

    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith(SESSION, '2', false);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(capturePane).not.toHaveBeenCalled();
  });

  it('leaves a checkbox payload on another tool alone', async () => {
    // claude's and agy's checkbox menus keep the brackets on their labels and
    // are driven by the cursor arm; the measurement behind the arm above is
    // Command Code's and nobody else's.
    const frame = questionFrame({ ticked: [] });
    const data = payloadFor(frame);
    await sendPromptAnswer({
      sessionName: 'mcbd-claude-wt',
      answer: '2',
      cliToolId: 'claude',
      promptData: data,
      frame,
    });

    expect(keyCalls()).toEqual([['Down', 'Enter']]);
    expect(capturePane).not.toHaveBeenCalled();
  });
});
