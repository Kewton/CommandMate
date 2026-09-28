/**
 * OpenCode V2's approvals and questions on the PC panel and the phone sheet
 * (Issue #2945 D1/D2).
 *
 *  - the approval card shows the diff the agent sent (`permission.asked`'s
 *    `metadata.files[].patch`, carried as the record's multi-line message);
 *  - the verdicts read in v2's words (`Always allow`), and still send the
 *    number `2`;
 *  - the phone sheet draws the same verdict buttons and question choices the
 *    PC panel draws, instead of a sheet with no buttons.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => 'en');
});

import { MobilePromptSheet } from '@/components/mobile/MobilePromptSheet';
import { PromptPanel } from '@/components/worktree/PromptPanel';
import {
  readPromptDecisionId,
  withToolDecisionLabels,
} from '@/components/worktree/prompt-decision-id';
import {
  buildStructuredPromptData,
  STRUCTURED_DECISION_OPTIONS,
  type StructuredPromptFacts,
} from '@/lib/session/structured-prompt';

const PERMISSION_ID = 'per_2945probePermission0000000';
const FORM_ID = 'frm_2945probeForm00000000000000';
const DIFF = 'edit hello.txt\n@@ -0,0 +1,1 @@\n+hi';

function build(facts: Partial<StructuredPromptFacts>) {
  return buildStructuredPromptData('wt-2945', {
    source: 'notification',
    message: null,
    ...facts,
  } as StructuredPromptFacts);
}

const approval = () =>
  build({
    message: DIFF,
    toolName: 'edit',
    decisionOptions: STRUCTURED_DECISION_OPTIONS,
    decisionId: PERMISSION_ID,
    patterns: ['*'],
  });

const question = () =>
  build({
    message: 'Favourite colour?',
    askUserQuestion: { question: 'Favourite colour?', labels: ['Blue', 'Red'], questionCount: 1 },
    decisionOptions: null,
    decisionId: FORM_ID,
  });

describe('withToolDecisionLabels', () => {
  it("relabels OpenCode V2's `always` verdict and keeps every number and reply", () => {
    const relabelled = withToolDecisionLabels(approval(), 'opencode-v2') as {
      decisionOptions: typeof STRUCTURED_DECISION_OPTIONS;
    };
    expect(relabelled.decisionOptions).toEqual([
      { number: 1, label: 'Allow once', reply: 'once' },
      { number: 2, label: 'Always allow', reply: 'always' },
      { number: 3, label: 'Reject', reply: 'reject' },
    ]);
  });

  it('leaves v1 and a payload without verdicts untouched (same object)', () => {
    const v1 = approval();
    expect(withToolDecisionLabels(v1, 'opencode')).toBe(v1);
    const q = question();
    expect(withToolDecisionLabels(q, 'opencode-v2')).toBe(q);
    expect(withToolDecisionLabels(null, 'opencode-v2')).toBeNull();
  });
});

describe('PC panel', () => {
  it('shows the diff as lines and the v2 verdicts; `Always allow` sends 2', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const data = withToolDecisionLabels(approval(), 'opencode-v2');
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
    expect(screen.getByTestId('structured-decision-message').textContent).toBe(DIFF);
    const always = screen.getByTestId('structured-decision-option-2');
    expect(always.textContent).toBe('2. Always allow');
    fireEvent.click(always);
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith('2', PERMISSION_ID));
  });
});

describe('phone sheet', () => {
  it('draws the approval with its diff and the verdict buttons', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(
      <MobilePromptSheet
        promptData={withToolDecisionLabels(approval(), 'opencode-v2')}
        visible
        answering={false}
        onRespond={onRespond}
      />,
    );
    expect(screen.getByTestId('mobile-structured-decision-message').textContent).toBe(DIFF);
    expect(
      ['1', '2', '3'].map((n) => screen.getByTestId(`mobile-structured-decision-option-${n}`).textContent),
    ).toEqual(['1. Allow once', '2. Always allow', '3. Reject']);
    fireEvent.click(screen.getByTestId('mobile-structured-decision-option-1'));
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith('1'));
  });

  it('draws a question as choices and a submit that sends the number', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(
      <MobilePromptSheet promptData={question()} visible answering={false} onRespond={onRespond} />,
    );
    expect(screen.queryByTestId('mobile-structured-decision-actions')).toBeNull();
    const submit = screen.getByTestId('mobile-structured-question-submit');
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByText('2. Red'));
    fireEvent.click(submit);
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith('2'));
  });

  it('draws no controls for a dialog that names no decision', () => {
    render(
      <MobilePromptSheet
        promptData={build({ message: 'something', decisionOptions: STRUCTURED_DECISION_OPTIONS })}
        visible
        answering={false}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('mobile-structured-decision-actions')).toBeNull();
    expect(screen.queryByTestId('mobile-structured-question')).toBeNull();
  });
});
