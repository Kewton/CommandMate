/**
 * `PromptPanel` answering a CHECKBOX question (Issue #2755 §4).
 *
 * `RadioGroup` is structurally one-of-N, so the moment a payload says several
 * answers are allowed the control has to be a different one — which is also
 * what lets the radio list stay untouched for every other prompt, and this file
 * asserts both halves.
 *
 * Backed by the real dictionaries rather than the global next-intl mock, for
 * the reason `PromptPanelUnclassified` gives: the mock echoes `namespace.key`
 * back, so an assertion about wording passes whether the key exists or not.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

import { PromptPanel } from '@/components/worktree/PromptPanel';
import type { MultipleChoicePromptData } from '@/types/models';

/** #2754's `multiselect-two-checked`, as the reader publishes it. */
const CHECKBOX: MultipleChoicePromptData = {
  type: 'multiple_choice',
  question: 'Which files should I update?',
  status: 'pending',
  isAskUserQuestion: true,
  multiSelect: true,
  submitMode: 'answer_only',
  options: [
    { number: 1, label: 'calc.js', isDefault: true, checked: false },
    { number: 2, label: 'README.md', isDefault: false, checked: true },
    { number: 3, label: 'docs', isDefault: false, checked: false },
    { number: 4, label: 'Type something...', isDefault: false, checked: false, requiresTextInput: true },
  ],
};

/** The same screen as a single-select, for the "nothing else moved" half. */
const SINGLE: MultipleChoicePromptData = {
  type: 'multiple_choice',
  question: 'Which branch should the worker start from?',
  status: 'pending',
  isAskUserQuestion: true,
  options: [
    { number: 1, label: 'develop', isDefault: true },
    { number: 2, label: 'main', isDefault: false },
    { number: 3, label: 'Type something...', isDefault: false, requiresTextInput: true },
  ],
};

function renderPanel(
  promptData: MultipleChoicePromptData,
  onRespond = vi.fn().mockResolvedValue(undefined),
) {
  const view = render(
    <PromptPanel
      promptData={promptData}
      messageId="prompt-1"
      visible
      answering={false}
      onRespond={onRespond}
    />,
  );
  return { ...view, onRespond };
}

describe('[#2755] the checkbox control', () => {
  it('draws checkboxes, not radios, and opens on what the terminal shows', async () => {
    locale.current = 'en';
    renderPanel(CHECKBOX);

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(4);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);

    // The card opens on the pane's own state. Opening empty would offer a
    // "select nothing" the operator never asked for, and sending it would
    // untick the box they had already ticked in the terminal.
    expect(boxes[1]).toBeChecked();
    expect(boxes[0]).not.toBeChecked();
    expect(boxes[2]).not.toBeChecked();
  });

  it('sends the ascending, comma-separated SET', async () => {
    locale.current = 'en';
    const { onRespond } = renderPanel(CHECKBOX);

    // Tick 1 and 3 on top of the 2 that is already on, then take 2 off again:
    // the answer is the final set, not the sequence of clicks.
    fireEvent.click(screen.getAllByRole('checkbox')[2]);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    fireEvent.click(screen.getByTestId('multi-select-submit'));

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond.mock.calls[0][0]).toBe('1,3');
  });

  it('will not submit with nothing ticked', async () => {
    locale.current = 'en';
    const { onRespond } = renderPanel(CHECKBOX);

    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    const submit = screen.getByTestId('multi-select-submit');
    expect(submit).toBeDisabled();

    fireEvent.click(submit);
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('sends the text alone when the free-text row is ticked', async () => {
    // Typing into that row is what ticks it on the real screen, and the
    // characters would swallow any numbers sent with them — so the two cannot
    // be combined (#2755 §4).
    locale.current = 'en';
    const { onRespond } = renderPanel(CHECKBOX);

    fireEvent.click(screen.getAllByRole('checkbox')[3]);
    // Nothing typed yet: there is no answer to send.
    expect(screen.getByTestId('multi-select-submit')).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('Enter a value...'), { target: { value: 'docs/api.md' } });
    fireEvent.click(screen.getByTestId('multi-select-submit'));

    expect(onRespond.mock.calls[0][0]).toBe('docs/api.md');
  });

  it('says several answers are allowed', () => {
    locale.current = 'en';
    renderPanel(CHECKBOX);
    expect(screen.getByTestId('multi-select-hint')).toHaveTextContent(
      'Several answers are allowed',
    );
    // The `fieldset` and the inner `role="group"` both carry the name; what
    // matters is that the group is labelled at all.
    expect(screen.getAllByRole('group', { name: 'Select all that apply' }).length)
      .toBeGreaterThan(0);
  });

  it('is translated', () => {
    locale.current = 'ja';
    renderPanel(CHECKBOX);
    expect(screen.getByTestId('multi-select-hint').textContent).toContain('複数選べます');
    expect(screen.getByTestId('multi-select-hint').textContent).not.toContain('prompt.');
  });

  it('does not label the cursor row as a default', () => {
    // On this screen the `❯` marks the row a key would TOGGLE. Calling it the
    // default is the misreading that had `respond --default` untick somebody's
    // own choice on a real capture.
    locale.current = 'en';
    renderPanel(CHECKBOX);
    expect(screen.queryByText('Default')).not.toBeInTheDocument();
  });
});

