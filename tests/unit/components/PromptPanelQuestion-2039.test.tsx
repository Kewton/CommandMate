/**
 * The panel drawing a question's choices as a picker (Issue #2039).
 *
 * #1726 put the agent's own account of an `AskUserQuestion` on the degraded
 * panel and listed the labels WITHOUT numbers, on purpose: Claude's picker
 * renumbers and appends its own entries, nothing here can see which screen is
 * up, and a number published against the wrong screen answers the wrong
 * question. That is still the right rendering for Claude.
 *
 * opencode is the case it was not written for. The choices arrive as data, the
 * question has an id, and the answer goes to `POST /question/:id/reply` by
 * label — there is no screen to be renumbered out from under the numbers. So
 * when (and only when) the payload names the question by id, the list becomes a
 * picker.
 *
 * ## What this file is really guarding
 *
 * The gate, from both sides. `readPromptQuestionChoices` is the one place that
 * decides whether the panel may answer, and the failures it prevents are
 * silent: a picker with no id posts down the keystroke path, where a bare "1"
 * takes whatever the picker happens to be highlighting (#1681); a picker drawn
 * beside the three approval verdicts offers two answers to one id, and the
 * wrong one is refused at the source (`question-needs-answer-verdict`). Both
 * negatives are asserted here, and so is the Claude payload staying byte-for-
 * byte what it was.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

import { PromptPanel } from '@/components/worktree/PromptPanel';
import {
  buildStructuredPromptData,
  STRUCTURED_DECISION_OPTIONS,
  type StructuredPromptFacts,
} from '@/lib/session/structured-prompt';
import { readPromptDecisionId } from '@/components/worktree/prompt-decision-id';

const QUESTION_ID = 'que_0000000000000000000000000';
const PERMISSION_ID = 'per_0000000000000000000000000';

/** The `question.asked` summary, as `summarizeAskUserQuestion` publishes it. */
const COLOUR_QUESTION = {
  question: 'Which colour do you prefer?',
  labels: ['Red', 'Blue'],
  questionCount: 1,
};

function build(facts: Partial<StructuredPromptFacts>) {
  return buildStructuredPromptData('wt-2039', {
    source: 'notification',
    message: null,
    ...facts,
  } as StructuredPromptFacts);
}

function renderPanel(
  promptData: ReturnType<typeof buildStructuredPromptData>,
  onRespond = vi.fn().mockResolvedValue(undefined),
) {
  render(
    <PromptPanel
      promptData={promptData}
      messageId={null}
      // Exactly what `TerminalSplitPaneContent` does with the payload, so this
      // covers the wiring rather than just the component's props.
      decisionId={readPromptDecisionId(promptData)}
      visible
      answering={false}
      onRespond={onRespond}
    />,
  );
  return onRespond;
}

describe('an addressable question becomes a picker', () => {
  const addressable = () =>
    build({ askUserQuestion: COLOUR_QUESTION, decisionId: QUESTION_ID });

  it('renders every choice, numbered', () => {
    renderPanel(addressable());

    const picker = screen.getByTestId('structured-question-actions');
    expect(picker).toHaveTextContent('1. Red');
    expect(picker).toHaveTextContent('2. Blue');
    // The read-only list #1726 drew is gone: there is one affordance, not a
    // picker sitting under a bullet list of the same labels.
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('sends the option NUMBER with the decision id, and only after a choice', async () => {
    const onRespond = renderPanel(addressable());

    const submit = screen.getByTestId('structured-question-submit');
    // Nothing is preselected: the agent published no default, and a picker that
    // arrived with one would let a stray Enter answer for the operator.
    expect(submit).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /2\. Blue/ }));
    });
    await act(async () => {
      fireEvent.click(submit);
    });
    await waitFor(() => expect(onRespond).toHaveBeenCalled());

    // The NUMBER, not the label: `resolveStructuredQuestionAnswer` reads a
    // digit-shaped answer as a position, so a label that happened to be a digit
    // would resolve to a choice the operator did not click.
    expect(onRespond).toHaveBeenCalledWith('2', QUESTION_ID);
  });

  it('does not offer the three approval verdicts', async () => {
    renderPanel(addressable());

    // The acceptance criterion, on the surface a user touches: an approval
    // verdict cannot answer a question (`question-needs-answer-verdict`), so a
    // panel that drew both would be offering an answer that is refused.
    expect(screen.queryByTestId('structured-decision-actions')).toBeNull();
    for (const option of STRUCTURED_DECISION_OPTIONS) {
      expect(screen.queryByText(new RegExp(option.label))).toBeNull();
    }
  });

  it('drops the "answer it in the terminal" line, which the picker contradicts', () => {
    renderPanel(addressable());
    expect(screen.queryByText(/respond/i)).toBeNull();
  });
});

describe('the gate', () => {
  it('keeps the read-only list when the payload names no id (claude)', () => {
    // The pre-#2039 rendering, unchanged. Every hook source publishes
    // `decisionId: null` — `eventIdentity` is null for all five — so this is
    // what every tool but opencode still gets.
    renderPanel(build({ askUserQuestion: COLOUR_QUESTION }));

    expect(screen.queryByTestId('structured-question-actions')).toBeNull();
    expect(screen.getByTestId('unclassified-ask-user-question')).toHaveTextContent('Red');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('keeps the verdict buttons when the payload offers them for this id', () => {
    // A question summary can ride along on an approval payload — the episode
    // map and the dialog record are keyed separately. The payload's own
    // statement about the id wins: `decisionOptions` means the id names an
    // APPROVAL, so the picker must not be drawn for it.
    renderPanel(
      build({
        askUserQuestion: COLOUR_QUESTION,
        decisionId: PERMISSION_ID,
        decisionOptions: STRUCTURED_DECISION_OPTIONS,
      }),
    );

    expect(screen.getByTestId('structured-decision-actions')).toBeInTheDocument();
    expect(screen.queryByTestId('structured-question-actions')).toBeNull();
  });

  it('keeps the read-only list for a multi-question call', () => {
    // `answers` is one array per question and a single click cannot say what
    // the others are, so the server refuses this shape. A picker whose submit
    // is a guaranteed 400 is worse than the line telling the user where to go.
    renderPanel(
      build({
        askUserQuestion: { ...COLOUR_QUESTION, questionCount: 2 },
        decisionId: QUESTION_ID,
      }),
    );

    expect(screen.queryByTestId('structured-question-actions')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders nothing new for a payload with no question at all', () => {
    renderPanel(build({ message: 'Claude needs your permission to use Bash', toolName: 'Bash' }));

    expect(screen.queryByTestId('structured-question-actions')).toBeNull();
    expect(screen.queryByTestId('unclassified-ask-user-question')).toBeNull();
  });
});
