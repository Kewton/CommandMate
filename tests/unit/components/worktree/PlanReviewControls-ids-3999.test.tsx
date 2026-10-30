/**
 * Issue #3999: the comment box's id is unique per instance.
 *
 * The controls now also show in terminal footers, so a 2x2 split can put two
 * Command Code instances of the same worktree side by side. With an id keyed
 * by the worktree alone, the second label's `htmlFor` pointed at the first
 * box, and in compact (label `sr-only`) the second box lost its name.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlanReviewControls } from '@/components/worktree/PlanReviewControls';

const WORKTREE_ID = 'wt-3999';

describe('[#3999] PlanReviewControls: comment box ids per instance', () => {
  it.each([false, true])('two instances of one worktree get distinct ids (compact=%s)', (compact) => {
    render(
      <>
        <PlanReviewControls worktreeId={WORKTREE_ID} cliToolId="command-code" instanceId="command-code" compact={compact} />
        <PlanReviewControls worktreeId={WORKTREE_ID} cliToolId="command-code" instanceId="command-code-2" compact={compact} />
      </>,
    );
    const inputs = screen.getAllByTestId('plan-review-comment-input');
    expect(inputs).toHaveLength(2);
    const [first, second] = inputs;
    expect(first.id).not.toBe('');
    expect(first.id).not.toBe(second.id);
    // Each label names its own box, not the other pane's.
    for (const input of inputs) {
      const labels = document.querySelectorAll(`label[for="${CSS.escape(input.id)}"]`);
      expect(labels).toHaveLength(1);
      expect(labels[0].parentElement).toContainElement(input);
      expect((input as HTMLTextAreaElement).labels?.[0]).toBe(labels[0]);
    }
  });

  it('without an instanceId the id falls back to the CLI tool id', () => {
    render(<PlanReviewControls worktreeId={WORKTREE_ID} cliToolId="command-code" />);
    expect(screen.getByTestId('plan-review-comment-input').id).toBe(
      `plan-review-comment-${WORKTREE_ID}:command-code`,
    );
  });
});
