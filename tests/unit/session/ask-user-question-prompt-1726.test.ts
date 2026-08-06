/**
 * Turning an `AskUserQuestion` payload into answerable options (Issue #1726).
 *
 * The screens here are real. `CANARY_ASKUSERQUESTION_TASK_PANEL` is a capture of
 * a live v2.1.223 picker with the task panel overlaid, and
 * `askuserquestion-submit-taskpanel.txt` is the "Ready to submit your answers?"
 * screen from the #1708 investigation. They are run through the actual detector
 * rather than through hand-written `promptData`, because the interesting part of
 * this module is precisely the mismatch between what the payload says and what
 * the pane shows — a fabricated `promptData` would be a fabricated mismatch.
 *
 * The negative cases are what make the positive ones safe. A module that
 * substituted its options unconditionally would pass every "the labels are
 * right" assertion while putting one question's options under another's
 * question, and putting the first question's options under `1. Submit answers`.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { detectMultipleChoicePrompt } from '@/lib/detection/prompt-detect-multiple-choice';
import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import type { AskUserQuestionSpec } from '@/lib/hooks/ask-user-question-payload';
import { parseAskUserQuestionToolInput } from '@/lib/hooks/ask-user-question-payload';
import {
  applyAskUserQuestion,
  isPickerMetaOption,
  matchAskUserQuestion,
  resolveAskUserQuestionAnswer,
} from '@/lib/session/ask-user-question-prompt';
import type { MultipleChoicePromptData, PromptData } from '@/types/models';
import { CANARY_ASKUSERQUESTION_TASK_PANEL } from '../../fixtures/canary/askuserquestion-task-panel';

/** Run a captured pane through the real detector, exactly as the route does. */
function detect(frame: string): MultipleChoicePromptData {
  const output = stripBoxDrawing(stripAnsi(frame));
  const result = detectMultipleChoicePrompt(output, buildDetectPromptOptions('claude'), (s) => s);
  if (result.promptData?.type !== 'multiple_choice') {
    throw new Error('fixture did not detect as a multiple_choice prompt');
  }
  return result.promptData;
}

function spec(toolInput: unknown, promptId: string | null = 'prompt-1'): AskUserQuestionSpec {
  const questions = parseAskUserQuestionToolInput(toolInput);
  if (questions === null) throw new Error('test payload did not parse');
  return { questions, promptId };
}

/** The call behind the canary capture: three tasks, each with a description. */
const TASK_SPEC = spec({
  questions: [
    {
      question: 'Which task would you like to start with?',
      header: 'First task',
      multiSelect: false,
      options: [
        { label: 'Clear desk', description: 'Start by clearing the desk surface.' },
        { label: 'Sort papers', description: 'Start by sorting through the papers.' },
        { label: 'Wrangle cables', description: 'Start by wrangling and organizing the cables.' },
      ],
    },
  ],
});

const SUBMIT_SCREEN = readFileSync(
  join(process.cwd(), 'tests/unit/lib/detection/fixtures/claude-live-1708/askuserquestion-submit-taskpanel.txt'),
  'utf8',
);

/** The three-question call that produced the submit screen above. */
const THREE_QUESTION_SPEC = spec({
  questions: [
    {
      question: 'Which color scheme do you prefer?',
      header: 'Color scheme',
      options: [{ label: 'Dark' }, { label: 'Light' }],
    },
    {
      question: 'Which editor do you prefer?',
      header: 'Editor',
      options: [{ label: 'Vim' }, { label: 'Emacs' }],
    },
    {
      question: 'Which shell do you prefer?',
      header: 'Shell',
      options: [{ label: 'zsh' }, { label: 'bash' }],
    },
  ],
});

