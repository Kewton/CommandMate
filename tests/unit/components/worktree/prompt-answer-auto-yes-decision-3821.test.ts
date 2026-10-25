/**
 * The answer panels' Auto-Yes gate and the server's decision (Issue #3821).
 *
 * Under Auto-Yes the panel (PC `shouldShowPromptPanel`, phone
 * `showsPromptUnderAutoYes` in `WorktreeDetailRefactored`) stays hidden only
 * while the server says it is answering the prompt. `withheld`, `none` and no
 * decision at all (an older server) draw it; a question the agent asked over
 * its API is drawn whatever the decision says.
 */

import { describe, it, expect } from 'vitest';
import { isApiQuestionPrompt, showsPromptUnderAutoYes } from '@/components/worktree/prompt-answer';
import { shouldShowPromptPanel } from '@/components/worktree/terminal-split-pane-content/pane-gates';
import { isAutoYesAnswering, laterAutoYesDecision } from '@/types/auto-yes-decision';
import type { LivePromptData } from '@/types/models';
import { PROMPT_VIEW_ROWS } from '../../../fixtures/prompt-view-3184';

const SINGLE_CHOICE = {
  type: 'multiple_choice',
  question: 'Do you want to proceed?',
  status: 'pending',
  options: [
    { number: 1, label: 'Yes', isDefault: true },
    { number: 2, label: 'No', isDefault: false },
  ],
} as LivePromptData;

/** OpenCode's question over its API (#3184's shared fixture, the `agent-question` row). */
const API_QUESTION = PROMPT_VIEW_ROWS.find((row) => row.expected.heading === 'agent-question')!.data;

describe('[#3821] showsPromptUnderAutoYes and the decision', () => {
  it('answering: a readable single choice stays hidden', () => {
    expect(showsPromptUnderAutoYes(SINGLE_CHOICE, true, { state: 'answering' })).toBe(false);
  });

  it.each([
    ['withheld', { state: 'withheld' as const }],
    ['none', { state: 'none' as const }],
    ['no decision (an older server)', undefined],
    ['null', null],
  ])('%s: drawn', (_label, decision) => {
    expect(showsPromptUnderAutoYes(SINGLE_CHOICE, true, decision)).toBe(true);
  });

  it('the PC gate reads the same decision', () => {
    const base = { visible: true, isStarting: false, autoYesEnabled: true, data: SINGLE_CHOICE, answerable: true };
    expect(shouldShowPromptPanel({ ...base, autoYesDecision: { state: 'answering' } })).toBe(false);
    expect(shouldShowPromptPanel({ ...base, autoYesDecision: { state: 'withheld' } })).toBe(true);
    expect(shouldShowPromptPanel({ ...base, autoYesDecision: undefined })).toBe(true);
    // Auto-Yes off: drawn whatever the decision says, as before.
    expect(shouldShowPromptPanel({ ...base, autoYesEnabled: false, autoYesDecision: { state: 'answering' } })).toBe(true);
  });
});

describe('[#3821] a question over the agent’s API is drawn under Auto-Yes', () => {
  it('is read as one (non-vacuous)', () => {
    expect(isApiQuestionPrompt(API_QUESTION)).toBe(true);
    expect(isApiQuestionPrompt(SINGLE_CHOICE)).toBe(false);
  });

  it('drawn even when a decision says answering', () => {
    expect(showsPromptUnderAutoYes(API_QUESTION, undefined, { state: 'answering' })).toBe(true);
  });
});

describe('[#3821] the decision helpers', () => {
  it('isAutoYesAnswering: answering only', () => {
    expect(isAutoYesAnswering({ state: 'answering' })).toBe(true);
    expect(isAutoYesAnswering({ state: 'withheld' })).toBe(false);
    expect(isAutoYesAnswering({ state: 'none' })).toBe(false);
    expect(isAutoYesAnswering(undefined)).toBe(false);
  });

  it('laterAutoYesDecision: the later observation wins, an older one is not applied', () => {
    const older = { state: 'answering' as const, reason: null, observedAt: 1 };
    const newer = { state: 'withheld' as const, reason: 'mode-off', observedAt: 2 };
    expect(laterAutoYesDecision(older, newer)).toBe(newer);
    expect(laterAutoYesDecision(newer, older)).toBe(newer);
    expect(laterAutoYesDecision(undefined, older)).toBe(older);
    expect(laterAutoYesDecision(newer, undefined)).toBeUndefined();
  });

  it('laterAutoYesDecision: only for the same confirmation; another, or an unknown one, is not kept', () => {
    const newerA = { state: 'answering' as const, reason: null, observedAt: 5, confirmation: 'A' };
    const olderA = { state: 'none' as const, reason: null, observedAt: 3, confirmation: 'A' };
    const olderB = { state: 'none' as const, reason: null, observedAt: 3, confirmation: 'B' };
    const olderUnknown = { state: 'none' as const, reason: null, observedAt: 3 };
    expect(laterAutoYesDecision(newerA, olderA)).toBe(newerA);
    expect(laterAutoYesDecision(newerA, olderB)).toBe(olderB);
    expect(laterAutoYesDecision(newerA, olderUnknown)).toBe(olderUnknown);
    expect(laterAutoYesDecision({ ...newerA, confirmation: undefined }, olderA)).toBe(olderA);
  });
});
