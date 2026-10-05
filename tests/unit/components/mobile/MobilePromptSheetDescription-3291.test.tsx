/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => 'en');
});

import { MobilePromptSheet } from '@/components/mobile/MobilePromptSheet';
import type { MultipleChoicePromptData } from '@/types/models';
import {
  buildStructuredPromptData,
  type StructuredPromptFacts,
} from '@/lib/session/structured-prompt';

function renderSheet(p: MultipleChoicePromptData) {
  return render(
    <MobilePromptSheet promptData={p} visible answering={false} onRespond={vi.fn().mockResolvedValue(undefined)} />,
  );
}

const base = { type: 'multiple_choice' as const, question: 'Q?', status: 'pending' as const };

describe('[#3291] phone sheet draws option descriptions and progress', () => {
  it('radio list shows description only for options that have one', () => {
    renderSheet({
      ...base,
      options: [
        { number: 1, label: 'A', isDefault: true, description: 'about A' },
        { number: 2, label: 'B', isDefault: false },
      ],
    });
    expect(screen.getByText('about A')).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByText('2. B').parentElement!.querySelectorAll('p')).toHaveLength(0);
  });

  it('checkbox list shows description only for options that have one', () => {
    renderSheet({
      ...base,
      isAskUserQuestion: true,
      multiSelect: true,
      submitMode: 'answer_only',
      options: [
        { number: 1, label: 'A', isDefault: true, checked: false, description: 'about A' },
        { number: 2, label: 'B', isDefault: false, checked: false },
      ],
    });
    expect(screen.getByText('about A')).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByText('2. B').parentElement!.querySelectorAll('p')).toHaveLength(0);
  });

  it('shows the question progress line for an AskUserQuestion payload', () => {
    renderSheet({
      ...base,
      askUserQuestion: { questionIndex: 1, questionCount: 3 },
      options: [{ number: 1, label: 'A', isDefault: true }],
    } as MultipleChoicePromptData);
    expect(screen.getByTestId('ask-user-question-progress').textContent).toContain('2 of 3');
  });

  it('shows no progress line without askUserQuestion', () => {
    renderSheet({ ...base, options: [{ number: 1, label: 'A', isDefault: true }] });
    expect(screen.queryByTestId('ask-user-question-progress')).toBeNull();
  });

  it('unclassified: lists the question and labels when no id names the question', () => {
    const data = buildStructuredPromptData('wt-3291', {
      source: 'notification',
      message: null,
      askUserQuestion: { question: 'Favourite colour?', labels: ['Blue', 'Red'], questionCount: 1 },
      decisionOptions: null,
      decisionId: null,
    } as StructuredPromptFacts);
    render(
      <MobilePromptSheet promptData={data} visible answering={false} onRespond={vi.fn().mockResolvedValue(undefined)} />,
    );
    const box = screen.getByTestId('unclassified-ask-user-question');
    expect(box.textContent).toContain('Favourite colour?');
    expect(screen.getByText('Blue')).toBeTruthy();
    expect(screen.getByText('Red')).toBeTruthy();
  });

  it('unclassified with a decision id: the question text appears exactly once', () => {
    const data = buildStructuredPromptData('wt-3291', {
      source: 'notification',
      message: 'Favourite colour?',
      askUserQuestion: { question: 'Favourite colour?', labels: ['Blue', 'Red'], questionCount: 1 },
      decisionOptions: null,
      decisionId: 'frm_3291probeForm0000000000000000',
    } as StructuredPromptFacts);
    render(
      <MobilePromptSheet promptData={data} visible answering={false} onRespond={vi.fn().mockResolvedValue(undefined)} />,
    );
    expect(screen.getByTestId('mobile-structured-question')).toBeTruthy();
    expect(screen.queryByTestId('unclassified-ask-user-question')).toBeNull();
    expect(screen.getAllByText('Favourite colour?').filter((el) => el.tagName === 'P')).toHaveLength(1);
  });
});