describe('the live picker with the task panel on screen (Issue #1726)', () => {
  const screen = detect(CANARY_ASKUSERQUESTION_TASK_PANEL);

  it('the capture really is the case this Issue is about', () => {
    // Stated so the assertions below cannot quietly become vacuous: the frame
    // has the task panel in it, the picker parses, and it carries the two
    // options Claude appends itself.
    expect(CANARY_ASKUSERQUESTION_TASK_PANEL).toContain('AskUserQuestion');
    expect(screen.isAskUserQuestion).toBe(true);
    expect(screen.options.map((o) => o.number)).toEqual([1, 2, 3, 4, 5]);
    expect(screen.options.map((o) => o.label)).toContain('Type something.');
  });

  it('publishes the agent’s labels with their descriptions', () => {
    const applied = applyAskUserQuestion(screen, TASK_SPEC)!;

    expect(applied.options.slice(0, 3)).toEqual([
      {
        number: 1,
        label: 'Clear desk',
        isDefault: true,
        requiresTextInput: false,
        description: 'Start by clearing the desk surface.',
      },
      {
        number: 2,
        label: 'Sort papers',
        isDefault: false,
        requiresTextInput: false,
        description: 'Start by sorting through the papers.',
      },
      {
        number: 3,
        label: 'Wrangle cables',
        isDefault: false,
        requiresTextInput: false,
        description: 'Start by wrangling and organizing the cables.',
      },
    ]);
  });

  it('adds descriptions the scraper cannot see at all', () => {
    // The picker renders the description on its own indented line, which the
    // detector treats as a continuation and drops — otherwise it would parse as
    // another option. So this is information the payload adds, not information
    // it duplicates.
    expect(screen.options.every((o) => o.description === undefined)).toBe(true);
    expect(applyAskUserQuestion(screen, TASK_SPEC)!.options[0].description).toBeDefined();
  });

  it('keeps the two options the picker itself appends, with their numbers', () => {
    // They are selectable. Dropping them would make `respond <id> 5` refuse a
    // number the picker accepts.
    const applied = applyAskUserQuestion(screen, TASK_SPEC)!;

    expect(applied.options.map((o) => o.number)).toEqual([1, 2, 3, 4, 5]);
    expect(applied.options[3].label).toBe('Type something.');
    expect(applied.options[4].label).toBe('Chat about this');
    expect(applied.askUserQuestion!.metaOptionNumbers).toEqual([4, 5]);
  });

  it('replaces the question with the agent’s text, not the pane’s sweep', () => {
    // The detector's upward scan glues several lines together.
    expect(screen.question).toContain("I'll load the TaskCreate tool schema first");
    expect(applyAskUserQuestion(screen, TASK_SPEC)!.question).toBe(
      'Which task would you like to start with?',
    );
  });

  it('reports the header and that this is the only question', () => {
    expect(applyAskUserQuestion(screen, TASK_SPEC)!.askUserQuestion).toMatchObject({
      header: 'First task',
      multiSelect: false,
      questionIndex: 0,
      questionCount: 1,
    });
  });
});

describe('the phantom option this Issue exists to keep out (Issue #1726)', () => {
  /**
   * The exact poisoning shape: a task panel whose task count lands one past the
   * picker's last option, so `NORMAL_OPTION_PATTERN` reads its header as the
   * next option instead of breaking the scan (#1708).
   */
  const POISONED_FRAME = [
    CANARY_ASKUSERQUESTION_TASK_PANEL,
    '',
    '  6 tasks (0 done, 1 in progress, 5 open)',
    '  ◼ Clear desk',
    '  ◻ Sort papers',
  ].join('\n');

  it('the detector keeps it out — the #1708 guard, pinned here so it stays', () => {
    const screen = detect(POISONED_FRAME);

    expect(screen.options.map((o) => o.number)).toEqual([1, 2, 3, 4, 5]);
    expect(screen.options.some((o) => o.label.includes('tasks ('))).toBe(false);
  });

  it('and so does this layer, without needing to recognise a task panel', () => {
    // The second line of defence, and the one that does not depend on the
    // panel's wording: an option the payload does not describe and the picker
    // does not add is not an option. Fed a promptData poisoned exactly as the
    // 2026-08-06 incident was, to prove the filter is not simply inheriting the
    // detector's work.
    const poisoned: MultipleChoicePromptData = {
      ...detect(CANARY_ASKUSERQUESTION_TASK_PANEL),
      options: [
        ...detect(CANARY_ASKUSERQUESTION_TASK_PANEL).options,
        { number: 6, label: 'tasks (0 done, 1 in progress, 5 open)', isDefault: false },
      ],
    };

    const applied = applyAskUserQuestion(poisoned, TASK_SPEC)!;

    expect(applied.options.map((o) => o.number)).toEqual([1, 2, 3, 4, 5]);
    expect(applied.options.some((o) => o.label.includes('tasks'))).toBe(false);
  });

  it('refuses out-of-range answers that a phantom option would have accepted', () => {
    const applied = applyAskUserQuestion(detect(CANARY_ASKUSERQUESTION_TASK_PANEL), TASK_SPEC)!;

    expect(resolveAskUserQuestionAnswer(applied, '6')).toMatchObject({
      ok: false,
      reason: 'answer_out_of_range',
    });
  });
});

