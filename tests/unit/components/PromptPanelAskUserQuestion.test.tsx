/**
 * PromptPanel showing what the agent actually asked (Issue #1726).
 *
 * Backed by the real dictionaries, for the reason `PromptPanelUnclassified`
 * gives: the global next-intl mock echoes `namespace.key` back and drops
 * interpolation params, so an assertion about wording — or about a `{index}` /
 * `{total}` placeholder — passes there whether the key exists or not.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

import { PromptPanel } from '@/components/worktree/PromptPanel';
import { buildStructuredPromptData } from '@/lib/session/structured-prompt';
import type { MultipleChoicePromptData } from '@/types/models';

const PICKER: MultipleChoicePromptData = {
  type: 'multiple_choice',
  question: 'Which task would you like to start with?',
  status: 'pending',
  isAskUserQuestion: true,
  options: [
    {
      number: 1,
      label: 'Clear desk',
      isDefault: true,
      description: 'Start by clearing the desk surface.',
    },
    { number: 2, label: 'Sort papers', description: 'Start by sorting through the papers.' },
    { number: 3, label: 'Type something.' },
  ],
  askUserQuestion: {
    header: 'First task',
    multiSelect: false,
    questionIndex: 0,
    questionCount: 1,
    metaOptionNumbers: [3],
  },
};

function renderPanel(promptData: Parameters<typeof PromptPanel>[0]['promptData']) {
  return render(
    <PromptPanel
      promptData={promptData}
      messageId="prompt-1"
      visible
      answering={false}
      onRespond={vi.fn()}
    />,
  );
}

describe('PromptPanel with the agent’s own options (Issue #1726)', () => {
  it('shows each option’s description, which the pane never gave us', () => {
    // The picker renders the description on its own indented line and the
    // scraper drops it as a continuation, so before this Issue the panel showed
    // bare labels with no explanation of what they meant.
    locale.current = 'en';
    renderPanel(PICKER);

    expect(screen.getByText('Start by clearing the desk surface.')).toBeInTheDocument();
    expect(screen.getByText('Start by sorting through the papers.')).toBeInTheDocument();
  });

  it('still renders the options as choosable radio items', () => {
    locale.current = 'en';
    renderPanel(PICKER);

    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByText('1. Clear desk')).toBeInTheDocument();
  });

  it('says which question of the call this is when there is more than one', () => {
    locale.current = 'en';
    renderPanel({
      ...PICKER,
      askUserQuestion: { ...PICKER.askUserQuestion!, questionIndex: 1, questionCount: 3 },
    });

    expect(screen.getByTestId('ask-user-question-progress')).toHaveTextContent(
      'Question 2 of 3 asked by the agent',
    );
  });

  it('says it in the reader’s locale', () => {
    locale.current = 'ja';
    renderPanel({
      ...PICKER,
      askUserQuestion: { ...PICKER.askUserQuestion!, questionIndex: 1, questionCount: 3 },
    });

    expect(screen.getByTestId('ask-user-question-progress')).toHaveTextContent('2/3');
  });

  it('says nothing at all for a prompt read off the screen alone', () => {
    // The unconfigured machine: no `askUserQuestion`, no extra line.
    locale.current = 'en';
    const { askUserQuestion: _ignored, ...screenOnly } = PICKER;
    renderPanel({ ...screenOnly, options: PICKER.options.map(({ description: _d, ...o }) => o) });

    expect(screen.queryByTestId('ask-user-question-progress')).not.toBeInTheDocument();
    expect(screen.queryByText('Start by clearing the desk surface.')).not.toBeInTheDocument();
  });
});

describe('PromptPanel when only the agent can see the dialog (Issue #1726)', () => {
  const degraded = buildStructuredPromptData('wt-1', {
    source: 'permission-request',
    message: null,
    toolName: 'AskUserQuestion',
    askUserQuestion: {
      question: 'Which task would you like to start with?',
      labels: ['Clear desk', 'Sort papers', 'Wrangle cables'],
      questionCount: 1,
    },
  });

  it('names the question and lists what was offered', () => {
    locale.current = 'en';
    renderPanel(degraded);

    expect(screen.getByTestId('unclassified-ask-user-question')).toBeInTheDocument();
    expect(screen.getByText('Which task would you like to start with?')).toBeInTheDocument();
    expect(screen.getByText('Clear desk')).toBeInTheDocument();
  });

  it('offers nothing to click and shows no numbers', () => {
    // One tool call walks through a screen per question and then a `1. Submit
    // answers` confirmation, with no event at any transition. A layer that
    // cannot see the pane cannot know which screen a number would land on.
    locale.current = 'en';
    renderPanel(degraded);

    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByText('1. Clear desk')).not.toBeInTheDocument();
  });

  it('lists nothing when no question is in flight', () => {
    locale.current = 'en';
    renderPanel(
      buildStructuredPromptData('wt-1', {
        source: 'notification',
        message: 'Claude needs your permission to use Bash',
        toolName: 'Bash',
      }),
    );

    expect(screen.queryByTestId('unclassified-ask-user-question')).not.toBeInTheDocument();
  });
});
