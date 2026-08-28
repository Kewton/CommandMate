/**
 * Turning an operator's answer into a reply to a `question.asked` (Issue #2039).
 *
 * opencode publishes the question, its header and every choice as data, and
 * takes the answer back as `{"answers":[["Blue"]]}` on
 * `POST /question/:id/reply` (#1758 §5.2.4 — measured, `curl`, HTTP 200). What
 * CommandMate had was the receiving half only: `recordAskUserQuestion` for the
 * display, `replyOpencodeQuestion` written and never called, and nothing in
 * `src/` that built the `{ kind: 'answer' }` verdict between them. The three
 * approval verdicts could not stand in — `decideOpencode` refuses them with
 * `question-needs-answer-verdict` — so a question was answerable with arrow
 * keys and nothing else.
 *
 * Two properties are pinned here, and the second is the one this Issue's
 * acceptance criteria name:
 *
 *  - **the numbers are the QUESTION's**, resolved against the choices the agent
 *    published, so `3` at a two-option question is out of range rather than
 *    anything at all;
 *  - **the two vocabularies never meet.** `resolveStructuredDecisionOption`
 *    reads `1/2/3` as `Allow once / Allow always / Reject` and this reads them
 *    as choices; neither falls back to the other, and a word that means a
 *    verdict (`reject`, `yes`) is prose here.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_QUESTION_FREE_TEXT_LENGTH,
  questionAnswerVerdict,
  questionDecisionOptions,
  resolveStructuredDecisionOption,
  resolveStructuredQuestionAnswer,
} from '@/lib/hooks/structured-decision-response';
import type { AskUserQuestionSpec } from '@/lib/hooks/ask-user-question-payload';

/** The captured frame's question, parsed: two choices, single-select. */
function colourQuestion(multiSelect = false): AskUserQuestionSpec {
  return {
    promptId: 'que_0000000000000000000000000',
    questions: [
      {
        question: 'Which colour do you prefer?',
        header: 'Colour preference',
        multiSelect,
        choices: [
          { label: 'Red', description: 'The colour red' },
          { label: 'Blue', description: 'The colour blue' },
        ],
      },
    ],
  };
}

function twoQuestions(): AskUserQuestionSpec {
  const first = colourQuestion().questions[0];
  return {
    promptId: 'que_0000000000000000000000000',
    questions: [
      first,
      {
        question: 'Which editor?',
        header: 'Editor',
        multiSelect: false,
        choices: [{ label: 'VS Code', description: null }],
      },
    ],
  };
}

describe('the choices, numbered', () => {
  it('numbers the first question 1-based in payload order', () => {
    expect(questionDecisionOptions(colourQuestion())).toEqual([
      { number: 1, label: 'Red', reply: 'Red' },
      { number: 2, label: 'Blue', reply: 'Blue' },
    ]);
  });

  it('makes `reply` the label itself, because that is the wire value', () => {
    // Not a second spelling: `{"answers":[["Blue"]]}` carries labels, so a
    // `reply` that differed from the label would be an answer the agent never
    // offered. This is what lets Issue #2040 read a question and an approval
    // through one `{ number, label, reply }` shape.
    for (const option of questionDecisionOptions(colourQuestion())) {
      expect(option.reply).toBe(option.label);
    }
  });

  it('answers an empty list for a spec carrying no questions', () => {
    expect(questionDecisionOptions({ questions: [], promptId: null })).toEqual([]);
  });
});