describe('screens this module must not touch (Issue #1726)', () => {
  it('leaves the "Ready to submit your answers?" step alone', () => {
    // Its options are `1. Submit answers` / `2. Cancel` — in no `tool_input`.
    // Substituting the questions' options here would make `respond <id> 1`
    // report that it selected "Dark" while it actually submitted the form.
    const screen = detect(SUBMIT_SCREEN);

    expect(screen.options.map((o) => o.label)).toEqual(['Submit answers', 'Cancel']);
    expect(applyAskUserQuestion(screen, THREE_QUESTION_SPEC)).toBeNull();
  });

  it('leaves the confirmation step alone for a single-question call too', () => {
    // The ambiguity guard cannot help here — one question can only match once —
    // so this is the option-correspondence check doing the work on its own.
    const single = spec({
      questions: [
        {
          question: 'Which editor do you prefer?',
          options: [{ label: 'Vim' }, { label: 'Emacs' }],
        },
      ],
    });

    expect(applyAskUserQuestion(detect(SUBMIT_SCREEN), single)).toBeNull();
  });

  it('leaves a prompt that is not a multiple choice alone', () => {
    const yesNo: PromptData = {
      type: 'yes_no',
      question: 'Which task would you like to start with?',
      status: 'pending',
      options: ['yes', 'no'],
    };

    expect(applyAskUserQuestion(yesNo, TASK_SPEC)).toBeNull();
  });

  it('leaves a screen whose question matches nothing alone', () => {
    const other = detect(
      [
        'Do you want to make this edit to page.tsx?',
        '❯ 1. Yes',
        '  2. Yes, and don’t ask again',
        '  3. No',
        '',
        'Enter to select · ↑/↓ to navigate · Esc to cancel',
      ].join('\n'),
    );

    expect(applyAskUserQuestion(other, TASK_SPEC)).toBeNull();
  });

  it('leaves a screen alone when the options do not line up with the payload', () => {
    // A rendering this module does not understand is a rendering it does not
    // touch: the scraper's parse is at least about the screen in front of the
    // human, and a substitution built on a broken correspondence would not be.
    const screen = detect(CANARY_ASKUSERQUESTION_TASK_PANEL);
    const mismatched = spec({
      questions: [
        {
          question: 'Which task would you like to start with?',
          options: [{ label: 'Clear desk' }, { label: 'Something else entirely' }],
        },
      ],
    });

    expect(applyAskUserQuestion(screen, mismatched)).toBeNull();
  });

  it('leaves it alone when the payload has more options than the screen shows', () => {
    const screen = detect(CANARY_ASKUSERQUESTION_TASK_PANEL);
    const truncatedScreen: MultipleChoicePromptData = {
      ...screen,
      options: screen.options.filter((o) => o.number <= 2),
    };

    expect(applyAskUserQuestion(truncatedScreen, TASK_SPEC)).toBeNull();
  });
});

