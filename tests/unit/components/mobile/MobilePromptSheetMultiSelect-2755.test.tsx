/**
 * `MobilePromptSheet` answering a CHECKBOX question (Issue #2755 §4).
 *
 * The phone half of `PromptPanelMultiSelect-2755`. The two surfaces have never
 * shared a row renderer — the radio lists are two copies as well — and the
 * Issue's 逸脱時の扱い asks for that duplication to be reported rather than
 * refactored away, so the same behaviour is asserted twice rather than once.
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

import { MobilePromptSheet } from '@/components/mobile/MobilePromptSheet';
import type { MultipleChoicePromptData } from '@/types/models';

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

const SINGLE: MultipleChoicePromptData = {
  type: 'multiple_choice',
  question: 'Which branch should the worker start from?',
  status: 'pending',
  options: [
    { number: 1, label: 'develop', isDefault: true },
    { number: 2, label: 'main', isDefault: false },
  ],
};

function renderSheet(
  promptData: MultipleChoicePromptData,
  onRespond = vi.fn().mockResolvedValue(undefined),
) {
  const view = render(
    <MobilePromptSheet promptData={promptData} visible answering={false} onRespond={onRespond} />,
  );
  return { ...view, onRespond };
}

describe('[#2755] the phone sheet draws the same checkbox answer', () => {
  it('draws checkboxes opened on the pane’s own ticks', () => {
    locale.current = 'en';
    renderSheet(CHECKBOX);

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(4);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(boxes[1]).toBeChecked();
  });

  it('sends the ascending, comma-separated SET', () => {
    locale.current = 'en';
    const { onRespond } = renderSheet(CHECKBOX);

    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    fireEvent.click(screen.getAllByRole('checkbox')[2]);
    fireEvent.click(screen.getByTestId('multi-select-submit'));

    expect(onRespond).toHaveBeenCalledWith('1,3');
  });

  it('will not submit with nothing ticked', () => {
    locale.current = 'en';
    const { onRespond } = renderSheet(CHECKBOX);

    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(screen.getByTestId('multi-select-submit')).toBeDisabled();
    fireEvent.click(screen.getByTestId('multi-select-submit'));
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('sends the text alone when the free-text row is ticked', () => {
    locale.current = 'en';
    const { onRespond } = renderSheet(CHECKBOX);

    fireEvent.click(screen.getAllByRole('checkbox')[3]);
    expect(screen.getByTestId('multi-select-submit')).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Enter a value...'), {
      target: { value: 'docs/api.md' },
    });
    fireEvent.click(screen.getByTestId('multi-select-submit'));

    expect(onRespond).toHaveBeenCalledWith('docs/api.md');
  });

  it('is translated', () => {
    locale.current = 'ja';
    renderSheet(CHECKBOX);
    expect(screen.getByTestId('multi-select-hint').textContent).toContain('複数選べます');
  });
});

describe('[#2755] a second question in the same sheet', () => {
  it('does not carry the first question’s ticks into the second', () => {
    locale.current = 'en';
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderSheet(CHECKBOX, onRespond);

    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.getAllByRole('checkbox')[0]).toBeChecked();

    rerender(
      <MobilePromptSheet
        promptData={{
          ...CHECKBOX,
          question: 'Which caches should I clear?',
          options: [
            { number: 1, label: 'node_modules', isDefault: true, checked: false },
            { number: 2, label: 'dist', isDefault: false, checked: false },
          ],
        }}
        visible
        answering={false}
        onRespond={onRespond}
      />,
    );

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => !(box as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByTestId('multi-select-submit')).toBeDisabled();
  });

  it('keeps an in-progress selection across a poll of the same question', () => {
    locale.current = 'en';
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderSheet(CHECKBOX, onRespond);

    fireEvent.click(screen.getAllByRole('checkbox')[2]);
    rerender(
      <MobilePromptSheet
        promptData={{
          ...CHECKBOX,
          options: CHECKBOX.options.map((option) => ({ ...option, isDefault: option.number === 3 })),
        }}
        visible
        answering={false}
        onRespond={onRespond}
      />,
    );

    expect(screen.getAllByRole('checkbox')[2]).toBeChecked();
  });
});

describe('[#2755] the single-select sheet did not move', () => {
  it('still draws a radio group with the cursor row preselected', () => {
    locale.current = 'en';
    const { onRespond } = renderSheet(SINGLE);

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(radios[0]).toBeChecked();

    fireEvent.click(radios[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onRespond).toHaveBeenCalledWith('2');
  });
});