describe('[#2755] a second question in the same card', () => {
  it('does not carry the first question’s ticks into the second', async () => {
    // One `AskUserQuestion` call walks several questions through the SAME
    // mounted card: answering question 1 repaints the pane and the poller
    // hands the new payload to a component that was never unmounted. Both
    // surfaces initialised their selection in a `useState` initialiser, which
    // runs once — so question 2 opened with question 1's ticks on it, and on a
    // checkbox screen those ticks are an answer.
    locale.current = 'en';
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderPanel(CHECKBOX, onRespond);

    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.getAllByRole('checkbox')[0]).toBeChecked();

    const second: MultipleChoicePromptData = {
      ...CHECKBOX,
      question: 'Which caches should I clear?',
      options: [
        { number: 1, label: 'node_modules', isDefault: true, checked: false },
        { number: 2, label: 'dist', isDefault: false, checked: false },
      ],
    };
    rerender(
      <PromptPanel
        promptData={second}
        messageId="prompt-1"
        visible
        answering={false}
        onRespond={onRespond}
      />,
    );

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).not.toBeChecked();
    expect(boxes[1]).not.toBeChecked();
    expect(screen.getByTestId('multi-select-submit')).toBeDisabled();
  });

  it('does not overwrite a selection being made when the SAME question polls again', async () => {
    // The other half. A poll re-delivers the same question every couple of
    // seconds with `checked` and `isDefault` as the pane has them, and throwing
    // the operator's in-progress ticks away on every one of those would make
    // the card unusable.
    locale.current = 'en';
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderPanel(CHECKBOX, onRespond);

    fireEvent.click(screen.getAllByRole('checkbox')[2]);

    // The same question, cursor moved and a box toggled at the pane.
    rerender(
      <PromptPanel
        promptData={{
          ...CHECKBOX,
          options: CHECKBOX.options.map((option) => ({
            ...option,
            isDefault: option.number === 2,
            checked: option.number === 1,
          })),
        }}
        messageId="prompt-1"
        visible
        answering={false}
        onRespond={onRespond}
      />,
    );

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[1]).toBeChecked();
    expect(boxes[2]).toBeChecked();
  });
});

describe('[#2755] the single-select panel did not move', () => {
  it('still draws a radio group with the cursor row preselected', async () => {
    locale.current = 'en';
    const { onRespond } = renderPanel(SINGLE);

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(radios[0]).toBeChecked();
    expect(screen.getByText('Default')).toBeInTheDocument();

    fireEvent.click(radios[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onRespond.mock.calls[0][0]).toBe('2');
  });

  it('still opens the text field for its free-text row and sends the text', async () => {
    locale.current = 'en';
    const { onRespond } = renderPanel(SINGLE);

    fireEvent.click(screen.getAllByRole('radio')[2]);
    fireEvent.change(screen.getByPlaceholderText('Enter a value...'), { target: { value: 'feature/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(onRespond.mock.calls[0][0]).toBe('feature/x');
  });
});