describe('choosing which question the screen is on (Issue #1726)', () => {
  it('matches the question the picker is showing, not the first one', () => {
    const screen: MultipleChoicePromptData = {
      type: 'multiple_choice',
      question: 'Which editor do you prefer?',
      status: 'pending',
      options: [
        { number: 1, label: 'Vim', isDefault: true },
        { number: 2, label: 'Emacs' },
      ],
    };

    const applied = applyAskUserQuestion(screen, THREE_QUESTION_SPEC)!;

    expect(applied.askUserQuestion).toMatchObject({
      header: 'Editor',
      questionIndex: 1,
      questionCount: 3,
    });
    expect(applied.options.map((o) => o.label)).toEqual(['Vim', 'Emacs']);
  });

  it('refuses when two questions both match the screen', () => {
    // The "Review your answers" screen lists every question at once. Picking
    // either would put one question's options under another's.
    const ambiguous = spec({
      questions: [
        { question: 'Which editor do you prefer?', options: [{ label: 'Vim' }] },
        { question: 'Which editor do you prefer?', options: [{ label: 'Emacs' }] },
      ],
    });

    expect(matchAskUserQuestion(ambiguous, 'Which editor do you prefer?')).toBeNull();
  });

  it('matches a question the pane truncated or padded', () => {
    expect(
      matchAskUserQuestion(TASK_SPEC, '  Which task would you like to start with?  '),
    ).toMatchObject({ index: 0 });
    expect(matchAskUserQuestion(TASK_SPEC, 'Which task would you like to start')).toMatchObject({
      index: 0,
    });
  });

  it('does not match on a scrap of text', () => {
    expect(matchAskUserQuestion(TASK_SPEC, 'W')).toBeNull();
    expect(matchAskUserQuestion(TASK_SPEC, '')).toBeNull();
  });
});

describe('multi-select pickers (Issue #1726)', () => {
  const MULTI_SPEC = spec({
    questions: [
      {
        question: 'What should be copied?',
        multiSelect: true,
        options: [
          { label: 'User input only', description: 'Copy only the message you sent.' },
          { label: 'Response only', description: 'Copy only the assistant reply.' },
        ],
      },
    ],
  });

  const MULTI_SCREEN: MultipleChoicePromptData = {
    type: 'multiple_choice',
    question: 'What should be copied?',
    status: 'pending',
    isAskUserQuestion: true,
    options: [
      { number: 1, label: '[ ] User input only', isDefault: true },
      { number: 2, label: '[ ] Response only' },
      { number: 3, label: '[ ] Type something' },
    ],
  };

  it('keeps the checkbox prefix, because the answer sender keys off it', () => {
    // `prompt-answer-sender` recognises a multi-select picker by `^\[[ x]\] ` on
    // the labels and sends Space-toggle-then-Next for it. A "cleaner" label here
    // would silently turn that into a bare Enter on the wrong option.
    const applied = applyAskUserQuestion(MULTI_SCREEN, MULTI_SPEC)!;

    expect(applied.options.map((o) => o.label)).toEqual([
      '[ ] User input only',
      '[ ] Response only',
      '[ ] Type something',
    ]);
    expect(applied.options[0].description).toBe('Copy only the message you sent.');
    expect(applied.askUserQuestion!.multiSelect).toBe(true);
  });

  it('matches a checked box against the payload just the same', () => {
    const checked: MultipleChoicePromptData = {
      ...MULTI_SCREEN,
      options: [
        { number: 1, label: '[x] User input only', isDefault: true },
        { number: 2, label: '[ ] Response only' },
        { number: 3, label: '[ ] Type something' },
      ],
    };

    expect(applyAskUserQuestion(checked, MULTI_SPEC)!.options[0].label).toBe(
      '[x] User input only',
    );
  });
});

describe('recognising the picker’s own options (Issue #1726)', () => {
  it.each([
    'Type something.',
    'Type something',
    'Chat about this',
    '[ ] Type something',
    'Chat about this…',
  ])('recognises %s', (label) => {
    expect(isPickerMetaOption(label)).toBe(true);
  });

  it.each(['tasks (0 done, 1 in progress, 6 open)', 'Clear desk', 'Submit answers', ''])(
    'does not recognise %s',
    (label) => {
      expect(isPickerMetaOption(label)).toBe(false);
    },
  );
});