describe('resolving an answer', () => {
  it('maps an option number onto that choice`s label', () => {
    const outcome = resolveStructuredQuestionAnswer(colourQuestion(), '2');
    expect(outcome).toMatchObject({
      ok: true,
      resolved: { answers: [['Blue']], freeText: false },
    });
  });

  it('maps an option label, case-insensitively', () => {
    const outcome = resolveStructuredQuestionAnswer(colourQuestion(), 'blue');
    expect(outcome).toMatchObject({ ok: true, resolved: { answers: [['Blue']], freeText: false } });
  });

  it('refuses a number no choice carries rather than treating it as prose', () => {
    // The failure this ordering exists for: `3` at a two-option question is an
    // operator who miscounted, and sending "3" as a free-text answer would put
    // a number the agent never offered in front of it.
    const outcome = resolveStructuredQuestionAnswer(colourQuestion(), '3');
    expect(outcome).toMatchObject({ ok: false, reason: 'answer_out_of_range' });
    if (!outcome.ok) expect(outcome.message).toContain('1 = Red, 2 = Blue');
  });

  it('takes several numbers when the agent said multiSelect', () => {
    const outcome = resolveStructuredQuestionAnswer(colourQuestion(true), '1,2');
    expect(outcome).toMatchObject({ ok: true, resolved: { answers: [['Red', 'Blue']] } });
  });

  it('accepts whitespace as a separator too', () => {
    const outcome = resolveStructuredQuestionAnswer(colourQuestion(true), '1 2');
    expect(outcome).toMatchObject({ ok: true, resolved: { answers: [['Red', 'Blue']] } });
  });

  it('collapses a repeated number instead of counting it twice', () => {
    // Otherwise `1,1` looks like two selections and is refused on a
    // single-select question that the operator answered perfectly well.
    const outcome = resolveStructuredQuestionAnswer(colourQuestion(), '1,1');
    expect(outcome).toMatchObject({ ok: true, resolved: { answers: [['Red']] } });
  });

  it('refuses several numbers when the question is single-select', () => {
    const outcome = resolveStructuredQuestionAnswer(colourQuestion(), '1,2');
    expect(outcome).toMatchObject({ ok: false, reason: 'multi_select_not_offered' });
  });

  it('sends anything else as free text', () => {
    const outcome = resolveStructuredQuestionAnswer(colourQuestion(), 'something else entirely');
    expect(outcome).toMatchObject({
      ok: true,
      resolved: { answers: [['something else entirely']], selected: [], freeText: true },
    });
  });

  it('refuses an over-long free-text answer rather than cutting it short', () => {
    const outcome = resolveStructuredQuestionAnswer(
      colourQuestion(),
      'x'.repeat(MAX_QUESTION_FREE_TEXT_LENGTH + 1),
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'unresolvable_answer' });
  });

  it('refuses an empty answer', () => {
    expect(resolveStructuredQuestionAnswer(colourQuestion(), '   ')).toMatchObject({
      ok: false,
      reason: 'unresolvable_answer',
    });
  });

  it('refuses a multi-question call outright', () => {
    // `answers` is one array PER QUESTION and a single answer string cannot say
    // what the others are; an empty array is not known to mean "skip". The
    // terminal keeps it, which is exactly the pre-#2039 state for this shape.
    const outcome = resolveStructuredQuestionAnswer(twoQuestions(), '1');
    expect(outcome).toMatchObject({ ok: false, reason: 'multi_question_unsupported' });
  });
});

describe('the two vocabularies do not meet', () => {
  it('reads `reject` as prose, not as the third verdict', () => {
    // `resolveStructuredDecisionOption('reject')` is `Reject`. Here the word
    // names no choice, so it is a free-text answer — and the important half is
    // that it is NOT silently delivered as a denial of the tool call.
    expect(resolveStructuredDecisionOption('reject')).toMatchObject({ number: 3 });

    const outcome = resolveStructuredQuestionAnswer(colourQuestion(), 'reject');
    expect(outcome).toMatchObject({ ok: true, resolved: { answers: [['reject']], freeText: true } });
  });

  it('reads `2` as the second CHOICE, not as `Allow always`', () => {
    expect(resolveStructuredDecisionOption('2')).toMatchObject({ label: 'Allow always' });
    expect(resolveStructuredQuestionAnswer(colourQuestion(), '2')).toMatchObject({
      ok: true,
      resolved: { answers: [['Blue']] },
    });
  });

  it('builds a verdict `toOpencodePermissionReply` has no wire value for', () => {
    // The fail-closed half. An `answer` verdict that reached an approval by
    // mistake POSTs nothing at all, which is why crossing the two costs a
    // refusal rather than an approval.
    const outcome = resolveStructuredQuestionAnswer(colourQuestion(), '2');
    if (!outcome.ok) throw new Error('expected the answer to resolve');
    expect(questionAnswerVerdict(outcome.resolved)).toEqual({
      kind: 'answer',
      answers: [['Blue']],
    });
  });
});
