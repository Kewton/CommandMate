/**
 * What the panel says an approval is FOR (Issue #2031).
 *
 * #1932 gave the degraded panel three buttons. It did not give it a subject:
 * `Allow once / Allow always / Reject` appeared over an agent's one-line
 * message and nothing else, and `Allow always` is the one verdict there whose
 * effect outlives the dialog — it saves a rule. Offering it without showing the
 * rule asks for a decision whose size the user cannot see.
 *
 * The payload had both facts and no surface read them: `toolName` (the
 * `message.part.updated` correlation, because `permission.asked` does not name
 * its own tool) and `patterns`.
 *
 * ## The negative half
 *
 * Every assertion about opencode here has a claude twin, because "other tools
 * are unaffected" is the acceptance criterion this Issue can most easily break.
 * The subject block hangs off the SAME gate as the buttons — an addressable
 * `decisionId` — so a payload that gets no buttons gets no new markup either,
 * and the claude panel renders exactly the text it rendered before.
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
import {
  buildStructuredPromptData,
  STRUCTURED_DECISION_OPTIONS,
} from '@/lib/session/structured-prompt';
import { readPromptDecisionId } from '@/components/worktree/prompt-decision-id';

const DECISION_ID = 'per_0000000000000000000000000';

/** What `buildCurrentOutput` publishes for an opencode approval after #2031. */
const opencodePrompt = buildStructuredPromptData('wt-2031', {
  source: 'notification',
  message: 'touch /tmp/cmate-marker.txt',
  toolName: 'bash',
  decisionId: DECISION_ID,
  decisionOptions: STRUCTURED_DECISION_OPTIONS,
  patterns: ['/tmp/*', 'bash(git status)'],
});

/** What it publishes for claude — the same builder, no addressable approval. */
const claudePrompt = buildStructuredPromptData('wt-2031', {
  source: 'notification',
  message: 'Claude needs your permission to use Bash',
  toolName: 'Bash',
});

function renderPanel(promptData: ReturnType<typeof buildStructuredPromptData>) {
  return render(
    <PromptPanel
      promptData={promptData}
      messageId={null}
      // Exactly what `TerminalSplitPaneContent` does with the payload, so this
      // covers the wiring and not just the component's props.
      decisionId={readPromptDecisionId(promptData)}
      visible
      answering={false}
      onRespond={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

describe('the addressable approval names its subject', () => {
  it('shows the tool the correlation identified', () => {
    renderPanel(opencodePrompt);
    expect(screen.getByTestId('structured-decision-tool')).toHaveTextContent('bash');
  });

  it('shows every rule `Allow always` would save, next to that verdict`s own label', () => {
    renderPanel(opencodePrompt);

    const patterns = screen.getByTestId('structured-decision-patterns');
    expect(patterns).toHaveTextContent('/tmp/*');
    expect(patterns).toHaveTextContent('bash(git status)');
    // Untranslated on purpose, and read off STRUCTURED_DECISION_OPTIONS rather
    // than written here: it is the same CLI answer vocabulary the button below
    // carries, so the list and the button it scopes cannot drift apart.
    expect(screen.getByTestId('structured-decision-patterns-label')).toHaveTextContent(
      STRUCTURED_DECISION_OPTIONS.find((option) => option.reply === 'always')!.label,
    );
  });

  it('still offers the three buttons, which is what the subject is describing', () => {
    renderPanel(opencodePrompt);
    // The end-to-end property #1932 could not reach: the payload alone now
    // carries enough to draw an answerable panel, with no prop plumbed by hand.
    expect(screen.getByTestId('structured-decision-actions')).toBeInTheDocument();
    expect(screen.getByTestId('structured-decision-option-3')).toBeEnabled();
  });

  it('draws no rule list when the approval named none', () => {
    renderPanel(
      buildStructuredPromptData('wt-2031', {
        source: 'notification',
        message: 'touch /tmp/marker.txt',
        toolName: 'bash',
        decisionId: DECISION_ID,
        decisionOptions: STRUCTURED_DECISION_OPTIONS,
      }),
    );

    expect(screen.getByTestId('structured-decision-tool')).toBeInTheDocument();
    expect(screen.queryByTestId('structured-decision-patterns')).not.toBeInTheDocument();
  });
});

describe('every other tool renders exactly what it rendered before', () => {
  it('adds nothing to the claude panel', () => {
    renderPanel(claudePrompt);

    // The pre-#2031 rendering, asserted as a whole: the agent's line, the
    // terminal instruction, and no new markup of any kind.
    const notice = screen.getByTestId('unclassified-prompt-notice');
    expect(notice).toHaveTextContent('Claude needs your permission to use Bash');
    expect(notice).toHaveTextContent('commandmate respond');
    expect(screen.queryByTestId('structured-decision-subject')).not.toBeInTheDocument();
    expect(screen.queryByTestId('structured-decision-tool')).not.toBeInTheDocument();
    expect(screen.queryByTestId('structured-decision-patterns')).not.toBeInTheDocument();
    expect(screen.queryByTestId('structured-decision-actions')).not.toBeInTheDocument();
  });

  it('keeps the subject out of a payload that has verdicts but no id', () => {
    // The shape `current-output-builder` no longer publishes, rendered anyway:
    // the panel is the last line of defence, and it must not become a place
    // where "we know the tool" is mistaken for "we can answer it".
    render(
      <PromptPanel
        promptData={opencodePrompt}
        messageId={null}
        visible
        answering={false}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('structured-decision-subject')).not.toBeInTheDocument();
    expect(screen.queryByTestId('structured-decision-actions')).not.toBeInTheDocument();
    expect(screen.getByTestId('unclassified-prompt-notice')).toHaveTextContent(
      'commandmate respond',
    );
  });
});
