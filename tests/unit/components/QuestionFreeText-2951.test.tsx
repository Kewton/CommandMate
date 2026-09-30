/**
 * A question that takes a typed answer, on the PC panel and the phone sheet
 * (Issue #2951).
 *
 * OpenCode V2's form field `custom: true` reaches the browser as
 * `askUserQuestion.custom`. Both surfaces then offer a text input beside the
 * choices; the typed text is what is sent (the route turns it into
 * `{answer: {<key>: <text>}}` — `tests/unit/api/respond-opencode-v2-2951.test.ts`).
 * Digits alone would be read as an option number, so they are not sent.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => 'en');
});

import { MobilePromptSheet } from '@/components/mobile/MobilePromptSheet';
import { PromptPanel } from '@/components/worktree/PromptPanel';
import { readPromptDecisionId } from '@/components/worktree/prompt-decision-id';
import {
  buildStructuredPromptData,
  type StructuredPromptFacts,
} from '@/lib/session/structured-prompt';

const FORM_ID = 'frm_2951probeForm00000000000000';

function question(custom: boolean) {
  return buildStructuredPromptData('wt-2951', {
    source: 'notification',
    message: 'Favourite colour?',
    askUserQuestion: {
      question: 'Favourite colour?',
      labels: ['Blue', 'Red'],
      questionCount: 1,
      ...(custom ? { custom: true as const } : {}),
    },
    decisionOptions: null,
    decisionId: FORM_ID,
  } as StructuredPromptFacts);
}

function renderPanel(custom: boolean) {
  const onRespond = vi.fn().mockResolvedValue(undefined);
  const data = question(custom);
  render(
    <PromptPanel
      promptData={data}
      messageId={null}
      decisionId={readPromptDecisionId(data)}
      visible
      answering={false}
      onRespond={onRespond}
    />,
  );
  return onRespond;
}

function renderSheet(custom: boolean) {
  const onRespond = vi.fn().mockResolvedValue(undefined);
  render(
    <MobilePromptSheet promptData={question(custom)} visible answering={false} onRespond={onRespond} />,
  );
  return onRespond;
}

describe('PC panel', () => {
  it('offers no input for a question that takes none', () => {
    renderPanel(false);
    expect(screen.queryByTestId('structured-question-free-text')).toBeNull();
  });

  it('sends the typed text with the decision id', async () => {
    const onRespond = renderPanel(true);
    const submit = screen.getByTestId('structured-question-submit');
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId('structured-question-free-text'), {
      target: { value: '  purple  ' },
    });
    expect(submit).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(submit);
    });
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith('purple', FORM_ID));
  });

  it('picking a choice clears the text, and the number is sent', async () => {
    const onRespond = renderPanel(true);
    fireEvent.change(screen.getByTestId('structured-question-free-text'), {
      target: { value: 'purple' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /2\. Red/ }));
    });
    expect(screen.getByTestId('structured-question-free-text')).toHaveValue('');
    await act(async () => {
      fireEvent.click(screen.getByTestId('structured-question-submit'));
    });
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith('2', FORM_ID));
  });

  it('refuses digits alone, and says why', () => {
    const onRespond = renderPanel(true);
    fireEvent.change(screen.getByTestId('structured-question-free-text'), {
      target: { value: '2' },
    });
    expect(screen.getByTestId('structured-question-free-text-numeric')).toBeInTheDocument();
    expect(screen.getByTestId('structured-question-submit')).toBeDisabled();
    expect(onRespond).not.toHaveBeenCalled();
  });
});

describe('phone sheet', () => {
  it('offers no input for a question that takes none', () => {
    renderSheet(false);
    expect(screen.queryByTestId('mobile-structured-question-free-text')).toBeNull();
  });

  it('sends the typed text', async () => {
    const onRespond = renderSheet(true);
    const submit = screen.getByTestId('mobile-structured-question-submit');
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId('mobile-structured-question-free-text'), {
      target: { value: 'purple' },
    });
    await act(async () => {
      fireEvent.click(submit);
    });
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith('purple'));
  });

  it('refuses digits alone', () => {
    renderSheet(true);
    fireEvent.change(screen.getByTestId('mobile-structured-question-free-text'), {
      target: { value: '1, 2' },
    });
    expect(screen.getByTestId('mobile-structured-question-free-text-numeric')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-structured-question-submit')).toBeDisabled();
  });
});
