/**
 * An unclassified dialog that still carries addressable choices must not say
 * its options could not be read (Issue #3181).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => 'en');
});

import { MobilePromptSheet } from '@/components/mobile/MobilePromptSheet';
import { PromptPanel } from '@/components/worktree/PromptPanel';
import { readDecisionId as readPromptDecisionId } from '@/lib/session/prompt-view';
import {
  buildStructuredPromptData,
  STRUCTURED_DECISION_OPTIONS,
  type StructuredPromptFacts,
} from '@/lib/session/structured-prompt';

const UNREADABLE = /could not read its options/;

function build(facts: Partial<StructuredPromptFacts>) {
  return buildStructuredPromptData('wt-3181', {
    source: 'notification',
    message: null,
    ...facts,
  } as StructuredPromptFacts);
}

const approval = () =>
  build({
    message: 'edit hello.txt',
    toolName: 'edit',
    decisionOptions: STRUCTURED_DECISION_OPTIONS,
    decisionId: 'per_3181probePermission0000000',
    patterns: ['*'],
  });

const noOptions = () => build({ message: 'something is open', decisionOptions: null });

function panel(data: ReturnType<typeof build>) {
  render(
    <PromptPanel
      promptData={data}
      messageId={null}
      decisionId={readPromptDecisionId(data)}
      visible
      answering={false}
      onRespond={vi.fn()}
    />,
  );
}

describe('PC panel heading', () => {
  it('names the tool for an approval with verdicts, not "could not read"', () => {
    panel(approval());
    expect(screen.queryByText(UNREADABLE)).toBeNull();
    expect(screen.getByText('Approval for edit')).toBeTruthy();
    expect(screen.getByTestId('structured-decision-option-1')).toBeTruthy();
  });

  it('keeps the old sentence when there are no options', () => {
    panel(noOptions());
    expect(screen.getByText(UNREADABLE)).toBeTruthy();
  });
});

describe('phone sheet heading', () => {
  it('names the tool for an approval with verdicts', () => {
    render(<MobilePromptSheet promptData={approval()} visible answering={false} onRespond={vi.fn()} />);
    expect(screen.queryByText(UNREADABLE)).toBeNull();
    expect(screen.getByText('Approval for edit')).toBeTruthy();
  });

  it('says the old sentence when there are no options', () => {
    render(<MobilePromptSheet promptData={noOptions()} visible answering={false} onRespond={vi.fn()} />);
    expect(screen.getByText(UNREADABLE)).toBeTruthy();
  });
});
