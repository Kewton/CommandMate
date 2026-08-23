/**
 * PromptPanel answering by decision id (Issue #1932).
 *
 * The panel is the only surface a browser has for a dialog the scraper could
 * not read, and until this Issue it could only tell the user to go and type
 * `commandmate respond` in a terminal. `decisionId` is what changes that: with
 * an id in hand the three verdicts the payload already publishes stop being a
 * list of words and become buttons, because each one addresses a specific
 * approval over the agent's own API.
 *
 * The load-bearing assertion is the negative one. `decisionOptions` alone must
 * NOT produce buttons: those numbers reach the keystroke path when there is no
 * id to send them with, and a bare `1` at a cursor-navigated picker selects
 * whatever line is highlighted (#1681). So the control is gated on the id, not
 * on the options, and the panel keeps its pre-#1932 text without one.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

import { PromptPanel } from '@/components/worktree/PromptPanel';
import {
  buildStructuredPromptData,
  STRUCTURED_DECISION_OPTIONS,
} from '@/lib/session/structured-prompt';
import type { YesNoPromptData } from '@/types/models';

const DECISION_ID = 'per_0000000000000000000000000';

/** The degraded form for a source that CAN be answered by id (opencode). */
const addressablePrompt = buildStructuredPromptData('wt-1', {
  source: 'notification',
  message: 'opencode needs your permission to run a command',
  toolName: 'bash',
  decisionOptions: STRUCTURED_DECISION_OPTIONS,
});

/** The degraded form for every hook source: no verdicts, nothing to address. */
const unaddressablePrompt = buildStructuredPromptData('wt-1', {
  source: 'notification',
  message: 'Claude needs your permission to use Bash',
  toolName: 'Bash',
});

const yesNoPrompt: YesNoPromptData = {
  type: 'yes_no',
  status: 'pending',
  question: 'Proceed?',
  options: ['yes', 'no'],
};

describe('the structured decision controls', () => {
  it('offers one button per published verdict when an id addresses them', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(
      <PromptPanel
        promptData={addressablePrompt}
        messageId={null}
        decisionId={DECISION_ID}
        visible
        answering={false}
        onRespond={onRespond}
      />,
    );

    const actions = screen.getByTestId('structured-decision-actions');
    for (const option of STRUCTURED_DECISION_OPTIONS) {
      expect(actions).toHaveTextContent(`${option.number}. ${option.label}`);
    }

    fireEvent.click(screen.getByTestId('structured-decision-option-2'));

    // The NUMBER, with the id it belongs to. The caller posts both, and the
    // route refuses the pair if the id is not pending on this instance.
    await waitFor(() => {
      expect(onRespond).toHaveBeenCalledWith('2', DECISION_ID);
    });
  });

  it('replaces the terminal instruction only when it can be answered here', () => {
    render(
      <PromptPanel
        promptData={addressablePrompt}
        messageId={null}
        decisionId={DECISION_ID}
        visible
        answering={false}
        onRespond={vi.fn()}
      />,
    );

    const notice = screen.getByTestId('unclassified-prompt-notice');
    expect(notice).not.toHaveTextContent('commandmate respond');
  });

  it('offers nothing to click when the payload names no approval', () => {
    // `decisionOptions` without a `decisionId` is the state this Issue must NOT
    // turn into buttons: the numbers would go down the keystroke path, where a
    // bare "1" is whatever the picker happens to be highlighting (#1681).
    render(
      <PromptPanel
        promptData={addressablePrompt}
        messageId={null}
        visible
        answering={false}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('structured-decision-actions')).not.toBeInTheDocument();
    expect(screen.getByTestId('unclassified-prompt-notice')).toHaveTextContent(
      'commandmate respond',
    );
  });

  it('offers nothing to click for a source that publishes no verdicts', () => {
    render(
      <PromptPanel
        promptData={unaddressablePrompt}
        messageId={null}
        decisionId={DECISION_ID}
        visible
        answering={false}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('structured-decision-actions')).not.toBeInTheDocument();
    expect(screen.getByTestId('unclassified-prompt-notice')).toHaveTextContent(
      'commandmate respond',
    );
  });

  it('does not fire while a previous answer is still in flight', () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(
      <PromptPanel
        promptData={addressablePrompt}
        messageId={null}
        decisionId={DECISION_ID}
        visible
        answering
        onRespond={onRespond}
      />,
    );

    const button = screen.getByTestId('structured-decision-option-1');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onRespond).not.toHaveBeenCalled();
  });
});

describe('the id travels with every answer the panel takes', () => {
  it('passes it alongside a yes/no answer', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(
      <PromptPanel
        promptData={yesNoPrompt}
        messageId={null}
        decisionId={DECISION_ID}
        visible
        answering={false}
        onRespond={onRespond}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /yes/i }));
    await waitFor(() => {
      expect(onRespond).toHaveBeenCalledWith('yes', DECISION_ID);
    });
  });

  it('passes undefined when there is no id, leaving the pane path alone', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(
      <PromptPanel
        promptData={yesNoPrompt}
        messageId="msg-1"
        visible
        answering={false}
        onRespond={onRespond}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /yes/i }));
    await waitFor(() => {
      expect(onRespond).toHaveBeenCalledWith('yes', undefined);
    });
  });
});