describe('checking an answer against the agent’s options (Issue #1726)', () => {
  const applied = applyAskUserQuestion(detect(CANARY_ASKUSERQUESTION_TASK_PANEL), TASK_SPEC)!;

  it('accepts a number the picker offers', () => {
    expect(resolveAskUserQuestionAnswer(applied, '2')).toEqual({ ok: true, input: '2' });
    expect(resolveAskUserQuestionAnswer(applied, ' 5 ')).toEqual({ ok: true, input: '5' });
  });

  it('refuses a number outside the list', () => {
    for (const answer of ['0', '6', '99']) {
      expect(resolveAskUserQuestionAnswer(applied, answer), answer).toMatchObject({
        ok: false,
        reason: 'answer_out_of_range',
      });
    }
  });

  it('resolves a label to its number', () => {
    expect(resolveAskUserQuestionAnswer(applied, 'Sort papers')).toEqual({
      ok: true,
      input: '2',
      resolved: { via: 'semantic', optionNumber: 2, optionLabel: 'Sort papers' },
    });
  });

  it('resolves a label case-insensitively and by prefix', () => {
    expect(resolveAskUserQuestionAnswer(applied, 'wrangle')).toMatchObject({
      ok: true,
      input: '3',
    });
    expect(resolveAskUserQuestionAnswer(applied, 'CLEAR DESK')).toMatchObject({
      ok: true,
      input: '1',
    });
  });

  it('refuses an ambiguous prefix instead of guessing', () => {
    const ambiguous = applyAskUserQuestion(
      {
        type: 'multiple_choice',
        question: 'Pick a colour, any colour',
        status: 'pending',
        options: [
          { number: 1, label: 'Blue steel', isDefault: true },
          { number: 2, label: 'Blue lagoon' },
        ],
      },
      spec({
        questions: [
          {
            question: 'Pick a colour, any colour',
            options: [{ label: 'Blue steel' }, { label: 'Blue lagoon' }],
          },
        ],
      }),
    )!;

    expect(resolveAskUserQuestionAnswer(ambiguous, 'Blue')).toMatchObject({
      ok: false,
      reason: 'unresolvable_answer',
    });
  });

  it('refuses yes/no — the Issue #1681 accident, stopped before it is sent', () => {
    // On a cursor-navigated picker typed text is not a selection; the Enter
    // after it takes whatever is highlighted, so `respond <id> no` has been able
    // to arrive as an approval.
    for (const answer of ['yes', 'no', 'y', 'n', 'YES']) {
      expect(resolveAskUserQuestionAnswer(applied, answer), answer).toMatchObject({
        ok: false,
        reason: 'unresolvable_answer',
      });
    }
  });

  it('never quotes the answer back in the message (SEC-003)', () => {
    const rejected = resolveAskUserQuestionAnswer(applied, '<script>alert(1)</script>');

    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.message).not.toContain('script');
  });

  it('lets free text through when an option asks for it', () => {
    const withTextInput: MultipleChoicePromptData = {
      ...applied,
      options: applied.options.map((o) =>
        o.number === 4 ? { ...o, label: 'Tell Claude what to do differently', requiresTextInput: true } : o,
      ),
    };

    expect(resolveAskUserQuestionAnswer(withTextInput, 'do it the other way')).toEqual({
      ok: true,
      input: 'do it the other way',
    });
  });

  it('still refuses yes/no when an option asks for free text', () => {
    const withTextInput: MultipleChoicePromptData = {
      ...applied,
      options: applied.options.map((o) =>
        o.number === 4 ? { ...o, requiresTextInput: true } : o,
      ),
    };

    expect(resolveAskUserQuestionAnswer(withTextInput, 'no')).toMatchObject({
      ok: false,
      reason: 'unresolvable_answer',
    });
  });
});
